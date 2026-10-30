/**
 * 嫦娥一号地月转移轨道引擎（2026-10-22 移植自参考项目 Fly2moon/chang-e-hohmann.html）
 * ---------------------------------------------------------------------------
 * 设计原则（与参考项目一致，勿自行「改进」）：
 *  1. **拼接圆锥**：转移椭圆与月球双曲线在影响球（R_SOI=66,000 km）边界上**位置与速度同时连续**；
 *     以「近月点高度 420 km」为条件二分反解转移轨道进入影响球的真近点角 ν。捕获段不是硬接的，
 *     而是同一条轨迹在两套引力场里各自积分的结果。
 *  2. **滑行段用开普勒方程**把真实时间映射到真近点角——近地点快、远地点慢是算出来的，不是插值的。
 *  3. **时间压缩按区统一**：地球段 EARTH_RATE、环月段 LUNAR_RATE=2800；点火段的真实时长由
 *     几何反推（扫过 2·BURN_SWEEP 的弧长 ÷ 该处角速度）。若按压缩比硬推，点火时航天器几乎不动
 *     而月球照常前进，地心行迹会被拉成一条直线（参考项目第七轮实测教训）。
 *  4. 本模块只解**轨道平面内的 2D 状态**；由调用方用平面基 (e1,e2) 映射成 3D（Cesium 用）。
 *
 * 与 sphere 旧实现的差异（用户 2026-10-22 拍板「完全换」）：
 *   旧：rp=6964(593km)/ra=405000、无影响球、远地点直接会合（距月心 20,599 km）、制动总 Δv 1.169 km/s
 *   新：rp=6576(205km)/ra=384400、影响球拼接、双曲线 v∞≈0.739、近月点 420→200、制动 Δv 321/283/211
 *       = **0.815 km/s**（比旧值更接近嫦娥官方实测 ~0.848 km/s）。
 */

/* ============================ 1. 物理常数 ============================ */
export const MU_E = 398600.4418;                            // km³/s²
export const MU_M = 4902.800;
export const R_E = 6371.0;
export const R_M = 1737.4;
export const D_M = 384400.0;
export const T_MOON = 27.321661 * 86400;                    // s
export const V_MOON = 2 * Math.PI * D_M / T_MOON;           // 1.0232 km/s

export const RP_E = R_E + 205;                              // 停泊轨道半径 6,576 km
export const R_SOI = 66000;                                 // 月球影响球半径
export const H_P1 = 420;                                    // 捕获点（近月点）高度
export const H_P2 = 200;                                    // 最终环月高度
export const RP_L2 = R_M + H_P2;                            // 1,937.4 km

/* ============================ 2. 圆锥曲线工具 ============================ */
export function mkOrb(rp, ra, mu) {
  const a = (rp + ra) / 2;
  const e = (ra - rp) / (ra + rp);
  return { rp, ra, a, e, mu, p: a * (1 - e * e), T: 2 * Math.PI * Math.sqrt(a * a * a / mu), n: Math.sqrt(mu / (a * a * a)) };
}
export function aOfT(T, mu) { return Math.cbrt(mu * T * T / (4 * Math.PI * Math.PI)); }
export function conicR(o, nu) { return o.p / (1 + o.e * Math.cos(nu)); }
export function vAt(o, r) { return Math.sqrt(o.mu * (2 / r - 1 / o.a)); }
export function rotV(v, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c];
}
/** 速度矢量（轨道平面内，math 坐标；近月点在 0 方向） */
export function velVec(o, nu) {
  const sq = Math.sqrt(o.mu / o.p);
  const vr = sq * o.e * Math.sin(nu);
  const vt = sq * (1 + o.e * Math.cos(nu));
  const c = Math.cos(nu), s = Math.sin(nu);
  return [vr * c - vt * s, vr * s + vt * c];
}
export function MofNu(o, nu) {
  const E = 2 * Math.atan2(Math.sqrt(1 - o.e) * Math.sin(nu / 2), Math.sqrt(1 + o.e) * Math.cos(nu / 2));
  return E - o.e * Math.sin(E);
}
/** 开普勒方程：平近点角 → 真近点角（牛顿迭代 80 次，1e-13） */
export function keplerNu(o, M) {
  const e = o.e;
  let E = M + 0.85 * e * (Math.sin(M) >= 0 ? 1 : -1);
  for (let i = 0; i < 80; i++) {
    const f = E - e * Math.sin(E) - M, fp = 1 - e * Math.cos(E), d = f / fp;
    E -= d;
    if (Math.abs(d) < 1e-13) break;
  }
  let nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
  if (nu < 0) nu += 2 * Math.PI;
  return nu;
}
/** 双曲开普勒：平近点角 → 双曲近点角 */
export function hypH(M, e) {
  let H = Math.asinh(M / e);
  for (let i = 0; i < 100; i++) {
    const f = e * Math.sinh(H) - H - M, fp = e * Math.cosh(H) - 1, d = f / fp;
    H -= d;
    if (Math.abs(d) < 1e-13) break;
  }
  return H;
}

