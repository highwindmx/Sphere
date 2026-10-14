// 离线卫星影像瓦片下载脚本
//
// 数据源：Esri World Imagery（ArcGIS 公共瓦片服务）
//   URL 规则：https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}
//   无 API key、公开访问、全球 0.3m–500m 分辨率
//   注意：ArcGIS tile URL 是 {z}/{y}/{x}（row 在 col 前）
//   保存时按 Cesium 兼容格式 {z}/{x}/{y}.jpg 存，main.js 用 UrlTemplateImageryProvider 直接加载
//
// 用法：
//   node scripts/download-satellite-tiles.mjs                # 默认：全球 z0-z5 + 中国周边 z6-z10
//   node scripts/download-satellite-tiles.mjs --quick      # 只下全球 z0-z2（验证脚本）
//   node scripts/download-satellite-tiles.mjs --china      # 只下中国周边 z0-z10
//   node scripts/download-satellite-tiles.mjs --region places # 山川形胜/水利标注点周边 z10-z14
//   node scripts/download-satellite-tiles.mjs --min-z 6 --max-z 8 --bbox 100,20,130,45  # 自定义范围
//
// 与现有地形瓦片（download-tiles.mjs）互补：
//   地形 → public/tiles/terrain/{z}/{x}/{y}.png（Terrarium PNG）
//   影像 → public/tiles/satellite/{z}/{x}/{y}.jpg（Esri JPEG）

import { mkdir, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile';
const OUT_DIR = 'public/tiles/satellite';
const CONCURRENCY = 6;       // 影像瓦片比地形大（JPEG 50-200KB vs PNG 2-20KB），降并发
const MAX_RETRY = 3;
const FETCH_TIMEOUT_MS = 30000;

// ---------- 经纬度 → WebMercator 瓦片坐标（与 download-tiles.mjs 完全一致） ----------

function lonLatToTile(lon, lat, z) {
  const n = Math.pow(2, z);
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
  return [x, Math.max(0, Math.min(n - 1, y))];
}

function tilesInBBox(z, minLon, minLat, maxLon, maxLat) {
  const [x1, y1] = lonLatToTile(minLon, maxLat, z);
  const [x2, y2] = lonLatToTile(maxLon, minLat, z);
  const n = Math.pow(2, z);
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);
  const tiles = [];
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      if (y < 0 || y >= n) continue;
      tiles.push([x, y]);
    }
  }
  return tiles;
}

// ---------- 任务清单 ----------

function buildTaskList(options) {
  const tasks = [];

  const pushBBox = (z, bbox) => {
    const [minLon, minLat, maxLon, maxLat] = bbox;
    for (const [x, y] of tilesInBBox(z, minLon, minLat, maxLon, maxLat)) {
      tasks.push({ z, x, y });
    }
  };

  const pushGlobal = (z) => {
    const n = Math.pow(2, z);
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) {
        tasks.push({ z, x, y });
      }
    }
  };

  if (options.quick) {
    for (let z = 0; z <= 2; z++) pushGlobal(z);
    return dedup(tasks);
  }

  if (options.china) {
    // 中国全境 z0-z10（z10 单级约 2000 瓦片）
    const CHINA = [60, 15, 150, 58];
    for (let z = 0; z <= 10; z++) pushBBox(z, CHINA);
    return dedup(tasks);
  }

  if (options.region === 'places') {
    // 核心视点 z10-z14（每个点 ±2°）
    const PLACES = [
      // 水利工程（waterworks.js）
      [103.6, 31.0], [110.7, 25.7], [89.2, 42.9], [108.8, 34.6], [116.5, 32.2],
      [111.0, 30.8], [102.9, 27.0], [103.6, 28.3], [102.5, 26.5], [107.0, 25.0],
      [100.1, 24.7], [111.27, 30.73], [104.9, 28.6], [101.5, 28.2], [101.7, 26.9],
      [101.1, 36.1], [113.4, 34.9],
      // 世界海洋地形（world-ocean.js）
      [102.0, 2.5], [56.3, 26.5], [142.59, 11.37], [-66.5, 19.5], [-176.0, -23.0],
      // 山脉（mountains.js）—— 只下几个核心段
      [86.0, 28.0], [100.0, 29.0], [85.0, 36.0], [110.0, 33.5], [103.0, 37.0], [85.0, 43.0],
    ];
    const DELTA = 2;
    for (const [lon, lat] of PLACES) {
      const bbox = [lon - DELTA, lat - DELTA, lon + DELTA, lat + DELTA];
      for (let z = 10; z <= 14; z++) pushBBox(z, bbox);
    }
    return dedup(tasks);
  }

  // 默认：全球 z0-z5 + 中国周边 z6-z10
  for (let z = 0; z <= 5; z++) pushGlobal(z);
  const CHINA_BBOX = [60, 0, 150, 60];
  for (let z = 6; z <= 10; z++) pushBBox(z, CHINA_BBOX);

  if (options.bbox && options.minZ != null && options.maxZ != null) {
    const bbox = options.bbox.split(',').map(Number);
    for (let z = options.minZ; z <= options.maxZ; z++) pushBBox(z, bbox);
  }

  return dedup(tasks);
}

