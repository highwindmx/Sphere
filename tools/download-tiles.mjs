// 通用瓦片批量下载器（2026-10-16）
//
// 与 download-satellite-tiles.mjs（Esri 专用）/ download_terrain_tiles.py（地形专用）不同，
// 本脚本覆盖全部图源，且**走本地代理端点** /tiles/<源>/... ——带来三个好处：
//   ① 上游 URL、失败语义（terrain 404 回退等）、回写落盘全由 app.py 统一维护，不重复实现；
//   ② 下载的瓦片与主应用「浏览即缓存」落盘路径完全一致，下载完立刻可见；
//   ③ 天地图的浏览器端 key 由服务端 .env 提供，脚本无需管 key。
// ⚠ 因此需要 app.py 处于运行状态（默认 http://127.0.0.1:5008）。
//
// 用法：
//   node tools/download-tiles.mjs --source esri --min-z 0 --max-z 4
//   node tools/download-tiles.mjs --source tianditu --min-z 0 --max-z 8      # 天地图（全局/按 bbox）
//   node tools/download-tiles.mjs --source gibs --min-z 0 --max-z 7          # GIBS 非二分网格
//   node tools/download-tiles.mjs --source esri --min-z 9 --max-z 11 --bbox 73,18,135,54
//   node tools/download-tiles.mjs --source terrain --min-z 0 --max-z 4 --concurrency 12 --force
//
// 标注点子集（--points）：只下载左侧栏所有标注点半径 --radius-km（默认 25）范围内的瓦片，
//   覆盖范围 = 每个点的小 bbox 求并集去重，比「全部」小一个量级（高清段最实用）。
//   node tools/download-tiles.mjs --source esri --min-z 9 --max-z 11 --points --radius-km 25
//   node tools/download-tiles.mjs --source esri --min-z 9 --max-z 11 --points --dry-run   # 只数不下载
//   --with-lines：把线路（polyline/polygon）顶点也算作兴趣点（默认只算点状标注）。
//
// 断点续传：已存在的本地文件默认跳过（--force 强制重下）。Ctrl+C 可随时中断。

import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE_DEFAULT = 'http://127.0.0.1:5008/';

/** 各源的本地路径规则（与 app.py proxy_*_tile 的落盘路径严格一致） */
const SOURCES = {
  esri:     { kind: 'xyz', maxZ: 19, path: (z, x, y) => `tiles/esri/${z}/${x}/${y}.jpg` },
  eox:      { kind: 'xyz', maxZ: 18, path: (z, x, y) => `tiles/eox/${z}/${x}/${y}.jpg` },
  tianditu: { kind: 'xyz', maxZ: 18, path: (z, x, y) => `tiles/tianditu/0/${z}/${x}/${y}.jpg` },
  gibs:     { kind: 'gibs', maxZ: 7, path: (z, x, y) => `tiles/gibs/${z}/${y}/${x}.jpeg` },
  terrain:  { kind: 'xyz', maxZ: 15, path: (z, x, y) => `tiles/terrain/${z}/${x}/${y}.png` },
};
// GIBS 非二分网格（与 src/gibs-provider.js 的 COLS/ROWS 对应，此处取每级列数/行数）
const GIBS_COLS = [2, 3, 5, 10, 20, 40, 80, 160];
const GIBS_ROWS = [1, 2, 3, 5, 10, 20, 40, 80];

function parseArgs(argv) {
  const o = {
    source: 'esri', minZ: 0, maxZ: 4, bbox: null, concurrency: 8, force: false, base: BASE_DEFAULT,
    points: false, radiusKm: 25, withLines: false, dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source') o.source = argv[++i];
    else if (a === '--min-z') o.minZ = parseInt(argv[++i], 10);
    else if (a === '--max-z') o.maxZ = parseInt(argv[++i], 10);
    else if (a === '--bbox') o.bbox = argv[++i].split(',').map(Number);
    else if (a === '--concurrency') o.concurrency = parseInt(argv[++i], 10);
    else if (a === '--base') o.base = argv[++i];
    else if (a === '--radius-km') o.radiusKm = parseFloat(argv[++i]);
    else if (a === '--points') o.points = true;
    else if (a === '--with-lines') o.withLines = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--force') o.force = true;
  }
  return o;
}

// ---------- 瓦片枚举 ----------
const lon2x = (lon, z) => Math.floor((lon + 180) / 360 * Math.pow(2, z));
const lat2y = (lat, z) => Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, z));

function enumerateXyz(zmin, zmax, bbox) {
  const tasks = [];
  for (let z = zmin; z <= zmax; z++) {
    const n = Math.pow(2, z);
    const [x0, x1] = bbox ? [lon2x(bbox[0], z), lon2x(bbox[2], z)] : [0, n - 1];
    const [y0, y1] = bbox ? [lat2y(bbox[3], z), lat2y(bbox[1], z)] : [0, n - 1];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) tasks.push({ z, x, y });
  }
  return tasks;
}

