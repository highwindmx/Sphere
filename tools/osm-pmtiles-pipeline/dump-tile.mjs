/*
 * tools/osm-pmtiles-pipeline/dump-tile.mjs
 *
 * 从离线 PMTiles 里导出**一块原始 MVT 字节**到磁盘，用于交叉验证：
 * 当怀疑「离线看不到街道名/楼高」是数据侧（MVT 属性编码）问题时，
 * 把瓦片导出给**独立实现**的解析器（Python mapbox_vector_tile）解一遍，
 * 就能分清是「我们写错了」还是「我们读错了」。
 *
 * 用法：
 *   node tools/osm-pmtiles-pipeline/dump-tile.mjs 米兰 15            // 中心瓦片 → 系统 TEMP
 *   node tools/osm-pmtiles-pipeline/dump-tile.mjs 米兰 15 17406 11924 out.mvt
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PMT_DIR = path.join(ROOT, 'public', 'data', 'osm', 'pmtiles');
const _mod = require(path.join(ROOT, 'public', 'vendor', 'pmtiles-reader.js'));
const READER = (_mod && typeof _mod.fromBuffer === 'function') ? _mod : globalThis.PMTilesReader;

const [cityName, zArg, xArg, yArg, outArg] = process.argv.slice(2);
if (!cityName || !zArg) { console.error('用法: dump-tile.mjs <城市名> <z> [x] [y] [输出路径]'); process.exit(1); }
const manifest = JSON.parse(fs.readFileSync(path.join(PMT_DIR, 'manifest.json'), 'utf8'));
const hit = Object.entries(manifest).find(([n, v]) => n.includes(cityName) && v.ok && v.bbox);
if (!hit) { console.error('manifest 里没有该城市: ' + cityName); process.exit(1); }
const [name, v] = hit;
const file = v.file.replace(/^.*\//, '');
const r = READER.fromBuffer(new Uint8Array(fs.readFileSync(path.join(PMT_DIR, file))));
const z = +zArg;
let x = xArg ? +xArg : null, y = yArg ? +yArg : null;
if (x == null) {
  const clng = v.center ? v.center[0] : (v.bbox[0] + v.bbox[2]) / 2;
  const clat = v.center ? v.center[1] : (v.bbox[1] + v.bbox[3]) / 2;
  const n = 2 ** z;
  x = Math.floor((clng + 180) / 360 * n);
  const lr = clat * Math.PI / 180;
  y = Math.floor((1 - Math.log(Math.tan(lr) + 1 / Math.cos(lr)) / Math.PI) / 2 * n);
}
const tile = await r.getTile(z, x, y);
const out = outArg ? path.resolve(outArg) : path.join(os.tmpdir(), `tile-${name}-${z}-${x}-${y}.mvt`);
if (!tile) { console.error(`瓦片为空: z=${z} x=${x} y=${y}`); process.exit(2); }
fs.writeFileSync(out, Buffer.from(tile));
console.log(out);
console.log(`z=${z} x=${x} y=${y}  bytes=${tile.length}`);
