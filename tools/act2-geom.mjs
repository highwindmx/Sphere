/**
 * 第二幕（嫦娥一号真实轨道）几何复算——纯标量，公式与 src/rocket.js 同源，不依赖浏览器/Cesium。
 * 用途：改参数后一键验证三段衔接跳变、轨道尺度、取景距离，替代「肉眼看动画」。
 */
const MU = 398600.4418, rE = 6378.137, MOONDIST = 384400, MOONR = 1737.4, EXAG = 8, MOONP = 27.321661;
const RV = MOONR * EXAG;

const keplerE = (M, e) => {
  let E = M;
  for (let i = 0; i < 60; i++) {
    const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-12) break;
  }
  return E;
};
const ell = (a, e, M) => {           // 面内 [沿 d1, 沿 d2]（km）
  const E = keplerE(M, e);
  const r = a * (1 - e * Math.cos(E));
  const nu = Math.atan2(Math.sqrt(1 - e * e) * Math.sin(E), Math.cos(E) - e);
  return [r * Math.cos(nu), r * Math.sin(nu)];
};
const prep = (list, base, scale) => list.map((o) => {
  const rp = base + o.rp * scale, ra = base + o.ra * scale;
  return { ...o, rp, ra, a: (rp + ra) / 2, e: (ra - rp) / (ra + rp) };
});

const PHASING = [{ rp: 205, ra: 50900, laps: 3, per: 16, name: '16h' },
                 { rp: 593, ra: 71600, laps: 3, per: 24, name: '24h' },
                 { rp: 593, ra: 119800, laps: 1, per: 48, name: '48h' }];
const CAPTURE = [{ rp: 211, ra: 8500, laps: 2, per: 12, name: '12h' },
                 { rp: 200, ra: 1729, laps: 4, per: 3.5, name: '3.5h' },
                 { rp: 195, ra: 195, laps: 1, per: 127 / 60, name: '127min' }];
const PH = prep(PHASING, rE, 1), CA = prep(CAPTURE, RV, EXAG);

const H = {
  phasing: PHASING.reduce((s, o) => s + o.laps * o.per, 0),
  transfer: 114,
  capture: CAPTURE.reduce((s, o) => s + o.laps * o.per, 0),
};
const TOT = H.phasing + H.transfer + H.capture;
const TPH = H.phasing + H.transfer;
const P2 = { phasingEnd: H.phasing / TOT, transferEnd: TPH / TOT };

// 转移椭圆 + 会合点
const rp = rE + 593, ra = 405000, a = (rp + ra) / 2, e = (ra - rp) / (ra + rp);
const encR = MOONDIST + CA[0].rp;
const Ee = Math.acos(Math.max(-1, Math.min(1, (1 - encR / a) / e)));
const Menc = Ee - e * Math.sin(Ee);
const nuEnc = Math.atan2(Math.sqrt(1 - e * e) * Math.sin(Ee), Math.cos(Ee) - e);
const nEnc = Math.sqrt(MU / (a ** 3));
const tEncH = (Menc / nEnc) / 3600;

// 位置函数（面内 km）
function posAt(pp) {
  const s = Math.min(1, Math.max(0, pp));
  if (s < P2.phasingEnd) {
    const u = s / P2.phasingEnd, h = u * H.phasing;
    let acc = 0;
    for (let oi = 0; oi < PH.length; oi++) {
      for (let li = 0; li < PH[oi].laps; li++) {
        const per = PH[oi].per, last = oi === PH.length - 1 && li === PH[oi].laps - 1;
        if (h < acc + per || last) { const cu = last ? 1 : (h - acc) / per; return ell(PH[oi].a, PH[oi].e, 2 * Math.PI * cu); }
        acc += per;
      }
    }
  }
  if (s < P2.transferEnd) {
    const u = (s - P2.phasingEnd) / (P2.transferEnd - P2.phasingEnd);
    return ell(a, e, Menc * u);
  }
  const u = (s - P2.transferEnd) / (1 - P2.transferEnd), h = u * H.capture;
  const sAct = s;
  // 月球位置（面内 km）
  const th = nuEnc + (2 * Math.PI / (MOONP * 86400)) * (TOT * sAct - TPH) * 3600;
  const mc = [MOONDIST * Math.cos(th), MOONDIST * Math.sin(th)];
  let acc = 0;
  for (let oi = 0; oi < CA.length; oi++) {
    for (let li = 0; li < CA[oi].laps; li++) {
      const per = CA[oi].per, last = oi === CA.length - 1 && li === CA[oi].laps - 1;
      if (h < acc + per || last) {
        const cu = last ? 1 : (h - acc) / per;
        // d1 = 径向外 rhat，d2 = rhat × nrm（逆行）→ 面内 d2 分量取 -(逆时针 90° 旋转)
        const [px, py] = ell(CA[oi].a, CA[oi].e, 2 * Math.PI * cu);
        const ux = Math.cos(th), uy = Math.sin(th);       // rhat
        const vx = uy, vy = -ux;                          // rhat × nrm（面内，右手系 nrm 朝外）
        return [mc[0] + px * ux + py * vx, mc[1] + px * uy + py * vy];
      }
      acc += per;
    }
  }
}
const moonAt = (s) => {
  const th = nuEnc + (2 * Math.PI / (MOONP * 86400)) * (TOT * s - TPH) * 3600;
  return [MOONDIST * Math.cos(th), MOONDIST * Math.sin(th)];
};
const d = (p1, p2) => Math.hypot(p1[0] - p2[0], p1[1] - p2[1]);
const mag = (p) => Math.hypot(p[0], p[1]);