/* ============================ 3. 地球段轨道 ============================ */
export const O_PARK = mkOrb(RP_E, RP_E, MU_E);
export const O_16 = mkOrb(RP_E, 2 * aOfT(16 * 3600, MU_E) - RP_E, MU_E);
export const O_24 = mkOrb(RP_E, 2 * aOfT(24 * 3600, MU_E) - RP_E, MU_E);
export const O_48 = mkOrb(RP_E, 2 * aOfT(48 * 3600, MU_E) - RP_E, MU_E);
export const O_TR = mkOrb(RP_E, D_M, MU_E);

export const DV_R1 = vAt(O_16, RP_E) - vAt(O_PARK, RP_E);   // 末级点火（最大的一次）
export const DV_1 = vAt(O_24, RP_E) - vAt(O_16, RP_E);
export const DV_2 = vAt(O_48, RP_E) - vAt(O_24, RP_E);
export const DV_3 = vAt(O_TR, RP_E) - vAt(O_48, RP_E);      // TLI
export const DV_ACC = DV_R1 + DV_1 + DV_2 + DV_3;

/* ============================ 4. 拼接圆锥求解 ============================ */
function earthState(nu) {
  const r = conicR(O_TR, nu);
  const sq = Math.sqrt(MU_E / O_TR.p);
  const vr = sq * O_TR.e * Math.sin(nu);
  const vt = sq * (1 + O_TR.e * Math.cos(nu));
  const c = Math.cos(nu), s = Math.sin(nu);
  return { r, x: r * c, y: r * s, vx: vr * c - vt * s, vy: vr * s + vt * c };
}

/** 给定转移轨道真近点角 ν，求影响球边界处的月球双曲线参数 */
function soiProbe(nu) {
  const s = earthState(nu);
  const d2 = s.x * s.x + s.y * s.y;
  if (d2 <= 0) return null;
  // 月球必须同时满足 |m|=D_M 与 |m-s|=R_SOI：两圆交点
  const a = (d2 + D_M * D_M - R_SOI * R_SOI) / (2 * Math.sqrt(d2));
  const h2 = D_M * D_M - a * a;
  if (h2 < 0) return null;
  const hh = Math.sqrt(h2);
  const ux = s.x / Math.sqrt(d2), uy = s.y / Math.sqrt(d2);
  const mx = a * ux + hh * uy, my = a * uy - hh * ux;
  const thm = Math.atan2(my, mx);
  // 相对状态
  const mvx = -V_MOON * Math.sin(thm), mvy = V_MOON * Math.cos(thm);
  const rx = s.x - mx, ry = s.y - my;
  const vx = s.vx - mvx, vy = s.vy - mvy;
  const h = rx * vy - ry * vx;
  const v2 = vx * vx + vy * vy;
  const en = v2 / 2 - MU_M / R_SOI;
  if (en <= 0) return null;                                  // 必须是被月球甩开的双曲线
  const e = Math.sqrt(1 + 2 * en * h * h / (MU_M * MU_M));
  const p = h * h / MU_M;
  const rp = p / (1 + e);
  const c = (p / R_SOI - 1) / e;
  if (c < -1 || c > 1) return null;
  let nuh = Math.acos(c);
  if (rx * vx + ry * vy < 0) nuh = -nuh;                     // 尚在接近段
  return { nu, thm, rp, e, p, h, vinf: Math.sqrt(2 * en), nuh, peria: Math.atan2(ry, rx) - nuh, ah: -MU_M / (2 * en) };
}

