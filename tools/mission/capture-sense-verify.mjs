// 独立复核：霍曼转移抵达月球时「顺行/逆行」到底如何判定
// 只用基本天体力学 + rocket.js 的真实常量，不引用任何旧注释/记忆
const MU_E = 398600.4418, MU_M = 4902.8;
const rE = 6378.137, moonDist = 384400, moonR = 1737.4, moonPeriod = 27.321661;

// ---- rocket.js 真实常量 ----
const rp = rE + 593, ra = 405000;            // EM.rp / EM.ra（嫦娥一号转移轨道）
const a  = (rp + ra) / 2, e = (ra - rp) / (ra + rp);
const h  = Math.sqrt(MU_E * a * (1 - e * e)); // 转移椭圆角动量 km²/s
const v_apo = h / ra;                          // 远地点速度（纯切向）
const omega = (2 * Math.PI) / (moonPeriod * 86400);
const v_moon = omega * moonDist;
const v_rel_arr = v_apo - v_moon;              // 抵达时「相对月球」的切向速度（+θ = 顺公转）

console.log('======== 1. 抵达时刻（月球追上飞船）========');
console.log(`转移远地点速度 v_apogee = ${v_apo.toFixed(4)} km/s  (方向 +θ，顺公转)`);
console.log(`月球公转速度   v_moon   = ${v_moon.toFixed(4)} km/s  (方向 +θ)`);
console.log(`相对月球切向  v_rel    = ${v_rel_arr.toFixed(4)} km/s  → ${v_rel_arr < 0 ? '−θ（逆着月球公转方向漂移，月球从后面追上）' : '+θ'}`);
console.log(`比值 |v_rel|/v_moon    = ${(Math.abs(v_rel_arr) / v_moon).toFixed(3)}  （NASA TN D-1081: 抵达速度沿 −(ω×r) 方向）`);

// ---- 硬上限：从 LEO 近地点出发，月球距离处切向速度不可能超过多少 ----
const v_esc_p = Math.sqrt(2 * MU_E / rp);
const h_max = rp * v_esc_p;
console.log('\n======== 2. 硬上限（角动量守恒，不可绕过）========');
console.log(`近地点逃逸速度 ${v_esc_p.toFixed(2)} km/s → 最大角动量 h_max = ${(h_max / 1e3).toFixed(1)}e3 km²/s`);
console.log(`⇒ 月球距离处切向速度上限 ${(h_max / moonDist).toFixed(4)} km/s  <  月球公转 ${v_moon.toFixed(4)} km/s`);
console.log('⇒ 结论：任何从 LEO 出发的霍曼转移，抵达时相对月球必然是「被追上」，v_rel 恒为 −θ。');

// ---- 捕获轨道两条可能走向 ----
const CA0 = { rp: moonR + 200, ra: moonR + 18862 };  // CH_CAPTURE[0]
const aC = (CA0.rp + CA0.ra) / 2;
const v_apoC = Math.sqrt(MU_M * (2 / CA0.ra - 1 / aC));
const v_perC = Math.sqrt(MU_M * (2 / CA0.rp - 1 / aC));
const v_circ195 = Math.sqrt(MU_M / (moonR + 195));

console.log('\n======== 3. 捕获首段椭圆（远月点 20,599 / 近月点 1,937 km）========');
console.log(`远月点速度 ${v_apoC.toFixed(3)} km/s   近月点速度 ${v_perC.toFixed(3)} km/s`);
console.log(`末段 195km 圆轨道速度 ${v_circ195.toFixed(3)} km/s   vs 月球公转 ${v_moon.toFixed(3)} km/s`);

