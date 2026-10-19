// src/rocket.js — 探月任务四幕剧（3D 版：glTF Model + 火焰/RCS 特效）
// 四幕结构：
//   第一幕 · 点火起飞   （地球 Viewer：发射段上升 + 助推器/整流罩分离动效 + 发射轨迹线；
//                         长征五号整箭 → 抛助推器后芯级箭 → 抛整流罩后飞船上面级（模型随分离切换）；
//                         主发动机火焰 + 发射台灰尘 + 过顶段 RCS 姿控喷气）
//   第二幕 · 月地转移   （地球 Viewer「地月顶视图」：真实比例地月系 + 霍曼转移椭圆，
//                         近地点 200 km → 远地点月距 384,400 km，月球沿轨道同步移动（5 天扫过 ~65°），
//                         飞船上面级沿椭圆飞行，TLI 点火火焰；距离压缩说明见 #compressNote）
//   第三幕 · 月球着陆   （月球 Viewer：赤道环月轨道 100 km（倾角 0°，2026-10-17 用户反馈修正）→
//                         离轨制动 → 动力下降：自降交点沿子午线大圆弧滑往着陆点，
//                         着陆器 + 发动机火焰 + 触月灰尘，末端按真实月面 DEM 接地）
//   第四幕 · 玉兔巡视   （着陆器驻留，玉兔号月球车驶出，6 轮滚动节点动画）
// 幕间用文字幕卡过渡。复用底部巡游面板：播放/暂停/倍率/进度条拖拽/幕节点跳转/重播。
// 交互（2026-10-17 用户反馈）：播放中允许鼠标拖拽/滚轮接管相机（松手 1.1s 平滑回归脚本机位）；
//                            只有时间轴上的拖拽才影响时序（画布左键拖动不 seek）。
// 崩溃防护：camera.lookAt 只接受 Cartesian3 —— 禁止把 entity.position（Property）直接传入，
//           否则相机矩阵为 NaN → createPotentiallyVisibleSet 抛 RangeError: invalid array length。
// 3D 模型说明（2026-10-17，Cesium 1.146 实测要点）：
//   - Model.fromGltfAsync({url, minimumPixelSize}) 异步加载；billboard 保留作加载期/失败兜底
//   - 定位必须显式 modelMatrix = eastNorthUpToFixedFrame(pos, ellipsoid) * 旋转，否则躺在原点不可见
//   - glTF 为 Y-up，Cesium 自动做 Y→Z 轴校正：identity 旋转即「竖直向上」
//   - requestRenderMode 下每帧必须 scene.requestRender()（tick 内已做），模型才会随动画重绘

import * as Cesium from 'cesium';
import { MOON_ELLIPSOID, MOON_LANDING_SITES, sampleMoonHeight } from './lunar.js';
import { sampleTerrainHeight } from './terrarium-provider.js';
import { LANDER_ICON, SPACECRAFT_ICON } from './moon-landing.js';
import {
  FULL_ROCKET_ICON,
  STAGE1_ICON,
  BOOSTER_ICON,
  FAIRING_LEFT_ICON,
  FAIRING_RIGHT_ICON,
} from './icons.js';
import { isRouteTourActive } from './route-tour.js';

const MOON_R = 1737400;
const SPEED_STEPS = [0.5, 1, 2, 4, 8];
const BASE_DURATION = 132; // 1× 全程秒数（2026-10-19：拆出「近月捕获」幕后 120 → 132 s）

// ====== 第二幕：地月转移（嫦娥一号真实轨道，2026-10-19 重做） ======
// 数据源：国防科工委 2007-11-01 发布会实录 + 卫星百科「嫦娥一号」词条（四处互证）。
// 全部距离以 km 计（地心/月心），最终落位时换算成米。
const EM = {
  mu: 398600.4418,        // 地球引力常数 km³/s²
  rE: 6378.137,           // 地球赤道半径 km
  moonDist: 384400,       // 地月平均距离 km（月心距，真实值；不再为凑衔接外推）
  moonR: 1737.4,          // 月球真实半径 km
  moonExag: 8,            // 近景（绕月）视觉放大倍数；远景另由 MOON_EXAG_FAR=3 接管（见 moonExagAt）
  moonPeriod: 27.321661,  // 月球恒星周期（天）
};

// —— 嫦娥一号三段真实轨道（高度 km / 圈数 / 周期 h）——
// ⭐⭐ 三条**离散**椭圆，不是连续渐变：连续渐变在几何上渲染成一条螺旋，根本读不出「一圈一圈」；
//     离散档位让三条椭圆在近地点汇聚于一点、向远地点层层张开——这才是用户反馈「看不到一圈圈
//     椭圆」的真根因（参考卫星百科「变种霍曼转移方式」动图 sat.huijiwiki.com/wiki/地月转移轨道）。
const CH_PHASING = [                  // 调相段：每次过近地点点火，远地点逐档抬高
  { rp: 205, ra: 50900,  laps: 3, per: 16, name: '16 小时轨道' },       // 10/24 18:05 入轨
  { rp: 593, ra: 71600,  laps: 3, per: 24, name: '24 小时轨道' },       // 10/26 第1次近地点加速（连飞 3 圈：把 1 天发射窗口扩成 3 天）
  { rp: 593, ra: 119800, laps: 1, per: 48, name: '48 小时轨道' },       // 10/29 第2次近地点加速（远地点 119,800 km，当时我国最远纪录）
];
const CH_CAPTURE = [                  // 捕获段：每次过近月点制动，逐档收圆
  { rp: 211, ra: 8500, laps: 2, per: 12,       name: '12 小时轨道' },   // 11/5 LOI-1（点火 22 分钟）
  { rp: 200, ra: 1729, laps: 4, per: 3.5,      name: '3.5 小时轨道' },  // 11/6 LOI-2
  { rp: 195, ra: 195,  laps: 1, per: 127 / 60, name: '127 分钟圆轨道' },// 11/7 LOI-3（点火 10 分钟，200 km 极月轨道）
];
// —— 月球视觉倍率 LOD（2026-10-19）——
// ⭐ 远景（地月同框，取景 33–70 万 km）月球必须**小于地球**，否则直接违反直觉：
//    ×8 → 13,899 km = 地球 2.18 倍（旧行为，用户反馈「月球比地球大」）；
//    ×3 → 5,212 km = 地球 0.82 倍。近景（绕月取景 5–14 万 km）真实月球只占画面 ~11%，
//    必须放大才读得出环月轨道 → ×8。两者随 s 平滑过渡（过渡窗口见 moonExagAt）。
//    环月轨道半径 = 月半径 × exag **同步缩放**（整个「月系」等比）→ 改一个标量即可，不会脱节。
const MOON_EXAG_FAR = 3;
const MOON_EXAG_NEAR = EM.moonExag;            // 8
const CH_RV_KM = EM.moonR * MOON_EXAG_NEAR;    // 会合点显示月半径 km = 13,899
const caAt = (exag) => prepOrbits(CH_CAPTURE, EM.moonR * exag, exag);
// 轨道几何预计算：调相取地心距，捕获取月心距（与显示月球同步 ×8 缩放，否则环月轨道会插进
// 放大月球内部）。月球 ×8 的连锁后果：12h 轨道远月点 = 5.9 Rv，在地月全景里必然显得很大。
function prepOrbits(list, baseR, scale) {
  return list.map((o) => {
    const rp = baseR + o.rp * scale, ra = baseR + o.ra * scale;
    return { rp, ra, a: (rp + ra) / 2, e: (ra - rp) / (ra + rp), laps: o.laps, per: o.per, name: o.name };
  });
}
const PH = prepOrbits(CH_PHASING, EM.rE, 1);
const CA = caAt(MOON_EXAG_NEAR);   // 捕获段恒定 ×8：encR / CA_RANGE / 制动判据全部以它为准

// 转移椭圆（嫦娥一号真实：10/31 第 3 次近地点加速进入，近地点 593 km、远地点 405,000 km）
EM.rp = EM.rE + 593;
EM.ra = 405000;
EM.a = (EM.rp + EM.ra) / 2;
EM.e = (EM.ra - EM.rp) / (EM.ra + EM.rp);
// 抵达点：飞船在月球轨道**外侧**与月球会合（距月心 = 12h 环月轨道近月点 = 15,587 km），
// 即月球背面——正是真实嫦娥 LOI-1 的制动位置（背面无地面测控，故点火必须在那儿完成）。
// 该处平近点角由开普勒方程反解：r = a(1 − e·cosE) → E → M。
EM.encR = EM.moonDist + CA[0].rp;
(function initEncounter() {
  const { a, e } = EM;
  const E = Math.acos(Math.max(-1, Math.min(1, (1 - EM.encR / a) / e)));
  EM.Menc = E - e * Math.sin(E);                                  // 抵达点平近点角（rad）
  EM.nuEnc = Math.atan2(Math.sqrt(1 - e * e) * Math.sin(E), Math.cos(E) - e);  // 抵达点真近点角
  if (EM.nuEnc < 0) EM.nuEnc += Math.PI * 2;
}());
// 真实耗时（h）：调相 7 天绕地 7 圈 168 h / 转移 114 h / 捕获 3 次制动 40.1 h
const CH_H = {
  phasing: CH_PHASING.reduce((s, o) => s + o.laps * o.per, 0),
  transfer: 114,
  capture: CH_CAPTURE.reduce((s, o) => s + o.laps * o.per, 0),
};
const CH_TOTAL_H = CH_H.phasing + CH_H.transfer + CH_H.capture;   // 322.1 h ≈ 13.4 天
const CH_TPH = CH_H.phasing + CH_H.transfer;                      // 会合时刻（h）
// 地月段内部进度 s∈[0,1] 的三段分配（调相→转移→捕获）：按真实耗时等比 → s 与真实时间严格线性。
// ⚠ 2026-10-19 拆幕后 s 不再是「某一幕内的进度」，而是横跨第二幕（转移）与第三幕（捕获）的
//   统一时钟：第二幕走 s∈[0,enc]、捕获幕走 s∈[enc,1]（见 act2Progress）。enc = 会合时刻。
const P2 = {
  phasingEnd: CH_H.phasing / CH_TOTAL_H,
  enc: CH_TPH / CH_TOTAL_H,
};
/** 月球视觉倍率：**在会合点硬切换**（远景 ×3 / 会合及捕获 ×8）。
 *  ⚠ 不能按 s 平滑抬升：会合点半径 encR 是按 ×8 算的，抵达瞬间倍率没升满就会跳变上万 km。
 *    平滑抬升改在**幕卡 2** 里做（那时飞船隐藏、镜头正在从 39 万 km 推到 13 万 km，
 *    地球逐步出画，月球由小变大正好读作「正在接近」）——见 render 的幕卡 2 分支。 */
function moonExagAt(s) {
  return s < P2.enc ? MOON_EXAG_FAR : MOON_EXAG_NEAR;
}
/** 当前倍率下的显示月半径（km） */
const moonRadiusAt = (s) => EM.moonR * moonExagAt(s);
EM.moonC = EM.moonDist;                                            // 月心距（真实值）
EM.moonOmega = (2 * Math.PI) / (EM.moonPeriod * 86400);             // 月球绕地角速度 rad/s
EM.moonThetaEnc = EM.nuEnc;   // 会合时刻月球方向 = 飞船抵达方向（同一射线，二者必重合）

// —— 顶视取景几何 ——
// Cesium 默认 fov 60°（横屏时按**水平**计）→ 水平半张角 tan30°=0.5774；
// 竖直 fov 只有 36°（60° ÷ 16:9）→ 竖直半张角 tan18°=0.3249。
// ⚠ 竖直 fov 小得多，是第二幕取景的关键约束：月球转到画面上下方时必须拉远才不会出画。
const TAN_H = Math.tan(Math.PI / 6);
const TAN_V = TAN_H / (16 / 9);
/** 由轨道面内包围盒半尺寸（km）反算顶视取景距离，保证目标不出画 */
function fitRangeKm(halfX, halfY, margin = 0.88) {
  return Math.max(halfX / TAN_H, halfY / TAN_V) / margin;
}
const PH_B = PH.map((o) => o.a * Math.sqrt(1 - o.e * o.e));   // 调相三条椭圆半短轴
const CA_B = CA.map((o) => o.a * Math.sqrt(1 - o.e * o.e));   // 环月三条轨道半短轴
const PH_RANGE = fitRangeKm(PH[2].a, PH_B[2]);                // 调相段定焦（含最外 48h 椭圆）
// 捕获段三档取景（随制动逐档收紧）；margin 0.8 比 0.88 留白更多——127min 轨道贴着月面，
// 画面太满会把环月轨道挤到边角
const CA_RANGE = CA.map((o, i) => fitRangeKm(o.a, CA_B[i], 0.8));
// 捕获段内两次换轨时刻（段内进度 0..1）：LOI-2 / LOI-3
const CA_SWITCH = [0, 1].map((i) =>
  CH_CAPTURE.slice(0, i + 1).reduce((s, o) => s + o.laps * o.per, 0) / CH_H.capture);

// 四个发射场中用于探月任务的低纬两个（数据与 moonmission 图层一致）
export const LAUNCH_SITES = {
  jiuquan: { lon: 100.298, lat: 40.96, name: '酒泉' },
  wenchang: { lon: 110.951, lat: 19.614, name: '文昌' },
};

// 幕时间边界（归一化 0..1）
// ⭐ 2026-10-19 拆幕：原第二幕把「调相 + 转移 + 捕获」322 h 塞进 45.6 s，捕获段只分到 5.7 s。
//    现将捕获段独立成幕：全程 120 → 132 s，其它各幕**绝对秒数不变**，多出的 12 s 全给捕获幕。
//    秒数核对（× BASE_DURATION 132 s）：第一幕 22.8 / 幕卡1 3.6 / 转移幕 39.9 / 幕卡2 3.6
//    / 捕获幕 14.0 / 幕卡3 3.6 / 着陆幕 34.9 / 巡视幕 9.6 = 132.0 s
const T = {
  liftEnd: 0.1727,    // 第一幕结束（入轨 ~200 km）  22.8 s
  card1End: 0.2000,   // 幕卡 1 结束                  3.6 s
  transferEnd: 0.5023,// 第二幕结束（抵达月球、与月球会合）39.9 s（调相 168 h + 转移 114 h）
  card2End: 0.5295,   // 幕卡 2 结束                  3.6 s
  captureEnd: 0.6356, // 第三幕结束（三次近月制动完成）14.0 s（捕获 40.1 h）
  card3End: 0.6629,   // 幕卡 3 结束（地月全景定场镜头）3.6 s
  loiEnd: 0.8361,     // 第四幕内：环月制动段结束（开始离轨/动力下降）
  touchEnd: 0.9273,   // 第四幕结束（触月）；0.9273~1.00 为第五幕「玉兔巡视」  9.6 s
};
// 幕内推进倍率（2026-10-17 用户反馈「第一幕太快」）：tick 内 p += dt/BASE*mult*rateAt(p)。
//   第一幕：0.1727 × 132s ÷ 0.6 ≈ 38 s（与原 22.8/0.6 一致）
//   第五幕：0.0727 × 132s ÷ 0.7 ≈ 13.7 s
const ACT_RATE = { act1: 0.6, act4: 0.7 };
function rateAt(pp) {
  if (pp < T.liftEnd) return ACT_RATE.act1;
  if (pp >= T.touchEnd) return ACT_RATE.act4;
  return 1;
}
// 演示时间加速倍率（用户拍板「时间可以加速」）：按段算，进度条显式标出真实节奏。
//   转移幕 282 h → 39.9 s ≈ 2.5 万倍；捕获幕 40.1 h → 14.0 s ≈ 1.0 万倍。
const CH_SPEEDUP = {
  transfer: Math.round((CH_TPH * 3600) / ((T.transferEnd - T.card1End) * BASE_DURATION)),
  capture: Math.round((CH_H.capture * 3600) / ((T.captureEnd - T.card2End) * BASE_DURATION)),
};
/** 地月段统一内部时钟：把全局进度 pp 映射到 s∈[0,1]（调相→转移→捕获，与真实小时线性）。
 *  第二幕（转移）承担 s∈[0,P2.enc]，捕获幕承担 s∈[P2.enc,1]，幕卡期间冻结在边界值。
 *  ⚠ 全项目凡需要「地月段进度」的地方一律走这里，禁止再写 (p−card1End)/(transferEnd−card1End)。 */
function act2Progress(pp) {
  const enc = P2.enc;
  if (pp < T.card1End) return 0;
  if (pp < T.transferEnd) return enc * clamp01((pp - T.card1End) / (T.transferEnd - T.card1End));
  if (pp < T.card2End) return enc;
  if (pp < T.captureEnd) {
    return enc + (1 - enc) * clamp01((pp - T.card2End) / (T.captureEnd - T.card2End));
  }
  return 1;
}
/** 真实任务时间格式化：T+3 天 12 时 */
function fmtElapsed(h) {
  const d = Math.floor(h / 24), hh = Math.floor(h % 24);
  return d > 0 ? `T+${d} 天 ${hh} 时` : `T+${hh} 时`;
}
// 幕节点（进度条跳转锚点）
const ACTS = [
  { f: 0, name: '点火' },
  { f: T.card1End, name: '转移' },
  { f: T.card2End, name: '捕获' },
  { f: T.card3End, name: '环月' },
  { f: T.loiEnd, name: '着陆' },
  { f: T.touchEnd, name: '巡视' },
];
// 第一幕内的分离事件时刻（随幕长自动缩放）
const BOOSTER_SEP = T.liftEnd * 0.45;  // 助推器分离
const FAIRING_SEP = T.liftEnd * 0.78;  // 整流罩分离
// 特效时间窗（第一幕，按 liftEnd 比例——改幕长时行为不变）
const DUST_END = T.liftEnd * 0.214;  // 发射台灰尘持续时间
const RCS_FROM = T.liftEnd * 0.071;  // 过顶段 RCS 起始（重力转弯窗口）
const RCS_TO = T.liftEnd * 0.343;    // 过顶段 RCS 结束

function $(id) { return document.getElementById(id); }
function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function easeIn(t) { return t * t; }
function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

function samplePath(points, s) {
  const s01 = clamp01(s);
  const n = points.length - 1;
  const x = s01 * n;
  const i = Math.min(n - 1, Math.floor(x));
  const f = x - i;
  const a = points[i], b = points[i + 1];
  return [lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f)];
}

function wrapLon(lon) { return ((lon + 180) % 360 + 360) % 360 - 180; }
function shortestAngle(a, b) { return ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI; }

// ====== 玉兔巡视路线（2026-10-17 二修） ======
// ⚠ 旧版用 97,700 m/度 换算经度——那是地球量级；月球 1° 经度 = (π/180)·1,737,400 ≈ 30,325 m，
//   少算 3.2×，标称 14 m 的行程实际只走了 4.3 m（用户实测「行进路线不正常」）。
// 2026-10-17 用户反馈二：「月兔车没有驶离着陆器」——除月面过暗外，起点正压在着陆器腿环
//   （腿跨 2.36 m）下方，近距看不清「驶离」。现将起点后移 5 m（腿环之外），行程加长到 26 m。
// 路线：自着陆器后方 5 m 出发、航向 96°→126°（东微南 → 东南）的 26 m 缓弯，
//   逐点按 DEM 取地面高贴地行驶。
const MOON_M_PER_DEG = (Math.PI / 180) * MOON_R;    // ≈30,325 m/度（月球）
const ROVER_LEN = 26;                               // 巡视行程（米）
const ROVER_START_BACK = 5;                         // 起点相对着陆器的后移量（米，避开腿环）
let _roverPathCache = null;                         // { key, pts }
let _diveBlend = null;                              // 第三幕末「切着陆机位」推近混合 { t0 }