/** 二分：找到使近月点高度恰为 H_P1 的转移真近点角 */
const PC = (function solve() {
  let lo = 179.0 * Math.PI / 180, hi = 179.9 * Math.PI / 180;
  for (let i = 0; i < 90; i++) {
    const mid = (lo + hi) / 2;
    const r = soiProbe(mid);
    if (!r) { lo = mid; continue; }
    if (r.rp - R_M > H_P1) hi = mid; else lo = mid;
  }
  const nu = (lo + hi) / 2;
  const r = soiProbe(nu);
  r.nu = nu;
  return r;
}());
export { PC as SOI_PATCH };

export const HYP = {
  mu: MU_M, e: PC.e, p: PC.p, a: Math.abs(PC.ah), rp: PC.rp,
  nuh0: PC.nuh, peria: PC.peria, vinf: PC.vinf, nuInf: Math.acos(-1 / PC.e),
};
HYP.n = Math.sqrt(MU_M / (HYP.a * HYP.a * HYP.a));

export const M_SOI = MofNu(O_TR, PC.nu);
export const T_SOI = M_SOI / O_TR.n;
export const H_SOI = Math.acosh((R_SOI / HYP.a + 1) / HYP.e);
export const MH_SOI = HYP.e * Math.sinh(H_SOI) - H_SOI;
export const T_HYP = MH_SOI / HYP.n;
export const V_PERI_HYP = Math.sqrt(HYP.vinf * HYP.vinf + 2 * MU_M / HYP.rp);

/* ============================ 5. 月球段轨道 ============================ */
export const O_L1 = mkOrb(HYP.rp, 2 * aOfT(12 * 3600, MU_M) - HYP.rp, MU_M);
export const O_L2 = mkOrb(RP_L2, 2 * aOfT(3.5 * 3600, MU_M) - RP_L2, MU_M);
export const O_L3 = mkOrb(RP_L2, RP_L2, MU_M);

export const DV_B1 = V_PERI_HYP - vAt(O_L1, HYP.rp);
export const DV_B2 = vAt(O_L1, HYP.rp) - Math.sqrt(MU_M * (2 / HYP.rp - 1 / O_L2.a));
export const DV_B3 = vAt(O_L2, RP_L2) - vAt(O_L3, RP_L2);
export const DV_BRK = DV_B1 + DV_B2 + DV_B3;

/* ============================ 6. 时间线 ============================ */
// 点火时扫过的真近点角半宽（rad）
export const BURN_SWEEP = 0.26;
// 环月段统一时间压缩比；接近段也用它（否则 9.41 d 首次制动那一刻压缩比会从 ×7244 跳到 ×2800）
export const LUNAR_RATE = 2800;
export const REV = 2;      // 12 h / 3.5 h 环月各绕 2 圈
export const REV3 = 3;     // 127.5 min 极轨绕 3 圈
const RLD = (sec) => sec / LUNAR_RATE;
/**
 * 点火段的真实时长必须由**几何**反推：扫过 2·BURN_SWEEP 的弧长 ÷ 该处角速度。
 * 若按压缩比硬推（dur × 2800），月球的公转会比航天器快二十倍 —— 制动时航天器几乎不动、
 * 月球却照常前进，地心行迹会被拉成一条直线（参考项目第七轮实测：修前 v_rel/v_moon≈0.10，应≈2.2）。
 */
export function BURN_RT_M(fromOrb) {
  const r0 = fromOrb ? conicR(fromOrb, 0) : HYP.rp;
  const p = fromOrb ? fromOrb.p : HYP.p;
  return 2 * BURN_SWEEP * r0 * r0 / Math.sqrt(MU_M * p);
}
// 地球段：先把 8 段物理时长加起来，再用「总真实时长 ÷ 总动画时长」反推压缩比 ——
// 段内比例恒定，同时进入影响球的任务时刻完全不变。
const E_RT = O_PARK.T + 600 + O_16.T + 668 + O_24.T + 788 + O_48.T + 867;
const E_DUR = 4.6 + 1.3 + 2.8 + 1.0 + 3.0 + 1.0 + 3.4 + 1.4;
export const EARTH_RATE = E_RT / E_DUR;
const ERT = (dur) => dur * EARTH_RATE;