function dedup(tasks) {
  const seen = new Set();
  return tasks.filter(({ z, x, y }) => {
    const key = `${z}/${x}/${y}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------- 下载 ----------

function tileSavePath(z, x, y) {
  return join(OUT_DIR, String(z), String(x), `${y}.jpg`);
}

// Esri URL 用 {z}/{y}/{x}，和 Web Mercator {z}/{x}/{y} 是一一对应关系
function tileFetchUrl(z, x, y) {
  return `${BASE_URL}/${z}/${y}/${x}`;
}

async function downloadTile(z, x, y, retry = 0) {
  const outPath = tileSavePath(z, x, y);
  if (existsSync(outPath)) return 'skip';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(tileFetchUrl(z, x, y), {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'sphere-tile-downloader/1.0' }
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 200) throw new Error(`响应过小（${buf.length} 字节），可能是空瓦片`);
    await mkdir(join(OUT_DIR, String(z), String(x)), { recursive: true });
    await writeFile(outPath, buf);
    return 'ok';
  } catch (err) {
    clearTimeout(timer);
    if (retry < MAX_RETRY) {
      await new Promise((r) => setTimeout(r, 800 * (retry + 1)));
      return downloadTile(z, x, y, retry + 1);
    }
    throw err;
  }
}

// ---------- 并发调度 ----------

async function runPool(tasks, concurrency, worker) {
  let index = 0, done = 0, ok = 0, skip = 0, fail = 0;
  const failures = [];
  const startedAt = Date.now();

  async function workerLoop() {
    while (index < tasks.length) {
      const myIndex = index++;
      const task = tasks[myIndex];
      try {
        const result = await worker(task);
        done++;
        if (result === 'ok') ok++;
        else if (result === 'skip') skip++;
        const elapsed = (Date.now() - startedAt) / 1000;
        const rate = done / Math.max(elapsed, 0.1);
        const eta = Math.round((tasks.length - done) / Math.max(rate, 0.1));
        const etaStr = eta > 60 ? `${Math.floor(eta / 60)}m${eta % 60}s` : `${eta}s`;
        process.stdout.write(
          `\r${done}/${tasks.length} (✓${ok} 新 ⏭${skip} 🗑${fail}) · ${rate.toFixed(1)}/s · 剩 ${etaStr}   `
        );
      } catch (err) {
        done++; fail++;
        failures.push({ ...task, error: err.message });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, () => workerLoop())
  );
  process.stdout.write('\n');
  return { ok, skip, fail, failures };
}

// ---------- CLI ----------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    quick: false, china: false, region: undefined,
    bbox: undefined, minZ: null, maxZ: null,
    listOnly: false,          // 只生成链接列表，不下载
    listFormat: 'url',        // url | aria2 | idm | wget
    listOutput: undefined     // 列表文件路径，默认 satellite-tiles.txt
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--quick') opts.quick = true;
    else if (a === '--china') opts.china = true;
    else if (a === '--region') opts.region = args[++i];
    else if (a === '--bbox') opts.bbox = args[++i];
    else if (a === '--min-z') opts.minZ = Number(args[++i]);
    else if (a === '--max-z') opts.maxZ = Number(args[++i]);
    else if (a === '--list-only') opts.listOnly = true;
    else if (a === '--format' || a === '--list-format') opts.listFormat = args[++i];
    else if (a === '--output' || a === '--list-output') opts.listOutput = args[++i];
    else if (a === '-h' || a === '--help') {
      console.log(`用法：node scripts/download-satellite-tiles.mjs [选项]

数据源：Esri World Imagery（公开卫星影像，1m–500m 分辨率）

选项：
  --quick             全球 z0-z2（验证脚本）
  --china             中国全境 z0-z10（约 2 万瓦片）
  --region places     山川形胜/水利标注点周边 z10-z14
  --bbox W,S,E,N      自定义范围（如 --bbox 100,20,130,45）
  --min-z <n>  --max-z <n>   与 --bbox 配合

  --list-only         只生成链接列表文件，不下载（适合用 IDM/aria2c/迅雷提速）
  --format <fmt>      列表格式：url（默认）| aria2 | idm | wget
  --output <path>     列表文件路径（默认 satellite-tiles.<ext>）

默认（无 --list-only）：全球 z0-z5 + 中国周边 z6-z10（约 5 万瓦片，3-5 小时）

列表格式说明：
  url      每行一个 URL，aria2c -i、wget -i、迅雷/IDM 均可直接导入
  aria2    aria2c 专用：每行 URL + 下一行 out=保存路径（保留 {z}/{x}/{y}.jpg 结构）
  wget     wget -i 专用，每行 URL
  idm      IDM 导入格式（URL + DestFileName）

输出目录：${OUT_DIR}/{z}/{x}/{y}.jpg（Cesium UrlTemplateImageryProvider 直接加载）`);
      process.exit(0);
    }
  }
  return opts;
}

// ---------- 主 ----------

function generateList(tasks, format) {
  switch (format) {
    case 'aria2':
      // aria2c 专用：URL + 下一行 out=相对路径（保留 {z}/{x}/{y}.jpg 结构）
      return tasks
        .map(({ z, x, y }) => {
          const url = tileFetchUrl(z, x, y);
          const outPath = join(OUT_DIR, String(z), String(x), `${y}.jpg`);
          return `${url}\n  out=${outPath}`;
        })
        .join('\n');

    case 'idm':
      // IDM 导入格式：<url> 后跟 DestFileName= 路径
      return tasks
        .map(({ z, x, y }) => {
          const url = tileFetchUrl(z, x, y);
          const fname = `${z}/${x}/${y}.jpg`;
          return `${url} DestFileName=${fname}`;
        })
        .join('\n');

    case 'wget':
      // wget -i 专用，还需调整 base url 和 -P 目标目录
      // 直接输出 URL 列表，配合 wget -B 或 curl 批量
      return tasks.map(({ z, x, y }) => tileFetchUrl(z, x, y)).join('\n');

    case 'url':
    default:
      // 默认：每行一个 URL，最简单通用。aria2c -i、迅雷、IDM、wget -i 全支持
      return tasks.map(({ z, x, y }) => tileFetchUrl(z, x, y)).join('\n');
  }
}

async function main() {
  const opts = parseArgs();
  const tasks = buildTaskList(opts);

  if (tasks.length === 0) { console.log('无任务。'); return; }

  // ------ 列表模式 ------
  if (opts.listOnly) {
    const ext = opts.listFormat === 'aria2' ? 'txt' : opts.listFormat === 'idm' ? 'txt' : 'txt';
    const outPath = opts.listOutput || `satellite-tiles-${opts.listFormat}.${ext}`;
    const content = generateList(tasks, opts.listFormat);
    await writeFile(outPath, content);
    console.log(`✓ 已生成 ${tasks.length} 条 URL → ${outPath}`);
    console.log(`\n格式说明：`);
    if (opts.listFormat === 'aria2') {
      console.log(`  推荐下载：aria2c -x 16 -s 16 -j 8 -i ${outPath}`);
      console.log(`  （aria2c 自动按 out= 路径保存，目录结构已就绪）`);
    } else {
      console.log(`  aria2c: aria2c -x 16 -s 16 -j 8 -i ${outPath} -d ${OUT_DIR}`);
      console.log(`  wget:   wget -i ${outPath} --directory-prefix=${OUT_DIR}`);
      console.log(`  迅雷/IDM：直接导入 txt 文件（注意：需要手动设置下载后移动到 ${OUT_DIR} 或指定保存路径）`);
      console.log(`\n  ⚠ 下载器如果不自动创建子目录，需要先 mkdir -p ${OUT_DIR}/{z}/{x}（或让 aria2c 自动创建）`);
    }
    return;
  }

  // ------ 下载模式（原有逻辑） ------
  console.log(`Esri World Imagery 下载任务：${tasks.length} 瓦片 → ${OUT_DIR}/`);
  console.log(`URL 规则: ${BASE_URL}/{z}/{y}/{x} → 保存 {z}/{x}/{y}.jpg`);

  if (tasks.length > 100000) {
    console.log(`⚠ 任务量 ${tasks.length} 非常大，预计数十 GB。强烈建议缩小 --bbox 或降低 --max-z。`);
    console.log(`  继续执行请等待，Ctrl+C 可随时取消，下次运行断点续传。`);
  } else if (tasks.length > 20000) {
    console.log(`预计耗时 1–3 小时。Ctrl+C 随时取消，断点续传。`);
  } else if (tasks.length > 2000) {
    console.log(`预计 10–30 分钟。`);
  } else {
    console.log(`预计几分钟。`);
  }

  const result = await runPool(tasks, CONCURRENCY, (t) => downloadTile(t.z, t.x, t.y));

  console.log(`\n完成：${result.ok} 新下载 / ${result.skip} 跳过 / ${result.fail} 失败`);
  if (result.failures.length > 0) {
    console.log(`\n失败瓦片（前 10）：`);
    for (const f of result.failures.slice(0, 10)) {
      console.log(`  z=${f.z} x=${f.x} y=${f.y}  ${f.error}`);
    }
    if (result.failures.length > 10) console.log(`  …还有 ${result.failures.length - 10} 个`);
    console.log(`重新运行脚本会自动重试失败的。`);
  }
  console.log(`\n本地瓦片就绪后，启动应用即可自动加载离线影像底图。`);
}

main().catch((err) => { console.error('脚本出错:', err); process.exit(1); });