/** 巡视路线采样点：[{lon, lat, h, heading}]，按落点缓存（DEM 采样开销不逐帧付） */
function roverPath(site) {
  const key = `${site.lon},${site.lat}`;
  if (_roverPathCache && _roverPathCache.key === key) return _roverPathCache.pts;
  const N = 64;
  const ds = ROVER_LEN / N;
  // 起点 = 着陆器 − 5 m（沿初始航向 96° 的反方向），即腿环（半径 ~1.2 m）之外
  const h0 = Cesium.Math.toRadians(96);
  let lon = site.lon - (ROVER_START_BACK * Math.sin(h0)) / (MOON_M_PER_DEG * Math.max(0.2, Math.cos(Cesium.Math.toRadians(site.lat))));
  let lat = site.lat - (ROVER_START_BACK * Math.cos(h0)) / MOON_M_PER_DEG;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const s = i / N;
    const heading = Cesium.Math.toRadians(96 + 30 * s);   // 航向（自北顺时针）
    pts.push({ lon, lat, h: sampleMoonHeight(lon, lat), heading });
    if (i < N) {
      const dN = ds * Math.cos(heading), dE = ds * Math.sin(heading);
      lat += dN / MOON_M_PER_DEG;
      lon += dE / (MOON_M_PER_DEG * Math.max(0.2, Math.cos(Cesium.Math.toRadians(lat))));
    }
  }
  _roverPathCache = { key, pts };
  return pts;
}

// ====== glTF 3D 模型（异步加载 + billboard 兜底；2026-10-17） ======
// 模型约定（tools/make_mission_models.py）：Y-up；火箭/飞船机头 +Y，原点=发动机喷口面；
// 着陆器/月球车接地 y=0；火焰/RCS 原点=喷口、焰柱 +Y。
// Cesium 对 glTF 自动做 Y→Z 校正，故 modelMatrix = ENU(pos) * R 时 R=identity 即竖直向上。
// minimumPixelSize 标定（2026-10-17 实测，勿照理论公式）：
//   Cesium 的 minPx 放大用 _initialRadius（≠当前 boundingSphere.radius，实测放大量比理论小 ~4×），
//   表观像素 ≈ 0.231 × minPx。取值按「旧 billboard 尺寸」标定：火箭/飞船/分离件 ~35px → 150/120，
//   着陆器下降段 marker ~28px → 120；近距（月球车 30m 机位）走自然尺寸，minPx 不参与。
const MODEL_DEFS = {
  rocket:     { url: '/models/longmarch5.glb',      minPx: 150 },  // 第一幕整箭
  rocketCore: { url: '/models/longmarch5_core.glb', minPx: 150 },  // 抛助推器后芯级箭（仍带整流罩）
  craft:      { url: '/models/spacecraft.glb',      minPx: 150 },  // 抛整流罩后上面级（转移/环月/离轨）
  loiCraft:   { url: '/models/spacecraft.glb',      minPx: 150 },  // 月球 viewer 独立实例
  booster:    { url: '/models/booster.glb',         minPx: 120 },  // 分离件（每枚独立实例）
  fairing:    { url: '/models/fairing.glb',         minPx: 120 },
  lander:     { url: '/models/moon_lander.glb',     minPx: 120 },
  rover:      { url: '/models/yutu_rover.glb',      minPx: 80 },   // 第四幕（6 轮滚动动画）
  flame:      { url: '/models/flame.glb',           minPx: 24 },   // 发动机火焰（远距不消失、近距自然大小）
  rcs:        { url: '/models/rcs.glb',             minPx: 16 },   // RCS 姿控喷气
};

const slots = [];           // 全部存活 slot 登记（stop 时统一销毁）
let rocketSlot = null;      // 单例：整箭 / 芯级箭 / 上面级 / 环月飞船 / 着陆器 / 月球车
let rocketCoreSlot = null;
let craftSlot = null;
let loiCraftSlot = null;
let landerSlot = null;
let roverSlot = null;
let earthViewerRef = null;  // 由 createMoonMission 赋值
let moonViewerRef = null;
const fxSlots = new Map();  // viewer → { flame, rcs }（特效模型按 viewer 各一份）

/** 新建一个模型槽位并开始异步加载（不立即入场景，由 attachIfReady 在渲染循环里挂载） */
function loadSlot(key, viewer) {
  const def = MODEL_DEFS[key];
  const slot = {
    key, def, viewer,
    model: null, ready: false, failed: false, added: false, destroyed: false,
    animCount: 0, mat: new Cesium.Matrix4(),
  };
  slots.push(slot);
  Cesium.Model.fromGltfAsync({
    url: def.url,
    minimumPixelSize: def.minPx,
    gltfCallback: (gltf) => { slot.animCount = gltf.animations ? gltf.animations.length : 0; },
  }).then((m) => {
    if (slot.destroyed) { try { m.destroy(); } catch { /* 已销毁 */ } return; }
    slot.model = m;
    slot.ready = true;
  }).catch((e) => {
    slot.failed = true;
    console.warn('[moonMission] 模型加载失败，回退 2D 图标：', def.url, e);
  });
  return slot;
}

/** 就绪即挂载到目标 viewer 的 primitives（月球 viewer 会随模式切换重建，added 标志自然复位） */
function attachIfReady(slot) {
  if (slot.ready && slot.model && !slot.added && !slot.model.isDestroyed()) {
    slot.viewer?.scene.primitives.add(slot.model);
    slot.added = true;
  }
  return slot.ready && slot.added;
}

function destroySlot(slot) {
  if (!slot) return;
  slot.destroyed = true;
  if (slot.added && slot.viewer) {
    try { slot.viewer.scene.primitives.remove(slot.model); } catch { /* 忽略 */ }
  }
  if (slot.model) { try { slot.model.destroy(); } catch { /* 忽略 */ } }
  const i = slots.indexOf(slot);
  if (i >= 0) slots.splice(i, 1);
}

function getRocketSlot() { if (!rocketSlot) rocketSlot = loadSlot('rocket', earthViewerRef); return rocketSlot; }
function getRocketCoreSlot() { if (!rocketCoreSlot) rocketCoreSlot = loadSlot('rocketCore', earthViewerRef); return rocketCoreSlot; }
function getCraftSlot() { if (!craftSlot) craftSlot = loadSlot('craft', earthViewerRef); return craftSlot; }
function getLoiCraftSlot() { if (!loiCraftSlot) loiCraftSlot = loadSlot('loiCraft', moonViewerRef); return loiCraftSlot; }
function getLanderSlot() { if (!landerSlot) landerSlot = loadSlot('lander', moonViewerRef); return landerSlot; }
function getRoverSlot() { if (!roverSlot) roverSlot = loadSlot('rover', moonViewerRef); return roverSlot; }
/** 特效模型（火焰/RCS）：每个 viewer 各持一份（月球 viewer 换代时随旧 viewer 一起销毁） */
function getFx(viewer, kind) {
  if (!viewer) return null;
  let m = fxSlots.get(viewer);
  if (!m) { m = {}; fxSlots.set(viewer, m); }
  if (!m[kind]) m[kind] = loadSlot(kind, viewer);
  return m[kind];
}
function destroyFxFor(viewer) {
  const m = fxSlots.get(viewer);
  if (!m) return;
  for (const k of Object.keys(m)) destroySlot(m[k]);
  fxSlots.delete(viewer);
}
function hideSlot(s) { if (s && s.ready && s.model) s.model.show = false; }
function showSlot(s) { if (s && s.ready && s.model) s.model.show = true; }

// —— 旋转/定位辅助（ENU 系内）——
const _q = new Cesium.Quaternion();
const _q2 = new Cesium.Quaternion();
const _q3 = new Cesium.Quaternion();
const _m3 = new Cesium.Matrix3();
const _rotM = new Cesium.Matrix4();
const _scaleM = new Cesium.Matrix4();
const _enuM = new Cesium.Matrix4();
const _dir = new Cesium.Cartesian3();
const _dir2 = new Cesium.Cartesian3();
const _dir3 = new Cesium.Cartesian3();
const _vec = new Cesium.Cartesian3();
const _scaleV = new Cesium.Cartesian3(1, 1, 1);
// 转移几何运算临时量
const _tTmp = new Cesium.Cartesian3();
const _m3t = new Cesium.Matrix3();
const _vt = new Cesium.Cartesian3();
const _enuT = new Cesium.Matrix4();
const _invT = new Cesium.Matrix4();
const _locT = new Cesium.Cartesian3();
const _eastV = new Cesium.Cartesian3();
const _northV = new Cesium.Cartesian3();
const _upV = new Cesium.Cartesian3();
let frameDt = 0.016;   // 最近一帧 dt（相机回归混合用）
const _dbg = { dir: [0, 0, 0], exhaust: [0, 0, 0] };   // 冒烟：最近一帧飞行方向/喷流方向（ENU）

/** 求把 ENU 天顶(0,0,1) 旋到单位向量 dir 的四元数（机头/焰柱对准用） */
function quatUpTo(dir, out) {
  const d = Cesium.Cartesian3.dot(Cesium.Cartesian3.UNIT_Z, dir);
  if (d > 0.999999) return Cesium.Quaternion.clone(Cesium.Quaternion.IDENTITY, out);
  if (d < -0.999999) return Cesium.Quaternion.fromAxisAngle(Cesium.Cartesian3.UNIT_X, Math.PI, out);
  Cesium.Cartesian3.cross(Cesium.Cartesian3.UNIT_Z, dir, _dir2);
  Cesium.Cartesian3.normalize(_dir2, _dir2);
  return Cesium.Quaternion.fromAxisAngle(_dir2, Math.acos(Math.max(-1, Math.min(1, d))), out);
}

/** [lon,lat,alt] 路径 a→b 的切向单位向量（ENU：东/北/天，米制近似） */
function tangentENU(a, b, out) {
  const latMid = Cesium.Math.toRadians((a[1] + b[1]) / 2);
  const east = (b[0] - a[0]) * Cesium.Math.toRadians(1) * 6378137 * Math.cos(latMid);
  const north = (b[1] - a[1]) * Cesium.Math.toRadians(1) * 6356752;
  const up = b[2] - a[2];
  const len = Math.hypot(east, north, up);
  if (len < 1e-9) return Cesium.Cartesian3.clone(Cesium.Cartesian3.UNIT_Z, out);
  return Cesium.Cartesian3.normalize(new Cesium.Cartesian3(east, north, up), out);
}

/** 模型落位：modelMatrix = ENU(cart, ellipsoid) * R(quat)。quat 为 ENU 系内旋转 */
function placeModel(slot, cart, quat, ellipsoid) {
  const m = slot.model;
  if (!m || m.isDestroyed()) return;
  Cesium.Matrix3.fromQuaternion(quat, _m3);
  Cesium.Matrix4.fromRotationTranslation(_m3, Cesium.Cartesian3.ZERO, _rotM);
  Cesium.Transforms.eastNorthUpToFixedFrame(cart, ellipsoid, _enuM);
  Cesium.Matrix4.multiply(_enuM, _rotM, slot.mat);
  m.modelMatrix = slot.mat;
}

/** 模型落位（带缩放，火焰油门用）：ENU * R * S */
function placeModelS(slot, cart, quat, scale, ellipsoid) {
  const m = slot.model;
  if (!m || m.isDestroyed()) return;
  Cesium.Matrix3.fromQuaternion(quat, _m3);
  Cesium.Matrix4.fromRotationTranslation(_m3, Cesium.Cartesian3.ZERO, _rotM);
  _scaleV.x = _scaleV.y = _scaleV.z = scale;
  Cesium.Matrix4.fromScale(_scaleV, _scaleM);
  Cesium.Matrix4.multiply(_rotM, _scaleM, _rotM);
  Cesium.Transforms.eastNorthUpToFixedFrame(cart, ellipsoid, _enuM);
  Cesium.Matrix4.multiply(_enuM, _rotM, slot.mat);
  m.modelMatrix = slot.mat;
}

/** 模型绕固定 ENU 轴翻滚（分离件用） */
function tumbleQuat(axis, angle, out) {
  return Cesium.Quaternion.fromAxisAngle(axis, angle, out);
}

  /** 沿地表法线抬升 h 米（火焰挂喷口、避开月面用） */
  function offsetUp(cart, h, out) {
    const n = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(cart, out ?? new Cesium.Cartesian3());
    return Cesium.Cartesian3.add(cart, Cesium.Cartesian3.multiplyByScalar(n, h, _vec), out ?? new Cesium.Cartesian3());
  }

  /** ENU 米制偏移：cart + e·East + n·North + u·Up（分离件弹道、相机微调用） */
  function offsetENU(cart, e, n, u, out) {
    Cesium.Transforms.eastNorthUpToFixedFrame(cart, Cesium.Ellipsoid.WGS84, _enuT);
    Cesium.Matrix4.getColumn(_enuT, 0, _eastV);    // East 轴
    Cesium.Matrix4.getColumn(_enuT, 1, _northV);   // North 轴
    Cesium.Matrix4.getColumn(_enuT, 2, _upV);      // Up 轴
    const r = out ?? new Cesium.Cartesian3();
    r.x = cart.x + _eastV.x * e + _northV.x * n + _upV.x * u;
    r.y = cart.y + _eastV.y * e + _northV.y * n + _upV.y * u;
    r.z = cart.z + _eastV.z * e + _northV.z * n + _upV.z * u;
    return r;
  }

/** 火焰/喷气特效：exhaustDir = 喷流方向（模型 +Y 对准它）；null 或 scale<=0 时隐藏 */
function updateFlame(viewer, cart, exhaustDir, scale, ellipsoid) {
  const fx = getFx(viewer, 'flame');
  if (!fx || !attachIfReady(fx)) return;
  if (!exhaustDir || !(scale > 0)) { fx.model.show = false; return; }
  fx.model.show = true;
  placeModelS(fx, cart, quatUpTo(exhaustDir, _q2), scale, ellipsoid);
}

function updateRcs(viewer, cart, jetDir, scale, ellipsoid) {
  const fx = getFx(viewer, 'rcs');
  if (!fx || !attachIfReady(fx)) return;
  if (!jetDir || !(scale > 0)) { fx.model.show = false; return; }
  fx.model.show = true;
  placeModelS(fx, cart, quatUpTo(jetDir, _q3), scale, ellipsoid);
}

// —— 相机：AUTO 脚本机位 / MANUAL 用户接管（2026-10-18 双模式定版） ——
// 设计（用户拍板）：
//   • 「看哪里」归脚本、「从哪看」归用户：AUTO 按每幕关键帧默认机位；用户拖拽/滚轮
//     即进入 MANUAL 并**永久保持**（不定时拉回）。MANUAL 下关注点照常跟随飞行器
//     （applyManualFollow：参考系原点跟目标走、用户的 heading/pitch/range 原样保留），
//     分离特写等关键帧机位切换一律不生效。
//   • 跨幕（actKey 变化）/ 停止 / 点「🎯 推荐视角」→ 回 AUTO；同 viewer 内平滑混合，
//     地月跨 viewer（容器都换了）瞬切。
//   • 第二幕例外：默认机位是「轨道面法向俯瞰地月全局」（世界位姿，无 lookAt 参考系），
//     MANUAL 下完全自由视角（38 万 km 尺度下飞行器只是一个点，跟随没有意义）。
let camOverride = false;      // MANUAL：用户已接管
let camHookViewer = null;     // 用户正在操作的 viewer
let blendT = 0;               // >0：AUTO 过渡混合进行中（0..1）
let blendFrom = null;         // { pos, dir, up } 过渡起始世界位姿
let camRangeScale = 1;        // 导航缩放按钮的持久缩放（脚本 range 乘子）
const BLEND_SEC = 1.4;        // 「🎯 推荐视角」/跨幕回默认的平滑过渡时长

function resetCamOverride() {
  camOverride = false; blendT = 0; blendFrom = null;
}

/** 从当前世界位姿启动一次到脚本机位的平滑过渡（「🎯 推荐视角」/跨幕回默认时用） */
function startBlendFrom(v) {
  blendFrom = null;
  try {
    blendFrom = {
      pos: Cesium.Cartesian3.clone(v.camera.positionWC),
      dir: Cesium.Cartesian3.clone(v.camera.directionWC),
      up: Cesium.Cartesian3.clone(v.camera.upWC),
    };
  } catch { /* 相机未就绪 */ }
  blendT = blendFrom ? 0.0001 : 0;
  camOverride = false;
}

function hookCamera(v) {
  if (!v || !v.scene || !v.scene.canvas || v.__moonCamHook) return;
  v.__moonCamHook = true;
  const canvas = v.scene.canvas;
  // DOM 级监听（不走 ScreenSpaceEventHandler，避免与其他输入动作争抢）。
  // 任何拖拽/滚轮 → MANUAL 并保持（2026-10-18：不再定时回归）。
  canvas.addEventListener('pointerdown', () => {
    camHookViewer = v; camOverride = true; blendT = 0; blendFrom = null;
  });
  canvas.addEventListener('wheel', () => {
    camHookViewer = v; camOverride = true; blendT = 0; blendFrom = null;
  }, { passive: true });
}

/** 右上角导航控件（cesium-navigation）接管：指南针/缩放/重置进入 MANUAL（保持用户视角） */
function hookNavControls(root, v) {
  if (!root || root.__moonNavHook) return;
  root.__moonNavHook = true;
  root.addEventListener('pointerdown', (e) => {
    camHookViewer = v || camHookViewer;
    camOverride = true; blendT = 0; blendFrom = null;
    const t = e.target;
    const closest = (sel) => (t && t.closest ? t.closest(sel) : null);
    if (closest('.navigation-control-icon-zoom-in')) {
      camRangeScale = Math.max(0.12, camRangeScale / 1.8);
    } else if (closest('.navigation-control-icon-zoom-out')) {
      camRangeScale = Math.min(8, camRangeScale * 1.8);
    } else if (closest('.navigation-control-icon-reset')) {
      camRangeScale = 1;
    }
  });
}

/** 脚本机位（可被导航缩放持久缩放的版本）：跟随类机位一律走这里 */
function applyFollow(v, target, heading, pitch, range) {
  applyCamera(v, target, heading, pitch, range * camRangeScale);
}

const _bp = new Cesium.Cartesian3();
const _bd = new Cesium.Cartesian3();
const _bu = new Cesium.Cartesian3();