// 取景几何
const TAN_H = Math.tan(Math.PI / 6), TAN_V = TAN_H / (16 / 9);
const fit = (hx, hy, m = 0.88) => Math.max(hx / TAN_H, hy / TAN_V) / m;
const PH_B = PH.map((o) => o.a * Math.sqrt(1 - o.e * o.e));
const CA_B = CA.map((o) => o.a * Math.sqrt(1 - o.e * o.e));

console.log('===== 第二幕 · 嫦娥一号真实轨道 =====');
console.log(`段耗时      调相 ${H.phasing.toFixed(1)}h / 转移 ${H.transfer}h / 捕获 ${H.capture.toFixed(1)}h  → 共 ${TOT.toFixed(1)}h`);
console.log(`时间占比    调相 ${(P2.phasingEnd * 100).toFixed(1)}% / 转移 ${((P2.transferEnd - P2.phasingEnd) * 100).toFixed(1)}% / 捕获 ${((1 - P2.transferEnd) * 100).toFixed(1)}%`);
console.log(`加速倍率    ×${Math.round(TOT * 3600 / (0.38 * 120))}（45.6s 演完 322h）\n`);

console.log('—— 调相三条椭圆（地心距 km）——');
PH.forEach((o, i) => console.log(`  ${PHASING[i].name.padEnd(6)} rp ${o.rp.toFixed(0).padStart(6)}  ra ${o.ra.toFixed(0).padStart(7)}  a ${o.a.toFixed(0).padStart(6)}  e ${o.e.toFixed(4)}  b ${PH_B[i].toFixed(0).padStart(6)}  ×${PHASING[i].laps}圈`));
console.log('—— 环月三条轨道（月心距 km，×8 同步）——');
CA.forEach((o, i) => console.log(`  ${CAPTURE[i].name.padEnd(6)} rp ${o.rp.toFixed(0).padStart(6)}  ra ${o.ra.toFixed(0).padStart(6)}  a ${o.a.toFixed(0).padStart(6)}  e ${o.e.toFixed(4)}  b ${CA_B[i].toFixed(0).padStart(6)}  ×${CAPTURE[i].laps}圈  远月点 ${(o.ra / RV).toFixed(2)} Rv`));
console.log(`转移椭圆    rp ${rp.toFixed(0)}  ra ${ra}  a ${a.toFixed(0)}  e ${e.toFixed(4)}（霍曼 e 应≈0.96）`);
console.log(`会合点      r ${encR.toFixed(0)} km  ν ${(nuEnc * 180 / Math.PI).toFixed(1)}°  平近点角 M ${Menc.toFixed(4)}  飞行 ${tEncH.toFixed(1)}h（真实 114h）`);
console.log(`月球扫过    ${((2 * Math.PI / (MOONP * 86400)) * TOT * 3600 * 180 / Math.PI).toFixed(1)}°（第二幕全长 322h；会合前 154.8°，会合后再 22°）`);

