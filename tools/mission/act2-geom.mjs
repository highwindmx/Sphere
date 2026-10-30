/**
 * 第二幕（嫦娥一号真实轨道）几何复算——纯标量，公式与 src/rocket.js 同源，不依赖浏览器/Cesium。
 * 用途：改参数后一键验证三段衔接跳变、轨道尺度、取景距离、运动方向连续性，替代「肉眼看动画」。
 *
 * 2026-10-19 重做（用户反馈「地月转移与月球捕获衔接点反向，科学性错误」，参照 demos/）：
 *   · 捕获段起真实比例（EXAG=1）：环月轨道远月点不再 ×8 放大到 81,899 km（超出转移可达
 *     最远处 20,599 km → 物理上接不上转移）；
 *   · 抵达点在**远月点**（距月心 20,599 km = 转移远地点 405,000 − 地月距 384,400）；
 *   · 远月点运动方向 = +that（= 飞船相对月球的抵达方向），两个坐标系里都不反向；
 *   · LOI 制动在**近月点**（向地侧 −rhat），相邻轨道近月点共享 → 换轨无跳变。
 */
const MU = 398600.4418, rE = 6378.137, MOONDIST = 384400, MOONR = 1737.4, EXAG = 1, MOONP = 27.321661;
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
const CAPTURE = [{ rp: 200, ra: 18862, laps: 0.5, per: 12, name: '抵达' },
                 { rp: 211, ra: 8500, laps: 2, per: 12, name: '12h' },
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
const P2 = { phasingEnd: H.phasing / TOT, enc: TPH / TOT };

// 转移椭圆 + 会合点（会合点 = 转移远地点，距月心 = 转移可达最远处）
const rp = rE + 593, ra = 405000, a = (rp + ra) / 2, e = (ra - rp) / (ra + rp);
const encR = MOONDIST + CA[0].ra;
const Ee = Math.acos(Math.max(-1, Math.min(1, (1 - encR / a) / e)));
const Menc = Ee - e * Math.sin(Ee);
const nuEnc = Math.atan2(Math.sqrt(1 - e * e) * Math.sin(Ee), Math.cos(Ee) - e);
const nEnc = Math.sqrt(MU / (a ** 3));
const tEncH = (Menc / nEnc) / 3600;

const moonThetaAt = (s) => nuEnc + (2 * Math.PI / (MOONP * 86400)) * (TOT * s - TPH) * 3600;
const moonAt = (s) => { const th = moonThetaAt(s); return [MOONDIST * Math.cos(th), MOONDIST * Math.sin(th)]; };

// 捕获段进度 → { oi, segU }（seg0 半圈自远月点 M=π 起跑；其余自近月点 M=0 整圈）
function capSeg(u) {
  const h = u * H.capture;
  let acc = 0;
  for (let oi = 0; oi < CAPTURE.length; oi++) {
    const segH = CAPTURE[oi].laps * CAPTURE[oi].per;
    if (h < acc + segH || oi === CAPTURE.length - 1) {
      return { oi, segU: oi === CAPTURE.length - 1 ? 1 : (h - acc) / segH };
    }
    acc += segH;
  }
}

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
  if (s < P2.enc) {
    const u = (s - P2.phasingEnd) / (P2.enc - P2.phasingEnd);
    return ell(a, e, Menc * u);
  }
  const u = (s - P2.enc) / (1 - P2.enc);
  const { oi, segU } = capSeg(u);
  const M = (oi === 0 ? Math.PI : 0) + Math.PI * 2 * segU * CAPTURE[oi].laps;
  const mc = moonAt(s), th = Math.atan2(mc[1], mc[0]);
  const [px, py] = ell(CA[oi].a, CA[oi].e, M);
  // d1 = −rhat（近月点在向地侧）、d2 = −that（远月点沿 +that 运动 = 与抵达衔接）
  const d1 = [-Math.cos(th), -Math.sin(th)], d2 = [-Math.sin(th), Math.cos(th)];
  return [mc[0] + px * d1[0] + py * d2[0], mc[1] + px * d1[1] + py * d2[1]];
}
const d = (p1, p2) => Math.hypot(p1[0] - p2[0], p1[1] - p2[1]);
const mag = (p) => Math.hypot(p[0], p[1]);