/** 相机混合尾部：把相机从 blendFrom 世界位姿插值到目标世界位姿（pos/dir/up） */
function blendCameraTo(v, destPos, destDir, destUp) {
  if (blendT > 0 && blendFrom) {
    const k = easeInOut(Math.min(1, blendT));
    v.camera.setView({
      destination: Cesium.Cartesian3.lerp(blendFrom.pos, destPos, k, new Cesium.Cartesian3()),
      orientation: {
        direction: Cesium.Cartesian3.normalize(Cesium.Cartesian3.lerp(blendFrom.dir, destDir, k, new Cesium.Cartesian3()), new Cesium.Cartesian3()),
        up: Cesium.Cartesian3.normalize(Cesium.Cartesian3.lerp(blendFrom.up, destUp, k, new Cesium.Cartesian3()), new Cesium.Cartesian3()),
      },
    });
    blendT += frameDt / BLEND_SEC;
    if (blendT >= 1) { blendT = 0; blendFrom = null; }
  }
}

function applyCamera(v, target, heading, pitch, range) {
  if (!v) return;
  if (camOverride) return;   // MANUAL：机位归用户（关注点由 applyManualFollow 跟随）
  v.camera.lookAt(target, new Cesium.HeadingPitchRange(heading, pitch, range));
  if (blendT > 0 && blendFrom) {
    // 脚本位姿 = lookAt 后的世界位姿；读回后切世界模式做插值覆盖
    Cesium.Cartesian3.clone(v.camera.positionWC, _bp);
    Cesium.Cartesian3.clone(v.camera.directionWC, _bd);
    Cesium.Cartesian3.clone(v.camera.upWC, _bu);
    v.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    blendCameraTo(v, _bp, _bd, _bu);
  }
}

/** 世界位姿版 applyCamera（第二幕顶视用）：直接给相机位置/视线/上方向。
 *  先清 lookAt 参考系——残留参考系会让用户拖拽绕旧目标转、且 MANUAL 判定失准。 */
function applyCameraPose(v, camPos, dir, up) {
  if (!v) return;
  if (camOverride) return;
  try { v.camera.lookAtTransform(Cesium.Matrix4.IDENTITY); } catch { /* 忽略 */ }
  v.camera.setView({ destination: camPos, orientation: { direction: dir, up } });
  blendCameraTo(v, camPos, dir, up);
}

/** MANUAL 模式：关注点跟随 + 用户视角保持（2026-10-18 双模式核心）。
 *  相机处于 lookAt 参考系时读 camera.heading/pitch/range（= 用户拖拽/缩放的结果），
 *  再 lookAt 到移动后的目标——参考系原点跟着飞行器走，用户视角原样保留；
 *  无参考系/读数异常时静默跳过 = 完全自由视角（第二幕即走这条路）。
 *  右上角 cesium-navigation 控件（指南针/缩放）的「绕谁转」由 vendored 的
 *  Utils.getCameraFocus / ZoomNavigationControl.zoom 补丁决定——二者在相机处于
 *  lookAt 参考系(transform≠单位阵)时改取参考系原点(巡游物)，故控件也绕巡游物而非球体。 */
function applyManualFollow(v, target) {
  if (!v || !camOverride || !target) return;
  try {
    const h = v.camera.heading;
    const pi = v.camera.pitch;
    const r = v.camera.range;
    if (!isFinite(h) || !isFinite(pi) || !isFinite(r) || !(r > 0)) return;
    // 防手动镜头钻入球体内部（用户反馈）：target 在球面时，pitch 越过地平线到目标下方
    // （pitch>0，仰视）即穿球；range 过小则近裁剪面切入地表。两处各加一道下限。
    const ell = (v.scene.globe && v.scene.globe.ellipsoid) ? v.scene.globe.ellipsoid : Cesium.Ellipsoid.WGS84;
    const minR = ell.maximumRadius * 0.0008;            // 到 target 的最小距离（地球 ~5.1km / 月球 ~1.4km）
    if (r < minR) r = minR;
    const maxPitch = Cesium.Math.toRadians(-3);          // 不允许仰视越过地平线（防穿球；俯视/侧视全保留）
    if (pi > maxPitch) pi = maxPitch;
    v.camera.lookAt(target, new Cesium.HeadingPitchRange(h, pi, r));
  } catch { /* 无参考系：自由视角 */ }
}

/** 视角模式徽标（AUTO=自动视角 / MANUAL=🎯 推荐视角按钮可点） */
function updateCamBadge() {
  const b = document.getElementById('tourCamMode');
  if (!b) return;
  if (camOverride) {
    b.textContent = '🎯 推荐视角';
    b.title = '当前为手动视角（跨幕恢复默认）；点击回到本幕推荐机位';
    b.classList.add('manual');
  } else {
    b.textContent = '👁 自动视角';
    b.title = '脚本机位跟随中；拖拽画面或滚轮即可接管视角';
    b.classList.remove('manual');
  }
}

/**
 * 创建探月任务控制器
 * @param {object} opts
 *   earthViewer  地球 Viewer
 *   env          { showMoon(), showEarth(), getMoonViewer(), onStatus() }
 */
