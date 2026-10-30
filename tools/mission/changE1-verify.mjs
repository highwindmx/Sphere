// 数值验证 src/changE1.js：与参考项目 Fly2moon/chang-e-hohmann.html 的已知数值逐项对撞。
// 期望值取自参考项目 HTML 的 UI 默认值与 NOTES 文案（都是它自己算出来的）。
import * as M from '../../src/changE1.js';

let fail = 0;
function ck(name, got, want, tol, unit = '') {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) fail++;
  console.log(` ${ok ? '✓' : '✗'} ${name.padEnd(24)} got=${(+got).toPrecision(7)}${unit}  want=${want}${unit}  (tol ${tol})`);
}
console.log('=== 地球段 ===');
ck('停泊 T (min)', M.O_PARK.T / 60, 88.4, 0.1);
ck('停泊 v (km/s)', M.vAt(M.O_PARK, M.RP_E), 7.786, 0.002);
ck('b1 Δv (km/s)', M.DV_R1, 2.648, 0.002);
ck('c16 ra (km)', M.O_16.ra, 57896, 60);
ck('b2 Δv (m/s)', M.DV_1 * 1000, 139, 1.5);
ck('c24 ra (km)', M.O_24.ra, 77906, 60);
ck('b3 Δv (m/s)', M.DV_2 * 1000, 164, 1.5);
ck('c48 ra (km)', M.O_48.ra, 127531, 60);
ck('b4 Δv (m/s)', M.DV_3 * 1000, 180, 1.5);
ck('加速累计 (km/s)', M.DV_ACC, 3.132, 0.002);
ck('转移 a (km)', M.O_TR.a, 195488, 60);
ck('转移 e', M.O_TR.e, 0.9664, 0.0002);
ck('转移 近地点 v', M.vAt(M.O_TR, M.RP_E), 10.92, 0.01);
ck('转移 远地点 v', M.vAt(M.O_TR, M.O_TR.ra), 0.187, 0.002);
ck('转移时长 (d)', M.T_SOI / 86400, 4.83, 0.02);

console.log('=== 拼接圆锥 / 月球段 ===');
ck('v∞ (km/s)', M.HYP.vinf, 0.739, 0.002);
ck('近月点高度 (km)', M.HYP.rp - M.R_M, 420, 1.5);
ck('lb1 前 v (km/s)', M.V_PERI_HYP, 2.256, 0.005);
ck('lb1 后 v (km/s)', M.vAt(M.O_L1, M.HYP.rp), 1.936, 0.005);
ck('lb1 Δv (m/s)', M.DV_B1 * 1000, 321, 2);
// 注：参考项目 NOTES 中「420 × 10,128」「200 × 3,466」的**后一项是月心距**（它把近月点写高度、
// 远月点写月心距）。故这里对 ra 本身，不再减 R_M。
ck('l12 远月点月心距', M.O_L1.ra, 10128, 40);
ck('lb2 Δv (m/s)', M.DV_B2 * 1000, 283, 2);
ck('l35 远月点月心距', M.O_L2.ra, 3466, 40);
ck('l35 e', M.O_L2.e, 0.283, 0.003);
ck('lb3 Δv (m/s)', M.DV_B3 * 1000, 211, 2);
ck('l127 v (km/s)', M.vAt(M.O_L3, M.RP_L2), 1.591, 0.003);
ck('l127 T (min)', M.O_L3.T / 60, 127.5, 0.2);
ck('制动累计 (km/s)', M.DV_BRK, 0.815, 0.003);

