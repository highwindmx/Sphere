// 独立复核：「捕获前飞船比月球公转慢 ⇒ 之后没法继续减速？」这条质疑成不成立
// 只用二体天体力学 + rocket.js 的真实常量（MU/MU_M/CH_CAPTURE），不引用任何旧注释/记忆
const MU_E = 398600.4418, MU_M = 4902.8;
const rE = 6378.137, moonDist = 384400, moonR = 1737.4, moonPeriod = 27.321661;

const f = (x, n = 4) => x.toFixed(n).padStart(9);
const sgn = (x) => (x > 0 ? '+' : x < 0 ? '−' : ' ');

// ---------- 转移轨道（rocket.js: EM.rp = rE+593, EM.ra = 405000）----------
const rp = rE + 593, ra = 405000;
const aT = (rp + ra) / 2, eT = (ra - rp) / (ra + rp);
const hT = Math.sqrt(MU_E * aT * (1 - eT * eT));
const encR = moonDist + 18862;                 // EM.encR：会合点地心距
const vEnc = Math.sqrt(MU_E * (2 / encR - 1 / aT));
const vEncT = hT / encR;                       // 切向分量
const vEncR = Math.sqrt(Math.max(0, vEnc * vEnc - vEncT * vEncT)); // 径向分量（近远地点→很小）
const omega = (2 * Math.PI) / (moonPeriod * 86400);
const vMoon = omega * moonDist;

console.log('══════ 1. 抵达（会合）时刻：飞船 vs 月球 ══════');
console.log(`  会合点地心距 r = ${encR.toFixed(0)} km（月球在 ${moonDist} km，飞船在其外侧 18,862 km）`);
console.log(`  飞船地心速度 v_s/c = ${vEnc.toFixed(4)} km/s（切向 ${vEncT.toFixed(4)}，径向 ${vEncR.toFixed(4)}，方向 +θ 顺公转）`);
console.log(`  月球公转速度 v_moon = ${vMoon.toFixed(4)} km/s（方向 +θ）`);
console.log(`  ⇒ 飞船只有月球的 ${(vEncT / vMoon * 100).toFixed(1)}% ⇒ 月球从后面追上它`);
console.log(`  相对月球 v_rel = ${(vEncT - vMoon).toFixed(4)} km/s（−θ，即相对月球「向后漂」）`);

// ---------- 入站双曲线（相对月球）----------
const rRel0 = 18862;                            // 会合时相对月心的距离
const epsRel = (vEncT - vMoon) ** 2 / 2 - MU_M / rRel0;
const vInf = Math.sqrt(2 * Math.max(0, epsRel));
const CA = [200, 211, 200, 195].map((x, i) => i); // 占位
const CH_CAPTURE = [
  { rp: 200, ra: 18862, name: '地月转移抵达(12h?)' },
  { rp: 211, ra: 8500, name: 'LOI-1 后 12 小时轨道' },
  { rp: 200, ra: 1729, name: 'LOI-2 后 3.5 小时轨道' },
  { rp: 195, ra: 195, name: 'LOI-3 后 127 分钟圆轨道' },
];
const orbits = CH_CAPTURE.map((o) => {
  const R_p = moonR + o.rp, R_a = moonR + o.ra;
  const a = (R_p + R_a) / 2, e = (R_a - R_p) / (R_a + R_p);
  return { ...o, Rp: R_p, Ra: R_a, a, e,
    vPeri: Math.sqrt(MU_M * (2 / R_p - 1 / a)),
    vApo: Math.sqrt(MU_M * (2 / R_a - 1 / a)),
    eps: -MU_M / (2 * a) };
});

console.log('\n══════ 2. 入站双曲线（捕获前，相对月球）══════');
console.log(`  会合点相对速度 ${Math.abs(vEncT - vMoon).toFixed(4)} km/s @ r_rel=${rRel0} km`);
console.log(`  月系比能 ε = ${epsRel.toFixed(4)} km²/s² → ${epsRel > 0 ? '>0 双曲线（未被捕获，会飞走）' : '<0 椭圆'}`);
console.log(`  双曲线超速 v_∞ = ${vInf.toFixed(4)} km/s`);
const vHypApo = Math.sqrt(vInf ** 2 + 2 * MU_M / orbits[0].Ra);
console.log(`  在该椭圆远月点半径(${orbits[0].Ra.toFixed(0)} km)处的入站速度 = ${vHypApo.toFixed(4)} km/s`);

console.log('\n══════ 3. 关键对比：捕获这一下，两个参考系各发生了什么 ══════');
console.log(`  月系（相对月球）：${vHypApo.toFixed(3)} → ${orbits[0].vApo.toFixed(3)} km/s   ⇒ 减速 ${(vHypApo - orbits[0].vApo).toFixed(3)} km/s  ✅ 制动`);
console.log(`  月系比能 ε      ：${epsRel.toFixed(4)} → ${orbits[0].eps.toFixed(4)} km²/s²  ⇒ 由「逃逸」变「束缚」 ✅ 被抓住`);
const vGeoBefore = vMoon + (vEncT - vMoon);               // = vEncT
const vGeoAfterApo = vMoon - orbits[0].vApo;
const vGeoAfterPeri = vMoon + orbits[0].vPeri;
console.log(`  地球系（绕地）  ：${vGeoBefore.toFixed(3)} → 远月点 ${vGeoAfterApo.toFixed(3)} / 近月点 ${vGeoAfterPeri.toFixed(3)} km/s`);
console.log(`  ⇒ 地球系速度 ${vGeoBefore.toFixed(3)} → ${vGeoAfterApo.toFixed(3)} km/s，是【加速】，不是减速！`);
console.log(`  ⇒ 捕获的本质 = 「跟上月球」：飞船从自己慢悠悠的 ${vGeoBefore.toFixed(2)} km/s，变成绕着月球在 ${vMoon.toFixed(2)}±${orbits[0].vPeri.toFixed(2)} km/s 之间摆动（骑在月球身上）。`);