/**
 * 16 段：dur = 「看」的秒数，rt = 「飞」的真实秒数。
 * kind: coast=开普勒滑行 / burn=地球段点火(轨道 lerp) / hyp=月球双曲线接近 / burnM=近月制动
 * frame: e=地心系（轨道平面内地心坐标）/ m=月心系（相对月球）
 */
export const SEGS = [
  { key: 'park', kind: 'coast', frame: 'e', orb: O_PARK, dur: 4.6, rt: ERT(4.6), M1: 2 * Math.PI },
  { key: 'b1', kind: 'burn', frame: 'e', from: O_PARK, to: O_16, dur: 1.3, rt: ERT(1.3), dv: DV_R1 },
  { key: 'c16', kind: 'coast', frame: 'e', orb: O_16, dur: 2.8, rt: ERT(2.8), M1: 2 * Math.PI },
  { key: 'b2', kind: 'burn', frame: 'e', from: O_16, to: O_24, dur: 1.0, rt: ERT(1.0), dv: DV_1 },
  { key: 'c24', kind: 'coast', frame: 'e', orb: O_24, dur: 3.0, rt: ERT(3.0), M1: 2 * Math.PI },
  { key: 'b3', kind: 'burn', frame: 'e', from: O_24, to: O_48, dur: 1.0, rt: ERT(1.0), dv: DV_2 },
  { key: 'c48', kind: 'coast', frame: 'e', orb: O_48, dur: 3.4, rt: ERT(3.4), M1: 2 * Math.PI },
  { key: 'b4', kind: 'burn', frame: 'e', from: O_48, to: O_TR, dur: 1.4, rt: ERT(1.4), dv: DV_3 },
  { key: 'trans', kind: 'coast', frame: 'e', orb: O_TR, dur: 12.5, rt: T_SOI, M1: M_SOI },
  { key: 'appr', kind: 'hyp', frame: 'e', dur: RLD(T_HYP), rt: T_HYP },
  { key: 'lb1', kind: 'burnM', frame: 'm', to: O_L1, dur: 3.8, rt: BURN_RT_M(), dv: DV_B1 },
  { key: 'l12', kind: 'coast', frame: 'm', orb: O_L1, dur: RLD(REV * O_L1.T), rt: REV * O_L1.T, M1: REV * 2 * Math.PI, nu0: 2 * BURN_SWEEP },
  { key: 'lb2', kind: 'burnM', frame: 'm', from: O_L1, to: O_L2, dur: 2.2, rt: BURN_RT_M(O_L1), dv: DV_B2 },
  { key: 'l35', kind: 'coast', frame: 'm', orb: O_L2, dur: RLD(REV * O_L2.T), rt: REV * O_L2.T, M1: REV * 2 * Math.PI, nu0: 2 * BURN_SWEEP },
  { key: 'lb3', kind: 'burnM', frame: 'm', from: O_L2, to: O_L3, dur: 1.8, rt: BURN_RT_M(O_L2), dv: DV_B3 },
  { key: 'l127', kind: 'coast', frame: 'm', orb: O_L3, dur: RLD(REV3 * O_L3.T), rt: REV3 * O_L3.T, M1: REV3 * 2 * Math.PI, nu0: 2 * BURN_SWEEP },
];

let _t = 0, _rt = 0;
for (const s of SEGS) { s.t0 = _t; _t += s.dur; s.t1 = _t; s.rt0 = _rt; _rt += s.rt; s.rt1 = _rt; }
export const TOTAL = _t;          // 动画总时长（s）
export const RT_TOTAL = _rt;      // 任务真实总时长（s）
export const DAYS_TOTAL = _rt / 86400;

export const SEG_BY_KEY = {};
SEGS.forEach((s) => { SEG_BY_KEY[s.key] = s; });

/** 月球相位：以影响球进入时刻为锚点（参考项目同款） */
export const RT_SOI = SEG_BY_KEY.trans.rt1;
export function thetaMoonAt(rt) {
  return PC.thm - 2 * Math.PI * (RT_SOI - rt) / T_MOON;
}