function enumerateGibs(zmin, zmax) {
  const tasks = [];
  for (let g = zmin; g <= zmax; g++) {
    for (let c = 0; c < GIBS_COLS[g]; c++) for (let r = 0; r < GIBS_ROWS[g]; r++) tasks.push({ z: g, x: c, y: r });
  }
  return tasks;
}

// ---------- 标注点子集 ----------
// 兴趣点直接来自前端图层数据 src/layers/*.js（纯 ESM 数据模块，Node 可 import），
// 与左侧栏显示的标注严格同源，无需另维护一份坐标表。
// moonmission 的发射场是地球坐标（酒泉/太原/西昌/文昌），保留；tiangong 无静态点（groups 为空）。
const POINT_SKIP_LAYERS = new Set(['tiangong']);

async function collectPoints(withLines) {
  const { LAYERS } = await import('../src/layers/index.js');
  const pts = [];
  const seen = new Set();
  const push = (lon, lat) => {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    if (Math.abs(lat) > 85) return;                 // 极区外无瓦片几何
    const k = `${lon.toFixed(3)},${lat.toFixed(3)}`; // 0.001° ≈ 100m，足以去重
    if (seen.has(k)) return;
    seen.add(k);
    pts.push([lon, lat]);
  };
  for (const layer of LAYERS) {
    if (POINT_SKIP_LAYERS.has(layer.id)) continue;
    for (const g of layer.groups || []) {
      for (const e of g.entities || []) {
        if (e.type === 'point' || e.type === 'label') {
          if (Number.isFinite(e.lon) && Number.isFinite(e.lat)) push(e.lon, e.lat);
          else if (Array.isArray(e.coords) && e.coords.length === 2
                   && Number.isFinite(e.coords[0])) push(e.coords[0], e.coords[1]);
        } else if (withLines && Array.isArray(e.coords)) {
          for (const c of e.coords) {
            if (Array.isArray(c) && c.length >= 2) push(c[0], c[1]);
          }
        }
      }
    }
  }
  return pts;
}

/** 点 + 半径 → 小 bbox（经纬度近似：1° 纬 ≈ 111.32 km，1° 经 ≈ 111.32·cosφ km） */
function pointBbox(lon, lat, rKm) {
  const dLat = rKm / 111.32;
  const cos = Math.max(0.05, Math.cos(lat * Math.PI / 180));
  const dLon = rKm / (111.32 * cos);
  return [
    Math.max(-180, lon - dLon), Math.max(-85, lat - dLat),
    Math.min(180, lon + dLon), Math.min(85, lat + dLat),
  ];
}

/** GIBS 非二分网格：经纬 → 行列（与 src/gibs-provider.js 的 SPAN0=288 换算一致） */
const gibsCol = (lon, g) => Math.min(GIBS_COLS[g] - 1, Math.max(0, Math.floor((lon + 180) * Math.pow(2, g) / 288)));
const gibsRow = (lat, g) => Math.min(GIBS_ROWS[g] - 1, Math.max(0, Math.floor((90 - lat) * Math.pow(2, g) / 288)));

function enumeratePoints(kind, zmin, zmax, pts, rKm, clip = null) {
  const map = new Map();
  for (const [lon, lat] of pts) {
    if (kind === 'gibs') {
      for (let g = zmin; g <= zmax; g++) {
        const c0 = gibsCol(lon - rKm / 80, g), c1 = gibsCol(lon + rKm / 80, g);
        const r0 = gibsRow(lat + rKm / 111, g), r1 = gibsRow(lat - rKm / 111, g);
        for (let c = c0; c <= c1; c++) for (let r = r0; r <= r1; r++) map.set(`${g}/${c}/${r}`, { z: g, x: c, y: r });
      }
    } else {
      let bb = pointBbox(lon, lat, rKm);
      if (clip) {
        // 与全局 bbox 求交（天地图等只覆盖部分区域的源，区外点自动剔除）
        bb = [Math.max(bb[0], clip[0]), Math.max(bb[1], clip[1]), Math.min(bb[2], clip[2]), Math.min(bb[3], clip[3])];
        if (bb[0] > bb[2] || bb[1] > bb[3]) continue;
      }
      for (const t of enumerateXyz(zmin, zmax, bb)) map.set(`${t.z}/${t.x}/${t.y}`, t);
    }
  }
  return [...map.values()];
}