// 严格用极坐标推导，不拍脑袋定符号：
//   位置 = r(cosφ·r̂ + sinφ·θ̂)，φ 自「背地方向(+r̂)」朝 +θ̂ 起算；φ̇ = L_z/r²
//   ⇒ v_θ = ṙ·sinφ + r·φ̇·cosφ ；在拱点 ṙ=0 ⇒ v_θ = (L_z/r)·cosφ
//   背地远月点 φ=0   ⇒ v_θ = +L_z/r_apo
//   向地近月点 φ=π   ⇒ v_θ = −L_z/r_peri
const Lz = Math.sqrt(MU_M * (CA0.rp * CA0.ra * 2 / (CA0.rp + CA0.ra)) * 1) ; // 占位，下面重算
const p = 2 * CA0.rp * CA0.ra / (CA0.rp + CA0.ra);          // 半通径
const eC = (CA0.ra - CA0.rp) / (CA0.ra + CA0.rp);
const Lmag = Math.sqrt(MU_M * p);                            // |角动量|
/** 绕月轨道面内、给定 φ 处的相对月球切向速度（sgn=+1 顺行 CCW / −1 逆行 CW） */
function vRelTheta(sgn, phi) {
  const c = Math.cos(phi);
  const r = p / (1 - eC * c);       // 远月点在 φ=0
  return sgn * Lmag * c / r;
}
function scanSense(sgn) {
  let minE = Infinity, maxE = -Infinity, minAt = 0;
  for (let i = 0; i <= 720; i++) {
    const phi = (i / 720) * Math.PI * 2;
    const vE = v_moon + vRelTheta(sgn, phi);
    if (vE < minE) { minE = vE; minAt = phi; }
    if (vE > maxE) maxE = vE;
  }
  const backSide = v_moon + vRelTheta(sgn, 0);    // 背地远月点
  const nearPeri = v_moon + vRelTheta(sgn, Math.PI); // 向地近月点
  console.log(`\n--- 绕月${sgn < 0 ? '逆行 CW（当前代码）' : '顺行 CCW（你建议的改法）'} ---`);
  console.log(`  背地远月点 地球系 v_θ = ${backSide.toFixed(3)} km/s → ${backSide > 0 ? '顺公转 ✓' : '逆公转 ✗（绕地反向）'}`);
  console.log(`  向地近月点 地球系 v_θ = ${nearPeri.toFixed(3)} km/s → ${nearPeri > 0 ? '顺公转 ✓' : '逆公转 ✗（绕地反向）'}`);
  console.log(`  整圈地球系 v_θ 区间 = [${minE.toFixed(3)}, ${maxE.toFixed(3)}] km/s`);
  console.log(`  ⇒ 整圈${minE > 0 ? '全部顺公转 ✓' : '有 ' + (minAt * 180 / Math.PI).toFixed(0) + '° 附近出现绕地逆行 ✗'}`);
  return minE;
}
console.log('\n======== 4. 两种绕月走向 → 地球系是否始终顺公转（首段捕获椭圆）=========');
const cw = scanSense(-1);
const ccw = scanSense(+1);
console.log(`\n★ 判定：绕月逆行(CW) 地球系最小 ${cw.toFixed(3)} km/s；绕月顺行(CCW) 地球系最小 ${ccw.toFixed(3)} km/s`);

console.log('\n======== 5. 低轨必然出现「绕地反向」（与顺逆无关）========');
console.log(`195km 圆轨道环月速度 ${v_circ195.toFixed(3)} > 月球公转 ${v_moon.toFixed(3)}`);
console.log(`⇒ 地球系速度区间 [${(v_moon - v_circ195).toFixed(3)}, ${(v_moon + v_circ195).toFixed(3)}] km/s`);
console.log(`⇒ 环月速度 > 月球公转 ⇒ 地球系轨迹必然带「倒退小圈」（真实现象，非 bug），`);
console.log(`   且该结论与绕月顺逆无关：顺逆只决定小圈出现在背地侧还是向地侧。`);

console.log('\n======== 6. 相机「以谁为中心」= 减去谁的速度 =========');
console.log(`飞船自己（地球系）会合时 ${v_apo.toFixed(3)} km/s，月球 ${v_moon.toFixed(3)} km/s`);
console.log(`若镜头跟随月球 ⇒ 屏幕位移 = v_craft − v_moon = ${(v_apo - v_moon).toFixed(3)} km/s → 与地球系读数反号`);
console.log(`⇒ 「镜头中心」不是纯平移：跟随月球要从所有物体里减掉 ${v_moon.toFixed(3)} km/s，`);
console.log(`   而飞船自身只有 ${v_apo.toFixed(3)} km/s，故屏幕方向被整体翻转 180°。`);