/** 进度条分组（时间轴 5 组） */
export const GROUPS = [
  { key: 'park', label: '停泊', from: 'park', to: 'park' },
  { key: 'phase', label: '调相', from: 'b1', to: 'b4' },
  { key: 'transfer', label: '转移', from: 'trans', to: 'appr' },
  { key: 'brake', label: '制动', from: 'lb1', to: 'lb3' },
  { key: 'lunar', label: '环月', from: 'l127', to: 'l127' },
];
GROUPS.forEach((g) => { g.t0 = SEG_BY_KEY[g.from].t0; g.t1 = SEG_BY_KEY[g.to].t1; });

/* ============================ 7. 状态求解 ============================ */
const ease = (u) => u * u * (3 - 2 * u);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
function lerpOrb(A, B, u) { return mkOrb(A.rp + (B.rp - A.rp) * u, A.ra + (B.ra - A.ra) * u, B.mu); }

export function realAt(t) {
  const s = segAt(t);
  const u = clamp((t - s.t0) / s.dur, 0, 1);
  return s.rt0 + u * (s.rt1 - s.rt0);
}
export function segAt(t) {
  for (const s of SEGS) if (t < s.t1) return s;
  return SEGS[SEGS.length - 1];
}

/**
 * 给定动画时刻 t（0..TOTAL）求完整状态。
 * 返回：{ seg,key,u,frame,kind,burning,dv, orb,nu,r,speed,vel[2], px,py, distMoon, thetaMoon,
 *        hyp?, nuH?, morph? }
 *  · frame 'e'：px,py = **地心**轨道平面坐标（km）；月球在 thetaMoon 方向的 D_M 处。
 *  · frame 'm'：px,py = **相对月心**的坐标（km）；月球位置由调用方另算。
 */
export function stateAt(t) {
  t = clamp(t, 0, TOTAL);
  const s = segAt(t);
  const u = clamp((t - s.t0) / s.dur, 0, 1);
  const st = { seg: s, key: s.key, u, frame: s.frame, burning: false, kind: s.kind };

  if (s.kind === 'coast') {
    const M0 = s.nu0 ? MofNu(s.orb, s.nu0) : 0;    // 从上一段制动结束处接续，避免跳变
    const M = M0 + (s.M1 - M0) * u;
    st.orb = s.orb;
    st.nu = keplerNu(s.orb, M);
    st.r = conicR(s.orb, st.nu);
    st.speed = vAt(s.orb, st.r);
    st.vel = velVec(s.orb, st.nu);
  } else if (s.kind === 'burn') {
    const k = ease(u);
    st.orb = lerpOrb(s.from, s.to, k);
    st.nu = -BURN_SWEEP + 2 * BURN_SWEEP * u;
    st.r = conicR(st.orb, st.nu);
    st.speed = vAt(st.orb, st.r);
    st.vel = velVec(st.orb, st.nu);
    st.burning = true;
    st.dv = s.dv;
  } else if (s.kind === 'hyp') {
    const Mh = -MH_SOI * (1 - u);
    const H = hypH(Mh, HYP.e);
    st.r = HYP.a * (HYP.e * Math.cosh(H) - 1);
    st.nuH = 2 * Math.atan2(Math.sqrt((HYP.e + 1) / (HYP.e - 1)) * Math.tanh(H / 2), 1);
    st.nu = st.nuH;
    st.speed = Math.sqrt(HYP.vinf * HYP.vinf + 2 * MU_M / st.r);
    st.vel = rotV(velVec(HYP, st.nuH), HYP.peria);
    st.orb = HYP;
    st.hyp = true;
  } else if (s.kind === 'burnM') {
    // 近月点制动：轨道由双曲线（或大椭圆）平滑过渡到目标椭圆，
    // 从近月点（nu=0）出发扫过 2·BURN_SWEEP，与前后滑行段首尾相接
    const k = ease(u);
    st.nu = 2 * BURN_SWEEP * u;
    st.orb = s.from ? lerpOrb(s.from, s.to, k) : s.to;
    st.r = conicR(st.orb, st.nu);                  // 沿当前轨道走，喷焰才严格沿切线
    st.speed = s.from ? vAt(st.orb, st.r)
      : V_PERI_HYP + (vAt(st.orb, st.r) - V_PERI_HYP) * k;
    const vv = velVec(st.orb, st.nu);
    const vm = Math.hypot(vv[0], vv[1]) || 1;
    st.vel = rotV([vv[0] * st.speed / vm, vv[1] * st.speed / vm], HYP.peria);
    st.burning = true;
    st.dv = s.dv;
    st.morph = k;
  }

  // 月球位置与相对距离
  st.thetaMoon = thetaMoonAt(realAt(t));
  if (s.frame === 'e') {
    const mx = D_M * Math.cos(st.thetaMoon), my = D_M * Math.sin(st.thetaMoon);
    let px, py;
    if (s.kind === 'hyp') {
      px = mx + st.r * Math.cos(HYP.peria + st.nuH);
      py = my + st.r * Math.sin(HYP.peria + st.nuH);
      st.distMoon = st.r;
      // 地心系速度 = 月球速度 + 相对速度
      const mvx = -V_MOON * Math.sin(st.thetaMoon), mvy = V_MOON * Math.cos(st.thetaMoon);
      st.vel = [st.vel[0] + mvx, st.vel[1] + mvy];
    } else {
      px = st.r * Math.cos(st.nu);
      py = st.r * Math.sin(st.nu);
      st.distMoon = Math.hypot(px - mx, py - my);
    }
    st.px = px; st.py = py;
  } else {
    st.distMoon = st.r;
    st.angRel = HYP.peria + st.nu;
    // 月心系：相对月心的平面坐标（近月点方向 = HYP.peria）
    st.px = st.r * Math.cos(st.angRel);
    st.py = st.r * Math.sin(st.angRel);
  }
  return st;
}

