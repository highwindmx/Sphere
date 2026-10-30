// tools/add_provenance_headers.mjs — 给图层数据文件补统一坐标系/精度/来源文件头
// 用法: node tools/add_provenance_headers.mjs   （幂等，已处理过的会跳过）
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const layersDir = join(__dirname, '..', '..', 'src', 'layers');

const HEADER = `// 坐标系: WGS84 (EPSG:4326)，十进制度，坐标顺序统一为 [经度 lon, 纬度 lat]。
//   渲染端由 Cesium.Cartesian3.fromDegrees(lon, lat) / fromDegreesArray 直接使用，无需额外转换。
// 数据性质: 教学示意级。城市/地点坐标为近似位置（精度约市级 ±1–5 km）；
//           历史疆域/路线为简化示意，非考据级边界，仅供空间认知。
// 来源: 编译自公开地理资料与通史常识，非测绘权威数据；用于科普与家庭教育。
`;

const OLD = '// Auto-rebuilt from extracted-layers.json — DO NOT HAND-EDIT';
const MARK = '// 坐标系: WGS84';

let files = readdirSync(layersDir).filter(f => f.endsWith('.js') && f !== 'index.js');
let done = 0, skipped = 0;
for (const f of files) {
  const p = join(layersDir, f);
  let src = readFileSync(p, 'utf8');
  if (src.includes(MARK)) { skipped++; continue; }
  if (src.startsWith(OLD)) {
    src = HEADER + '\n' + src.slice(OLD.length).replace(/^\r?\n/, '');
  } else {
    src = HEADER + '\n' + src;
  }
  writeFileSync(p, src, 'utf8');
  done++;
}
console.log(`已补文件头: ${done}  已存在跳过: ${skipped}  共: ${files.length}`);
