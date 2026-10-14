// 离线瓦片下载脚本（Terrarium 地形格式）
//
// 数据源：AWS 公共数据集 elevation-tiles-prod（Terrarium PNG，全球到 z15）
//   URL 规则：https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
//   无 API key、无使用限制、无 requester-pays
//
// 用法：
//   node scripts/download-tiles.mjs               # 默认：全球 z0-z5 + 中国周边 z6-z9 + 7 地点 z10-z12
//   node scripts/download-tiles.mjs --quick      # 只下全球 z0-z2（验证脚本，约 1 分钟）
//   node scripts/download-tiles.mjs --region china  # 只下中国周边 z6-z9
//   node scripts/download-tiles.mjs --region places # 只下 7 地点高分辨率
//   node scripts/download-tiles.mjs --min-z 6 --max-z 8 --bbox 100,20,130,45  # 自定义范围
//
// 已下载的瓦片会跳过（断点续传）。失败的瓦片自动重试 3 次。

import { mkdir, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { LAYER as SCENERY } from '../src/layers/scenery.js';
// 山川形胜各标注点的经纬度，用于下载这些地点的高分辨率地形瓦片
const PLACES = SCENERY.groups.flatMap((g) =>
  g.entities.map((e) => ({ name: e.name, lon: e.lon, lat: e.lat }))
);

const BASE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const OUT_DIR = 'public/tiles/terrain';
const CONCURRENCY = 8;       // 并发下载数（再多容易被服务端限速）
const MAX_RETRY = 3;
const FETCH_TIMEOUT_MS = 20000;

// ---------- 经纬度 → WebMercator 瓦片坐标 ----------

// 给定缩放级别和经纬度，返回该点所属瓦片的 (x, y) 坐标
// 公式来自 OSM wiki，与 Google/必应/AWS Terrarium 一致
function lonLatToTile(lon, lat, z) {
  const n = Math.pow(2, z);
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
  return [x, Math.max(0, Math.min(n - 1, y))];
}

// 给定范围 (minLon, minLat, maxLon, maxLat)，返回该范围覆盖的所有瓦片坐标
function tilesInBBox(z, minLon, minLat, maxLon, maxLat) {
  const [x1, y1] = lonLatToTile(minLon, maxLat, z); // 注意：纬度大的对应 y 小（北）
  const [x2, y2] = lonLatToTile(maxLon, minLat, z);
  const n = Math.pow(2, z);
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);
  const tiles = [];
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      // 跳过越界（极地附近 y 可能超出范围）
      if (y < 0 || y >= n) continue;
      tiles.push([x, y]);
    }
  }
  return tiles;
}

// ---------- 下载任务清单 ----------