// 取景几何
const TAN_H = Math.tan(Math.PI / 6), TAN_V = TAN_H / (16 / 9);
const fit = (hx, hy, m = 0.88) => Math.max(hx / TAN_H, hy / TAN_V) / m;
const PH_B = PH.map((o) => o.a * Math.sqrt(1 - o.e * o.e));
const CA_B = CA.map((o) => o.a * Math.sqrt(1 - o.e * o.e));

console.log('===== 第二幕 · 嫦娥一号真实轨道（捕获段真实比例 ×1）=====');
console.log(`段耗时      调相 ${H.phasing.toFixed(1)}h / 转移 ${H.transfer}h / 捕获 ${H.capture.toFixed(1)}h  → 共 ${TOT.toFixed(1)}h`);
console.log(`时间占比    调相 ${(P2.phasingEnd * 100).toFixed(1)}% / 转移 ${((P2.enc - P2.phasingEnd) * 100).toFixed(1)}% / 捕获 ${((1 - P2.enc) * 100).toFixed(1)}%`);
console.log(`加速倍率    转移 ×${Math.round(TPH * 3600 / (0.38 * 132))} / 捕获 ×${Math.round(H.capture * 3600 / (0.106 * 132))}\n`);

console.log('—— 调相三条椭圆（地心距 km）——');
PH.forEach((o, i) => console.log(`  ${PHASING[i].name.padEnd(6)} rp ${o.rp.toFixed(0).padStart(6)}  ra ${o.ra.toFixed(0).padStart(7)}  a ${o.a.toFixed(0).padStart(6)}  e ${o.e.toFixed(4)}  b ${PH_B[i].toFixed(0).padStart(6)}  ×${PHASING[i].laps}圈`));
console.log('—— 环月四条轨道（月心距 km，真实比例 ×1）——');
CA.forEach((o, i) => console.log(`  ${CAPTURE[i].name.padEnd(6)} rp ${o.rp.toFixed(0).padStart(6)}  ra ${o.ra.toFixed(0).padStart(7)}  a ${o.a.toFixed(0).padStart(6)}  e ${o.e.toFixed(4)}  b ${CA_B[i].toFixed(0).padStart(6)}  ×${CAPTURE[i].laps}圈  远月点 ${(o.ra / RV).toFixed(2)} Rv`));
console.log(`转移椭圆    rp ${rp.toFixed(0)}  ra ${ra}  a ${a.toFixed(0)}  e ${e.toFixed(4)}（霍曼 e 应≈0.96）`);
console.log(`会合点      r ${encR.toFixed(0)} km  ν ${(nuEnc * 180 / Math.PI).toFixed(2)}°  平近点角 M ${Menc.toFixed(4)}  飞行 ${tEncH.toFixed(1)}h（真实 114h）`);
console.log(`转移可达    最远月心距 = ra − MOONDIST = ${(ra - MOONDIST).toFixed(0)} km；捕获远月点 = ${CA[0].ra.toFixed(0)} km（须 ≤ 可达）`);
console.log(`月球扫过    ${((2 * Math.PI / (MOONP * 86400)) * TOT * 3600 * 180 / Math.PI).toFixed(1)}°（第二幕全长 ${TOT.toFixed(1)}h）`);

