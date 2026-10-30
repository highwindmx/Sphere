// 用「嫦娥一号官方实测数据」反推抵达运动学，与 rocket.js 代码几何对撞
// 官方数据（国防科工委 2007-11-05/07 发布会、术语解读、央视/中新社报道）：
//   转移轨道：近地点 593 km、远地点 405,000 km、飞行 114 h
//   11/05 11:15 首达近月点(200km)，速度 2.4 km/s → 制动至 2.06 km/s，入 12h 椭圆(近月点210/远月点8600)
//   11/06 → 1.8 km/s，3.5h(远月点1700)；11/07 → 1.59 km/s，127min、200km 圆极轨(倾角 90.2°)
//   三次制动「相对月球速度共减小约 848 m/s」
const MU_E = 398600.4418, MU_M = 4902.8;
const moonDist = 384400, moonR = 1737.4, moonPeriod = 27.321661;
const omega = (2 * Math.PI) / (moonPeriod * 86400);
const vMoon = omega * moonDist;

console.log('══════ 1. 用嫦娥一号实测「近月点 2.4 km/s」反推抵达的 v_∞ ══════');
const rPeri1 = moonR + 200;                       // 首次制动点：距月心 1,937.4 km
const vAtPeri = 2.4;                              // 官方：制动前速度
const vInf = Math.sqrt(vAtPeri ** 2 - 2 * MU_M / rPeri1);
console.log(`  月心距 ${rPeri1.toFixed(1)} km 处速度 ${vAtPeri} km/s（官方实测）`);
console.log(`  ⇒ v_∞ = √(v² − 2μ_M/r) = ${vInf.toFixed(4)} km/s   【这就是嫦娥抵达月球时的相对速度】`);

console.log('\n══════ 2. 与代码几何对撞 ══════');
const rp = 6378.137 + 593, ra = 405000;           // 代码 EM.rp / EM.ra = 嫦娥转移轨道
const aT = (rp + ra) / 2, eT = (ra - rp) / (ra + rp);
const hT = Math.sqrt(MU_E * aT * (1 - eT * eT));
const encR = moonDist + 18862;
const vEnc = Math.sqrt(MU_E * (2 / encR - 1 / aT));
const vEncT = hT / encR;
const vEncR = Math.sqrt(Math.max(0, vEnc ** 2 - vEncT ** 2));
const vRelCode = Math.hypot(vEncT - vMoon, vEncR);
console.log(`  代码：会合点地心速度 ${vEnc.toFixed(4)}（切向 ${vEncT.toFixed(4)}，径向 ${vEncR.toFixed(4)}）`);
console.log(`  代码：相对月球速度 ${vRelCode.toFixed(4)} km/s`);
console.log(`  嫦娥实测反推 v_∞   ${vInf.toFixed(4)} km/s`);
console.log(`  ⇒ 偏差 ${(Math.abs(vRelCode - vInf) / vInf * 100).toFixed(1)}%  → ${Math.abs(vRelCode - vInf) / vInf < 0.05 ? '✅ 一致' : '⚠ 不一致'}`);

console.log('\n══════ 3. 「比月球慢」是数学必然，不是代码选的 ══════');
const vEscAtMoon = Math.sqrt(2 * MU_E / moonDist);
const vEscAtEnc = Math.sqrt(2 * MU_E / encR);
console.log(`  月球公转速度                     ${vMoon.toFixed(4)} km/s`);
console.log(`  当地逃逸速度(地心距 ${moonDist})  ${vEscAtMoon.toFixed(4)} km/s`);
console.log(`  若飞船「比月球快」同样的 ${vInf.toFixed(2)} km/s ⇒ 地心速度 ${(vMoon + vInf).toFixed(3)} km/s`);
console.log(`    vs 当地逃逸速度 ${vEscAtMoon.toFixed(3)} → ${vMoon + vInf > vEscAtMoon ? '【超过逃逸速度 ⇒ 双曲线飞离地球，根本不是地月转移轨道】✗' : '可能'}`);
console.log(`  实际：飞船地心速度 ${vEnc.toFixed(3)} km/s < 逃逸 ${vEscAtEnc.toFixed(3)} km/s ✅ 束缚`);
const aMax = ra / 2;                              // 远地点恰在 405,000 时的最小 a（rp→0 极限）
const vApoMax = Math.sqrt(MU_E * (2 / ra - 1 / ra)); // a=ra（圆轨道）⇒ 远地点速度上限
console.log(`  更严格：远地点恰在 405,000 km 的绕地束缚椭圆，远地点速度上限 = ${vApoMax.toFixed(4)} km/s（a→ra 即圆轨道）`);
console.log(`    → ${vApoMax.toFixed(4)} < ${vMoon.toFixed(4)} ⇒ 只要远地点在月球距离，飞船必然比月球慢。`);