function buildTaskList(options) {
  const tasks = []; // [{z, x, y}]

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
    // 验证模式：只下全球 z0-z2
    for (let z = 0; z <= 2; z++) pushGlobal(z);
    return tasks;
  }

  if (options.region === 'global' || !options.region) {
    // 全球低分辨率基底
    for (let z = 0; z <= 5; z++) pushGlobal(z);
  }

  if (options.region === 'china' || !options.region) {
    // 中国+亚洲周边中分辨率
    const CHINA_BBOX = [60, 0, 150, 60]; // 经度 60-150, 纬度 0-60
    for (let z = 6; z <= 9; z++) pushBBox(z, CHINA_BBOX);
  }

  if (options.region === 'places' || !options.region) {
    // 7 个地点高分辨率
    const PLACE_BBOX_DELTA = 3; // 每个地点 ±3 度
    for (const place of PLACES) {
      const bbox = [
        place.lon - PLACE_BBOX_DELTA,
        place.lat - PLACE_BBOX_DELTA,
        place.lon + PLACE_BBOX_DELTA,
        place.lat + PLACE_BBOX_DELTA
      ];
      for (let z = 10; z <= 12; z++) pushBBox(z, bbox);
    }
  }

  if (options.bbox && options.minZ != null && options.maxZ != null) {
    const bbox = options.bbox.split(',').map(Number);
    for (let z = options.minZ; z <= options.maxZ; z++) pushBBox(z, bbox);
  }

  // 去重（同一 z/x/y 可能被多次添加）
  const seen = new Set();
  return tasks.filter(({ z, x, y }) => {
    const key = `${z}/${x}/${y}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------- 下载单个瓦片 ----------

function tilePath(z, x, y) {
  return join(OUT_DIR, String(z), String(x), `${y}.png`);
}

function tileUrl(z, x, y) {
  return `${BASE_URL}/${z}/${x}/${y}.png`;
}

async function downloadTile(z, x, y, retry = 0) {
  const outPath = tilePath(z, x, y);
  if (existsSync(outPath)) return 'skip';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(tileUrl(z, x, y), { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) throw new Error(`响应过小（${buf.length} 字节），可能是空瓦片`);
    await mkdir(join(OUT_DIR, String(z), String(x)), { recursive: true });
    await writeFile(outPath, buf);
    return 'ok';
  } catch (err) {
    clearTimeout(timer);
    if (retry < MAX_RETRY) {
      await new Promise((r) => setTimeout(r, 500 * (retry + 1))); // 退避
      return downloadTile(z, x, y, retry + 1);
    }
    throw err;
  }
}

// ---------- 并发调度 ----------

async function runPool(tasks, concurrency, worker) {
  let index = 0;
  let done = 0;
  let okCount = 0;
  let skipCount = 0;
  let failCount = 0;
  const failures = [];
  const startedAt = Date.now();

  async function processNext() {
    while (index < tasks.length) {
      const myIndex = index++;
      const task = tasks[myIndex];
      try {
        const result = await worker(task);
        done++;
        if (result === 'ok') okCount++;
        else if (result === 'skip') skipCount++;
        if (done % 50 === 0 || done === tasks.length) {
          const elapsed = (Date.now() - startedAt) / 1000;
          const rate = done / elapsed;
          const eta = Math.round((tasks.length - done) / rate);
          const etaStr =
            eta > 60 ? `${Math.floor(eta / 60)}m${eta % 60}s` : `${eta}s`;
          process.stdout.write(
            `\r${done}/${tasks.length} (${okCount} 新, ${skipCount} 跳过, ${failCount} 失败) · ${rate.toFixed(1)} 瓦片/秒 · 剩 ${etaStr}   `
          );
        }
      } catch (err) {
        done++;
        failCount++;
        failures.push({ ...task, error: err.message });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, () => processNext())
  );

  process.stdout.write('\n');
  return { okCount, skipCount, failCount, failures };
}

// ---------- 解析命令行参数 ----------

function parseArgs() {
  const args = process.argv.slice(2);
  const options = { quick: false, region: undefined, bbox: undefined, minZ: null, maxZ: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--quick') options.quick = true;
    else if (a === '--region') options.region = args[++i];
    else if (a === '--bbox') options.bbox = args[++i];
    else if (a === '--min-z') options.minZ = Number(args[++i]);
    else if (a === '--max-z') options.maxZ = Number(args[++i]);
    else if (a === '--help' || a === '-h') {
      console.log(`用法：node scripts/download-tiles.mjs [选项]

选项：
  --quick             只下全球 z0-z2（验证脚本，约 1 分钟）
  --region <name>     只下指定区域：global | china | places
  --bbox <minLon,minLat,maxLon,maxLat>   自定义范围
  --min-z <n> --max-z <n>                与 --bbox 配合

默认（无参数）：全球 z0-z5 + 中国周边 z6-z9 + 7 地点 z10-z12（约 470MB）`);
      process.exit(0);
    }
  }
  return options;
}

// ---------- 主流程 ----------

async function main() {
  const options = parseArgs();
  const tasks = buildTaskList(options);
  console.log(`任务：${tasks.length} 个瓦片，输出目录 ${OUT_DIR}/`);
  if (tasks.length === 0) {
    console.log('没有任务。检查参数。');
    return;
  }
  if (tasks.length > 200000) {
    console.log(`⚠ 任务量 ${tasks.length} 较大，预计耗时数小时。继续执行请等待，按 Ctrl+C 取消。`);
  } else if (tasks.length > 20000) {
    console.log(`预计耗时几十分钟到 1 小时。可以 Ctrl+C 随时取消，下次运行会断点续传。`);
  } else {
    console.log(`预计几分钟内完成。`);
  }

  const result = await runPool(tasks, CONCURRENCY, (task) =>
    downloadTile(task.z, task.x, task.y)
  );

  console.log(`\n完成：${result.okCount} 新下 / ${result.skipCount} 跳过 / ${result.failCount} 失败`);
  if (result.failures.length > 0) {
    console.log('\n失败瓦片（前 10 个）：');
    for (const f of result.failures.slice(0, 10)) {
      console.log(`  z=${f.z} x=${f.x} y=${f.y}  ${f.error}`);
    }
    if (result.failures.length > 10) {
      console.log(`  …还有 ${result.failures.length - 10} 个失败`);
    }
    console.log('\n可以重新运行此脚本，已下载的会跳过，只重试失败的。');
  }
  console.log(`\n瓦片已保存到 ${OUT_DIR}/。启动 npm run dev 即可使用离线地形。`);
}

main().catch((err) => {
  console.error('脚本出错：', err);
  process.exit(1);
});
