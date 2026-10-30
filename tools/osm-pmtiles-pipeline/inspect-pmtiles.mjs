/*
 * tools/osm-pmtiles-pipeline/inspect-pmtiles.mjs
 *
 * 诊断：离线 PMTiles 里**到底有没有** name / height / building:levels 属性。
 * 用来区分「离线看不到街道名/楼高」的两类根因：
 *   A. 数据里压根没这些字段（源 OSM 就没标）→ 改样式也没用；
 *   B. 数据有字段，是样式（字体 glyphs / 表达式字段名 / minzoom）的问题。
 *
 * 零外部依赖：PMTiles 读取用 public/vendor/pmtiles-reader.js（fromBuffer），
 * MVT 用本文件内自带的最小 protobuf 解析器（venv 里的 mapbox_vector_tile 只用于 Python 侧）。
 *
 * 用法：
 *   node tools/osm-pmtiles-pipeline/inspect-pmtiles.mjs            // 默认查前 3 个城市
 *   node tools/osm-pmtiles-pipeline/inspect-pmtiles.mjs 上海 西安   // 指定城市名（模糊匹配）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PMT_DIR = path.join(ROOT, 'public', 'data', 'tiles', 'osm', 'pmtiles');
// package.json 若为 "type":"module"，该 .js 会被当 ESM 加载，UMD 的 module.exports 分支不生效、
// API 改挂到 globalThis.PMTilesReader —— 两种都兜住。
const _mod = require(path.join(ROOT, 'public', 'vendor', 'pmtiles-reader.js'));
const READER = (_mod && typeof _mod.fromBuffer === 'function') ? _mod : globalThis.PMTilesReader;
if (!READER || typeof READER.fromBuffer !== 'function') { console.error('PMTilesReader 加载失败'); process.exit(1); }

// ---------- 最小 protobuf / MVT 解析 ----------
function readVarint(b, p) {
  let val = 0, shift = 1, byte;
  do { byte = b[p++]; val += (byte & 0x7f) * shift; shift *= 128; } while (byte & 0x80);
  return [val, p];
}
function fields(buf, start, end) {
  const out = [];
  let p = start;
  while (p < end) {
    let key; [key, p] = readVarint(buf, p);
    const field = key >> 3, wire = key & 7;
    if (wire === 0) { let v; [v, p] = readVarint(buf, p); out.push({ field, wire, v }); }
    else if (wire === 2) { let len; [len, p] = readVarint(buf, p); out.push({ field, wire, buf: buf.subarray(p, p + len) }); p += len; }
    else if (wire === 5) { out.push({ field, wire, buf: buf.subarray(p, p + 4) }); p += 4; }
    else if (wire === 1) { out.push({ field, wire, buf: buf.subarray(p, p + 8) }); p += 8; }
    else throw new Error('unsupported wire type ' + wire);
  }
  return out;
}
function parseValue(buf) {
  for (const f of fields(buf, 0, buf.length)) {
    if (f.field === 1 && f.wire === 2) return Buffer.from(f.buf).toString('utf8');
    if (f.field === 2 && f.wire === 5) return f.buf.readFloatLE(0);
    if (f.field === 3 && f.wire === 1) return f.buf.readDoubleLE(0);
    if (f.field === 7 && f.wire === 0) { const n = f.v; return n % 2 === 0 ? n / 2 : -(n + 1) / 2; }
    if (f.field === 8 && f.wire === 0) return !!f.v;
    if (f.wire === 0) return f.v;
  }
  return null;
}
function parseFeature(buf) {
  const out = { tags: [], type: 0 };
  for (const f of fields(buf, 0, buf.length)) {
    if (f.field === 2 && f.wire === 2) {
      let p = 0; const arr = [];
      while (p < f.buf.length) { let v; [v, p] = readVarint(f.buf, p); arr.push(v); }
      out.tags = arr;
    }
    if (f.field === 3 && f.wire === 0) out.type = f.v;
  }
  return out;
}
function parseLayer(buf) {
  const L = { name: '', keys: [], values: [], features: [] };
  for (const f of fields(buf, 0, buf.length)) {
    if (f.field === 1 && f.wire === 2) L.name = Buffer.from(f.buf).toString('utf8');
    if (f.field === 2 && f.wire === 2) L.features.push(parseFeature(f.buf));
    if (f.field === 3 && f.wire === 2) L.keys.push(Buffer.from(f.buf).toString('utf8'));
    if (f.field === 4 && f.wire === 2) L.values.push(parseValue(f.buf));
  }
  return L;
}
function parseTile(buf) {
  const layers = [];
  for (const f of fields(buf, 0, buf.length)) {
    if (f.field === 3 && f.wire === 2) layers.push(parseLayer(f.buf));
  }
  return layers;
}
function propsOf(L, feat) {
  const p = {};
  for (let i = 0; i + 1 < feat.tags.length; i += 2) {
    const k = L.keys[feat.tags[i]], v = L.values[feat.tags[i + 1]];
    if (k != null) p[k] = v;
  }
  return p;
}
function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const x = Math.floor((lon + 180) / 360 * n);
  const lr = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2 * n);
  return { x, y };
}

// ---------- 主流程 ----------
const manifest = JSON.parse(fs.readFileSync(path.join(PMT_DIR, 'manifest.json'), 'utf8'));
const all = Object.entries(manifest).filter(([, v]) => v.ok && v.bbox);
const want = process.argv.slice(2);
const picked = want.length
  ? all.filter(([name]) => want.some((w) => name.includes(w)))
  : all.slice(0, 3);
if (!picked.length) { console.log('没有匹配的城市，manifest 共 ' + all.length + ' 个'); process.exit(0); }

for (const [name, v] of picked) {
  const file = v.file.replace(/^.*\//, '');
  const fp = path.join(PMT_DIR, file);
  if (!fs.existsSync(fp)) { console.log(`[${name}] 文件缺失 ${fp}`); continue; }
  const r = READER.fromBuffer(new Uint8Array(fs.readFileSync(fp)));
  const z = Math.min(15, v.maxz || 15);
  const clng = v.center ? v.center[0] : (v.bbox[0] + v.bbox[2]) / 2;
  const clat = v.center ? v.center[1] : (v.bbox[1] + v.bbox[3]) / 2;
  const { x: cx, y: cy } = lonLatToTile(clng, clat, z);

  const st = { trans: { n: 0, name: 0, nameEn: 0 }, area: { n: 0, building: 0, height: 0, levels: 0, blevels: 0 } };
  const samples = { road: [], height: [], blevels: [] };
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const tile = await r.getTile(z, cx + dx, cy + dy);
      if (!tile) continue;
      for (const L of parseTile(tile)) {
        for (const feat of L.features) {
          const p = propsOf(L, feat);
          if (L.name === 'transportation') {
            st.trans.n++;
            if (p.name) { st.trans.name++; if (samples.road.length < 6) samples.road.push(p.name); }
            if (p['name:en']) st.trans.nameEn++;
          } else if (L.name === 'area') {
            st.area.n++;
            if (p.building) st.area.building++;
            if (p.height != null) { st.area.height++; if (samples.height.length < 6) samples.height.push(p.height); }
            if (p.levels != null) st.area.levels++;
            if (p['building:levels'] != null) { st.area.blevels++; if (samples.blevels.length < 6) samples.blevels.push(p['building:levels']); }
          }
        }
      }
    }
  }
  console.log(`\n=== ${name} ===  z=${z} (maxz=${v.maxz})  3x3 瓦片  文件 ${file}`);
  console.log(`  transportation: ${st.trans.n} 条, 有 name: ${st.trans.name}, 有 name:en: ${st.trans.nameEn}`);
  console.log(`    街道名样例: ${samples.road.length ? samples.road.join(' / ') : '（无）'}`);
  console.log(`  area: ${st.area.n} 条, building: ${st.area.building}, height: ${st.area.height}, levels: ${st.area.levels}, building:levels: ${st.area.blevels}`);
  console.log(`    height 样例: ${samples.height.length ? samples.height.join(', ') : '（无）'}`);
  console.log(`    building:levels 样例: ${samples.blevels.length ? samples.blevels.join(', ') : '（无）'}`);
}