console.log('\n===== 衔接连续性（端点解析值直接比对，排除采样间隔伪影）=====');
// ① 调相末（48h 轨道 u=1 → 近地点）vs 转移起点（M=0 → 近地点）
const pEnd = ell(PH[2].a, PH[2].e, 2 * Math.PI);
const tStart = ell(a, e, 0);
const j1 = d(pEnd, tStart);
// ② 转移末（M=Menc）vs 捕获起点（seg0 u=0 远月点，月心 = 会合时刻月球位置）
const tEnd = ell(a, e, Menc);
const mEnc = moonAt(P2.enc);
const cStart = posAt(P2.enc);
const j2 = d(tEnd, cStart);
console.log(`  调相→转移（近地点）： ${j1.toFixed(6)} km   [${pEnd[0].toFixed(1)},${pEnd[1].toFixed(1)}] vs [${tStart[0].toFixed(1)},${tStart[1].toFixed(1)}]`);
console.log(`  转移→捕获（远月点）： ${j2.toFixed(6)} km   ← 旧版 72,276 km`);
// ③ 捕获段换轨（相邻两档近月点半径之差 = 制动点位置跳变）
const sw = [Math.abs(CA[0].rp - CA[1].rp), Math.abs(CA[1].rp - CA[2].rp), Math.abs(CA[2].rp - CA[3].rp)];
console.log(`  捕获 抵达→12h：       ${sw[0].toFixed(3)} km`);
console.log(`  捕获 12h→3.5h：       ${sw[1].toFixed(3)} km   ← 旧版 15,984 km`);
console.log(`  捕获 3.5h→127min：    ${sw[2].toFixed(3)} km`);
// 会合时刻月球 vs 飞船方向
const encMoon = moonAt(P2.enc), encSc = posAt(P2.enc);
console.log(`  会合时 月球方向 ${(Math.atan2(encMoon[1], encMoon[0]) * 180 / Math.PI).toFixed(2)}° / 飞船方向 ${(Math.atan2(encSc[1], encSc[0]) * 180 / Math.PI).toFixed(2)}°（须相等）`);
console.log(`  会合时 飞船地心距 ${mag(encSc).toFixed(0)} km = 月心距 ${mag(encMoon).toFixed(0)} + ${(mag(encSc) - mag(encMoon)).toFixed(0)}（= 捕获远月点）`);

// ④ 运动方向连续性（有限差分，km/h）：转移抵达前后 vs 捕获起步，都换算到**月心系**
console.log('\n===== 运动方向连续性（月心系，有限差分）=====');
const eps = 1e-4;
const relVel = (s) => {   // 月心系速度（km/h）
  const p1 = posAt(s - eps), p2 = posAt(s + eps);
  const m1 = moonAt(s - eps), m2 = moonAt(s + eps);
  return [(p2[0] - p1[0] - (m2[0] - m1[0])) / (2 * eps), (p2[1] - p1[1] - (m2[1] - m1[1])) / (2 * eps)];
};
const thatAt = (s) => { const th = moonThetaAt(s); return [Math.sin(th), -Math.cos(th)]; };  // rhat × n̂
const dot = (p, q) => (p[0] * q[0] + p[1] * q[1]) / (mag(p) * mag(q));
const ang = (p) => Math.atan2(p[1], p[0]) * 180 / Math.PI;
const vIn = relVel(P2.enc - 2e-4), vOut = relVel(P2.enc + 2e-4), thE = thatAt(P2.enc);
console.log(`  转移抵达前（月心系）${ang(vIn).toFixed(2)}°  大小 ${mag(vIn).toFixed(0)} km/h  与 +that 夹角 ${(Math.acos(Math.max(-1, Math.min(1, dot(vIn, thE)))) * 180 / Math.PI).toFixed(2)}°`);
console.log(`  捕获起步后（月心系）${ang(vOut).toFixed(2)}°  大小 ${mag(vOut).toFixed(0)} km/h  与 +that 夹角 ${(Math.acos(Math.max(-1, Math.min(1, dot(vOut, thE)))) * 180 / Math.PI).toFixed(2)}°`);
console.log(`  +that 方向           ${ang(thE).toFixed(2)}°（会合时刻）`);
// 抵近全过程扫描（转移末段各点 + 捕获起步各点）：夹角必须始终 < 10°
console.log('  抵近扫描（月心系速度 vs +that 夹角）：');
for (const off of [-0.10, -0.05, -0.02, -0.01, -0.005, -0.002, -0.0005, 0.0005, 0.002, 0.005, 0.01, 0.02, 0.05]) {
  const v = relVel(P2.enc + off);
  const df = Math.acos(Math.max(-1, Math.min(1, dot(v, thatAt(P2.enc + off))))) * 180 / Math.PI;
  console.log(`    s−enc=${off >= 0 ? '+' : ''}${off.toFixed(4)}  夹角 ${df.toFixed(2)}°  |v| ${mag(v).toFixed(0)} km/h`);
}
// 地心系方向（顶视画面里用户看到的「前进方向」）
const geoVel = (s) => { const p1 = posAt(s - eps), p2 = posAt(s + eps); return [(p2[0] - p1[0]) / (2 * eps), (p2[1] - p1[1]) / (2 * eps)]; };
const gIn = geoVel(P2.enc - 2e-4), gOut = geoVel(P2.enc + 2e-4);
console.log(`  地心系 转移 ${ang(gIn).toFixed(2)}°（${mag(gIn).toFixed(0)} km/h）→ 捕获 ${ang(gOut).toFixed(2)}°（${mag(gOut).toFixed(0)} km/h） 夹角 ${(Math.acos(Math.max(-1, Math.min(1, dot(gIn, gOut)))) * 180 / Math.PI).toFixed(2)}°（须 < 90° = 不反向）`);

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
  const s = P2.phasingEnd + (P2.enc - P2.phasingEnd) * (i / 20);
  const m = moonAt(s), c = ell(a, e, Menc * ((s - P2.phasingEnd) / (P2.enc - P2.phasingEnd)));
  let mnx = 0, mxx = 0, mny = 0, mxy = 0;
  for (const p of [m, c]) { mnx = Math.min(mnx, p[0]); mxx = Math.max(mxx, p[0]); mny = Math.min(mny, p[1]); mxy = Math.max(mxy, p[1]); }
  const r = fit((mxx - mnx) / 2, (mxy - mny) / 2);
  if (r > worst) { worst = r; worstS = s; }
}
console.log(`  转移段自适应 最远 ${(worst / 1000).toFixed(0)}e3 km（月球方位 ${(Math.atan2(moonAt(worstS)[1], moonAt(worstS)[0]) * 180 / Math.PI).toFixed(0)}°）→ 1px = ${(2 * worst * TAN_H / 1920).toFixed(1)} km`);