console.log('\n===== 衔接连续性（端点解析值直接比对，排除采样间隔伪影）=====');
// ① 调相末（48h 轨道 u=1 → 近地点）vs 转移起点（M=0 → 近地点）
const pEnd = ell(PH[2].a, PH[2].e, 2 * Math.PI);        // = [rp, 0]
const tStart = ell(a, e, 0);                             // = [rp, 0]
const j1 = d(pEnd, tStart);
// ② 转移末（M=Menc）vs 捕获起点（12h 轨道 u=0 近月点，月心 = 会合时刻月球位置）
const tEnd = ell(a, e, Menc);
const mEnc = moonAt(P2.transferEnd);
const ux = Math.cos(Math.atan2(mEnc[1], mEnc[0])), uy = Math.sin(Math.atan2(mEnc[1], mEnc[0]));
const cStart = [mEnc[0] + CA[0].rp * ux, mEnc[1] + CA[0].rp * uy];
const j2 = d(tEnd, cStart);
console.log(`  调相→转移（近地点）： ${j1.toFixed(6)} km   [${pEnd[0].toFixed(1)},${pEnd[1].toFixed(1)}] vs [${tStart[0].toFixed(1)},${tStart[1].toFixed(1)}]`);
console.log(`  转移→捕获（会合点）： ${j2.toFixed(6)} km   ← 旧版 72,276 km`);
// ③ 捕获段换轨（相邻两档近月点半径之差）
const sw = [Math.abs(CA[0].rp - CA[1].rp), Math.abs(CA[1].rp - CA[2].rp)];
console.log(`  捕获 12h→3.5h：       ${sw[0].toFixed(3)} km   ← 旧版 15,984 km`);
console.log(`  捕获 3.5h→127min：    ${sw[1].toFixed(3)} km`);
// 会合时刻月球 vs 飞船方向
const encMoon = moonAt(P2.transferEnd), encSc = posAt(P2.transferEnd);
console.log(`  会合时 月球方向 ${(Math.atan2(encMoon[1], encMoon[0]) * 180 / Math.PI).toFixed(2)}° / 飞船方向 ${(Math.atan2(encSc[1], encSc[0]) * 180 / Math.PI).toFixed(2)}°（须相等）`);
console.log(`  会合时 飞船地心距 ${mag(encSc).toFixed(0)} km = 月心距 ${mag(encMoon).toFixed(0)} + ${(mag(encSc) - mag(encMoon)).toFixed(0)}`);

// 抛物线/近地点间隙（真实取景下像素）
console.log('\n===== 取景（顶视，16:9，fov 60°）=====');
console.log(`  调相段定焦 ${(fit(PH[2].a, PH_B[2]) / 1000).toFixed(0)}e3 km → 1px = ${(2 * fit(PH[2].a, PH_B[2]) * TAN_H / 1920).toFixed(1)} km`);
CA.forEach((o, i) => {
  const r = fit(o.a, CA_B[i], 0.8);
  console.log(`  捕获 ${CAPTURE[i].name.padEnd(6)} ${(r / 1000).toFixed(0)}e3 km → 显示月球直径 ${(2 * RV / (2 * r * TAN_H / 1920)).toFixed(0)} px`);
});
// 转移段最坏取景
let worst = 0, worstS = 0;
for (let i = 0; i <= 20; i++) {
  const s = P2.phasingEnd + (P2.transferEnd - P2.phasingEnd) * (i / 20);
  const u = (s - P2.phasingEnd) / (P2.transferEnd - P2.phasingEnd);
  const m = moonAt(s), c = ell(a, e, Menc * u);
  let mnx = 0, mxx = 0, mny = 0, mxy = 0;
  for (const p of [m, c]) { mnx = Math.min(mnx, p[0]); mxx = Math.max(mxx, p[0]); mny = Math.min(mny, p[1]); mxy = Math.max(mxy, p[1]); }
  const r = fit((mxx - mnx) / 2, (mxy - mny) / 2);
  if (r > worst) { worst = r; worstS = s; }
}
console.log(`  转移段自适应 最远 ${(worst / 1000).toFixed(0)}e3 km（月球方位 ${(Math.atan2(moonAt(worstS)[1], moonAt(worstS)[0]) * 180 / Math.PI).toFixed(0)}°）→ 1px = ${(2 * worst * TAN_H / 1920).toFixed(1)} km`);
console.log(`  转移段末 月球 ${(Math.atan2(moonAt(P2.transferEnd)[1], moonAt(P2.transferEnd)[0]) * 180 / Math.PI).toFixed(0)}° → 取景 ${(fit(0, 0) >= 0 ? (() => { const m = moonAt(P2.transferEnd); let mnx = 0, mxx = 0, mny = 0, mxy = 0; for (const p of [m, ell(a, e, Menc)]) { mnx = Math.min(mnx, p[0]); mxx = Math.max(mxx, p[0]); mny = Math.min(mny, p[1]); mxy = Math.max(mxy, p[1]); } return (fit((mxx - mnx) / 2, (mxy - mny) / 2) / 1000).toFixed(0); })() : '')}e3 km`);

// 统一判定
const ok1 = j1 < 1, ok2 = j2 < 1, ok3 = sw.every((x) => x < 500);
console.log(`\n判定：调相→转移 ${ok1 ? 'OK' : 'FAIL'} / 转移→捕获 ${ok2 ? 'OK' : 'FAIL'} / 捕获换轨 ${ok3 ? 'OK' : 'FAIL'}`);