console.log('=== 时间线 ===');
ck('动画总时长 (s)', M.TOTAL, 111.43, 0.6);
ck('任务总时长 (d)', M.DAYS_TOTAL, 10.97, 0.05);
// 「月球提前 106° 出发」= TLI 那一刻**月球所在方位角**（飞船当时在近地点 nu≈0，故方位角即提前量）。
// 转移 4.83 d 期间月球再转过 63.7°，正好在远地点附近迎头会合（参考项目 NOTES 原文）。
const deg = (r) => ((r * 180 / Math.PI) % 360 + 360) % 360;
// ⚠ thetaMoonAt 收的是**真实秒 rt**（不是动画秒 t）——传 t 会差出整个调相段的月球位移。
ck('TLI 时月球方位 (°)', deg(M.thetaMoonAt(M.SEG_BY_KEY.trans.rt0)), 106, 3);
ck('转移期间月球转过 (°)', (M.T_SOI / M.T_MOON) * 360, 63.7, 0.5);

console.log('=== 连续性（段间位置跳跃）===');
// 参考项目**有意**让 coast 从近地点(nu=0)起算、burn 扫过 nu∈[−BURN_SWEEP,+BURN_SWEEP]，
// 故每个「滑行→点火」边界都有 2·r·sin(BURN_SWEEP/2) 的设计内跳跃；除此之外不应再有额外跳变。
// frame 由 e→m 切换时 px/py 语义变了（地心 → 相对月心），比较必须换算到同一绝对坐标。
function absPos(st) {
  if (st.frame === 'm') {
    return [M.D_M * Math.cos(st.thetaMoon) + st.px, M.D_M * Math.sin(st.thetaMoon) + st.py];
  }
  return [st.px, st.py];
}
for (let i = 0; i < M.SEGS.length - 1; i++) {
  const s = M.SEGS[i], nx = M.SEGS[i + 1];
  const a = M.stateAt(s.t1 - 1e-6), b = M.stateAt(nx.t0 + 1e-6);
  const [ax, ay] = absPos(a), [bx, by] = absPos(b);
  const jump = Math.hypot(bx - ax, by - ay);
  // 设计内跳跃：任一侧是 burn/burnM 段，则允许 ±BURN_SWEEP 对应的弦长
  const isBurn = s.kind === 'burn' || nx.kind === 'burn' || s.kind === 'burnM' || nx.kind === 'burnM';
  const expect = isBurn ? 2 * a.r * Math.sin(M.BURN_SWEEP / 2) : 0;
  const ok = jump <= expect * 1.15 + 5;
  if (!ok) fail++;
  console.log(` ${ok ? '✓' : '✗'} ${(s.key + '→' + nx.key).padEnd(14)}`
    + ` 跳跃 ${jump.toFixed(1).padStart(9)} km  设计内允许 ${expect.toFixed(1).padStart(9)} km`
    + (isBurn ? '  (点火弧)' : '  (应≈0)'));
}

console.log('=== 制动段「月球不能跑得比飞船快」（参考项目第七轮核心判据）===');
// 指标 = **月心系**相对速度 ÷ 月球公转速度。参考项目修后 lb1 2.21 / lb2 1.89 / lb3 1.76
// （修前 ≈0.10：点火真实时长按压缩比硬推，导致飞船相对月球几乎不动、月球却照常公转）。
const wantRel = { lb1: 2.21, lb2: 1.89, lb3: 1.76 };
for (const key of ['lb1', 'lb2', 'lb3']) {
  const s = M.SEG_BY_KEY[key];
  let peak = 0;
  for (let i = 0; i <= 8; i++) {
    const st = M.stateAt(s.t0 + (s.dur * i) / 9);
    peak = Math.max(peak, st.speed / M.V_MOON);
  }
  const ok = Math.abs(peak - wantRel[key]) < 0.06;
  if (!ok) fail++;
  console.log(` ${ok ? '✓' : '✗'} ${key} v_rel/v_moon 点火瞬时 ${peak.toFixed(3)}  期望 ${wantRel[key]}`
    + '  （修前 0.10 → 地心行迹被拉成直线）');
}

console.log(fail === 0 ? '\n全部通过 ✓✓' : `\n有 ${fail} 项偏差 ✗`);
process.exit(fail === 0 ? 0 : 1);