/* ============================ 8. 镜头调度（2D 语义 → 3D 可用规格） ============================ */
// 参考项目是 2D 画布（camK px/km + 焦点 fx/fy）。sphere 是 3D Cesium，故这里只导出
// **取景语义**：注视点（earth / moon 或二者按权重混合）与「需要装下的半尺寸 halfKm」。
// 调用方用 fitRangeKm(halfKm) 换算成相机 range，再按 focus 取世界坐标。
//   · park      → 地球特写（装下停泊轨道 6,576 km）
//   · b1..b4    → 按当前（插值中）轨道远地点装下
//   · trans/appr→ 地月全景；随 distMoon 从 168,000 → 74,000 km，ease 推向月球，视野收到 ±95,000 km
//   · frame 'm' → **全程锁定月球特写**（装下 200 km 环月轨道），镜头不再切换
const JUNC_FAR = 168000, JUNC_NEAR = 74000, JUNC_HALF = 95000;

export function camSpec(st) {
  if (st.frame === 'm') {
    // ⭐ 2026-10-23 用户反馈「环月椭圆时镜头推得太近只看到月球」：旧值固定 RP_L2×1.18
    //   （≈2,287 km）只够框住 200 km 圆轨道；12 h / 3.5 h 大椭圆的远月点达 10,128 / 3,466 km
    //   → 飞船远月在画外。改为**按当前轨道远月点自适应**，并给月球本体留 2.2× 的下限余量。
    const ap = (st.orb && isFinite(st.orb.ra)) ? Math.max(st.orb.ra, st.r) : RP_L2;
    return { focus: 'moon', w: 1, halfKm: Math.max(ap * 1.18, RP_L2 * 2.2), lunar: true };
  }
  let halfKm = D_M * 1.06;
  switch (st.key) {
    case 'park': halfKm = RP_E * 1.9; break;
    case 'b1': halfKm = Math.max(st.orb.ra * 1.12, RP_E * 1.9); break;
    case 'c16': halfKm = O_16.ra * 1.12; break;
    case 'b2': halfKm = Math.max(st.orb.ra * 1.12, O_16.ra * 1.12); break;
    case 'c24': halfKm = O_24.ra * 1.12; break;
    case 'b3': halfKm = Math.max(st.orb.ra * 1.12, O_24.ra * 1.12); break;
    case 'c48': halfKm = O_48.ra * 1.12; break;
    case 'b4': halfKm = Math.max(D_M * 1.06, Math.min(O_48.ra * 1.12, D_M * 1.06)); break;
    default: halfKm = D_M * 1.06; break;   // trans / appr
  }
  let w = 0;
  if (st.kind === 'hyp' || st.key === 'trans') {
    const dm = st.distMoon;
    w = ease(clamp((JUNC_FAR - dm) / (JUNC_FAR - JUNC_NEAR), 0, 1));
    if (w > 0) halfKm = halfKm * (1 - w) + JUNC_HALF * w;
  }
  return { focus: 'earth', w, halfKm, lunar: false };
}