// ---------- 单瓦片抓取 ----------
async function fetchOne(base, relPath, timeoutMs = 20000, retry = 3) {
  const url = base.replace(/\/$/, '') + '/' + relPath;
  for (let i = 0; i < retry; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      clearTimeout(timer);
      if (!r.ok) { if (r.status === 404) return { ok: false, skip: false, err: `HTTP ${r.status}` }; throw new Error(`HTTP ${r.status}`); }
      const buf = Buffer.from(await r.arrayBuffer());
      return { ok: true, buf };
    } catch (e) {
      clearTimeout(timer);
      if (i === retry - 1) return { ok: false, skip: false, err: e.name === 'AbortError' ? 'timeout' : e.message };
      await new Promise((res) => setTimeout(res, 400 * (i + 1)));
    }
  }
  return { ok: false, skip: false, err: 'unknown' };
}

// ---------- 主流程 ----------
const opts = parseArgs(process.argv.slice(2));
const src = SOURCES[opts.source];
if (!src) { console.error(`未知图源：${opts.source}（可选：${Object.keys(SOURCES).join(' / ')}）`); process.exit(1); }
if (!(opts.minZ >= 0 && opts.maxZ >= opts.minZ && opts.maxZ <= src.maxZ)) {
  console.error(`层级不合法：需 0 ≤ minZ ≤ maxZ ≤ ${src.maxZ}（当前 ${opts.minZ}–${opts.maxZ}）`);
  process.exit(1);
}
if (opts.bbox && (opts.bbox.length !== 4 || opts.bbox.some(Number.isNaN))) {
  console.error('--bbox 需 4 个数字：西,南,东,北'); process.exit(1);
}
if (opts.points && !(opts.radiusKm > 0 && opts.radiusKm <= 500)) {
  console.error('--radius-km 需在 (0, 500] 之间'); process.exit(1);
}

let pts = 0;
let tasks;
if (opts.points) {
  const points = await collectPoints(opts.withLines);
  pts = points.length;
  tasks = enumeratePoints(src.kind, opts.minZ, opts.maxZ, points, opts.radiusKm, opts.bbox);
} else {
  tasks = src.kind === 'gibs' ? enumerateGibs(opts.minZ, opts.maxZ) : enumerateXyz(opts.minZ, opts.maxZ, opts.bbox);
}
const scope = opts.points
  ? `${pts} 个标注点 ±${opts.radiusKm}km${opts.withLines ? '（含线路顶点）' : ''}`
  : (opts.bbox ? `bbox ${opts.bbox.join(',')}` : '全球');
console.log(`图源 ${opts.source}：${tasks.length} 瓦片（z${opts.minZ}–${opts.maxZ}，${scope}）→ ${opts.base}`);
if (opts.dryRun) {
  // 供 /api/downloader/plan 解析：只数不下载
  console.log(`PLAN ${JSON.stringify({ total: tasks.length, points: pts, source: opts.source, minZ: opts.minZ, maxZ: opts.maxZ, radiusKm: opts.radiusKm })}`);
  process.exit(0);
}
if (tasks.length === 0) { console.log('无任务。'); process.exit(0); }

let done = 0, ok = 0, skip = 0, fail = 0;
const failures = [];
const started = Date.now();
const fmtEta = (s) => (s > 60 ? `${Math.floor(s / 60)}m${Math.round(s % 60)}s` : `${Math.round(s)}s`);

function printProgress() {
  const elapsed = (Date.now() - started) / 1000;
  const rate = done / Math.max(elapsed, 0.1);
  const eta = fmtEta((tasks.length - done) / Math.max(rate, 0.1));
  // 进度行格式需匹配 app.py 的 _dl_progress_re（前端进度条/速度/ETA 靠它解析）
  process.stdout.write(`\r${done}/${tasks.length} (新 ${ok} · 跳过 ${skip} · 失败 ${fail}) · ${rate.toFixed(1)}/s · 剩 ${eta}   `);
}

let cursor = 0;
async function worker() {
  while (cursor < tasks.length) {
    const t = tasks[cursor++];
    const rel = src.path(t.z, t.x, t.y);
    const local = join(ROOT, 'public', rel);
    if (!opts.force && existsSync(local)) { done++; skip++; printProgress(); continue; }
    const r = await fetchOne(opts.base, rel);
    done++;
    if (r.ok) {
      try {
        await mkdir(dirname(local), { recursive: true });
        await writeFile(local, r.buf);
        ok++;
      } catch (e) { fail++; failures.push({ ...t, error: e.message }); }
    } else if (r.skip) {
      skip++;
    } else {
      fail++;
      if (failures.length < 20) failures.push({ ...t, error: r.err });
    }
    printProgress();
  }
}

const n = Math.min(opts.concurrency, tasks.length);
await Promise.all(Array.from({ length: n }, () => worker()));

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n完成：${ok} 新下载 / ${skip} 跳过 / ${fail} 失败，用时 ${elapsed}s`);
if (failures.length) {
  console.log(`\n失败瓦片（前 10）：`);
  for (const f of failures.slice(0, 10)) console.log(`  z=${f.z} x=${f.x} y=${f.y}  ${f.error}`);
}
process.exit(fail > 0 && ok === 0 ? 1 : 0);