console.log('\n══════ 4. 「0.202 < 1.023 就飞不过月球下方？」——两个参考系的量在混比 ══════');
const R_apo = moonR + 18862;                      // 代码首段椭圆远月点（月心距 20,599 km）
const R_per = moonR + 200;
const aC = (R_apo + R_per) / 2;
const vApoC = Math.sqrt(MU_M * (2 / R_apo - 1 / aC));
const vPerC = Math.sqrt(MU_M * (2 / R_per - 1 / aC));
const epsC = -MU_M / (2 * aC);
const gMoonAtApo = MU_M / R_apo ** 2;             // 远月点处月球引力加速度
const aTransport = vMoon ** 2 / moonDist;         // 月心系（非惯性）牵连加速度 = 月球绕地向心加速度
console.log(`  月系：远月点 ${vApoC.toFixed(3)} km/s，比能 ε = ${epsC.toFixed(4)} km²/s² → ${epsC < 0 ? '<0 闭合椭圆 ⇒ 必然绕回，不需要"追上月球"' : '>0'}`);
console.log(`  判据A 引力主导：月球引力 ${gMoonAtApo.toExponential(3)} km/s² vs 月心系牵连加速度 ${aTransport.toExponential(3)} km/s²`);
console.log(`          比值 = ${(gMoonAtApo / aTransport).toFixed(2)}× → 月球引力牢牢主导 ✅`);
console.log(`  判据B 地球系看全过程（绕过去的样子）：`);
console.log(`          远月点(背地) 地心 v_θ = ${(vMoon - vApoC).toFixed(3)} km/s  → 比月球慢 ${vApoC.toFixed(3)} ⇒ 相对月球「往后飘」`);
console.log(`          近月点(向地) 地心 v_θ = ${(vMoon + vPerC).toFixed(3)} km/s  → 比月球快 ${vPerC.toFixed(3)} ⇒ 「往前冲」`);
console.log(`          一整圈净漂移 = 0 ⇒ 它绕着月球打了个结，这就是「飞过月球下方」。`);
console.log(`  ⚠ 在月系里月球是静止的，根本不存在「1.023 km/s」这个数；把它和月系的 0.202 相比，是两个参考系混着比。`);

console.log('\n══════ 5. 代码的抵达分段 vs 嫦娥实测剖面（诚实缺口）══════');
const dvCode = 0.611 + 0.095 + 0.254 + 0.209;
const dvReal = 2.4 - 2.06 + (2.06 - 1.8) + (1.8 - 1.59);
console.log(`  嫦娥实测：双曲线直飞到 200km 近月点 → 一次制动 2.4→2.06（Δv=${(2.4 - 2.06).toFixed(2)}）`);
console.log(`            → 1.8（${(2.06 - 1.8).toFixed(2)}）→ 1.59（${(1.8 - 1.59).toFixed(2)}）；官方总减速 ≈ 0.848 km/s`);
console.log(`            （2.4 − 1.59 = ${(2.4 - 1.59).toFixed(3)} km/s，与官方 0.848 吻合 ✅）`);
console.log(`  代码路径：远月点(20,599)捕获制动 0.611 → 半圈 → 近月点 0.095 → 0.254 → 0.209；总 ${dvCode.toFixed(3)} km/s`);
console.log(`  ⇒ 代码总 Δv ${dvCode.toFixed(2)} km/s，比嫦娥实测 ${dvReal.toFixed(2)} km/s 多 ${(dvCode - dvReal).toFixed(2)} km/s：`);
console.log(`     代码把「入站双曲线」换成了「远月点直接接大椭圆」，省掉了那段俯冲，代价是多一次 0.61 km/s 的捕获制动。`);
console.log(`     方向/束缚性都正确，但 Δv 预算与嫦娥实测不吻合。**要不要改成嫦娥实测剖面（双曲线入站 + 近月点一次制动）由用户定。**`);
console.log(`  ⚠ 另：嫦娥一号最终是 200 km、倾角 90.2° 的**极轨**；代码画的是轨道面内的平面轨道，属 2D 简化。`);