/* ============================ 9. 16 段解说文案 ============================ */
// 数字与 SEGS 同源：均由本模块常量算出，改轨道参数即自动跟着变。
const f2 = (v) => v.toFixed(2);
const f3 = (v) => v.toFixed(3);
const i0 = (v) => Math.round(v).toLocaleString('en-US');

export const NOTES = {
  park: {
    idx: '2-1', title: '205 km 停泊轨道',
    text: `长征三号甲把嫦娥一号送入 205 km 圆轨道，速度 <b>${f3(vAt(O_PARK, RP_E))} km/s</b>。` +
      '火箭末级在这里等待点火窗口。',
    a: `T = ${(O_PARK.T / 60).toFixed(1)} min`, b: `v = ${f3(vAt(O_PARK, RP_E))} km/s`,
  },
  b1: {
    idx: '2-2', title: '火箭末级点火',
    text: `三级二次点火，<b>Δv = ${f3(DV_R1)} km/s</b>——全程最大的一次加速，由火箭完成。圆轨道被拉成 16 小时大椭圆。`,
    a: `Δv ${f3(DV_R1)} km/s`, b: '16 h 轨道',
  },
  c16: {
    idx: '2-3', title: '16 小时调相轨道',
    text: `远地点 ${i0(O_16.ra - R_E)} km。卫星在这一圈里测轨、校准，为后续三次近地点点火提供精确初值。`,
    a: `r_a = ${i0(O_16.ra)} km`, b: 'T = 16 h',
  },
  b2: {
    idx: '2-4', title: '近地点点火 1',
    text: `卫星自身 490 N 发动机点火，<b>Δv = ${Math.round(DV_1 * 1000)} m/s</b>，远地点抬到 ${i0(O_24.ra - R_E)} km。`,
    a: `Δv ${Math.round(DV_1 * 1000)} m/s`, b: '24 h 轨道',
  },
  c24: {
    idx: '2-5', title: '24 小时轨道',
    text: `远地点 ${i0(O_24.ra - R_E)} km。轨道周期与地球自转同步，地面站有充裕时间连续跟踪。`,
    a: `r_a = ${i0(O_24.ra)} km`, b: 'T = 24 h',
  },
  b3: {
    idx: '2-6', title: '近地点点火 2',
    text: `<b>Δv = ${Math.round(DV_2 * 1000)} m/s</b>，远地点抬到 ${i0(O_48.ra - R_E)} km。三次点火都在同一个近地点，属于共近地点变轨。`,
    a: `Δv ${Math.round(DV_2 * 1000)} m/s`, b: '48 h 轨道',
  },
  c48: {
    idx: '2-7', title: '48 小时轨道',
    text: `远地点 ${i0(O_48.ra - R_E)} km，已接近月球轨道的三分之一。这一圈用来最终确认奔月走廊。`,
    a: `r_a = ${i0(O_48.ra)} km`, b: 'T = 48 h',
  },
  b4: {
    idx: '2-8', title: '近地点点火 3 · TLI',
    text: `<b>Δv = ${Math.round(DV_3 * 1000)} m/s</b>，远地点抬到 ${i0(D_M)} km，正好触及月球轨道。` +
      `三次累计 ${f3(DV_ACC)} km/s，与一次点火完全等效。`,
    a: `Δv ${Math.round(DV_3 * 1000)} m/s`, b: `累计 ${f3(DV_ACC)} km/s`,
  },
  trans: {
    idx: '2-9', title: '地月转移滑行',
    text: `沿霍曼椭圆滑行 <b>${f2(T_SOI / 86400)} 天</b>。近地点 ${f2(vAt(O_TR, RP_E))} km/s，` +
      `远地点只剩 <b>${f3(vAt(O_TR, O_TR.ra))} km/s</b>——速度随半径衰减，越远越慢。` +
      `月球提前 ${Math.round(((PC.nu - thetaMoonAt(0)) * 180 / Math.PI + 360) % 360)}° 出发，在远地点附近迎头会合。`,
    a: `a = ${i0(O_TR.a)} km`, b: `e = ${O_TR.e.toFixed(4)}`,
  },
  appr: {
    idx: '2-10', title: '进入月球影响球',
    text: `距月球 ${i0(R_SOI)} km 处，月球引力开始主导。双曲线超速 <b>v∞ = ${f3(HYP.vinf)} km/s</b>，` +
      `飞船沿双曲线绕到近月点，高度 ${Math.round(HYP.rp - R_M)} km。`,
    a: `v∞ = ${f3(HYP.vinf)} km/s`, b: `r_p = ${Math.round(HYP.rp - R_M)} km`,
  },
  lb1: {
    idx: '2-11', title: '近月制动 1',
    text: `在近月点反向点火，<b>Δv = ${Math.round(DV_B1 * 1000)} m/s</b>。相对月球的速度从 ` +
      `${f3(V_PERI_HYP)} 降到 ${f3(vAt(O_L1, HYP.rp))} km/s，双曲线被削成 12 小时椭圆——这是被月球捕获的关键一步。`,
    a: `Δv ${Math.round(DV_B1 * 1000)} m/s`, b: '12 h 环月',
  },
  l12: {
    idx: '2-12', title: '12 小时环月椭圆',
    text: `近月点 ${Math.round(HYP.rp - R_M)} km、远月点 ${i0(O_L1.ra - R_M)} km。每转一圈经过近月点，都是一次制动的机会窗口。`,
    a: `${Math.round(HYP.rp - R_M)} × ${i0(O_L1.ra - R_M)} km`, b: 'T = 12 h',
  },
  lb2: {
    idx: '2-13', title: '近月制动 2',
    text: `<b>Δv = ${Math.round(DV_B2 * 1000)} m/s</b>，把轨道压到 ${H_P2} × ${i0(O_L2.ra - R_M)} km，周期 3.5 小时。` +
      `近月点同时从 ${Math.round(HYP.rp - R_M)} km 降到 ${H_P2} km。`,
    a: `Δv ${Math.round(DV_B2 * 1000)} m/s`, b: `${H_P2} × ${i0(O_L2.ra - R_M)} km`,
  },
  l35: {
    idx: '2-14', title: '3.5 小时环月椭圆',
    text: '轨道明显收紧，月球在视野里越来越大。再经过一次近月点，就可以圆化。',
    a: 'T = 3.5 h', b: `e = ${O_L2.e.toFixed(3)}`,
  },
  lb3: {
    idx: '2-15', title: '近月制动 3 · 圆化',
    text: `<b>Δv = ${Math.round(DV_B3 * 1000)} m/s</b>，速度降到 <b>${f3(vAt(O_L3, RP_L2))} km/s</b>，` +
      `进入 ${H_P2} km 极轨圆轨道，周期 ${(O_L3.T / 60).toFixed(1)} 分钟。`,
    a: `Δv ${Math.round(DV_B3 * 1000)} m/s`, b: `v = ${f3(vAt(O_L3, RP_L2))} km/s`,
  },
  l127: {
    idx: '2-16', title: `${(O_L3.T / 60).toFixed(1)} 分钟极轨`,
    text: '轨道面与月球赤道近乎垂直，可以扫过全部经度。嫦娥一号在这里工作了 16 个月，传回全月影像。',
    a: `h = ${H_P2} km`, b: `T = ${(O_L3.T / 60).toFixed(1)} min`,
  },
};

export const NAMES = {
  park: '停泊轨道', b1: '末级点火', c16: '16h 调相', b2: '点火 1', c24: '24h 调相',
  b3: '点火 2', c48: '48h 调相', b4: 'TLI 点火', trans: '地月转移', appr: '月球接近',
  lb1: '制动 1', l12: '12h 环月', lb2: '制动 2', l35: '3.5h 环月', lb3: '制动 3', l127: '极轨环月',
};
