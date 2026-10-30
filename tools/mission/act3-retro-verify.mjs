/**
 * 第三幕逆行接续性数值对撞（2026-10-23）
 * 复刻 src/rocket.js 的 makeBrakeEllipse / circleLL / LOI_RETRO 逻辑，验证：
 *   ① 制动椭圆逆行到近月点（th=−3π）的位置 ≡ 巡航起点 circlePosAt(F0)（位置接续）
 *   ② 椭圆到达近月点的运动方向（纬度趋势）≡ 巡航段 f 递减方向（方向接续）
 *   ③ 巡航终点 f(1) ≡ f0（下降起点接续）；全程 f 单调递减（真逆行）
 *   ④ 对比旧版 F0=fP+0.012 / fEnd=2F0−f0−2 的断差
 */
const MOON_R = 1737400;
const R = 1737400;                       // MOON_ELLIPSOID.maximumRadius 近似
const site = { lon: -30.7, lat: 44.0 };  // imbrium 量级
const LOI_RETRO = -1;

// —— makeBrakeEllipse（复刻）——
const ra = R + 800000, rp = R + 100000;
const a = (ra + rp) / 2, b = Math.sqrt(ra * rp), c = (ra - rp) / 2;
const lonR = site.lon * Math.PI / 180;
const Lx = Math.cos(lonR), Ly = Math.sin(lonR);
const laR = (site.lat - 120) * Math.PI / 180;
const ca = Math.cos(laR), sa = Math.sin(laR);
function ellipseAt(th) {
  const k = c + a * Math.cos(th), m = b * Math.sin(th);
  const X = k * ca - m * sa, Z = k * sa + m * ca;   // 子午面内（径向, 自转轴）
  const lat = Math.atan2(Z, Math.hypot(X * Lx, X * Ly)) * 180 / Math.PI;
  const lon = Math.atan2(X * Ly, X * Lx) * 180 / Math.PI;
  const r = Math.hypot(k, m);
  return { lat, lon: ((lon + 180) % 360 + 360) % 360 - 180, r };
}
// —— circleLL（复刻）——
function circleLL(frac) {
  const la = -90 + (((frac % 1) + 1) % 1) * 360;
  return la > 90
    ? { lon: (((site.lon + 180 + 180) % 360 + 360) % 360 - 180), lat: 180 - la }
    : { lon: site.lon, lat: la };
}

const f0 = (site.lat - 40 + 90) / 360;
const fP = (site.lat + 60 + 90) / 360;
const F0 = fP + LOI_RETRO * 0.012;
const fEnd = LOI_RETRO > 0 ? f0 + 2 : 2 * F0 - f0 + 1;

console.log('== 参数 ==');
console.log('f0(下降起点 la=%.1f) =%.4f  fP(近月点 la=%.1f) =%.4f  F0=%.4f  fEnd=%.4f', site.lat - 40, f0, site.lat + 60, fP, F0, fEnd);

// ① 位置接续：椭圆 th=−3π（逆行终点）vs 圆 fP（制动段点火起点，s=0.82 处的接续点）
const eEnd = ellipseAt(LOI_RETRO * 3 * Math.PI);
const cStart = circleLL(fP);
console.log('\n== ① 位置接续（椭圆→点火段接续点 s=0.82） ==');
console.log('椭圆终点   : lat=%.2f lon=%.2f r=%.0f km', eEnd.lat, eEnd.lon, eEnd.r / 1000);
console.log('圆 fP(点火起点): lat=%.2f lon=%.2f r=%.0f km', cStart.lat, cStart.lon, (R + 100000) / 1000);
console.log('纬度差 = %.4f°（<0.01 即接续）', Math.abs(eEnd.lat - cStart.lat));
// 附带：点火段终点 F0 与巡航起点本就同值（设计如此），只报滑动量
console.log('点火段沿圆滑动 %.2f°（fP→F0，逆行）', Math.abs(F0 - fP) * 360);

// ② 方向接续：椭圆过近月点的纬度趋势 vs 巡航 f 递减的纬度趋势
const eps = 1e-4;
const eBefore = ellipseAt(LOI_RETRO * 3 * Math.PI - eps), eAfter = ellipseAt(LOI_RETRO * 3 * Math.PI + eps);
// th 递减（逆行）：时间前进 = th 减小 → 从 eBefore(th 大) 到 eAfter(th 小)？不：逆行时 th 从 0→−3π，
// 时间前进 th 减小，故「前」= th+eps，「后」= th−eps
const ellDir = eBefore.lat - eAfter.lat;             // >0 = 纬度上升（北）
const cBefore = circleLL(F0 - LOI_RETRO * 1e-4), cAfter = circleLL(F0 + LOI_RETRO * 1e-4);
// 逆行 f 递减：前 = F0+ε（沿运动方向的前方是 f 更小处 → 前方 = F0−ε）
const cirDir = circleLL(F0 - 2e-4).lat - circleLL(F0).lat;   // >0 = 北
console.log('\n== ② 方向接续（近月点处） ==');
console.log('椭圆到达方向: %s（lat %.4f → %.4f）', ellDir > 0 ? '北 ↑' : '南 ↓', eAfter.lat, eBefore.lat);
console.log('巡航出发方向: %s（lat %.4f → %.4f）', cirDir > 0 ? '北 ↑' : '南 ↓', circleLL(F0).lat, circleLL(F0 - 2e-4).lat);
console.log('方向一致:', (ellDir > 0) === (cirDir > 0) ? '✓' : '✗ 断接！');

// ③ 巡航终点 ≡ f0 + 全程单调
const f1 = F0 + LOI_RETRO * (fEnd - F0);
console.log('\n== ③ 巡航终点 / 单调性 ==');
console.log('f(1) =%.6f  f0+2 =%.6f  f0 =%.6f  → 终点≡f0(mod1): %s', f1, f0 + 2, f0, Math.abs(((f1 - f0) % 1 + 1) % 1) < 1e-9 || Math.abs(((f1 - f0) % 1 + 1) % 1 - 1) < 1e-9 ? '✓' : '✗');
let mono = true, prev = F0;
for (let i = 1; i <= 100; i++) {
  const sC = i / 100, f = F0 + LOI_RETRO * (fEnd - F0) * sC;
  if (LOI_RETRO < 0 ? f > prev + 1e-12 : f < prev - 1e-12) mono = false;
  prev = f;
}
console.log('全程 f 单调递减（逆行）:', mono ? '✓' : '✗');
console.log('逆行圈数 = %.3f', Math.abs(fEnd - F0));

// ④ 旧版对照
const F0old = fP + 0.012, fEndOld = 2 * F0old - f0 - 2;
console.log('\n== ④ 旧版（2026-10-23）断差 ==');
console.log('旧 F0=%.4f vs 点火终点 fP%+.4f=%.4f → 跳差 %.4f（%.1f°）', F0old, LOI_RETRO * 0.012, fP + LOI_RETRO * 0.012, Math.abs(F0old - (fP + LOI_RETRO * 0.012)), Math.abs(F0old - (fP + LOI_RETRO * 0.012)) * 360);
const f1old = F0old + LOI_RETRO * (fEndOld - F0old);
console.log('旧 f(1)=%.4f（应≡f0=%.4f）：%s；旧 fEnd=%.4f < F0 → 实际顺行 %.3f 圈（根本没逆行）', f1old, f0, Math.abs(((f1old - f0) % 1 + 1) % 1) < 1e-9 || Math.abs(((f1old - f0) % 1 + 1) % 1 - 1) < 1e-9 ? '终点对但方向错' : '终点也错', fEndOld, Math.abs(fEndOld - F0old));
