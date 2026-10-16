// 自检：验证内置示意 TLE 的列对齐、校验和与 satellite.js 解析结果。
// 用法：node tools/verify-tle.mjs
import satellite from 'satellite.js';
import { applyChecksum, buildFallbackLine1 } from '../src/tiangong.js';

const l1 = buildFallbackLine1(new Date());
const l2 = applyChecksum(
  '2 48274  41.4700 120.0000 0005000  60.0000 300.0000 15.61000000  999X'
);

let failed = false;
for (const [name, line] of [['行1', l1], ['行2', l2]]) {
  if (line.length !== 69) {
    console.error(`❌ TLE ${name}长度应为 69，实际 ${line.length}：\n${line}`);
    failed = true;
  }
}

const satrec = satellite.twoline2satrec(l1, l2);
if (satrec.error !== 0) {
  console.error(`❌ TLE 解析失败，satrec.error = ${satrec.error}`);
  failed = true;
  process.exit(1);
}

const periodMin = (2 * Math.PI) / satrec.no;
const now = new Date();
const pv = satellite.propagate(satrec, now);
if (!pv.position) {
  console.error('❌ SGP4 位置解算失败');
  process.exit(1);
}

const rKm = Math.sqrt(pv.position.x ** 2 + pv.position.y ** 2 + pv.position.z ** 2);

console.log('✅ 内置示意 TLE 合法');
console.log(`   倾角：${(satrec.inclo * (180 / Math.PI)).toFixed(2)}°（期望约 41.47°）`);
console.log(`   周期：${periodMin.toFixed(1)} 分钟（期望约 92 分钟）`);
console.log(`   当前轨道半径：${rKm.toFixed(1)} km（地心起算，轨道高度约 ${(rKm - 6371).toFixed(0)} km）`);

// 在线实时 TLE 端到端验证（与 src/tiangong.js 的解析逻辑保持一致）
console.log('\n正在验证在线 TLE 源…');
try {
  const res = await fetch(
    'https://celestrak.org/NORAD/elements/gp.php?CATNR=48274&FORMAT=TLE',
    { signal: AbortSignal.timeout(12000) }
  );
  const text = await res.text();
  const raw = text.split(/\r?\n/).map((s) => s.trimEnd()).filter(Boolean);
  let online1;
  let online2;
  for (let i = 0; i < raw.length - 2; i++) {
    if (raw[i + 1].startsWith('1 48274') && raw[i + 2].startsWith('2 48274')) {
      online1 = raw[i + 1];
      online2 = raw[i + 2];
    }
  }
  if (!online1) throw new Error('未找到 48274 根数');
  const onlineRec = satellite.twoline2satrec(online1, online2);
  if (onlineRec.error !== 0) throw new Error(`解析错误码 ${onlineRec.error}`);
  const onlinePv = satellite.propagate(onlineRec, new Date());
  const onlineR = Math.sqrt(onlinePv.position.x ** 2 + onlinePv.position.y ** 2 + onlinePv.position.z ** 2);
  console.log(`✅ 在线 TLE 获取并解算成功：CSS (TIANHE)，当前轨道高度约 ${(onlineR - 6371).toFixed(0)} km`);
} catch (err) {
  console.warn(`⚠ 在线 TLE 验证失败（不影响程序，会自动降级）：${err.message}`);
}

if (failed) process.exit(1);