console.log('\n══════ 4. 逐级「减速」发生在月系（首段在远月点制动，之后每次过近月点逆行制动）══════');
// 符号（绕月逆行 CW，即当前代码 CAP_FLIP_Y=+1）：
//   背地远月点 φ=0   → v_rel,θ = −v_apo   ⇒ 地球系 v_θ = v_moon − v_apo
//   向地近月点 φ=π   → v_rel,θ = +v_peri  ⇒ 地球系 v_θ = v_moon + v_peri
console.log('  段  轨道(高度km)      a(km)     月系ε(km²/s²)   v_近月点   v_远月点   地球系v_θ区间(km/s)   制动Δv');
let prevPeriV = vHypApo; // 首段衔接：入站在远月点的速度
orbits.forEach((o, i) => {
  const dv = i === 0 ? vHypApo - o.vApo : prevPeriV - o.vPeri;
  const lo = vMoon - o.vApo, hi = vMoon + o.vPeri;
  const where = i === 0 ? '远月点' : '近月点';
  const flag = lo > 0 ? '全顺 ✓' : '有倒退';
  console.log(`  ${i}  ${(o.rp + '/' + o.ra).padEnd(12)} ${o.a.toFixed(0).padStart(8)}    ${o.eps.toFixed(4).padStart(8)}     ${o.vPeri.toFixed(3)}    ${o.vApo.toFixed(3)}    [${lo.toFixed(2)}, ${hi.toFixed(2)}] ${flag}   ${dv.toFixed(3)}@${where}`);
  prevPeriV = o.vPeri;
});
const totalDv = (vHypApo - orbits[0].vApo) + (orbits[0].vPeri - orbits[1].vPeri) + (orbits[1].vPeri - orbits[2].vPeri) + (orbits[2].vPeri - orbits[3].vPeri);
console.log(`  总制动 Δv ≈ ${totalDv.toFixed(3)} km/s（对照：Apollo LOI 实测约 0.8~1.2 km/s，量级一致 ✅）`);
console.log('  ⇒ 月系比能 ε 单调下降（−0.218 → −1.269）= 逐级真的在「减速/降能量」；');
console.log('  ⇒ 地球系速度却在【上升并展开】（0.20 → 0.82~3.17），因为它在逐步「骑上月球」。');

console.log('\n══════ 5. 质疑的直接回答 ══════');
console.log('  「比月球慢，还怎么继续减速？」→ 被捕获根本不是继续对地减速，而是【对月减速 + 对地加速】。');
console.log(`  飞船对地 ${vEncT.toFixed(3)} km/s，比月球慢 ${(vMoon - vEncT).toFixed(3)} km/s；`);
console.log(`  它必须把对地速度从 ${vEncT.toFixed(3)} 提到 ~${vMoon.toFixed(2)} km/s（与月球同步）才能被月球带着走。`);
console.log(`  这正是 LOI 制动的净效果：对月减 ${(vHypApo - orbits[0].vApo).toFixed(2)} km/s，同时对地加 ${(vGeoAfterApo - vGeoBefore).toFixed(2)} km/s。`);
console.log('  ⇒「比月球慢」恰恰是能被低成本捕获的【前提】：月球从后面追上，飞船落进月球引力井，再刹一下就被抓住了。');

console.log('\n══════ 6. 若强行改成「绕月顺行 CCW」要付多少 Δv ══════');
const need = Math.abs(vEncT - vMoon) * 2;
console.log(`  入站 v_rel = ${(vEncT - vMoon).toFixed(3)} km/s（−θ）。要让绕月变顺行，远月点相对速度须翻成 +θ：`);
console.log(`  ⇒ 需要在会合点额外改变速度 ${need.toFixed(3)} km/s（约 ${(need / 1).toFixed(2)} km/s，比整条捕获序列总 Δv 还大）。`);
console.log(`  且翻向后：近月点地球系 v_θ = ${(vMoon - orbits[0].vPeri).toFixed(3)} km/s → 真的绕地倒飞 ✗（违背「始终顺公转」）。`);

console.log('\n══════ 7. 束缚性检查（首段椭圆是否真被月球抓住）══════');
const hill = moonDist * Math.cbrt(MU_M / MU_E / 3);
console.log(`  月球希尔球半径 ≈ ${hill.toFixed(0)} km；首段远月点 ${orbits[0].Ra.toFixed(0)} km = 希尔球的 ${(orbits[0].Ra / hill * 100).toFixed(0)}%  ✅ 在束缚范围内`);
console.log(`  ⚠ 希尔球内「地球二体能量」无意义：近月点对地速度 ${vGeoAfterPeri.toFixed(2)} km/s 虽 > 当地逃逸速度 ${Math.sqrt(2 * MU_E / (moonDist - orbits[0].Rp)).toFixed(2)} km/s，但那是月球主导区，不代表逃逸地球。`);