// 捕获段全程扫描：位置跳变（相邻采样点）+ 是否始终保持「月心距 ∈ [rp−50, ra+50]」
let maxJump = 0, maxJumpU = 0, minR = 1e9, maxR = 0;
const NC = 4000;
for (let i = 0; i <= NC; i++) {
  const u = i / NC, s = P2.enc + (1 - P2.enc) * u;
  const p = posAt(s), m = moonAt(s);
  const rm = mag([p[0] - m[0], p[1] - m[1]]);
  minR = Math.min(minR, rm); maxR = Math.max(maxR, rm);
  if (i > 0) {
    const p0 = posAt(P2.enc + (1 - P2.enc) * ((i - 1) / NC));
    const j = d(p, p0);
    if (j > maxJump) { maxJump = j; maxJumpU = u; }
  }
}
console.log(`\n  捕获段扫描 ${NC + 1} 点：月心距 ${minR.toFixed(0)} ~ ${maxR.toFixed(0)} km（应 = 近月点 200 ~ 远月点 ${CA[0].ra.toFixed(0)}）`);
console.log(`  捕获段最大相邻跳变 ${maxJump.toFixed(1)} km @ u=${maxJumpU.toFixed(3)}（换轨瞬间；<500 km 即无可见直线）`);

// 统一判定
const ok1 = j1 < 1, ok2 = j2 < 1, ok3 = sw.every((x) => x < 500);
const ok4 = Math.acos(Math.max(-1, Math.min(1, dot(vIn, thE)))) * 180 / Math.PI < 5
  && Math.acos(Math.max(-1, Math.min(1, dot(vOut, thE)))) * 180 / Math.PI < 5;
const ok5 = Math.acos(Math.max(-1, Math.min(1, dot(gIn, gOut)))) * 180 / Math.PI < 90;
const ok6 = CA[0].ra <= ra - MOONDIST + 1;
console.log(`\n判定：调相→转移 ${ok1 ? 'OK' : 'FAIL'} / 转移→捕获 ${ok2 ? 'OK' : 'FAIL'} / 捕获换轨 ${ok3 ? 'OK' : 'FAIL'}`
  + ` / 月心系方向连续 ${ok4 ? 'OK' : 'FAIL'} / 地心系不反向 ${ok5 ? 'OK' : 'FAIL'} / 远月点可达 ${ok6 ? 'OK' : 'FAIL'}`);
