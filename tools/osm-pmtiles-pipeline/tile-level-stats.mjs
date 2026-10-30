/*
 * tools/osm-pmtiles-pipeline/tile-level-stats.mjs
 *
 * 诊断：同一地理位置在**各个 zoom** 上的瓦片内容量对比。
 * 用途：回答「离线能不能缩小」——如果 z11–z14 瓦片里根本没有面要素（water/green/building），
 *       缩小后画面就只剩路网，等于不可用；反之可以放开 minzoom。
 *
 * 用法：
 *   node tools/osm-pmtiles-pipeline/tile-level-stats.mjs 上海 121.4705 31.0805
 *   node tools/osm-pmtiles-pipeline/tile-level-stats.mjs 米兰 9.19 45.46 11 15    // 指定 z 区间
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PMT_DIR = path.join(ROOT, 'public', 'data', 'osm', 'pmtiles');
const _mod = require(path.join(ROOT, 'public', 'vendor', 'pmtiles-reader.js'));
const READER = (_mod && typeof _mod.fromBuffer === 'function') ? _mod : globalThis.PMTilesReader;
if (!READER || typeof READER.fromBuffer !== 'function') { console.error('PMTilesReader 加载失败'); process.exit(1); }

// ---------- 最小 protobuf / MVT 解析（与 inspect-pmtiles.mjs 同源） ----------
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
function parseLayerMeta(buf) {
  const L = { name: '', nFeat: 0, types: [0, 0, 0, 0] };
  for (const f of fields(buf, 0, buf.length)) {
    if (f.field === 1 && f.wire === 2) L.name = Buffer.from(f.buf).toString('utf8');
    if (f.field === 2 && f.wire === 2) {
      L.nFeat++;
      // Feature: field 3 = GeomType (0 UNKNOWN,1 POINT,2 LINESTRING,3 POLYGON)
      let gt = 0;
      for (const ff of fields(f.buf, 0, f.buf.length)) if (ff.field === 3 && ff.wire === 0) gt = ff.v;
      L.types[gt] = (L.types[gt] || 0) + 1;
    }
  }
  return L;
}
function parseTile(buf) {
  const layers = [];
  for (const f of fields(buf, 0, buf.length)) if (f.field === 3 && f.wire === 2) layers.push(parseLayerMeta(f.buf));
  return layers;
}
function decompress(d) {
  const b = Buffer.from(d);
  if (b[0] === 0x1f && b[1] === 0x8b) return zlib.gunzipSync(b);
  return b;
}
function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const x = Math.floor((lon + 180) / 360 * n);
  const lr = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2 * n);
  return { x, y };
}

// ---------- 主流程 ----------
const [cityArg, lonArg, latArg, z0Arg, z1Arg] = process.argv.slice(2);
if (!cityArg) { console.error('用法: tile-level-stats.mjs <城市名|文件路径.pmtiles> <lon> <lat> [zmin] [zmax]'); process.exit(1); }
let name, v, pmtPath;
if (/\.pmtiles$/i.test(cityArg)) {
  pmtPath = path.resolve(cityArg);
  name = path.basename(pmtPath);
  v = { file: name, minz: 11, maxz: 15 };
} else {
  const manifest = JSON.parse(fs.readFileSync(path.join(PMT_DIR, 'manifest.json'), 'utf8'));
  const hit = Object.entries(manifest).find(([n, x]) => n.includes(cityArg) && x.ok && x.bbox);
  if (!hit) { console.error('manifest 里没有该城市: ' + cityArg); process.exit(1); }
  name = hit[0]; v = hit[1];
  pmtPath = path.join(PMT_DIR, v.file.replace(/^.*\//, ''));
}
const lon = +lonArg, lat = +latArg;
const zMin = z0Arg ? +z0Arg : (v.minz || 11), zMax = z1Arg ? +z1Arg : (v.maxz || 15);
const r = READER.fromBuffer(new Uint8Array(fs.readFileSync(pmtPath)));

console.log(`城市 ${name}  文件声明的 z 区间 = ${v.minz}..${v.maxz}  探针点 ${lon},${lat}`);
console.log('z\ttile\tbytes\t' + '层级(点/线/面)');
for (let z = zMin; z <= zMax; z++) {
  const { x, y } = lonLatToTile(lon, lat, z);
  const t = await r.getTile(z, x, y);
  if (!t || !t.length) { console.log(`${z}\t${x},${y}\t0\t<空瓦片>`); continue; }
  let layers = [];
  try { layers = parseTile(decompress(t)); } catch (e) { console.log(`${z}\t${x},${y}\t${t.length}\t解析失败 ${e.message}`); continue; }
  const per = layers.map((L) => `${L.name}:${L.nFeat}`).join(' ');
  const tot = layers.reduce((a, L) => a + L.nFeat, 0);
  const pt = layers.reduce((a, L) => a + (L.types[1] || 0), 0);
  const ln = layers.reduce((a, L) => a + (L.types[2] || 0), 0);
  const pg = layers.reduce((a, L) => a + (L.types[3] || 0), 0);
  console.log(`${z}\t${x},${y}\t${t.length}\t总${tot}(点${pt}/线${ln}/面${pg})  ${per}`);
}