export function createMoonMission(opts) {
  const { earthViewer, env } = opts;
  earthViewerRef = earthViewer;
  hookCamera(earthViewer);
  // 右上角导航控件（cesium-navigation）：第一幕/第三幕保留可操作（用户反馈 2026-10-17），
  // 缩放量写入 camRangeScale，脚本机位按用户缩放持久跟随。
  hookNavControls(document.querySelector('.cesium-widget-cesiumNavigationContainer'), earthViewer);

  let raf = 0, last = 0;
  let p = 0, playing = false, mult = 1;
  let launchSiteKey = 'wenchang';
  let landingSiteKey = 'imbrium';
  let inMoon = false;
  let _wasPlaying = false;  // 拖拽进度条前的播放态（松手恢复）
  let _trackDragging = false; // 只有时间轴上按下才 seek（2026-10-17：画布拖动不再影响时序）

  // 路径数据（start/seekTo 时生成）
  let earthPath = [];      // 第一幕上升段 [lon,lat,alt]
  let transferCarts = [];  // 第二幕转移椭圆（霍曼）Cartesian3（画线用，实线：行径弧）
  let mirrorCarts = [];    // 转移椭圆未飞的对称半段（淡虚线：让椭圆形状可读）
  let emLineCarts = [];    // 地月连线（虚直线：地球质心 ↔ 月心，随月球移动）
  let moonOrbitCarts = []; // 月球绕地轨道环 Cartesian3
  let launchCarts = [];    // 已飞发射轨迹 Cartesian3（逐帧追加）
  let trailCarts = [];     // 已飞转移轨迹 Cartesian3（每帧取前缀）
  let phasingCarts = [];   // 调相段 2 圈渐扩椭圆（画线用）
  let captureCarts = [];   // 捕获段 2 圈渐收椭圆（绕显示月球，画线用）
  let lastLaunch = null;   // 发射轨迹上一次追加点（节流）

  // 实体
  let earthRocket = null;
  let launchTrailEnt = null;   // 发射轨迹线
  let transferFullEnt = null;  // 转移规划航线（霍曼椭圆，实线）
  let phasingEnt = null;       // 调相段 2 圈渐扩椭圆（嫦娥轨道）
  let captureEnt = null;       // 捕获段 2 圈渐收椭圆（绕显示月球）
  let phaseLabelEnts = [];     // 三段轨道标注（调相段/地月转移段/月球捕获段）
  let transferMirrorEnt = null;// 椭圆未飞半段（淡虚线，示意完整椭圆）
  let emLineEnt = null;        // 地月连线（虚直线）
  let transferTrailEnt = null; // 已飞转移轨迹（亮线）
  let transferLabelEnt = null; // 转移轨道标注
  let moonEnt = null;          // 月球实体（球体 + 标签）
  let moonOrbitEnt = null;     // 月球绕地轨道环（淡）
  let padDustEnt = null;       // 发射台灰尘（第一幕点火初期）
  let landDustEnt = null;      // 触月激尘（第三幕末）
  let moonRing = null;
  let moonCraft = null;
  let descentArcEnt = null;  // 动力下降段子午线大圆弧（淡虚线）
  let loiTrailEnt = null;    // LOI 已飞行径弧（赤道）
  let loiTrailCarts = [];
  let roverTrackEnt = null;   // 玉兔车辙（已行驶路线）
  let roverTrackCarts = [];   // 车辙 Cartesian3（逐帧前缀）
  // 分离件（第一幕临时实体）
  let boosters = [];    // [{ent, dir, axis, slot}]
  let fairings = [];    // [{ent, dir, axis, slot}]

  // 事件绑定引用
  let onPause = null, onStop = null, onSlower = null, onFaster = null;
  let onTrackDown = null, onTrackMove = null, onTrackUp = null;

  // 第一幕入轨注入点相对发射台的偏置（lon°E, lat°N, alt m）——makeEarthPath 与
  // buildTransferGeom 共用同一常量，保证「第一幕终点 = 第二幕转移轨道近地点」严格重合。
  const INJ_OFF = [2.2, 1.05, 200000];

  // 第一幕上升段轨迹（2026-10-17 用户反馈「折线不科学」→ 重力转弯数值积分）：
  //   在「发射方位–天顶」平面内按航迹角程序 γ(s)（90°→8°）与速度剖面 v(s) 积分弧长，
  //   再把 (下漂, 高度) 归一化到真实注入点——终点与 buildTransferGeom 的 inj 严格一致。
  //   ⚠ 改注入偏移必须改上面的 INJ_OFF，两处同源。
  function makeEarthPath(pad) {
    const latR = Cesium.Math.toRadians(pad.lat);
    const dE = INJ_OFF[0] * Cesium.Math.toRadians(1) * 6378137 * Math.cos(latR);  // 注入点东向偏置（m）
    const dN = INJ_OFF[1] * Cesium.Math.toRadians(1) * 6356752;                   // 注入点北向偏置（m）
    const az = Math.atan2(dE, dN);          // 发射方位角（自北顺时针）
    const D = Math.hypot(dE, dN);           // 注入点地表投影距（m）
    const H = INJ_OFF[2];                   // 注入高度（m）
    const N = 128;
    const xs = [0], ys = [0];
    for (let i = 1; i <= N; i++) {
      const s = i / N;
      // 航迹角（与水平面夹角）：竖直起步，程序转弯下垂，入轨近水平
      const gamma = (8 + 82 * Math.pow(1 - s, 1.6)) * Cesium.Math.RADIANS_PER_DEGREE;
      // 速度剖面：起步慢（垂直段）→ 转弯后加速（入轨）
      const v = 0.25 + 0.75 * Math.pow(s, 0.75);
      const dl = v / N;
      xs.push(xs[i - 1] + dl * Math.cos(gamma));
      ys.push(ys[i - 1] + dl * Math.sin(gamma));
    }
    const sx = D / xs[N], sy = H / ys[N];
    const lonScale = 111319.5 * Math.cos(latR);   // 经度米/度（按发射台纬度取常数 → 终点与 inj 严格一致）
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const x = xs[i] * sx;            // 沿方位角的下漂距离（m）
      const north = x * Math.cos(az), east = x * Math.sin(az);
      pts.push([
        pad.lon + east / lonScale,
        pad.lat + north / 110946,
        ys[i] * sy,
      ]);
    }
    return pts;
  }

  // —— 霍曼转移椭圆（第二幕科学化，2026-10-17） ——
  // 牛顿迭代解开普勒方程 E - e·sinE = M（高偏心率 0.983 也收敛）
  function keplerE(M, e) {
    let E = M;
    for (let i = 0; i < 24; i++) {
      const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
      E -= d;
      if (Math.abs(d) < 1e-12) break;
    }
    return E;
  }

  // 转移轨道几何：轨道面由「注入点 + 注入速度方向」确定，远地点在注入点对趾，
  // 月球抵达位 = 远地点（会合）。TR 在 buildPathData 时构建。
  let TR = null;
  function buildTransferGeom(pad) {
    const inj = [pad.lon + INJ_OFF[0], pad.lat + INJ_OFF[1], INJ_OFF[2]];   // 入轨注入点（与第一幕终点一致）
    const e1 = Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.fromDegrees(inj[0], inj[1], inj[2]), new Cesium.Cartesian3());
    const lonR = Cesium.Math.toRadians(inj[0]), latR = Cesium.Math.toRadians(inj[1]);
    // 顺行发射 → 注入速度 ≈ 当地东向
    Cesium.Cartesian3.normalize(new Cesium.Cartesian3(
      -Math.sin(lonR) * Math.cos(latR), Math.cos(lonR) * Math.cos(latR), Math.sin(latR)), _eastV);
    // ⭐⭐ 必须用**专属对象**，绝不能用共享暂存 _tTmp（2026-10-19 根因级修复）。
    // 旧版 e2 = normalize(..., _tTmp) 返回的就是 _tTmp 本身 → TR.e2 与共享暂存是同一个对象；
    // 之后任何 multiplyByScalar(TR.e2, k, _tTmp) 都会**就地缩放基向量**：
    //   ① 首帧 i=0 时 sinν=0 → e2 被乘成零向量 → 所有椭圆 y 分量归零 → **退化成过地心的直线**
    //      （这才是用户「看不到一圈一圈霍曼椭圆」的真根因，前几轮的相机/近地点修复全在打偏）；
    //   ② 之后 lookAtTransfer 的 nrm×range 写入 _tTmp → e2 变成 1.3e8 倍法向量，
    //      再被逐帧累乘到 3e15 → 飞船位置爆到 1e16 m。
    const e2 = Cesium.Cartesian3.normalize(Cesium.Cartesian3.subtract(
      _eastV,
      Cesium.Cartesian3.multiplyByScalar(e1, Cesium.Cartesian3.dot(_eastV, e1), new Cesium.Cartesian3()),
      new Cesium.Cartesian3()), new Cesium.Cartesian3());
    const nrm = Cesium.Cartesian3.cross(e1, e2, new Cesium.Cartesian3());
    TR = { e1, e2, nrm, inj };
  }

  /** 转移椭圆上位置（世界坐标）：s∈[0,1] 近地点→与月球会合处（略过远地点前），
   *  位置 = r·(cos ν·e1 + sin ν·e2)。⚠ s=1 对应 M=Menc（会合点）而非 π（远地点）——
   *  飞船在抵达月球轨道外侧时即被月球捕获，不会飞到 405,000 km 的远地点。 */
  function transferCartAt(s) {
    const s01 = clamp01(s);
    const M = EM.Menc * s01;
    const E = keplerE(M, EM.e);
    const r = EM.a * (1 - EM.e * Math.cos(E));
    const nu = Math.atan2(Math.sqrt(1 - EM.e * EM.e) * Math.sin(E), Math.cos(E) - EM.e);
    const cart = new Cesium.Cartesian3();
    Cesium.Cartesian3.multiplyByScalar(TR.e1, r * 1000 * Math.cos(nu), cart);
    Cesium.Cartesian3.multiplyByScalar(TR.e2, r * 1000 * Math.sin(nu), _tTmp);
    return Cesium.Cartesian3.add(cart, _tTmp, cart);
  }

  /** 转移椭圆上位置（[lon, lat, altM]） */
  function transferPosAt(s) {
    const c = Cesium.Cartographic.fromCartesian(transferCartAt(s), Cesium.Ellipsoid.WGS84, new Cesium.Cartographic());
    return [Cesium.Math.toDegrees(c.longitude), Cesium.Math.toDegrees(c.latitude), c.height];
  }

  /** 月球方向单位向量（世界）：第二幕全长（322 h）内沿轨道面顺行扫过 ~177°，
   *  会合时刻（s = P2.enc）方向恰 = 飞船抵达方向 EM.nuEnc。 */
  function moonDirAt(s) {
    const ang = EM.moonThetaEnc + EM.moonOmega * (CH_TOTAL_H * clamp01(s) - CH_TPH) * 3600;
    Cesium.Quaternion.fromAxisAngle(TR.nrm, ang, _q);
    Cesium.Matrix3.fromQuaternion(_q, _m3t);
    return Cesium.Matrix3.multiplyByVector(_m3t, TR.e1, _vt);
  }

  /** 月球中心（世界坐标）：月心距 = 真实地月距 384,400 km（不再外推 +9.4%）。 */
  function moonCartAt(s) {
    return Cesium.Cartesian3.multiplyByScalar(moonDirAt(s), EM.moonC * 1000, new Cesium.Cartesian3());
  }

  /** 椭圆轨道面内位置（焦点在原点，km）：M 平近点角、近点方向 d1、顺行 d2。 */
  function ellipseKM(aKm, eK, M, d1, d2) {
    const E = keplerE(M, eK);
    const r = aKm * (1 - eK * Math.cos(E));
    const nu = Math.atan2(Math.sqrt(1 - eK * eK) * Math.sin(E), Math.cos(E) - eK);
    return [r * Math.cos(nu), r * Math.sin(nu)];   // [沿 d1, 沿 d2]
  }

  /** 通用档位解析：进度 u∈[0,1]（与真实小时线性对应）→ { oi 轨道序号, li 圈序号, cu 圈内进度 }。
   *  三段轨道共 7 圈，每圈耗时 = 该档真实周期（16h/24h/48h），圈内自近地点(近月点)起跑。 */
  function orbitState(orbits, totalH, u) {
    const h = clamp01(u) * totalH;
    let acc = 0;
    for (let oi = 0; oi < orbits.length; oi++) {
      for (let li = 0; li < orbits[oi].laps; li++) {
        const per = orbits[oi].per;
        const last = oi === orbits.length - 1 && li === orbits[oi].laps - 1;
        if (h < acc + per || last) return { oi, li, cu: last ? 1 : clamp01((h - acc) / per) };
        acc += per;
      }
    }
    return { oi: orbits.length - 1, li: orbits[orbits.length - 1].laps - 1, cu: 1 };
  }
  const phasingState = (u) => orbitState(PH, CH_H.phasing, u);
  const captureState = (u) => orbitState(CA, CH_H.capture, u);

  /** 调相段位置（世界坐标，米）：三条离散椭圆 16h→24h→48h 共 7 圈，每圈自近地点起跑。
   *  ⭐ 三条椭圆的近地点几乎重合（6583 / 6971 / 6971 km）→ 左端汇聚一点、向远地点层层张开，
   *    一眼就是三个渐扩的圈（旧版连续渐变 = 螺旋，读不出圈）。 */
  function phasingCartAt(u) {
    const { oi, cu } = phasingState(u);
    const o = PH[oi];
    const [px, py] = ellipseKM(o.a, o.e, Math.PI * 2 * cu, TR.e1, TR.e2);
    const cart = Cesium.Cartesian3.multiplyByScalar(TR.e1, px * 1000, new Cesium.Cartesian3());
    Cesium.Cartesian3.multiplyByScalar(TR.e2, py * 1000, _tTmp);
    return Cesium.Cartesian3.add(cart, _tTmp, cart);
  }

  /** 捕获段位置（世界坐标，米）：三条离散环月轨道 12h→3.5h→127min 共 7 圈，每圈自近月点起跑。
   *  近月点方向 = 月心**背地**方向（径向外）——正是真实嫦娥 LOI 制动所在的月球背面；
   *  绕行方向取逆行（d2 = r̂ × nrm），与飞船抵达时相对月球的运动方向一致。
   *  ⚠ 椭圆整体跟随月球当前位置（旧版用固定 moonCartAt(1)，捕获段月球会与其轨道分离 5.2 万 km）。
   *  ⚠ 2026-10-19：环月轨道随月球视觉倍率 exag 等比缩放（月系整体放大），默认用捕获段的 ×8。 */
  function captureCartAt(u, exag = MOON_EXAG_NEAR, orbits = CA) {
    const u01 = clamp01(u);
    const { oi, cu } = orbitState(orbits, CH_H.capture, u01);
    const o = orbits[oi];
    const s = P2.enc + (1 - P2.enc) * u01;   // 该时刻地月段进度（月球在动）
    const mc = moonCartAt(s);
    const rhat = Cesium.Cartesian3.clone(moonDirAt(s), new Cesium.Cartesian3());   // 径向外 = 背地
    const that = Cesium.Cartesian3.cross(rhat, TR.nrm, new Cesium.Cartesian3());   // 逆行切向
    const [px, py] = ellipseKM(o.a, o.e, Math.PI * 2 * cu, rhat, that);
    const cart = Cesium.Cartesian3.multiplyByScalar(rhat, px * 1000, new Cesium.Cartesian3());
    Cesium.Cartesian3.multiplyByScalar(that, py * 1000, _tTmp);
    Cesium.Cartesian3.add(mc, Cesium.Cartesian3.add(cart, _tTmp, cart), cart);
    return cart;
  }

  /** 环月轨道线随月球视觉倍率重建（月系整体等比缩放）。
   *  ⚠ 只在倍率变化 >0.02 时重算，避免每帧 841 次开普勒求解；捕获段倍率恒定 ×8 → 只建一次。 */
  let _caExag = -1;
  function rebuildCaptureCarts(exag) {
    captureCarts = [];
    _caExag = exag;
    const orbits = caAt(exag);
    for (let i = 0; i <= 840; i++) captureCarts.push(captureCartAt(i / 840, exag, orbits));
  }

  /** 调相段喷焰：只在「换轨」那一圈的近地点点火（16h→24h、24h→48h）。
   *  ⚠ 同轨道内重复绕行不点火——真实 24h 轨道连飞 3 圈是把 1 天发射窗口扩成 3 天，期间无动力。 */
  function phasingBurn(u) {
    const { oi, li, cu } = phasingState(u);
    return (li === 0 && oi > 0 && cu < 0.06) ? 1.5 : 0;
  }

  /** 捕获段喷焰：三条轨道各自首圈的近月点逆向制动（LOI-1 / LOI-2 / LOI-3）。 */
  function captureBurn(u) {
    const { li, cu } = captureState(u);
    return (li === 0 && cu < 0.08) ? 1.2 : 0;
  }

  function buildPathData() {
    const pad = LAUNCH_SITES[launchSiteKey];
    earthPath = makeEarthPath(pad);
    buildTransferGeom(pad);
    transferCarts = [];
    mirrorCarts = [];
    for (let i = 0; i <= 256; i++) {
      const c = transferCartAt(i / 256);
      transferCarts.push(c);
      // 未飞半段 = 关于拱线（e1）的镜像：把面内 e2 分量取反 → 与已飞弧合成完整椭圆
      const a = Cesium.Cartesian3.dot(c, TR.e1);
      const b = Cesium.Cartesian3.dot(c, TR.e2);
      const m = Cesium.Cartesian3.multiplyByScalar(TR.e1, a, new Cesium.Cartesian3());
      Cesium.Cartesian3.multiplyByScalar(TR.e2, -b, _tTmp);
      mirrorCarts.push(Cesium.Cartesian3.add(m, _tTmp, m));
    }
    emLineCarts = [new Cesium.Cartesian3(0, 0, 0), moonCartAt(0)];
    moonOrbitCarts = [];
    for (let i = 0; i <= 128; i++) {
      // 月球绕地轨道 = 转移轨道面内的圆（半径 = 地月距 + 捕获远月点间距，与月心一致）
      const ang = (i / 128) * Math.PI * 2;
      Cesium.Quaternion.fromAxisAngle(TR.nrm, ang, _q);
      Cesium.Matrix3.fromQuaternion(_q, _m3t);
      const d = Cesium.Matrix3.multiplyByVector(_m3t, TR.e1, new Cesium.Cartesian3());
      moonOrbitCarts.push(Cesium.Cartesian3.multiplyByScalar(d, EM.moonC * 1000, new Cesium.Cartesian3()));
    }
    // 嫦娥三段轨道线：调相 7 圈（三条离散椭圆，地心系）+ 捕获 7 圈（三条离散环月轨道）
    // 采样密度随圈数提高：7 圈共 1200 点 ≈ 171 点/圈，保证最外圈（48h 大椭圆）不呈折线。
    phasingCarts = [];
    for (let i = 0; i <= 1200; i++) phasingCarts.push(phasingCartAt(i / 1200));
    rebuildCaptureCarts(MOON_EXAG_NEAR);
    _ovView = null;          // 定场取景缓存随轨迹重建失效
    launchCarts = [];
    lastLaunch = null;
    trailCarts = transferCarts.slice(0, 1);
  }

  // ---- 地球火箭（billboard 沿飞行方向旋转，形态随分离阶段切换）----
  // force=true：按当前 launchSiteKey 原地重建（发射前切换发射场用，2026-10-17）
  function ensureEarthRocket(force = false) {
    const pad = LAUNCH_SITES[launchSiteKey];
    if (earthRocket && !force) return;
    if (earthRocket) { earthViewer.entities.remove(earthRocket); earthRocket = null; }
    if (padDustEnt) { earthViewer.entities.remove(padDustEnt); padDustEnt = null; }
    earthRocket = earthViewer.entities.add({
      id: 'moonMissionRocket',
      position: Cesium.Cartesian3.fromDegrees(pad.lon, pad.lat, 0),
      billboard: {
        image: FULL_ROCKET_ICON,
        width: 34,
        height: 34,
        rotation: 0,
        alignedAxis: Cesium.Cartesian3.UNIT_Z,
        heightReference: Cesium.HeightReference.NONE,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: '长征五号 · 点火升空',
        font: '12px "Microsoft YaHei", sans-serif',
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -26),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        showBackground: true,
        backgroundColor: new Cesium.Color(0.05, 0.08, 0.18, 0.7),
        backgroundPadding: new Cesium.Cartesian2(6, 4),
      },
    });
    if (!padDustEnt) {
      padDustEnt = earthViewer.entities.add({
        id: 'moonPadDust',
        position: Cesium.Cartesian3.fromDegrees(pad.lon, pad.lat, 1),
        ellipse: {
          height: 1,
          radii: new Cesium.Cartesian3(1, 1, 1),
          material: Cesium.Color.WHITE.withAlpha(0),
        },
      });
    }
  }

  /**
   * 发射前预览（2026-10-17 用户反馈）：
   * 「还没发射，选择不同的发射场时镜头就应该随之转过去，并竖起火箭
   *  （而不是要点击发射才开始转场出现火箭）」。
   * 行为：按当前 launchSiteKey 把整箭竖立于发射台、相机取景（箭体+发射台同框）。
   * 仅任务未播放（!raf）且无巡礼时生效；播放中相机归脚本机位，不抢镜。
   */
  function previewLaunchSite() {
    if (raf) return;
    if (isRouteTourActive()) return;
    env.showEarth();                 // 幂等：在月球模式则先切回地球容器
    ensureEarthRocket(true);         // 换发射场 → 火箭搬家（按当前 key 重建）
    if (!earthRocket) return;
    const pad = LAUNCH_SITES[launchSiteKey];
    earthRocket.show = true;
    earthRocket.label.text = `长征五号 · 待发射（${pad.name}）`;
    // 特效全收（点火前不喷火、不扬尘）
    updateFlame(earthViewer, null, null, 0, Cesium.Ellipsoid.WGS84);
    updateRcs(earthViewer, null, null, 0, Cesium.Ellipsoid.WGS84);
    if (padDustEnt) padDustEnt.ellipse.material = Cesium.Color.WHITE.withAlpha(0);
    // 相机取景：从东南低空侧望箭体（先清 lookAt 变换，避免与旧参考系叠加）
    try { earthViewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY); } catch { /* 忽略 */ }
    resetCamOverride();
    // 按真实地形高程落位 + 取景（2026-10-17：酒泉海拔 ~1 km，0 高程会把火箭和相机
    // 都埋进地下）。同步先按 0 落一帧（模型/相机立刻就位），异步采样回真实高程再贴地。
    const placeAt = (groundH) => {
      const cart = Cesium.Cartesian3.fromDegrees(pad.lon, pad.lat, groundH);
      earthRocket.position = cart;
      // 竖立于发射台：整箭模型 +Y=天顶（Cesium Y→Z 校正后 identity 即竖直）
      const slot = getRocketSlot();
      if (attachIfReady(slot)) {
        earthRocket.billboard.show = false;
        hideSlot(rocketCoreSlot); hideSlot(craftSlot); showSlot(slot);
        placeModel(slot, cart, Cesium.Quaternion.IDENTITY, Cesium.Ellipsoid.WGS84);
      } else {
        earthRocket.billboard.show = true;
        earthRocket.billboard.image = FULL_ROCKET_ICON;
        earthRocket.billboard.rotation = 0;
      }
      const eastM = 240, southM = 150;                    // 水平偏移（发射台东南侧）
      const latOff = -southM / 110946;
      const lonOff = eastM / (111319.5 * Math.max(0.15, Math.cos(Cesium.Math.toRadians(pad.lat))));
      const camPos = Cesium.Cartesian3.fromDegrees(
        pad.lon + lonOff, pad.lat + latOff, groundH + 150);
      const dir = Cesium.Cartesian3.normalize(
        Cesium.Cartesian3.subtract(cart, camPos, new Cesium.Cartesian3()), new Cesium.Cartesian3());
      const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(cart, new Cesium.Cartesian3());
      applyCameraPose(earthViewer, camPos, dir, up);
    };
    placeAt(0);
    // 地形高程异步采样：相机必须在地表之上（否则地下渲染全黑）。
    // ⚠ 大坑（2026-10-17 实测）：Cesium.sampleTerrainMostDetailed 对本项目的自定义
    //   terrarium provider 直接抛 "computeMaximumLevelAtPosition of undefined"
    //   （CustomHeightmapTerrainProvider 无 availability），被外层 try/catch 吞掉后
    //   按 0 高程取景 → 酒泉火箭/相机都埋进地下 ~1 km。改用同源瓦片采样 sampleTerrainHeight。
    try {
      sampleTerrainHeight(pad.lon, pad.lat)
        .then((h) => { if (!raf) placeAt(h || 0); })
        .catch(() => { /* 保持 0 高程 */ });
    } catch {
      /* 保持 0 高程 */
    }
  }

  // ---- 轨迹、示意月球与月球轨道（地球侧，幂等创建，stop 时统一清理）----
  function ensureTransferScene() {
    if (!transferCarts.length) buildPathData();

    if (!launchTrailEnt) {
      launchTrailEnt = earthViewer.entities.add({
        id: 'moonLaunchTrail',
        polyline: {
          positions: new Cesium.CallbackProperty(() => launchCarts, false),
          width: 3,
          material: Cesium.Color.fromCssColorString('#ff8a5c'),
          arcType: Cesium.ArcType.NONE,
          depthFailMaterial: Cesium.Color.fromCssColorString('#ff8a5c').withAlpha(0.4),
        },
      });
    }
    if (!transferFullEnt) {
      // 2026-10-17 用户反馈「轨道看起来并非椭圆」：规划航线改**实线椭圆弧**
      transferFullEnt = earthViewer.entities.add({
        id: 'moonTransferPath',
        polyline: {
          positions: new Cesium.CallbackProperty(() => transferCarts, false),
          width: 2.4,
          material: Cesium.Color.fromCssColorString('#9ec1ff').withAlpha(0.75),
          depthFailMaterial: Cesium.Color.fromCssColorString('#9ec1ff').withAlpha(0.3),
          arcType: Cesium.ArcType.NONE,
        },
      });
    }
    if (!transferMirrorEnt) {
      // 未飞的对称半段（淡虚线）：两半合起来才看得出这是条椭圆，而不是地月连线
      transferMirrorEnt = earthViewer.entities.add({
        id: 'moonTransferMirror',
        polyline: {
          positions: new Cesium.CallbackProperty(() => mirrorCarts, false),
          width: 1.4,
          material: new Cesium.PolylineDashMaterialProperty({
            color: Cesium.Color.fromCssColorString('#9ec1ff').withAlpha(0.28),
            dashLength: 14,
          }),
          depthFailMaterial: new Cesium.PolylineDashMaterialProperty({
            color: Cesium.Color.fromCssColorString('#9ec1ff').withAlpha(0.14),
            dashLength: 14,
          }),
          arcType: Cesium.ArcType.NONE,
        },
      });
    }
    if (!phasingEnt) {
      // 调相段：三条离散椭圆 16h→24h→48h 共 7 圈（远地点 5.1 万→7.2 万→12 万 km），每次过
      // 近地点点火换轨。depthFail：椭圆近地点半圈插在地球内部，无它则被地球实体吃掉只剩
      // 「两条触角」（用户看不到圈）。
      phasingEnt = earthViewer.entities.add({
        id: 'moonPhasingOrbits',
        polyline: {
          positions: new Cesium.CallbackProperty(() => phasingCarts, false),
          width: 2.2,
          material: Cesium.Color.fromCssColorString('#9ec1ff').withAlpha(0.75),
          depthFailMaterial: Cesium.Color.fromCssColorString('#9ec1ff').withAlpha(0.3),
          arcType: Cesium.ArcType.NONE,
        },
      });
    }
    if (!captureEnt) {
      // 捕获段：绕显示月球三条离散环月轨道 12h→3.5h→127min 共 7 圈，每次过近月点制动减速。
      // 轨道尺寸与显示月球同步 ×8（真实 211×8500 km 轨道会钻进放大月球内部）。
      captureEnt = earthViewer.entities.add({
        id: 'moonCaptureOrbits',
        polyline: {
          positions: new Cesium.CallbackProperty(() => captureCarts, false),
          width: 2.2,
          material: Cesium.Color.fromCssColorString('#9ec1ff').withAlpha(0.75),
          depthFailMaterial: Cesium.Color.fromCssColorString('#9ec1ff').withAlpha(0.3),
          arcType: Cesium.ArcType.NONE,
        },
      });
    }
    if (!phaseLabelEnts.length) {
      // 三段标注（嫦娥一号轨道图样式）：48h 轨道远地点 / 转移中段 / 12h 环月轨道远月点
      const mk = (id, text, pos) => earthViewer.entities.add({
        id,
        position: pos,
        label: {
          text,
          font: '12px "Microsoft YaHei", sans-serif',
          fillColor: Cesium.Color.fromCssColorString('#bcd6ff'),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          showBackground: true,
          backgroundColor: new Cesium.Color(0.05, 0.08, 0.18, 0.55),
          backgroundPadding: new Cesium.Cartesian2(6, 4),
        },
      });
      // 采样点 = 各段最外档椭圆的远地点（进度按「该档累计小时 / 段总小时」换算）
      phaseLabelEnts = [
        mk('moonPhaseLabel1', '调相段 · 16h → 24h → 48h（7 圈 · 7 天）',
          phasingCartAt((CH_PHASING[0].laps * CH_PHASING[0].per + CH_PHASING[1].laps * CH_PHASING[1].per + CH_PHASING[2].per * 0.5) / CH_H.phasing)),
        mk('moonPhaseLabel2', '地月转移段 · 114 小时', transferCartAt(0.5)),
        mk('moonPhaseLabel3', '月球捕获段 · 12h → 3.5h → 127min', captureCartAt(CH_CAPTURE[0].per * 0.5 / CH_H.capture)),
      ];
    }
    if (!emLineEnt) {
      // 地月连线（虚直线）：随月球移动，与实线椭圆弧形成对照
      emLineEnt = earthViewer.entities.add({
        id: 'moonEmLine',
        polyline: {
          positions: new Cesium.CallbackProperty(() => emLineCarts, false),
          width: 1.6,
          material: new Cesium.PolylineDashMaterialProperty({
            color: Cesium.Color.fromCssColorString('#ffd24a').withAlpha(0.5),
            dashLength: 22,
          }),
          depthFailMaterial: new Cesium.PolylineDashMaterialProperty({
            color: Cesium.Color.fromCssColorString('#ffd24a').withAlpha(0.22),
            dashLength: 22,
          }),
          arcType: Cesium.ArcType.NONE,
        },
        label: {
          text: '地月连线 · 384,400 km（虚直线）',
          font: '11px "Microsoft YaHei", sans-serif',
          fillColor: Cesium.Color.fromCssColorString('#ffe9a8'),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          showBackground: true,
          backgroundColor: new Cesium.Color(0.05, 0.08, 0.18, 0.55),
          backgroundPadding: new Cesium.Cartesian2(6, 4),
        },
      });
    }
    if (!transferTrailEnt) {
      transferTrailEnt = earthViewer.entities.add({
        id: 'moonTransferTrail',
        polyline: {
          positions: new Cesium.CallbackProperty(() => trailCarts, false),
          width: 3,
          material: Cesium.Color.fromCssColorString('#ffd24a'),
          arcType: Cesium.ArcType.NONE,
          depthFailMaterial: Cesium.Color.fromCssColorString('#ffd24a').withAlpha(0.4),
        },
      });
    }
    if (!moonOrbitEnt) {
      moonOrbitEnt = earthViewer.entities.add({
        id: 'moonOrbitRing',
        polyline: {
          positions: new Cesium.CallbackProperty(() => moonOrbitCarts, false),
          width: 1,
          material: Cesium.Color.fromCssColorString('#8fa8c8').withAlpha(0.22),
          arcType: Cesium.ArcType.NONE,
        },
      });
    }
    if (!moonEnt) {
      moonEnt = earthViewer.entities.add({
        id: 'moonTransferTarget',
        position: Cesium.Cartesian3.fromDegrees(0, 0, (EM.moonDist - EM.rE) * 1000),
        ellipsoid: {
          // 2026-10-19：半径随视觉倍率 LOD 变化（远景 ×3 小于地球 → 近景 ×8 便于看环月轨道）
          radii: new Cesium.CallbackProperty(() => {
            const r = EM.moonR * _moonExagNow * 1000;
            return new Cesium.Cartesian3(r, r, r);
          }, false),
          material: '/lunar/lunar_wac.jpg',
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString('#9aa4b8').withAlpha(0.5),
        },
        label: {
          // 旧标注写「体积 ×8」是错的：放大的是**半径**（半径 ×8 = 体积 ×512）
          text: new Cesium.CallbackProperty(
            () => '月球（半径 ×' + _moonExagNow.toFixed(1) + ' 示意）', false),
          font: '12px "Microsoft YaHei", sans-serif',
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -34),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          showBackground: true,
          backgroundColor: new Cesium.Color(0.05, 0.08, 0.18, 0.7),
          backgroundPadding: new Cesium.Cartesian2(6, 4),
        },
      });
    }
    if (!transferLabelEnt) {
      const mid = transferPosAt(0.5);
      transferLabelEnt = earthViewer.entities.add({
        id: 'moonTransferLabel',
        position: Cesium.Cartesian3.fromDegrees(mid[0], mid[1], mid[2] + 26000000),
        label: {
          text: '霍曼转移轨道（实线=行径椭圆弧 · 近地点 200 km · 远地点 384,400 km）',
          font: '11px "Microsoft YaHei", sans-serif',
          fillColor: Cesium.Color.fromCssColorString('#cfe0ff'),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -14),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          showBackground: true,
          backgroundColor: new Cesium.Color(0.05, 0.08, 0.18, 0.55),
          backgroundPadding: new Cesium.Cartesian2(6, 4),
        },
      });
    }
  }

  // [lon,lat,alt] ← Cartesian3（WGS84 反解）
  function cartToPos(c) {
    const g = Cesium.Cartographic.fromCartesian(c, Cesium.Ellipsoid.WGS84, new Cesium.Cartographic());
    return [Cesium.Math.toDegrees(g.longitude), Cesium.Math.toDegrees(g.latitude), g.height];
  }

  // 主箭位置（第一、二幕内确定）——第二幕按嫦娥三段新映射（与 render 分支严格同源）
  function rocketPosAt(pp) {
    if (pp < T.liftEnd) {
      // 上升段：easeIn 加速爬升
      return samplePath(earthPath, easeIn(clamp01(pp / T.liftEnd)) * 0.999);
    }
    // 第二幕 + 第三幕（捕获）走同一个地月段时钟 act2Progress
    const s = act2Progress(pp);
    if (s < P2.phasingEnd) return cartToPos(phasingCartAt(s / P2.phasingEnd));
    if (s < P2.enc) return transferPosAt((s - P2.phasingEnd) / (P2.enc - P2.phasingEnd));
    return cartToPos(captureCartAt((s - P2.enc) / (1 - P2.enc)));
  }

  // 飞行方向角（屏幕旋转角，billboard 兜底用）：上升段竖直、转移段沿轨迹切线
  function flightRotation(pp) {
    if (pp < T.liftEnd) return 0;
    const s = act2Progress(pp);
    const a = transferPosAt(Math.max(0, s - 0.01));
    const b = transferPosAt(Math.min(1, s + 0.01));
    return -Math.atan2(b[0] - a[0], b[1] - a[1]);
  }

  // 发射轨迹逐帧追加（节流：水平累计 >0.012° 或高度变化 >1.2 km 才记一点；
  // 2026-10-17 重力转弯路径加密到 128 点，节流同步收紧，否则平滑曲线会被抽成折线）
  function pushLaunchTrail(pos) {
    if (!lastLaunch) {
      launchCarts.push(Cesium.Cartesian3.fromDegrees(pos[0], pos[1], pos[2]));
      lastLaunch = pos.slice();
      return;
    }
    const dh = Math.abs(pos[2] - lastLaunch[2]);
    const dl = Math.abs(pos[0] - lastLaunch[0]) + Math.abs(pos[1] - lastLaunch[1]);
    if (dh > 1200 || dl > 0.012) {
      launchCarts.push(Cesium.Cartesian3.fromDegrees(pos[0], pos[1], pos[2]));
      lastLaunch = pos.slice();
    }
  }

  // 转移已飞轨迹 = 规划航线前缀
  function updateTransferTrail(s) {
    // 已飞弧 = 调相（1200 点）+ 转移（256 点）+ 捕获（840 点）三段按进度拼接
    const NP = 1200, NC = 840;
    let pts;
    if (s < P2.phasingEnd) {
      const k = Math.max(1, Math.round((s / P2.phasingEnd) * NP));
      pts = phasingCarts.slice(0, k + 1);
    } else if (s < P2.enc) {
      const u = (s - P2.phasingEnd) / (P2.enc - P2.phasingEnd);
      const k = Math.max(1, Math.round(u * (transferCarts.length - 1)));
      pts = phasingCarts.concat(transferCarts.slice(0, k + 1));
    } else {
      const u = (s - P2.enc) / (1 - P2.enc);
      const k = Math.max(1, Math.round(u * NC));
      pts = phasingCarts.concat(transferCarts, captureCarts.slice(0, k + 1));
    }
    trailCarts = pts;
  }

  // ---- 分离件：助推器 ×4（四散弹开 + 下漂 + 重力抛物 + 缓慢翻滚），整流罩 ×2（两瓣抛离）----
  // 2026-10-17 用户反馈重做：「抛出后应该四散分开」「不用在空中翻滚这么多圈」
  // 「下落的速度与翻滚不成比例」：
  //   ① 弹开方向绕飞行方向扇形四散（±35°），并保留部分水平速度向下漂移；
  //   ② 竖直走重力抛物线（½·g·t²），与水平位移构成真实弹道感；
  //   ③ 翻滚总圈数 ~0.45 圈（旧版 2.2 圈），速率恒定、四枚交替反向；
  //   ④ 分离镜头：机位从「跟火箭」1.2s 混合到「跟分离件质心」——118 km 机位外
  //      760 m 的弹开距离只有 ~2 像素，用户根本看不到「四散」（见 sepCam）。
  let sepCam = null;   // 分离镜头混合状态 { t0, fromTgt, fromRange }

  function clearSeparators() {
    for (const b of boosters) {
      earthViewer.entities.remove(b.ent);
      destroySlot(b.slot);
    }
    for (const f of fairings) {
      earthViewer.entities.remove(f.ent);
      destroySlot(f.slot);
    }
    boosters = [];
    fairings = [];
    sepCam = null;
  }

  function spawnSeparators(kind) {
    const base = rocketPosAt(kind === 'booster' ? BOOSTER_SEP : FAIRING_SEP);
    const baseCart = Cesium.Cartesian3.fromDegrees(base[0], base[1], base[2]);
    const fdir = flightDirENU(kind === 'booster' ? BOOSTER_SEP : FAIRING_SEP);   // ENU 切向
    // 水平侧向 = fdir × Up（归一）
    Cesium.Cartesian3.cross(fdir, Cesium.Cartesian3.UNIT_Z, _vec);
    const side = Cesium.Cartesian3.normalize(_vec, new Cesium.Cartesian3());
    // 分离镜头起点：当前跟火箭机位（1.2s 混合到分离件质心，见 render）
    sepCam = {
      t0: performance.now(),
      fromTgt: Cesium.Cartesian3.clone(earthRocket.position.getValue(Cesium.JulianDate.now())),
      fromRange: _lastFocusRange,
    };
    if (kind === 'booster') {
      // 4 枚助推器：左右 × 上下的扇形四散，翻滚交替反向
      const dirs = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]];
      for (const [sgnSide, sgnUp, spin] of dirs) {
        boosters.push({
          sgnSide, sgnUp, spin, base, baseCart, fdir, side,
          axis: Cesium.Cartesian3.normalize(
            new Cesium.Cartesian3(sgnSide * 0.45, 0.85, sgnUp * 0.45), new Cesium.Cartesian3()),
          slot: loadSlot('booster', earthViewerRef),
          ent: earthViewer.entities.add({
            position: baseCart,
            billboard: {
              image: BOOSTER_ICON,
              width: 26,
              height: 26,
              rotation: 0,
              alignedAxis: Cesium.Cartesian3.UNIT_Z,
              heightReference: Cesium.HeightReference.NONE,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          }),
        });
      }
    } else {
      // 整流罩左右两瓣：向两侧水平抛离 + 微上 + 缓慢自转
      for (const d of [-1, 1]) {
        fairings.push({
          dir: d, base, baseCart, fdir, side,
          axis: Cesium.Cartesian3.normalize(
            new Cesium.Cartesian3(1, 0.15, 0.1), new Cesium.Cartesian3()),
          slot: loadSlot('fairing', earthViewerRef),
          ent: earthViewer.entities.add({
            position: baseCart,
            billboard: {
              image: d < 0 ? FAIRING_LEFT_ICON : FAIRING_RIGHT_ICON,
              width: 24,
              height: 24,
              rotation: 0,
              alignedAxis: Cesium.Cartesian3.UNIT_Z,
              heightReference: Cesium.HeightReference.NONE,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          }),
        });
      }
    }
  }

  /** 分离件质心（世界坐标，相机跟随用） */
  function debrisCentroid(list) {
    let ex = 0, ey = 0, ez = 0;
    for (const b of list) {
      const c = b.ent.position.getValue(Cesium.JulianDate.now());
      ex += c.x; ey += c.y; ez += c.z;
    }
    return new Cesium.Cartesian3(ex / list.length, ey / list.length, ez / list.length);
  }

  // 逐帧更新分离件（从分离时刻起的弹开/翻滚/下坠动画，结束后销毁）
  function updateSeparators() {
    const D = BASE_DURATION;
    // 助推器
    if (p >= BOOSTER_SEP && boosters.length === 0 && p < BOOSTER_SEP + 0.055) {
      spawnSeparators('booster');
    }
    if (boosters.length) {
      // 墙钟秒数：p 的推进已被 ACT_RATE 慢放，换算回真实秒要除以倍率（分离动效保持原速度）
      const dt = (p - BOOSTER_SEP) * D / ACT_RATE.act1;
      if (dt > 8) {
        clearSeparators();
      } else if (dt >= 0) {
        for (const b of boosters) {
          // 四散弹开 + 下漂（保留部分入轨速度）+ 重力抛物；翻滚 ~0.36 rad/s（8s≈0.46 圈）
          const drift = 2600 * dt;
          const eject = 95 * dt;
          const fall = 0.5 * 520 * dt * dt;
          const cart = offsetENU(
            b.baseCart,
            b.fdir.x * drift + b.side.x * b.sgnSide * eject * 0.82,
            b.fdir.y * drift + b.side.y * b.sgnSide * eject * 0.82,
            b.fdir.z * drift + b.sgnUp * eject * 0.57 - fall,
            new Cesium.Cartesian3());
          b.ent.position = cart;
          if (attachIfReady(b.slot)) {
            b.ent.billboard.show = false;
            placeModel(b.slot, cart, tumbleQuat(b.axis, b.spin * 0.36 * dt, _q), Cesium.Ellipsoid.WGS84);
          } else {
            b.ent.billboard.rotation = b.spin * 0.36 * dt;
          }
        }
        setPhase('第一幕 · 助推器分离（四散弹开）');
      }
    }
    // 整流罩
    if (p >= FAIRING_SEP && fairings.length === 0 && p < FAIRING_SEP + 0.045) {
      spawnSeparators('fairing');
    }
    if (fairings.length) {
      const dt = (p - FAIRING_SEP) * D / ACT_RATE.act1;
      if (dt > 6.5) {
        clearSeparators();
      } else if (dt >= 0) {
        for (const f of fairings) {
          // 两瓣向两侧抛离 + 随箭微漂 + 重力抛物；自转 ~0.2 rad/s（6.5s≈0.2 圈）
          const drift = 1400 * dt;
          const eject = 42 * dt;
          const fall = 0.5 * 520 * dt * dt;
          const cart = offsetENU(
            f.baseCart,
            f.fdir.x * drift + f.side.x * f.dir * eject,
            f.fdir.y * drift + f.side.y * f.dir * eject,
            f.fdir.z * drift - fall,
            new Cesium.Cartesian3());
          f.ent.position = cart;
          if (attachIfReady(f.slot)) {
            f.ent.billboard.show = false;
            placeModel(f.slot, cart, tumbleQuat(f.axis, f.dir * 0.2 * dt, _q), Cesium.Ellipsoid.WGS84);
          } else {
            f.ent.billboard.rotation = f.dir * 0.2 * dt;
          }
        }
        setPhase('第一幕 · 整流罩分离');
      }
    }
  }

  // ---- 月球场景（第三幕）----
  function clearMoonEntities() {
    const mv = env.getMoonViewer();
    if (mv) {
      if (moonRing) { mv.entities.remove(moonRing); moonRing = null; }
      if (moonCraft) { mv.entities.remove(moonCraft); moonCraft = null; }
      if (descentArcEnt) { mv.entities.remove(descentArcEnt); descentArcEnt = null; }
      if (loiTrailEnt) { mv.entities.remove(loiTrailEnt); loiTrailEnt = null; }
      loiTrailCarts = [];
      if (roverTrackEnt) { mv.entities.remove(roverTrackEnt); roverTrackEnt = null; }
      roverTrackCarts = [];
      if (landDustEnt) { mv.entities.remove(landDustEnt); landDustEnt = null; }
      try { mv.camera.lookAtTransform(Cesium.Matrix4.IDENTITY); } catch { /* 忽略 */ }
    }
  }

  function ensureMoonScene() {
    if (inMoon && moonCraft) return;
    const mv = env.showMoon();
    inMoon = true;
    resetCamOverride();   // 场景换代：相机所有权复位
    if (!mv) return;
    // 月球 viewer 每次进入都会重建（destroyMoonViewer → viewer.destroy()，其 primitives 随之销毁），
    // 旧槽位里的 Model 已不可用：检测换代即销毁重建，避免把死模型挂进新场景。
    if (moonViewerRef !== mv) {
      destroySlot(loiCraftSlot); loiCraftSlot = null;
      destroySlot(landerSlot); landerSlot = null;
      destroySlot(roverSlot); roverSlot = null;
      destroyFxFor(moonViewerRef);
      moonViewerRef = mv;
      hookCamera(mv);
      hookNavControls(mv.container?.querySelector('.cesium-widget-cesiumNavigationContainer'), mv);
    }
    const site = MOON_LANDING_SITES[landingSiteKey];

    // 环月目标轨道（2026-10-18 三轮定稿）：**过着陆点的子午线大圆**（固定经度 site.lon，
    // 过月心、过两极、过着陆点）。演进史：旧版纬度圈（不过月心，用户驳「不科学」）→
    // 赤道轨道（倾角 0°，但赤道轨道到不了 44°N 雨海，LOI→下降被迫折 90° 直角，用户再驳）→
    // 现方案：大圆轨道星下点轨迹直接过着陆点，LOI 制动、环月滑行、离轨下降**同弧同向**，
    // 三条线无缝衔接（嫦娥三号/阿波罗实为倾角对着陆点的斜轨，此处取其特例=极轨大圆）。
    const ring = [];
    for (let i = 0; i <= 240; i++) {
      const lat = -90 + (i / 240) * 360;          // -90 → 270（翻过北极后走背面半圆）
      const latN = lat > 90 ? 180 - lat : lat;
      ring.push(lat > 90 ? wrapLon(site.lon + 180) : site.lon, latN, 100000);
    }
    moonRing = mv.entities.add({
      id: 'moonLoiOrbit',
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArrayHeights(ring, MOON_ELLIPSOID),
        width: 2,
        material: Cesium.Color.fromCssColorString('#7fc4ff'),
        depthFailMaterial: Cesium.Color.fromCssColorString('#7fc4ff').withAlpha(0.35),
        arcType: Cesium.ArcType.NONE,
      },
    });

    // 动力下降段计划弧（与 LOI/环月同一子午线大圆，2026-10-18 定稿）：自环月 100 km
    // （着陆点以南 40°）沿大圆继续北滑，高度按 descentProfile 真实下滑线。
    if (!descentArcEnt) {
      const arc = [];
      for (let i = 0; i <= 48; i++) {
        const u = i / 48;
        arc.push(site.lon, site.lat + lerp(-40, 0, u), descentProfile(u).alt);
      }
      descentArcEnt = mv.entities.add({
        id: 'moonDescentArc',
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArrayHeights(arc, MOON_ELLIPSOID),
          width: 1.6,
          material: new Cesium.PolylineDashMaterialProperty({
            color: Cesium.Color.fromCssColorString('#9ec1ff').withAlpha(0.5),
            dashLength: 12,
          }),
          arcType: Cesium.ArcType.NONE,
        },
        label: {
          text: '动力下降段（环月 100 km → 着陆点 · 同一大圆）',
          font: '11px "Microsoft YaHei", sans-serif',
          fillColor: Cesium.Color.fromCssColorString('#cfe0ff'),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -14),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          showBackground: true,
          backgroundColor: new Cesium.Color(0.05, 0.08, 0.18, 0.55),
          backgroundPadding: new Cesium.Cartesian2(6, 4),
        },
      });
    }

    // LOI 已飞轨迹（赤道上的行径弧，逐帧追加）
    if (!loiTrailEnt) {
      loiTrailEnt = mv.entities.add({
        id: 'moonLoiTrail',
        polyline: {
          positions: new Cesium.CallbackProperty(() => loiTrailCarts, false),
          width: 2,
          material: Cesium.Color.fromCssColorString('#7fc4ff').withAlpha(0.85),
          arcType: Cesium.ArcType.NONE,
        },
      });
    }
    loiTrailCarts = [];

    // 玉兔车辙（第四幕：已行驶路线，亮黄细线；高度取 DEM 采样，贴地不悬空）
    if (!roverTrackEnt) {
      roverTrackEnt = mv.entities.add({
        id: 'moonRoverTrack',
        polyline: {
          positions: new Cesium.CallbackProperty(() => roverTrackCarts, false),
          width: 2,
          material: Cesium.Color.fromCssColorString('#ffd24a').withAlpha(0.85),
          arcType: Cesium.ArcType.NONE,
        },
      });
    }

    // 触月激尘（第三幕末展开）
    if (!landDustEnt) {
      landDustEnt = mv.entities.add({
        id: 'moonLandDust',
        position: Cesium.Cartesian3.fromDegrees(site.lon, site.lat, 1, MOON_ELLIPSOID),
        ellipse: {
          height: 1,
          radii: new Cesium.Cartesian3(1, 1, 1),
          material: Cesium.Color.WHITE.withAlpha(0),
        },
      });
    }

    // 航天器 / 着陆器（同一实体，末段换模型）
    moonCraft = mv.entities.add({
      id: 'moonMissionCraft',
      position: Cesium.Cartesian3.fromDegrees(site.lon, site.lat, 800000, MOON_ELLIPSOID),
      billboard: {
        image: SPACECRAFT_ICON,
        width: 32,
        height: 32,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: '探月飞船',
        font: '12px "Microsoft YaHei", sans-serif',
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -24),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        showBackground: true,
        backgroundColor: new Cesium.Color(0.05, 0.08, 0.18, 0.7),
        backgroundPadding: new Cesium.Cartesian2(6, 4),
      },
    });
  }

  function showCard(text) {
    const c = $('actCard');
    if (!c) return;
    $('actCardText').textContent = text;
    c.classList.remove('hidden');
    c.classList.add('show');
  }
  function hideCard() {
    const c = $('actCard');
    if (!c) return;
    c.classList.remove('show');
    c.classList.add('hidden');
  }
  function setPhase(text) {
    const el = $('rocketPhase');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('hidden');
  }
  function noteOn(on) {
    $('compressNote')?.classList.toggle('hidden', !on);
  }

  // 世界坐标 → 轨道面内坐标 [x 沿 e1, y 沿 e2]（km）
  function toPlaneKM(pc) {
    return [Cesium.Cartesian3.dot(pc, TR.e1) / 1000, Cesium.Cartesian3.dot(pc, TR.e2) / 1000];
  }
  // 轨道面内坐标（km）→ 世界坐标
  function planeToCart(xKm, yKm, out) {
    Cesium.Cartesian3.multiplyByScalar(TR.e1, xKm * 1000, out);
    Cesium.Cartesian3.multiplyByScalar(TR.e2, yKm * 1000, _tTmp);
    return Cesium.Cartesian3.add(out, _tTmp, out);
  }

  // 最近一次第二幕取景（km）：冒烟诊断用
  let _act2Cam = { rangeKm: 0, targetMagKm: 0 };

  // 第二幕顶视相机：相机悬在转移轨道面法向上方，正对椭圆面俯瞰（真实比例）。
  // 铁律：lookAt 的 pitch 相对目标点局部 ENU——中点处的「下方」恰是地月连线方向，
  // 用 HPR 顶视实际得到沿地月轴的侧视（椭圆压成一条线，地月两点重叠，2026-10-17 实测）。
  // 必须用轨道面法向 TR.nrm 直接摆世界位姿。
  /** 顶视机位落地（沿轨道面法向后退 rangeKm，up 取面内 e2 保证画面北向稳定） */
  function applyTopPose(tgt, rangeKm) {
    const camPos = Cesium.Cartesian3.add(
      tgt, Cesium.Cartesian3.multiplyByScalar(TR.nrm, rangeKm * 1000, _tTmp), new Cesium.Cartesian3());
    const dir = Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.subtract(tgt, camPos, _tTmp), new Cesium.Cartesian3());
    applyCameraPose(earthViewer, camPos, dir, TR.e2);
    // 冒烟诊断：暴露本次取景（直接断言「轨道在画面内」，比像素扫描更能定位问题）
    _act2Cam.rangeKm = rangeKm;
    _act2Cam.targetMagKm = Cesium.Cartesian3.magnitude(tgt) / 1000;
  }

  // —— 月球视觉倍率 LOD 的驱动点 ——
  // _moonExagNow 是「当前实际生效的倍率」：月球实体半径与标签的 CallbackProperty 读它，
  // 环月轨道线也随之重建（月系整体等比缩放）。幕卡 2 可传 exagOverride 做 ×3 → ×8 平滑抬升。
  let _moonExagNow = MOON_EXAG_FAR;
  function setMoonExag(ex) {
    if (Math.abs(ex - _moonExagNow) < 0.02) return;
    _moonExagNow = ex;
    rebuildCaptureCarts(ex);
  }
  /** 月球沿轨道同步移动 + 地月虚直线刷新 + 环月轨道按当前视觉倍率重建 */
  function updateMoonAndLine(s, exagOverride) {
    moonEnt.position = moonCartAt(s);
    emLineCarts = [new Cesium.Cartesian3(0, 0, 0), moonEnt.position];
    if (emLineEnt) {
      const mid = Cesium.Cartesian3.multiplyByScalar(moonEnt.position, 0.42, new Cesium.Cartesian3());
      emLineEnt.position = mid;
    }
    setMoonExag(exagOverride === undefined ? moonExagAt(s) : exagOverride);
  }

  /** 幕卡 3「地月全景定场」：一次性把整条轨迹装进画面——绕地三圈 + 转移大椭圆 + 绕月三圈。
   *  尺度跨度 6,971（近地点）→ 405,000 km（远地点）= 58 倍，所以正片里没有任何一帧能同框；
   *  这里按真实包围盒取景（≈ 39.6 万 km）给 3.6 s 定场，地球约 23 px、绕月轨道约 41% 画宽。
   *  ⚠ 月系按当前倍率（会合后恒 ×8）参与包围盒，否则绕月三圈会出画。 */
  let _ovView = null;   // 定场取景（只与轨迹几何有关，算一次缓存；buildPathData 时失效）
  function lookAtOverview() {
    if (!_ovView) {
      let minX = 0, maxX = 0, minY = 0, maxY = 0;
      const push = (c) => {
        const [x, y] = toPlaneKM(c);
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      };
      push(new Cesium.Cartesian3(0, 0, 0));                              // 地球
      push(planeToCart(-EM.ra, 0, new Cesium.Cartesian3()));             // 转移远地点（拱线 −e1）
      push(moonCartAt(1));                                                // 会合时刻月球
      for (const c of phasingCarts) push(c);                              // 绕地三圈
      for (const c of captureCarts) push(c);                              // 绕月三圈
      _ovView = {
        tgt: planeToCart((minX + maxX) / 2, (minY + maxY) / 2, new Cesium.Cartesian3()),
        rangeKm: fitRangeKm((maxX - minX) / 2, (maxY - minY) / 2, 0.9),
      };
    }
    applyTopPose(_ovView.tgt, _ovView.rangeKm);
  }

  function lookAtTransfer() {
    const s = act2Progress(p);
    const mc = moonCartAt(s);
    // —— A 调相段：定焦在最外 48h 椭圆的包围盒（三条椭圆如教科书般居中、向远地点层层张开）
    const aT = planeToCart(-PH[2].a * PH[2].e, 0, new Cesium.Cartesian3());
    const aR = PH_RANGE;
    // —— B 转移段：目标 = {地球, 月球, 飞船} 包围盒中心，距离随月球方位自适应
    //     （竖直 fov 仅 36°，月球转到画面上下方时必须拉远，否则地月会出画——旧版 8.0e5 km
    //      是拍脑袋的固定值，月球在上下方时照样出画）
    const uT = clamp01((s - P2.phasingEnd) / (P2.enc - P2.phasingEnd));
    let minX = 0, maxX = 0, minY = 0, maxY = 0;
    for (const c of [mc, transferCartAt(uT)]) {
      const [x, y] = toPlaneKM(c);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const bT = planeToCart((minX + maxX) / 2, (minY + maxY) / 2, new Cesium.Cartesian3());
    const bR = fitRangeKm((maxX - minX) / 2, (maxY - minY) / 2);
    // —— C 捕获段：跟随月球，取景随环月轨道收缩（12h 5.9Rv → 3.5h 2.0Rv → 127min 1.11Rv），
    //     在每次制动瞬间平滑拉近（与 LOI 点火同步，像真实任务那样「刹一脚看清楚一点」）
    const uC = clamp01((s - P2.enc) / (1 - P2.enc));
    const cT = mc;
    let cR = CA_RANGE[0];
    for (let i = 0; i < CA_SWITCH.length; i++) {
      cR = lerp(cR, CA_RANGE[i + 1], easeInOut(clamp01((uC - CA_SWITCH[i]) / 0.1 + 0.5)));
    }
    // 段间混合（smoothstep，避免镜头突变）
    const band = 0.03;
    let tgt = aT, rangeKm = aR;
    if (s < P2.phasingEnd + band) {
      const w = easeInOut(clamp01((s - (P2.phasingEnd - band)) / (2 * band)));
      tgt = Cesium.Cartesian3.lerp(aT, bT, w, new Cesium.Cartesian3());
      rangeKm = lerp(aR, bR, w);
    } else if (s < P2.enc + band) {
      if (s < P2.enc - band) { tgt = bT; rangeKm = bR; }
      else {
        const w = easeInOut(clamp01((s - (P2.enc - band)) / (2 * band)));
        tgt = Cesium.Cartesian3.lerp(bT, cT, w, new Cesium.Cartesian3());
        rangeKm = lerp(bR, cR, w);
      }
    } else { tgt = cT; rangeKm = cR; }
    applyTopPose(tgt, rangeKm);
  }

  let _lastFocusRange = 3.0e5;   // 最近一次跟火箭机位距离（分离镜头混合起点用）

  function focusEarth(alt, wide) {
    // 方案 A（2026-10-18 用户拍板）：火箭保持真实尺寸（56m），机位距离随高度**缓增**——
    // 近地 900m、20km 高时 ~3.3km（视角尺寸≈近地可读）、入轨段封顶 80km；幕卡用 3e7 全景。
    const range = wide ? 3.0e7 : Cesium.Math.clamp(900 + alt * 0.12, 900, 8.0e4);
    _lastFocusRange = range;
    const pos = earthRocket ? earthRocket.position.getValue(Cesium.JulianDate.now()) : null;
    if (!pos) return;
    applyFollow(earthViewer, pos, 0, Cesium.Math.toRadians(-38), range);
  }

  /** 分离镜头（2026-10-17）：机位从「跟火箭」1.2s 混合到「分离件质心 ↔ 火箭主体」同框。
   *  不这么做的话：118 km 外 760 m 的弹开距离 ≈ 2 像素，「四散分开」用户永远看不到；
   *  只盯质心的话火箭主体出画（2026-10-18 用户反馈）——目标取两者中点、距离盖住两者。 */
  function focusSeparators() {
    const list = boosters.length ? boosters : fairings.length ? fairings : null;
    if (!list || !sepCam) { focusEarth(rocketPosAt(p)[2]); return; }
    const centroid = debrisCentroid(list);
    const rocketCart = earthRocket ? earthRocket.position.getValue(Cesium.JulianDate.now()) : null;
    const k = easeInOut(Math.min(1, (performance.now() - sepCam.t0) / 1200));
    const tgt = rocketCart
      ? Cesium.Cartesian3.midpoint(centroid, rocketCart, new Cesium.Cartesian3())
      : centroid;
    const spread = rocketCart ? Cesium.Cartesian3.distance(centroid, rocketCart) : 0;
    const baseRange = boosters.length ? 7000 : 4500;
    const range = lerp(sepCam.fromRange, Math.max(baseRange, spread * 1.9), k);
    applyFollow(earthViewer, tgt, 0, Cesium.Math.toRadians(-30), range);
  }

  // 飞行方向单位向量（ENU）：取样 ±0.4% 进度处两点求切向（竖直起步时回退天顶）
  function flightDirENU(pp) {
    const e = 0.004;
    const a = rocketPosAt(Math.max(0, pp - e));
    const b = rocketPosAt(Math.min(1, pp + e));
    return tangentENU(a, b, _dir);
  }

  /** 火箭/飞船模型：就绪则落位返回 true（调用方据此隐藏 billboard 兜底） */
  function updateRocketModel(slot, cart, dir) {
    if (!slot) return false;
    if (!attachIfReady(slot)) return false;
    placeModel(slot, cart, quatUpTo(dir, _q), Cesium.Ellipsoid.WGS84);
    return true;
  }

  // ---- 逐帧渲染 ----
  // 跨幕相机重置（用户拍板 2026-10-18：MANUAL 不跨幕保留，跨幕回默认机位）。
  // 同 viewer 内平滑混合；地月跨 viewer（容器都换了）瞬切。
  // a2c = 第三幕「近月捕获」（仍在地心惯性系、地球 viewer 上）；c3 = 幕卡 3（全景定场）
  const ACT_VIEWER = {
    a1: 'earth', c1: 'earth', a2: 'earth', c2: 'earth', a2c: 'earth', c3: 'earth',
    a3l: 'moon', a3d: 'moon', a4: 'moon',
  };
  let _lastActKey = null;
  function actKeyOf(pp) {
    return pp < T.liftEnd ? 'a1' : pp < T.card1End ? 'c1' : pp < T.transferEnd ? 'a2'
      : pp < T.card2End ? 'c2' : pp < T.captureEnd ? 'a2c' : pp < T.card3End ? 'c3'
        : pp < T.loiEnd ? 'a3l' : pp < T.touchEnd ? 'a3d' : 'a4';
  }
  function viewerOfAct(key) {
    return ACT_VIEWER[key] === 'moon' ? env.getMoonViewer() : earthViewer;
  }
  function render() {
    const actKey = actKeyOf(p);
    if (actKey !== _lastActKey) {
      if (_lastActKey && camOverride) {
        const prevV = viewerOfAct(_lastActKey);
        const nextV = viewerOfAct(actKey);
        if (prevV && nextV && prevV === nextV) startBlendFrom(prevV);
        else resetCamOverride();
        updateCamBadge();
      }
      _lastActKey = actKey;
    }
    // —— 地球侧（第一幕 / 幕卡 1 / 第二幕转移 / 幕卡 2 / 第三幕捕获 / 幕卡 3）——
    // ⚠ 2026-10-19：捕获幕仍在地球 viewer（地心惯性系 + 绕月取景），月球侧从幕卡 3 之后才开始
    if (p < T.card3End) {
      if (inMoon) {
        clearMoonEntities();
        env.showEarth();
        inMoon = false;
        resetCamOverride();
      }
      ensureEarthRocket();
      ensureTransferScene();
      hideCard();
      // 三段轨道线/标注只在第二幕（及幕卡 2）出现：第一幕相机贴在火箭上，这些线会糊在画面里
      // （2026-10-18 修：transferFullEnt 此前不在 show 控制里，第一幕抬头就能看见天上
      //   一条蓝紫「计划线」穿过——即用户截图里的那根）
      const showEm = p >= T.card1End;
      if (emLineEnt) emLineEnt.show = showEm;
      if (transferMirrorEnt) transferMirrorEnt.show = showEm;
      if (transferFullEnt) transferFullEnt.show = showEm;
      if (phasingEnt) phasingEnt.show = showEm;
      if (captureEnt) captureEnt.show = showEm;
      for (const le of phaseLabelEnts) le.show = showEm;

      if (p < T.liftEnd) {
        // 第一幕：点火起飞（上升 + 分离动效 + 发射轨迹 + 火焰/灰尘/RCS）
        earthRocket.show = true;
        noteOn(false);
        const pos = rocketPosAt(p);
        const cart = Cesium.Cartesian3.fromDegrees(pos[0], pos[1], pos[2]);
        earthRocket.position = cart;
        const dir = flightDirENU(p);
        // 形态随分离阶段切换：整箭 →（抛助推器）芯级箭 →（抛整流罩）飞船上面级。
        // 显式 showSlot + hideSlot 其它：进度条来回拖拽也不会卡在错误形态（2026-10-17 修）。
        const stage = p < BOOSTER_SEP ? 'rocket' : p < FAIRING_SEP ? 'rocketCore' : 'craft';
        const slot = stage === 'rocket' ? getRocketSlot()
          : stage === 'rocketCore' ? getRocketCoreSlot() : getCraftSlot();
        if (updateRocketModel(slot, cart, dir)) {
          earthRocket.billboard.show = false;
          hideSlot(rocketSlot); hideSlot(rocketCoreSlot); hideSlot(craftSlot);
          showSlot(slot);
        } else {
          earthRocket.billboard.show = true;
          earthRocket.billboard.rotation = 0;
          earthRocket.billboard.image = p >= FAIRING_SEP ? SPACECRAFT_ICON
            : p >= BOOSTER_SEP ? STAGE1_ICON : FULL_ROCKET_ICON;
        }
        if (p >= FAIRING_SEP) {
          earthRocket.label.text = '长征五号 · 整流罩分离';
        } else if (p >= BOOSTER_SEP) {
          earthRocket.label.text = '长征五号 · 助推器分离';
        } else {
          earthRocket.label.text = '长征五号 · 点火升空';
        }
        // 主发动机火焰：点火至入轨全程工作（喷流 = 速度反方向），油门缩放 + 高频闪烁
        const flick = 0.92 + 0.08 * Math.sin(performance.now() * 0.047 + pos[2]);
        Cesium.Cartesian3.negate(dir, _vec);
        _dbg.dir = [Math.round(dir.x * 1000) / 1000, Math.round(dir.y * 1000) / 1000, Math.round(dir.z * 1000) / 1000];
        _dbg.exhaust = [Math.round(_vec.x * 1000) / 1000, Math.round(_vec.y * 1000) / 1000, Math.round(_vec.z * 1000) / 1000];
        updateFlame(earthViewer, cart, _vec, 1.55 * flick, Cesium.Ellipsoid.WGS84);
        // 发射台灰尘：点火初期椭圆扩散 + 衰减
        if (padDustEnt) {
          const u = clamp01(p / DUST_END);
          const r = lerp(30, 340, u);
          padDustEnt.ellipse.radii = new Cesium.Cartesian3(r, r, r);
          padDustEnt.ellipse.material = Cesium.Color.fromCssColorString('#cfd6e4').withAlpha(0.5 * (1 - u));
        }
        // 过顶段 RCS 姿控喷气（重力转弯窗口，机头侧向微喷）
        if (p >= RCS_FROM && p < RCS_TO) {
          const nose = offsetUp(cart, 30, new Cesium.Cartesian3());
          Cesium.Cartesian3.negate(Cesium.Cartesian3.UNIT_X, _vec);   // 喷流朝西（转弯反方向）
          updateRcs(earthViewer, nose, _vec, 0.55 * (0.7 + 0.3 * Math.sin(performance.now() * 0.05)), Cesium.Ellipsoid.WGS84);
        } else {
          updateRcs(earthViewer, null, null, 0, Cesium.Ellipsoid.WGS84);
        }
        pushLaunchTrail(pos);
        updateSeparators();
        // 分离相位文字由 updateSeparators() 内部按阶段设置（四散弹开/整流罩分离），
        // 这里只在无分离件时才设通用相位——否则会覆盖掉分离窗口的说明（2026-10-17 修）
        if (!boosters.length && !fairings.length) setPhase('第一幕 · 点火起飞');
        // MANUAL（用户拍板 2026-10-18）：关注点跟随火箭本体，分离特写不生效；
        // AUTO：分离窗口内切分离镜头（四散/翻滚可读），其余时间跟火箭
        if (camOverride) {
          applyManualFollow(earthViewer, cart);
        } else if (boosters.length || fairings.length) {
          focusSeparators();
        } else {
          focusEarth(pos[2]);
        }
      } else if (p < T.card1End) {
        // 幕卡 1：点火起飞 → 月地转移
        clearSeparators();
        earthRocket.show = false;
        updateFlame(earthViewer, null, null, 0, Cesium.Ellipsoid.WGS84);
        updateRcs(earthViewer, null, null, 0, Cesium.Ellipsoid.WGS84);
        if (padDustEnt) padDustEnt.ellipse.material = Cesium.Color.WHITE.withAlpha(0);
        noteOn(false);
        showCard('第一幕 · 点火起飞完成\n「进入 16 小时轨道，开始 7 天调相」');
        setPhase('幕间');
        if (camOverride && earthRocket.position) {
          applyManualFollow(earthViewer, earthRocket.position.getValue(Cesium.JulianDate.now()));
        } else {
          focusEarth(200000);
        }
      } else if (p < T.transferEnd) {
        // 第二幕：调相 7 圈 + 地月转移大椭圆（2026-10-19 拆幕：捕获段已独立成第三幕）
        clearSeparators();   // 跨幕 seek（如 0.08→0.35）不经过幕卡分支，这里兜底清分离件
        earthRocket.show = true;
        noteOn(true);
        const s = act2Progress(p);
        let cart, burn = 0, burnRetro = false;
        if (s < P2.phasingEnd) {
          const u = s / P2.phasingEnd;
          cart = phasingCartAt(u);
          burn = phasingBurn(u);                       // 每圈近地点点火（加速抬升远地点）
        } else {
          const u = (s - P2.phasingEnd) / (P2.enc - P2.phasingEnd);
          cart = transferCartAt(u);
          burn = u < 0.05 ? 1.5 : 0;                   // TLI：切入转移椭圆
        }
        earthRocket.position = cart;
        // 3D 飞船上面级（机头沿椭圆切向）
        if (updateRocketModel(getCraftSlot(), cart, flightDirENU(p))) {
          earthRocket.billboard.show = false;
          showSlot(craftSlot);
          hideSlot(rocketSlot); hideSlot(rocketCoreSlot);
        } else {
          earthRocket.billboard.show = true;
          earthRocket.billboard.rotation = flightRotation(p);
          earthRocket.billboard.image = SPACECRAFT_ICON;
        }
        // 喷焰节奏（逐圈加速/减速的可视化）：加速段喷流向后、制动段喷流向前
        if (burn > 0) {
          const flick = 0.9 + 0.1 * Math.sin(performance.now() * 0.053);
          if (burnRetro) Cesium.Cartesian3.clone(flightDirENU(p), _vec);
          else Cesium.Cartesian3.negate(flightDirENU(p), _vec);
          updateFlame(earthViewer, cart, _vec, burn * flick, Cesium.Ellipsoid.WGS84);
        } else {
          updateFlame(earthViewer, null, null, 0, Cesium.Ellipsoid.WGS84);
        }
        updateMoonAndLine(s);
        // 演示时间加速（用户拍板）：进度条标出真实任务时间，让「7 天调相 / 114 小时转移」可读
        const uP = s / P2.phasingEnd;
        const st = phasingState(uP);
        const nearPeri = st.cu < 0.1 || st.cu > 0.9;        // 近地点经过
        const coast = burn === 0 && nearPeri;                 // 非点火的近地点 = 无动力滑行圈
        const seg = s < P2.phasingEnd ? '调相段 · ' + PH[st.oi].name : '地月转移段';
        earthRocket.label.text = burn > 0
          ? '探月飞船 · ' + seg + ' 近地点点火'
          : coast ? '探月飞船 · ' + seg + ' ◯ 滑行（无动力）'
            : '探月飞船 · ' + seg;
        updateTransferTrail(s);
        setPhase('第二幕 · ' + seg + ' · ' + fmtElapsed(CH_TOTAL_H * s) + '（演示加速 ×' + CH_SPEEDUP.transfer + '）');
        lookAtTransfer();
      } else if (p < T.card2End) {
        // 幕卡 2：抵达月球 → 准备三次近月制动
        clearSeparators();
        earthRocket.show = false;
        updateFlame(earthViewer, null, null, 0, Cesium.Ellipsoid.WGS84);
        const cw = easeInOut(clamp01((p - T.transferEnd) / (T.card2End - T.transferEnd)));
        updateMoonAndLine(P2.enc, lerp(MOON_EXAG_FAR, MOON_EXAG_NEAR, cw));
        showCard('第二幕 · 抵达月球（背面）\n「接下来 40 小时：三次近月制动」');
        setPhase('幕间');
        lookAtTransfer();
      } else if (p < T.captureEnd) {
        // 第三幕：近月捕获（2026-10-19 独立成幕）——12h → 3.5h → 127min 三档逐次制动
        clearSeparators();
        earthRocket.show = true;
        noteOn(true);
        const s = act2Progress(p);
        const u = (s - P2.enc) / (1 - P2.enc);
        const cart = captureCartAt(u);
        const burn = captureBurn(u);            // 每圈近月点逆向点火（制动减速）
        earthRocket.position = cart;
        if (updateRocketModel(getCraftSlot(), cart, flightDirENU(p))) {
          earthRocket.billboard.show = false;
          showSlot(craftSlot);
          hideSlot(rocketSlot); hideSlot(rocketCoreSlot);
        } else {
          earthRocket.billboard.show = true;
          earthRocket.billboard.rotation = flightRotation(p);
          earthRocket.billboard.image = SPACECRAFT_ICON;
        }
        if (burn > 0) {
          const flick = 0.9 + 0.1 * Math.sin(performance.now() * 0.053);
          Cesium.Cartesian3.clone(flightDirENU(p), _vec);   // 制动：喷流朝前
          updateFlame(earthViewer, cart, _vec, burn * flick, Cesium.Ellipsoid.WGS84);
        } else {
          updateFlame(earthViewer, null, null, 0, Cesium.Ellipsoid.WGS84);
        }
        updateMoonAndLine(s);
        const cs = captureState(u);
        const nearPeri = cs.cu < 0.1 || cs.cu > 0.9;         // 近月点经过
        const coast = burn === 0 && nearPeri;                  // 非制动的近月点 = 无动力滑行圈
        const seg = '捕获段 · ' + CA[cs.oi].name;
        earthRocket.label.text = burn > 0
          ? '探月飞船 · ' + seg + ' 近月制动'
          : coast ? '探月飞船 · ' + seg + ' ◯ 滑行（无动力）'
            : '探月飞船 · ' + seg;
        updateTransferTrail(s);
        setPhase('第三幕 · ' + seg + ' · ' + fmtElapsed(CH_TOTAL_H * s)
          + '（演示加速 ×' + CH_SPEEDUP.capture + '）');
        lookAtTransfer();
      } else {
        // 幕卡 3：地月全景定场（3.6 s）——整条轨迹唯一一次同框
        clearSeparators();
        earthRocket.show = true;
        updateFlame(earthViewer, null, null, 0, Cesium.Ellipsoid.WGS84);
        const s = act2Progress(p);
        const cart = captureCartAt(1);
        earthRocket.position = cart;
        if (updateRocketModel(getCraftSlot(), cart, flightDirENU(p))) {
          earthRocket.billboard.show = false;
          showSlot(craftSlot);
          hideSlot(rocketSlot); hideSlot(rocketCoreSlot);
        } else {
          earthRocket.billboard.show = true;
          earthRocket.billboard.image = SPACECRAFT_ICON;
        }
        updateMoonAndLine(s);
        updateTransferTrail(s);
        showCard('第三幕 · 三次近月制动完成\n「整条轨迹：绕地 7 圈 → 转移大椭圆 → 绕月 7 圈」');
        setPhase('幕间');
        lookAtOverview();
      }
      return;
    }

    // —— 月球侧（第四幕：环月制动 → 离轨 → 动力下降着陆；第五幕：玉兔巡视）——
    hideCard();
    noteOn(false);
    if (earthRocket) earthRocket.show = false;
    clearSeparators();
    ensureMoonScene();
    const mv = env.getMoonViewer();
    if (!mv || !moonCraft) return;
    const site = MOON_LANDING_SITES[landingSiteKey];

    if (p < T.loiEnd) {
      // 环月制动 LOI（2026-10-18 定稿）：沿**过着陆点的子午线大圆**自南向北（着陆点以南
      // 120° → 40°），800 → 100 km 降轨；与下降段同一大圆同向，衔接无直角。
      // ⚠ 自北向南版起点 lat=site.lat+120 会越过极点（雨海 164°N 非法），故取南向起点。
      _diveBlend = null;
      const s = clamp01((p - T.card3End) / (T.loiEnd - T.card3End));
      const latT = site.lat + lerp(-120, -40, easeIn(s));
      const alt = lerp(800000, 100000, easeIn(s));
      const craftPos = Cesium.Cartesian3.fromDegrees(site.lon, latT, alt, MOON_ELLIPSOID);
      moonCraft.position = craftPos;
      moonCraft.label.text = '环月制动 · LOI（过着陆点大圆轨道 100 km）';
      setPhase('第四幕 · 环月制动（LOI）');
      // LOI 行径弧（大圆，逐帧追加；>20 km 才记一点）
      if (!loiTrailCarts.length ||
          Cesium.Cartesian3.distance(loiTrailCarts[loiTrailCarts.length - 1], craftPos) > 20000) {
        loiTrailCarts.push(Cesium.Cartesian3.clone(craftPos));
      }
      // 3D 飞船上面级（机头沿大圆切向，与第一/二幕同一模型）；未就绪回退 billboard
      const slot = getLoiCraftSlot();
      if (attachIfReady(slot)) {
        moonCraft.billboard.show = false;
        hideSlot(landerSlot); hideSlot(roverSlot); showSlot(slot);
        const e = 0.01;
        const sa = Math.max(0, s - e), sb = Math.min(1, s + e);
        const a = [site.lon, site.lat + lerp(-120, -40, easeIn(sa)), lerp(800000, 100000, easeIn(sa))];
        const b = [site.lon, site.lat + lerp(-120, -40, easeIn(sb)), lerp(800000, 100000, easeIn(sb))];
        placeModel(slot, craftPos, quatUpTo(tangentENU(a, b, _dir), _q), MOON_ELLIPSOID);
      } else {
        moonCraft.billboard.show = true;
        moonCraft.billboard.image = SPACECRAFT_ICON;
      }
      // 逆向点火（前 25%）：喷流沿速度方向（减速入轨）
      if (s < 0.25) {
        const e = 0.01;
        const sa = Math.max(0, s - e), sb = Math.min(1, s + e);
        const a = [wrapLon(site.lon - 120 + 120 * sa), 0, lerp(800000, 100000, sa)];
        const b = [wrapLon(site.lon - 120 + 120 * sb), 0, lerp(800000, 100000, sb)];
        const burn = 1.1 * (0.9 + 0.1 * Math.sin(performance.now() * 0.049)) * (1 - s / 0.25 * 0.35);
        updateFlame(mv, craftPos, tangentENU(a, b, _dir), burn, MOON_ELLIPSOID);
      } else {
        updateFlame(mv, null, null, 0, MOON_ELLIPSOID);
      }
      // 相机：框住整个月球 + 赤道轨环（旧值 70 万 km 时月球只剩小点，用户反馈看不全）
      // 月球半径 1,737 km、轨环半径 1,837 km → 420 万 m 处 60° 视角高 ~485 万 m，刚好容下
      if (camOverride) applyManualFollow(mv, craftPos);
      else applyFollow(mv, craftPos, 0, Cesium.Math.toRadians(-42), lerp(4.2e6, 2.6e6, s));
    } else if (p < T.touchEnd) {
      // 离轨 + 动力下降（2026-10-18 定稿）：与 LOI **同一子午线大圆**继续南滑
      // （着陆点以北 40° → 0°），高度 descentProfile（100 km → 0）——全程同弧同向无直角。
      //   相机：滑翔段保持 260 万 m 远机位（弧线在画面上 ~30% 高、可读不糊），
      //         触月前 1.4s 平滑推近到着陆机位（广播式「切着陆机位」）。
      const s = clamp01((p - T.loiEnd) / (T.touchEnd - T.loiEnd));
      const ground = sampleMoonHeight(site.lon, site.lat);
      const prof = descentProfile(s);
      const alt = ground + prof.alt;
      const latT = site.lat + lerp(-40, 0, s);
      const craftPos = Cesium.Cartesian3.fromDegrees(site.lon, latT, alt, MOON_ELLIPSOID);
      moonCraft.position = craftPos;
      // 姿态：大圆切向（北滑）→ 竖直（离轨段平滑过渡）
      const e = 0.01;
      const sa = Math.max(0, 1 - e), sb = Math.min(1, 1 + e);
      const a = [site.lon, site.lat + lerp(-40, 0, sa), ground + descentProfile(sa).alt];
      const b = [site.lon, site.lat + lerp(-40, 0, sb), ground + descentProfile(sb).alt];
      const orbitDir = tangentENU(a, b, _dir2);
      const u = s < 0.28 ? s / 0.28 : 1;
      const dir = new Cesium.Cartesian3(
        lerp(orbitDir.x, 0, easeIn(u)),
        lerp(orbitDir.y, 0, easeIn(u)),
        lerp(orbitDir.z, 1, easeIn(u)));
      Cesium.Cartesian3.normalize(dir, dir);
      if (s < 0.28) {
        // 离轨制动段：飞船上面级 + 逆向火焰（喷流沿速度方向）
        moonCraft.label.text = '离轨制动 · 15 km 轨道';
        setPhase('第四幕 · 离轨制动');
        const slot = getLoiCraftSlot();
        if (attachIfReady(slot)) {
          moonCraft.billboard.show = false;
          hideSlot(landerSlot); hideSlot(roverSlot); showSlot(slot);
          placeModel(slot, craftPos, quatUpTo(dir, _q), MOON_ELLIPSOID);
        } else {
          moonCraft.billboard.show = true;
          moonCraft.billboard.image = SPACECRAFT_ICON;
        }
        const burn = 0.95 * (0.9 + 0.1 * Math.sin(performance.now() * 0.051));
        updateFlame(mv, craftPos, dir, burn, MOON_ELLIPSOID);
        if (landDustEnt) landDustEnt.ellipse.material = Cesium.Color.WHITE.withAlpha(0);
      } else {
        // 动力下降段：着陆器（与飞船分离后）+ 主发动机火焰（油门曲线）+ 末段 RCS 精调
        moonCraft.label.text = site.name + ' · 动力下降';
        setPhase(s >= 1 ? '第四幕 · 月面着陆完成' : '第四幕 · 动力下降');
        const slot = getLanderSlot();
        if (attachIfReady(slot)) {
          moonCraft.billboard.show = false;
          hideSlot(loiCraftSlot); hideSlot(roverSlot); showSlot(slot);
          placeModel(slot, craftPos, Cesium.Quaternion.IDENTITY, MOON_ELLIPSOID);
        } else {
          moonCraft.billboard.show = true;
          moonCraft.billboard.image = LANDER_ICON;
        }
        const flick = 0.9 + 0.1 * Math.sin(performance.now() * 0.057);
        const flamePos = offsetUp(craftPos, 0.8, new Cesium.Cartesian3());
        Cesium.Cartesian3.negate(Cesium.Cartesian3.UNIT_Z, _vec);
        updateFlame(mv, flamePos, _vec, (0.5 + prof.thrust) * flick, MOON_ELLIPSOID);
        // 末段姿态微调 RCS（左右交替，触月前收
        if (u > 0.9) {
          const side = Math.sin(performance.now() * 0.03) > 0 ? 1 : -1;
          const rcsPos = offsetUp(craftPos, 3.2, new Cesium.Cartesian3());
          Cesium.Cartesian3.cross(Cesium.Cartesian3.UNIT_Z, new Cesium.Cartesian3(1, 0, 0), _vec);
          Cesium.Cartesian3.multiplyByScalar(_vec, side, _vec);
          updateRcs(mv, rcsPos, _vec, 0.5, MOON_ELLIPSOID);
        } else {
          updateRcs(mv, null, null, 0, MOON_ELLIPSOID);
        }
        // 触月激尘：最后 12% 展开
        if (landDustEnt) {
          const du = clamp01((s - 0.88) / 0.12);
          const r = lerp(4, 55, du);
          landDustEnt.ellipse.radii = new Cesium.Cartesian3(r, r, r);
          landDustEnt.ellipse.material = Cesium.Color.fromCssColorString('#b9b4ab').withAlpha(0.42 * (1 - du * 0.6));
        }
      }
      // 关键：必须传 Cartesian3 本体；传 Property 会得到 NaN 相机 → 渲染崩溃
      // 机位（2026-10-17 重做）：
      //   滑翔段（大圆弧，水平 ~223 km/s）必须保持 260 万 m 远机位——近了地形会糊成频闪；
      //   弧线走完后 1.4s 内平滑推近到着陆机位（末端 clamp 60m：着陆器 ~4.4m 高，
      //   不 clamp 触月瞬间只剩 1~2 像素）。
      const DIVE_FROM = 0.7;   // 触月前 30% 进度开始平滑推近着陆机位
      if (s < DIVE_FROM) {
        _diveBlend = null;
        if (camOverride) applyManualFollow(mv, craftPos);
        else applyFollow(mv, craftPos, 0, Cesium.Math.toRadians(-22), 2.6e6);
      } else {
        const near = Math.max(60, (alt - ground) * 2.4);
        if (!_diveBlend) _diveBlend = { t0: performance.now() };
        const k = easeInOut(Math.min(1, (performance.now() - _diveBlend.t0) / 1400));
        const range = Math.exp(lerp(Math.log(2.6e6), Math.log(near), k));
        if (camOverride) applyManualFollow(mv, craftPos);
        else applyFollow(mv, craftPos, 0, Cesium.Math.toRadians(-22), range);
      }
    } else {
      // 第四幕：玉兔驶出巡视（着陆器驻留 + 月球车 6 轮滚动节点动画）
      const s4 = clamp01((p - T.touchEnd) / (1 - T.touchEnd));
      const ground = sampleMoonHeight(site.lon, site.lat);
      const landerPos = Cesium.Cartesian3.fromDegrees(site.lon, site.lat, ground, MOON_ELLIPSOID);
      // 行进路线（2026-10-17 修正，见 roverPath 注释）：缓弯弧线 + 逐点 DEM 贴地
      const pts = roverPath(site);
      const fi = s4 * (pts.length - 1);
      const i0 = Math.min(pts.length - 2, Math.floor(fi));
      const fr = fi - i0;
      const pa = pts[i0], pb = pts[i0 + 1];
      const rLon = lerp(pa.lon, pb.lon, fr);
      const rLat = lerp(pa.lat, pb.lat, fr);
      const rGround = lerp(pa.h, pb.h, fr);
      const heading = lerp(pa.heading, pb.heading, fr);
      const roverPos = Cesium.Cartesian3.fromDegrees(rLon, rLat, rGround, MOON_ELLIPSOID);
      // 车头对准行进方向（2026-10-18 修「螃蟹车」）：Cesium glTF 轴校正是循环置换——
      // 模型 +X→世界**北**、+Y→天顶、+Z→东（probe23 实测），车头 +X 在 ENU 局部系指北；
      // 绕 ENU 天顶转 −heading 即指向航向（罗盘角自北顺时针，ENU 右手系绕 +Z 为逆时针）。
      const roverQuat = Cesium.Quaternion.fromAxisAngle(
        Cesium.Cartesian3.UNIT_Z, -heading, new Cesium.Quaternion());
      // 车辙 = 已行驶前缀（含当前点）
      roverTrackCarts = [];
      for (let i = 0; i <= i0; i++) {
        roverTrackCarts.push(Cesium.Cartesian3.fromDegrees(pts[i].lon, pts[i].lat, pts[i].h, MOON_ELLIPSOID));
      }
      roverTrackCarts.push(roverPos);
      moonCraft.position = roverPos;
      moonCraft.label.text = '玉兔号 · 月面巡视';
      setPhase(s4 >= 1 ? '第五幕 · 巡视完成' : '第五幕 · 玉兔驶出巡视');
      // 着陆器驻留（identity 竖直）
      const ls = getLanderSlot();
      if (attachIfReady(ls)) { showSlot(ls); placeModel(ls, landerPos, Cesium.Quaternion.IDENTITY, MOON_ELLIPSOID); }
      hideSlot(loiCraftSlot);
      // 月球车：前进 +X（Y→Z 轴校正后即 ENU 东向），按航向绕天顶旋转；
      // 轮子动画 REPEAT ×1.85（模型内一圈 0.86s ≈ 1.16 转/秒 ≈ 1.16 m/s；
      // 26 m ÷ 12 s ≈ 2.17 m/s → 倍率 2.17/1.16 ≈ 1.85）
      const rs = getRoverSlot();
      if (attachIfReady(rs)) {
        moonCraft.billboard.show = false;
        showSlot(rs);
        placeModel(rs, roverPos, roverQuat, MOON_ELLIPSOID);
        // 坑（2026-10-17 冒烟实测）：sceneGraph 要模型首次 update 后才有，未就绪时
        // activeAnimations.add 抛 TypeError，且异常穿出 tick 会杀死整个 rAF 循环（第四幕冻住）。
        // 判 sceneGraph 存在再 add；本帧未就绪则下一帧 render 自然重试（animOn 仍为 false）。
        if (rs.animCount > 0 && !rs.animOn && !rs.model.isDestroyed() && rs.model.sceneGraph) {
          rs.model.activeAnimations.add({ index: 0, loop: Cesium.ModelAnimationLoop.REPEAT, multiplier: 1.85 });
          rs.animOn = true;
        }
      } else {
        moonCraft.billboard.show = true;
        moonCraft.billboard.image = SPACECRAFT_ICON;
      }
      updateFlame(mv, null, null, 0, MOON_ELLIPSOID);
      updateRcs(mv, null, null, 0, MOON_ELLIPSOID);
      // 相机取着陆器与月球车中点、沿行进方向（航向 ~109°）俯瞰、38m 机位：
      // 26 m 全程 + 着陆器同框，「驶离」过程完整可读（2026-10-17 用户反馈）
      const mid = Cesium.Cartesian3.midpoint(landerPos, roverPos, new Cesium.Cartesian3());
      if (camOverride) applyManualFollow(mv, mid);
      else applyFollow(mv, mid, 1.9, Cesium.Math.toRadians(-24), 38);
    }
  }

  // ---- 进度跳转：跨幕时同步补建/清理场景与实体 ----
  function seekTo(f) {
    p = clamp01(f);
    if (!transferCarts.length) buildPathData();
    if (p < T.card3End) {
      // 地球侧（含捕获幕与幕卡 3）：若在月球段则切回
      if (inMoon) {
        clearMoonEntities();
        env.showEarth();
        inMoon = false;
        resetCamOverride();
      }
      ensureEarthRocket();
      ensureTransferScene();
      earthRocket.show = true;
    } else {
      // 月球侧：藏地球火箭、清分离件、补建月球场景
      if (earthRocket) earthRocket.show = false;
      clearSeparators();
      ensureTransferScene();
      ensureMoonScene();
    }
    if (p >= 1) { playing = false; const b = $('tourPause'); if (b) b.textContent = '重播'; }
    render();
    const bar = $('tourBar');
    if (bar) bar.style.width = (p * 100).toFixed(2) + '%';
    const txt = $('tourProgressText');
    if (txt) txt.textContent = Math.round(p * 100) + '%';
  }

  function tick(now) {
    if (!playing && p >= 1) { raf = 0; return; }
    const dt = last ? (now - last) / 1000 : 0;
    last = now;
    frameDt = Math.min(0.1, Math.max(0.001, dt));
    if (playing) {
      p += (dt / BASE_DURATION) * mult * rateAt(p);
      if (p >= 1) {
        p = 1;
        playing = false;
        const pb = $('tourPause');
        if (pb) pb.textContent = '重播';
      }
    }
    // MANUAL 持久（2026-10-18 双模式）：不再定时回归——跨幕重置在 render 的 actKey 检测里
    updateCamBadge();
    // 崩溃防护：单帧渲染异常不能杀死 rAF 循环（否则任务无声冻住）。
    // 正常路径不应触发（各坑位已有针对性 guard）；真出现时按消息去重只警告一次。
    try {
      render();
    } catch (e) {
      const key = String(e && e.message);
      if (!tick._warned) tick._warned = new Set();
      if (!tick._warned.has(key)) {
        tick._warned.add(key);
        console.warn('[moonMission] 单帧渲染异常（循环继续）：', e);
      }
    }
    // requestRenderMode 下必须主动请求渲染，否则静态相机帧里火箭/飞船不重绘（画面冻住）
    earthViewer.scene.requestRender();
    const mv = env.getMoonViewer();
    if (mv) mv.scene.requestRender();
    const bar = $('tourBar');
    if (bar) bar.style.width = (p * 100).toFixed(2) + '%';
    const txt = $('tourProgressText');
    if (txt) txt.textContent = Math.round(p * 100) + '%';
    raf = requestAnimationFrame(tick);
  }

  function bindPanel() {
    const pb = $('tourPause');
    if (pb) {
      pb.classList.remove('hidden');
      pb.textContent = '暂停';
    }
    // 视角模式按钮（2026-10-18 双模式）：AUTO 时只显示状态；MANUAL 时点击回推荐机位
    const cb = $('tourCamMode');
    if (cb) {
      cb.classList.remove('hidden');
      cb.addEventListener('click', () => {
        if (!camOverride) return;
        startBlendFrom(camHookViewer || earthViewerRef);
        updateCamBadge();
      });
      updateCamBadge();
    }
    // 播完后再按 = 从头重播（完整复位：回地球、重建火箭、清分离件与月球实体）
    onPause = () => {
      if (p >= 1) seekTo(0);
      playing = !playing;
      const b = $('tourPause');
      if (b) b.textContent = playing ? '暂停' : '播放';
      if (playing && !raf) { last = 0; raf = requestAnimationFrame(tick); }
    };
    onStop = () => { if (!isRouteTourActive()) stop(); };
    const step = (dir) => {
      if (isRouteTourActive()) return;
      const cur = SPEED_STEPS.indexOf(mult);
      const idx = cur >= 0 ? cur : 1;
      mult = SPEED_STEPS[Math.max(0, Math.min(SPEED_STEPS.length - 1, idx + dir))];
      const l = $('timeSpeedLabel');
      if (l) l.textContent = mult + '×';
    };
    onSlower = () => step(-1);
    onFaster = () => step(1);
    pb?.addEventListener('click', onPause);
    $('tourStop')?.addEventListener('click', onStop);
    $('timeSlower')?.addEventListener('click', onSlower);
    $('timeFaster')?.addEventListener('click', onFaster);
    const l = $('timeSpeedLabel');
    if (l) l.textContent = mult + '×';

    // 进度条拖拽 seek（拖动期间暂停，松手恢复原播放态）
    // 铁律（2026-10-17 用户反馈）：只有时间轴上按下才 seek——window 级 pointermove
    // 必须带 _trackDragging 旗标，否则画布左键拖动（转视角）会被误判成拖进度条。
    const track = $('tourTrack');
    if (track) {
      track.style.position = 'relative';
      const seekFromEvent = (e) => {
        const rect = track.getBoundingClientRect();
        seekTo((e.clientX - rect.left) / rect.width);
      };
      onTrackDown = (e) => {
        _wasPlaying = playing;
        playing = false;
        _trackDragging = true;
        seekFromEvent(e);
      };
      onTrackMove = (e) => { if (_trackDragging) seekFromEvent(e); };
      onTrackUp = () => {
        // 2026-10-17 用户反馈「时间轴无法暂停」根因：window 级 pointerup 无守卫——
        // 拖过进度条后（_wasPlaying 置 true 且不复位），之后点暂停、再点一下画布/任意按钮，
        // 都会走到这里把 playing 恢复（暂停被无声解除）。
        // 修复：① 只有时间轴上按下过的松手才处理；② _wasPlaying 用完立即复位。
        if (!_trackDragging) return;
        _trackDragging = false;
        if (_wasPlaying && p < 1) playing = true;
        _wasPlaying = false;
        const b = $('tourPause');
        if (b) b.textContent = playing ? '暂停' : '播放';
        if (playing && !raf) { last = 0; raf = requestAnimationFrame(tick); }
      };
      track.addEventListener('pointerdown', onTrackDown);
      window.addEventListener('pointermove', onTrackMove);
      window.addEventListener('pointerup', onTrackUp);
    }
  }

  function unbindPanel() {
    $('tourPause')?.removeEventListener('click', onPause);
    $('tourStop')?.removeEventListener('click', onStop);
    $('timeSlower')?.removeEventListener('click', onSlower);
    $('timeFaster')?.removeEventListener('click', onFaster);
    const track = $('tourTrack');
    if (track && onTrackDown) track.removeEventListener('pointerdown', onTrackDown);
    if (onTrackMove) window.removeEventListener('pointermove', onTrackMove);
    if (onTrackUp) window.removeEventListener('pointerup', onTrackUp);
    onPause = onStop = onSlower = onFaster = null;
    onTrackDown = onTrackMove = onTrackUp = null;
    _trackDragging = false;
  }

  function buildTicks() {
    const wrap = $('tourTicks');
    if (!wrap) return;
    wrap.innerHTML = '';
    for (const a of ACTS) {
      const dot = document.createElement('span');
      dot.className = 'fly-tick';
      dot.style.left = (a.f * 100).toFixed(2) + '%';
      dot.style.pointerEvents = 'auto';
      dot.style.cursor = 'pointer';
      dot.title = a.name;
      dot.addEventListener('pointerdown', (e) => e.stopPropagation());
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        seekTo(a.f);
      });
      wrap.appendChild(dot);
    }
  }

  function start(sel = {}) {
    if (raf) return;
    if (sel.launchSite && LAUNCH_SITES[sel.launchSite]) launchSiteKey = sel.launchSite;
    if (sel.landingSite && MOON_LANDING_SITES[sel.landingSite]) landingSiteKey = sel.landingSite;

    buildPathData();
    p = 0; mult = 1; playing = true; last = 0;
    inMoon = false;
    resetCamOverride();
    camRangeScale = 1;
    // 防「月球模式下点火」：任务从地球起步，无条件切回地球（幂等）
    env.showEarth();
    // 隐藏 Cesium 内置真月球（scene.moon）：第二幕顶视图里会与任务示意月球形成两个「月亮」
    if (earthViewer.scene.moon) earthViewer.scene.moon.show = false;
    clearSeparators();
    ensureEarthRocket();
    ensureTransferScene();
    earthRocket.show = true;

    const panel = $('tourPanel');
    panel?.classList.remove('hidden');
    $('tourTitle').textContent = '探月任务 · 四幕剧';
    $('flyControls')?.classList.add('hidden');
    $('rocketControls')?.classList.add('hidden');
    $('btnLaunch')?.classList.add('hidden');
    buildTicks();

    env.onStatus?.('探月任务开始：点火升空…', 'ok');
    bindPanel();
    render();
    raf = requestAnimationFrame(tick);
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0; playing = false;
    resetCamOverride();
    clearSeparators();          // 内含分离件 slot 销毁
    for (const s of slots.slice()) destroySlot(s);
    rocketSlot = rocketCoreSlot = craftSlot = loiCraftSlot = landerSlot = roverSlot = null;
    for (const v of [...fxSlots.keys()]) destroyFxFor(v);
    if (earthRocket) { earthViewer.entities.remove(earthRocket); earthRocket = null; }
    if (launchTrailEnt) { earthViewer.entities.remove(launchTrailEnt); launchTrailEnt = null; }
    if (transferFullEnt) { earthViewer.entities.remove(transferFullEnt); transferFullEnt = null; }
    if (phasingEnt) { earthViewer.entities.remove(phasingEnt); phasingEnt = null; }
    if (captureEnt) { earthViewer.entities.remove(captureEnt); captureEnt = null; }
    for (const le of phaseLabelEnts) earthViewer.entities.remove(le);
    phaseLabelEnts = [];
    if (transferMirrorEnt) { earthViewer.entities.remove(transferMirrorEnt); transferMirrorEnt = null; }
    if (emLineEnt) { earthViewer.entities.remove(emLineEnt); emLineEnt = null; }
    if (transferTrailEnt) { earthViewer.entities.remove(transferTrailEnt); transferTrailEnt = null; }
    if (transferLabelEnt) { earthViewer.entities.remove(transferLabelEnt); transferLabelEnt = null; }
    if (moonEnt) { earthViewer.entities.remove(moonEnt); moonEnt = null; }
    if (moonOrbitEnt) { earthViewer.entities.remove(moonOrbitEnt); moonOrbitEnt = null; }
    if (padDustEnt) { earthViewer.entities.remove(padDustEnt); padDustEnt = null; }
    clearMoonEntities();
    try { earthViewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY); } catch { /* 忽略 */ }
    if (earthViewer.scene.moon) earthViewer.scene.moon.show = true;   // 恢复内置月球
    unbindPanel();
    hideCard();
    noteOn(false);
    inMoon = false;
    $('rocketPhase')?.classList.add('hidden');
    $('tourPanel')?.classList.add('hidden');
    $('tourPause')?.classList.add('hidden');
    $('tourTicks').innerHTML = '';
    env.onStatus?.('探月任务已停止', '');
  }

  return {
    start,
    stop,
    isActive: () => !!raf,
    /** 预加载地球侧模型（面板打开时即可调用，点火时大概率已就绪） */
    preload: () => {
      getRocketSlot(); getRocketCoreSlot(); getCraftSlot();
      getFx(earthViewerRef, 'flame'); getFx(earthViewerRef, 'rcs');
    },
    /** 发射前预览：火箭竖立于当前发射台 + 相机取景（选场/进面板时调用；播放中自动跳过） */
    previewLaunchSite,
    /** 冒烟/诊断：各模型槽位状态（含 minimumPixelSize/computedScale 等运行时量）
     *  注意：Model.boundingSphere/computedScale 在 sceneGraph 未就绪（首次 update 前）时
     *  访问会抛异常，必须逐项 safe 包装（2026-10-17 实测）。 */
    debugState: () => ({
      p: +p.toFixed(4),
      cam: {
        override: camOverride,
        blend: +blendT.toFixed(3),
        act2RangeKm: Math.round(_act2Cam.rangeKm),
        act2TargetKm: Math.round(_act2Cam.targetMagKm),
      },
      dbg: _dbg,
      slots: slots.map((s) => {
        const m = s.model;
        const safe = (fn) => { try { return fn(); } catch { return null; } };
        // 注意：boundingSphere getter 本身在 sceneGraph 未就绪时就会抛（连存在性检查都不能裸做）
        const bs = m && !m.isDestroyed() ? safe(() => m.boundingSphere) : null;
        let camDist = null;
        if (bs && s.viewer) {
          camDist = safe(() => Math.round(Cesium.Cartesian3.distance(s.viewer.camera.positionWC, bs.center)));
        }
        return {
          key: s.key, ready: s.ready, failed: s.failed, added: s.added,
          show: safe(() => !!(m && m.show)),
          anim: s.animCount, animOn: !!s.animOn,
          hasSceneGraph: safe(() => !!m && !!m.sceneGraph),
          minPx: safe(() => (m ? m.minimumPixelSize : null)),
          computedScale: safe(() => (m && isFinite(m.computedScale) ? Math.round(m.computedScale * 1000) / 1000 : null)),
          bsRadius: safe(() => (m && m.sceneGraph && m.boundingSphere ? Math.round(m.boundingSphere.radius * 100) / 100 : null)),
          camDist,
        };
      }),
    }),
    /** 调试/冒烟：跳转到指定进度（跨幕自动补建/清理场景） */
    seek: (f) => seekTo(f),
    /** 右上角导航控件是否应锁定：仅第二幕（地月顶视构图）锁，第一/三/四幕保留给用户操作 */
    navLocked: () => p >= T.card1End && p < T.card3End,
    /** 冒烟诊断：第二幕轨道面内坐标（km）——直接定位「取景是否框住了目标」，
     *  比看画布像素更能定位问题（轨道面内 x 沿 e1、y 沿 e2）。 */
    debugAct2: () => {
      const s = act2Progress(p);
      const mc = moonCartAt(s);
      const sc = s < P2.phasingEnd ? phasingCartAt(s / P2.phasingEnd)
        : s < P2.enc ? transferCartAt((s - P2.phasingEnd) / (P2.enc - P2.phasingEnd))
          : captureCartAt((s - P2.enc) / (1 - P2.enc));
      const [mx, my] = toPlaneKM(mc);
      const [sx, sy] = toPlaneKM(sc);
      return {
        s: +s.toFixed(4),
        moonExag: +_moonExagNow.toFixed(3),          // 实际生效倍率（含幕卡 2 的过渡值）
        moonRadiusKm: Math.round(EM.moonR * _moonExagNow),
        moonExagTarget: +moonExagAt(s).toFixed(3),
        moon: [Math.round(mx), Math.round(my)],
        craft: [Math.round(sx), Math.round(sy)],
        moonMagKm: Math.round(Cesium.Cartesian3.magnitude(mc) / 1000),
        basis: [+Cesium.Cartesian3.magnitude(TR.e1).toFixed(4),
          +Cesium.Cartesian3.magnitude(TR.e2).toFixed(4),
          +Cesium.Cartesian3.magnitude(TR.nrm).toFixed(4)],
        e1e2: +Cesium.Cartesian3.dot(TR.e1, TR.e2).toFixed(6),
      };
    },
    /** 冒烟用时间轴常量（避免脚本里硬编码进度值，改幕长即失效） */
    timeline: () => ({ ...T, boosterSep: BOOSTER_SEP, fairingSep: FAIRING_SEP, rate: { ...ACT_RATE } }),
    /** 冒烟探针专用：原始槽位引用（页内计算用，勿序列化返回） */
    debugSlots: () => slots,
    /** 冒烟探针专用：某槽位模型的**实际渲染矩阵**（纯数据，可 CDP 序列化）。
     *  modelMatrix = 用户设置矩阵（ENU×R）；computed = Cesium 内部
     *  modelMatrix × axisCorrection（glTF Y-up→Z-up 校正）——模型局部轴的世界朝向
     *  必须读 computed，读 modelMatrix 只验证了自己的公式（2026-10-18 玉兔朝向误判教训）。 */
    debugSlotMatrix: (keyRe) => {
      const s = slots.find((sl) => keyRe.test(sl.key));
      if (!s) return null;
      const m = s.model;
      const sg = m ? (() => { try { return m.sceneGraph; } catch { return null; } })() : null;
      return {
        key: s.key, url: s.def ? s.def.url : null,
        ready: s.ready, added: s.added, failed: s.failed,
        modelMatrix: m ? Array.from(m.modelMatrix) : null,
        computed: sg && sg.computedModelMatrix ? Array.from(sg.computedModelMatrix) : null,
        axisCorrection: sg && sg.axisCorrectionMatrix ? Array.from(sg.axisCorrectionMatrix) : null,
        bs: sg && sg.boundingSphere
          ? { c: [sg.boundingSphere.center.x, sg.boundingSphere.center.y, sg.boundingSphere.center.z], r: sg.boundingSphere.radius }
          : null,
      };
    },
    setLaunchSite: (k) => {
      if (!LAUNCH_SITES[k]) return;
      launchSiteKey = k;
      previewLaunchSite();   // 未发射时换场：镜头转过去 + 竖起火箭（播放中内部自动跳过）
    },
    setLandingSite: (k) => { landingSiteKey = k; },
    getLaunchSite: () => launchSiteKey,
    getLandingSite: () => landingSiteKey,
  };
}

// 动力下降曲线（第三幕，2026-10-17 重做）：s∈[0,1]
//   0~0.28 离轨制动（仍是飞船上面级）：100 km → 15 km，逆向主发动机
//   0.28~1 动力下降（着陆器）：15 km → 月面，先快后慢，末段收油门
// 水平位移（子午线大圆弧）不在本曲线内——由 render 的 latT = site.lat + lerp(-40, 0, s)
// 按进度推进纬度（2026-10-18 定稿：与 LOI 同弧同向、自南向北）。
function descentProfile(s) {
  const s01 = clamp01(s);
  if (s01 < 0.28) {
    const u = s01 / 0.28;
    return { alt: lerp(100000, 15000, u * 0.25 + u * u * 0.75), thrust: 0.55 + 0.45 * (1 - u) };
  }
  const u = (s01 - 0.28) / 0.72;
  const alt = 15000 * Math.pow(1 - u, 1.1);
  const thrust = u < 0.82 ? 1 : Math.max(0.12, (1 - u) / 0.18);
  return { alt, thrust };
}

export default createMoonMission;
