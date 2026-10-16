// tools/validate_layers.mjs — 标注数据坐标系/合法性校验（dev 工具）
// 用法: node tools/validate_layers.mjs
// 目的: 抓出 (a) 经纬度越界 (b) 疑似 lon/lat 颠倒 (c) 中国语境图层落点漂出中国 bbox
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const layersDir = join(__dirname, '..', 'src', 'layers');

const CHINA = { w: 73, s: 3, e: 135, n: 54 }; // 中国大陆大致范围
// 这些图层含全球/远洋点，不套中国 bbox 校验
const GLOBAL_OK = new Set(['zhenghe', 'ageofsail', 'rome', 'crusades', 'mongol',
  'alexander', 'wwars', 'civilizations', 'heritage', 'wonders', 'worldocean',
  'currents', 'plates', 'geolines', 'tiangong', 'moonmission',
  'worldcapitals', 'peaks', 'worldrivers']);

let files = readdirSync(layersDir).filter(f => f.endsWith('.js') && f !== 'index.js');
let totalPoints = 0, totalLines = 0, totalPolys = 0;
const errors = [];
const warnings = [];

for (const f of files) {
  const mod = await import(pathToFileURL(join(layersDir, f)).href);
  const L = mod.LAYER;
  if (!L) continue;
  const ctx = L.id;
  for (const g of (L.groups || [])) {
    for (const ent of (g.entities || [])) {
      if (ent.type === 'point' || ent.type === 'label') {
        totalPoints++;
        const { lon, lat } = ent;
        if (typeof lon !== 'number' || typeof lat !== 'number') {
          errors.push(`${f} [${ent.name}] 缺 lon/lat`);
          continue;
        }
        if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
          errors.push(`${f} [${ent.name}] 越界 lon=${lon} lat=${lat}`);
        }
        if (!GLOBAL_OK.has(ctx) && (lon < CHINA.w || lon > CHINA.e || lat < CHINA.s || lat > CHINA.n)) {
          warnings.push(`${f} [${ent.name}] 漂出中国 bbox lon=${lon} lat=${lat}`);
        }
      } else if (ent.type === 'polyline' || ent.type === 'polygon') {
        totalPolys++;
        for (const [lon, lat] of (ent.coords || [])) {
          if (typeof lon !== 'number' || typeof lat !== 'number') {
            errors.push(`${f} [${ent.name}] coords 非数值`);
          } else if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
            errors.push(`${f} [${ent.name}] coords 越界 lon=${lon} lat=${lat}`);
          }
        }
      }
    }
  }
}

console.log(`图层文件: ${files.length}`);
console.log(`点/标注实体: ${totalPoints}  线/面实体: ${totalPolys}`);
console.log(`错误(越界/缺值): ${errors.length}`);
errors.forEach(e => console.log('  ✗ ' + e));
console.log(`警告(中国语境漂出 bbox, 需人工核对): ${warnings.length}`);
warnings.slice(0, 40).forEach(w => console.log('  ⚠ ' + w));
if (warnings.length > 40) console.log(`  ... 其余 ${warnings.length - 40} 条略`);
console.log(errors.length === 0 ? '\n✅ 无坐标越界错误' : '\n❌ 存在坐标错误，见上');
