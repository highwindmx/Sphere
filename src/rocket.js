// src/rocket.js — 探月任务四幕剧（3D 版：glTF Model + 火焰/RCS 特效）
// ⭐⭐ 2026-10-22 用户：原第二幕（调相+转移）与原第三幕（捕获）**合并为第二幕**，并全面改用
//   src/changE1.js 的嫦娥一号轨道引擎（移植自参考项目 Fly2moon/chang-e-hohmann.html）。
// 四幕结构：
//   第一幕 · 点火起飞   （地球 Viewer：发射段上升 + 四段分离动效 + 发射轨迹线；
//                         时序（2026-10-23 用户定序）：整箭 → ①四枚次级助推器分离 → ②主助推器/芯一级
//                         分离 → ③抛整流罩 → ④星箭分离（二级脱离，飞船帆板**收拢**）→ ⑤帆板展开；
//                         主发动机火焰 + 发射台灰尘 + 过顶段 RCS 姿控喷气）
//   第二幕 · 奔月与捕获 （地球 Viewer，changE1 引擎 15 段：205 km 停泊 → 16/24/48 h 调相各 1 圈
//                         → TLI → 转移椭圆 → 影响球 66,000 km 处拼接圆锥（双曲线接近，v∞≈0.739）
//                         → 三次近月制动 321/283/211 m/s 入 200 km 极轨；
//                         镜头：各档按远地点 fit，接近段随月距 16.8→7.4 万 km 推向月球，制动段锁定月球特写）
//   第三幕 · 环月与动力下降（月球 Viewer：环月巡航 → 离轨 → 动力下降着陆）
//   第四幕 · 着陆与巡视   （月球 Viewer：着陆器展翼 → 玉兔号驶出月面巡视）
// 幕间用文字幕卡过渡（幕卡 1 入轨 / 幕卡 2 地月全景定场）。
// ⭐ 时间边界一律读 T（见 ACTS 注释），勿硬编码；改动幕长时同步核对 ACTS 与 rateAt。
// 复用底部巡游面板：播放/暂停/倍率/进度条拖拽/幕节点跳转/重播。
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
import { MOON_ELLIPSOID, MOON_LANDING_SITES, sampleMoonHeight, isLunarHiRes } from './lunar.js';
import { sampleTerrainHeight } from './terrarium-provider.js';
import * as CE1 from './changE1.js';   // 嫦娥一号轨道引擎（第二幕，移植自 Fly2moon 参考项目）
import { LANDER_ICON, SPACECRAFT_ICON } from './moon-landing.js';
import {
  FULL_ROCKET_ICON,
  STAGE1_ICON,
  BOOSTER_ICON,
  FAIRING_LEFT_ICON,
  FAIRING_RIGHT_ICON,
  RELAY_ICON,
  ROVER_ICON,
  EARTH_ICON,
  MOON_ICON,
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
  moonExag: 8,            // 近景（绕月）视觉放大倍数；远景另由 MOON_EXAG_FAR=6 接管（见 moonExagAt）
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
const CH_CAPTURE = [                  // 捕获段：抵达在「远月点」(背地)，每次过「近月点」(向地)逆行制动，远月点逐档收圆
  { rp: 200, ra: 18862, laps: 0.5, per: 12,       name: '地月转移抵达' },   // 半圈：远月点(20,599 月心距 = 转移可达最远处)→近月点(LOI-1 首次制动)
  { rp: 211, ra: 8500,  laps: 2,   per: 12,       name: '12 小时轨道' },    // 11/5 LOI-1 后（近月点 211 / 远月点 8,500）
  { rp: 200, ra: 1729,  laps: 4,   per: 3.5,      name: '3.5 小时轨道' },   // 11/6 LOI-2 后
  { rp: 195, ra: 195,   laps: 1,   per: 127 / 60, name: '127 分钟圆轨道' }, // 11/7 LOI-3 后（200 km 极月圆轨道）
];
// —— 月球视觉倍率（2026-10-19 捕获段改真实比例）——
// ⭐ 捕获段必须**真实比例（×1）**：×8 会让环月轨道远月点(81,899 km)超出转移可达范围
//    (转移远地点 405,000 − 地月距 384,400 = 20,600 km)，物理上接不上转移；且旧版把抵达点放在
//    ×8 近月点 → 「转移→捕获反向」科学性错误（用户 2026-10-19 反馈，参照 demos/ 修正）。
//    远景（地月同框）仍用 ×3 让月球作为靶标可见（×1 时仅 ~3px 小点）；会合点硬切换 ×3→×1。
// ⚠ 倍率上限受「会合点」硬约束：飞船在转移远地点与月心距 = EM.encR − EM.moonDist
//   = 20,599 km。月球半径一旦放大到超过它，飞船会合时会**穿透月球内部**——所以 ×6
//   （半径 10,424 km，余量一半）已接近可读上限，×8 只剩 6,700 km 余量，×12 必然穿透。
//   2026-10-19 用户反馈「第二幕月球需要月面图片蒙皮」：×3 时屏幕直径仅 9.5~13 px，
//   10 MB 贴图压到十几像素等于没有；×6 后约 19~26 px 可辨认月面轮廓与月海明暗。
const MOON_EXAG_FAR = 6;
const MOON_EXAG_NEAR = 1;                      // 捕获段真实比例（与转移同尺度，保证衔接连续）
const CH_RV_KM = EM.moonR * MOON_EXAG_NEAR;    // 会合点月半径 km = 1,737（真实）
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
// 抵达点：飞船在转移**远地点**与月球会合（距月心 = 转移远地点 405,000 − 地月距 384,400
//   = 20,599 km）——这正是转移可达的最远处，捕获轨道远月点取它才能「衔接得上」。
// 该处平近点角由开普勒方程反解：r = a(1 − e·cosE) → E → M。
EM.encR = EM.moonDist + CA[0].ra;
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
/** 月球视觉倍率：**在会合点硬切换**（远景 ×3 / 会合及捕获 ×1 真实比例）。
 *  ⚠ 不能按 s 平滑抬升：会合点半径 encR 是按 ×1 算的（= 转移远地点 − 地月距 = 20,599 km），
 *    抵达瞬间倍率没降满就会与转移跳变。平滑下降改在**幕卡 2** 里做（那时飞船隐藏、
 *    镜头正在从 39 万 km 推到 2.4 万 km，地球逐步出画，月球由大变小正好读作「正在逼近」）
 *    ——见 render 的幕卡 2 分支。 */
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
/** ⭐ 2026-10-23 末：底部巡游面板（时间轴 + 解说两行）会遮住画面下沿，主体若按整屏居中
 *  就会被压在面板后面。这里统一做**遮挡补偿**：
 *    · visFracV() = 未被遮挡的竖直比例 → 取景按它收缩（主体完整落在可见区）
 *    · occlusionPanM() = 相机沿「屏幕下方」平移量 → 主体落到**可见区中心**（不是整屏中心）
 *  两者都是纯几何，与具体幕/机位无关，故放在公共层一次生效。 */
function bottomOcclusionFrac() {
  try {
    const el = document.getElementById('tourPanel');
    if (!el || el.classList.contains('hidden')) return 0;
    const r = el.getBoundingClientRect();
    if (!(r.height > 0)) return 0;
    const H = window.innerHeight || 1;
    return Math.max(0, Math.min(0.45, (r.height + 14) / H));
  } catch { return 0; }
}
function visFracV() { return 1 - bottomOcclusionFrac(); }

/** 相机竖直半张角的 tan（按当前 frustum / 画布宽高比实算，不再硬编码 16:9） */
function tanVertical(v) {
  try {
    const f = v && v.camera && v.camera.frustum;
    if (f && typeof f.fov === 'number' && isFinite(f.fov)) {
      const asp = f.aspectRatio;
      if (asp && isFinite(asp) && asp >= 1) return Math.tan(f.fov / 2) / asp;
      return Math.tan(f.fov / 2);
    }
  } catch { /* 忽略 */ }
  return TAN_V;
}
/** 遮挡补偿平移量（米）：range 为相机到主体的距离（米） */
function occlusionPanM(v, rangeM) {
  const fr = bottomOcclusionFrac();
  if (fr <= 0 || !(rangeM > 0)) return 0;
  return rangeM * tanVertical(v) * fr;
}

/** 由轨道面内包围盒半尺寸（km）反算顶视取景距离，保证目标不出画（已计入底部面板遮挡） */
function fitRangeKm(halfX, halfY, margin = 0.88) {
  return Math.max(halfX / TAN_H, halfY / (TAN_V * visFracV())) / margin;
}

/** 相机沿屏幕下方平移 d 米（direction/up 不变）→ 主体在画面里上移，落到可见区中心 */
function panDownScreen(v, d) {
  if (!v || !(d > 0)) return false;
  try {
    const pos = Cesium.Cartesian3.clone(v.camera.positionWC, _panP);
    const dir = Cesium.Cartesian3.clone(v.camera.directionWC, _panD);
    const up = Cesium.Cartesian3.clone(v.camera.upWC, _panUo);
    Cesium.Cartesian3.cross(dir, up, _panR);                       // right = dir × up
    if (Cesium.Cartesian3.magnitudeSquared(_panR) < 1e-12) return false;
    Cesium.Cartesian3.normalize(_panR, _panR);
    Cesium.Cartesian3.cross(_panR, dir, _panS);                    // 屏幕上方向
    Cesium.Cartesian3.normalize(_panS, _panS);
    Cesium.Cartesian3.multiplyByScalar(_panS, -d, _panS);
    Cesium.Cartesian3.add(pos, _panS, pos);
    v.camera.setView({ destination: pos, orientation: { direction: dir, up } });
    return true;
  } catch { return false; }
}

/** 相机所在处的**地面高程**（米，相对参考椭球）。
 *  优先 globe.getHeight（真实地形瓦片）；瓦片未就绪时返回 undefined → 对月球退回内置 DEM
 *  采样 sampleMoonHeight（与 CustomHeightmapTerrainProvider 同源，值一致且无需等瓦片）。 */
function terrainHeightAt(v, carto) {
  try {
    if (v.scene.globe && typeof v.scene.globe.getHeight === 'function') {
      const h = v.scene.globe.getHeight(carto);
      if (typeof h === 'number' && isFinite(h)) return h;
    }
  } catch { /* 忽略 */ }
  try {
    const ell = (v.scene.globe && v.scene.globe.ellipsoid) || Cesium.Ellipsoid.WGS84;
    if (Math.abs(ell.maximumRadius - MOON_ELLIPSOID.maximumRadius) < 1) {
      const h = sampleMoonHeight(Cesium.Math.toDegrees(carto.longitude), Cesium.Math.toDegrees(carto.latitude));
      if (typeof h === 'number' && isFinite(h)) return h;
    }
  } catch { /* 忽略 */ }
  return 0;
}
/** 防镜头钻进星球内部（2026-10-23 末用户「视角不能掉到月球内部去」）：
 *  ⚠ 基准必须是**地形面**而不是椭球面 —— 月球 DEM 相对参考椭球普遍为负（雨海 −5,278 m），
 *  相机离地高度低于下限就沿法线抬回，视线/上方向保持不变。 */
function enforceMinCamAlt(v, minM) {
  if (!v || !v.scene || !(minM > 0)) return;
  try {
    const ell = (v.scene.globe && v.scene.globe.ellipsoid) || Cesium.Ellipsoid.WGS84;
    const carto = Cesium.Cartographic.fromCartesian(v.camera.positionWC, ell);
    if (!carto || !isFinite(carto.height)) return;
    // ⭐⭐ 2026-10-24 修「3-6→4-1 着陆器从页面中消失」的真因：基准必须是**地形面**而非椭球面。
    //   月球 DEM（LOLA/Terrarium）相对参考椭球**普遍为负**——雨海着陆点实测 −5,278 m。
    //   于是「贴地机位」（落在 h≈−5,150 m）按椭球高判就是「在星球内部」，被整体抬到
    //   参考面上方 43 m ⇒ 比真实月面高 5 km，主体被甩到画面外。
    //   修：以 globe.getHeight 的地形高为基准，只要求「离**地面** ≥ minM」。
    let base = terrainHeightAt(v, carto);
    if (carto.height - base >= minM) return;
    const need = minM - (carto.height - base);
    const dir = Cesium.Cartesian3.clone(v.camera.directionWC, new Cesium.Cartesian3());
    const up = Cesium.Cartesian3.clone(v.camera.upWC, new Cesium.Cartesian3());
    const c2 = Cesium.Cartographic.clone(carto);
    c2.height = carto.height + need;
    const p = Cesium.Cartographic.toCartesian(c2, ell, new Cesium.Cartesian3());
    if (!p || !isFinite(p.x)) return;
    v.camera.setView({ destination: p, orientation: { direction: dir, up } });
  } catch { /* 忽略 */ }
}
/** 星球半径相关的最低离地高度（月球 ≈43 m / 地球 ≈159 m） */
function minCamAltM(v) {
  const ell = (v && v.scene && v.scene.globe && v.scene.globe.ellipsoid) || Cesium.Ellipsoid.WGS84;
  return Math.max(30, ell.maximumRadius * 2.5e-5);
}
const _panP = new Cesium.Cartesian3(), _panD = new Cesium.Cartesian3();
const _panUo = new Cesium.Cartesian3(), _panR = new Cesium.Cartesian3(), _panS = new Cesium.Cartesian3();
const PH_B = PH.map((o) => o.a * Math.sqrt(1 - o.e * o.e));   // 调相三条椭圆半短轴
const CA_B = CA.map((o) => o.a * Math.sqrt(1 - o.e * o.e));   // 环月四条轨道半短轴
const PH_RANGE = fitRangeKm(PH[2].a, PH_B[2]);                // 调相段定焦（含最外 48h 椭圆）
// 捕获段四档取景（随三次制动逐档收紧）；margin 0.8 比 0.88 留白更多——127min 轨道贴着月面，
// 画面太满会把环月轨道挤到边角
// ⚠ 2026-10-21：抵达半圈（i=0）定焦改按**远月点 ra**（月心距 20,599 km），不用半长轴 a
//   （11,268 km）——月心是椭圆的**焦点**而不是中心，而取景中心 cT 就是月心（见 lookAtTransfer
//   的 cT = mc）。按 a 定焦只能覆盖椭圆中心附近，远月点方向 20,599 km 处必然出画。
//   实测：会合点（= 转移弧末端）屏幕 x = −506 px（画布宽 940）→ 整条「来时路」虚线在捕获段
//   完全不可见（inView = 0）。改按 ra 定焦后取景 24,394 → 44,593 km，抵达半圈能看到完整
//   椭圆 + 会合点 + 从远处延伸进来的转移弧；月球屏幕半径 ~84 → ~42 px，仍清晰可辨。
const CA_RANGE = CA.map((o, i) => fitRangeKm(i === 0 ? o.ra : o.a, CA_B[i], 0.8));
// ⭐ 2026-10-22 用户要求「拉宽捕获幕主视图相机，让来时路大弧可见」：抵达段（首次制动前）用宽
//   取景把蓝色转移大弧纳入主视图，看到捕获环在 P 点接大弧；首次制动后收敛到 CA_RANGE[0] 再依次
//   收紧看环月轨道。代价：月球/玉兔变小（用户已确认接受）。
const CAP_WIDE_KM = 300000;
// ⭐ 2026-10-22 定稿打磨（用户「细节继续帮我打磨」）：衔接时刻（uC=0，含 card2 幕卡）主相机用
//   近景 CAP_JOIN_KM——相切弯道清晰可见（实测 +1 相切 vs -1 掉头在 30 万 km 宽取景下仅 ~30px
//   不可辨，这正是用户「完全没看到定稿样式变化」的根因）；随后拉远到 CAP_WIDE_KM 看来时路大弧，
//   抵达半程起再收敛到 CA_RANGE[0] 看首次制动。
const CAP_JOIN_KM = 60000;
// 捕获段内三次换轨时刻（段内进度 0..1）：抵达→12h / 12h→3.5h / 3.5h→127min
const CA_SWITCH = [0, 1, 2].map((i) =>
  CH_CAPTURE.slice(0, i + 1).reduce((s, o) => s + o.laps * o.per, 0) / CH_H.capture);

// 四个发射场中用于探月任务的低纬两个（数据与 moonmission 图层一致）
export const LAUNCH_SITES = {
  jiuquan: { lon: 100.298, lat: 40.96, name: '酒泉' },
  wenchang: { lon: 110.951, lat: 19.614, name: '文昌' },
};

// 幕时间边界（归一化 0..1）
// ⭐⭐ 2026-10-22 用户：**原第二幕（调相+转移）与原第三幕（捕获）合并为新第二幕**，全幕
//    改用 changE1.js 的嫦娥一号轨道引擎（停泊→调相→转移→影响球接近→三次制动，共 15 段）。
//    合并后共 **4 幕**：第一幕点火起飞 / 第二幕奔月与捕获 / 第三幕环月与动力下降 / 第四幕着陆巡视。
//    绝对秒数（× BASE_DURATION 132 s，rate=1 基准）：第一幕 22.8 / 幕卡1 3.6 /
//    **第二幕 57.5**（= 原转移幕 39.9 + 幕卡2 3.6 + 捕获幕 14.0，中间的幕卡 2 取消，改为连续一幕）
//    / 幕卡2 3.6 / 环月 30.6 / 下降 6.6 / 巡视 7.3 = 132.0 s。
//    ⚠ 命名：act2End=原 captureEnd 数值、card2End=原 card3End 数值；旧的 transferEnd /
//    card2End(0.5295) / card3End 三个边界已废止。
const T = {
  liftEnd: 0.1727,    // 第一幕结束（入轨 ~200 km）  22.8 s
  card1End: 0.2000,   // 幕卡 1 结束                  3.6 s
  act2End: 0.6356,    // 第二幕结束（三次近月制动完成）57.5 s
  card2End: 0.6629,   // 幕卡 2 结束（地月全景定场）  3.6 s
  cruiseEnd: 0.8950,  // 第三幕内：环月段结束（开始离轨/动力下降）30.6 s
  touchEnd: 0.9450,   // 第三幕结束（触月）；0.9450~1.00 为第四幕「玉兔巡视」
};
// 幕内推进倍率（2026-10-17 用户反馈「第一幕太快」）：tick 内 p += dt/BASE*mult*rateAt(p)。
//   第一幕：0.1727 × 132s ÷ 0.6 ≈ 38 s（与原 22.8/0.6 一致）
//   第五幕：0.0727 × 132s ÷ 0.7 ≈ 13.7 s
// ⭐ 2026-10-22 合并幕后：第二幕不再需要「调相慢放 / 抵达半圈慢放」这类补丁——
//   changE1.js 的 SEGS 每段 dur 已经是参考项目调好的节奏，幕内线性推进即可。
const ACT_RATE = {
  act1: 0.6,      // 第一幕：点火起飞（保留原慢放，用户反馈「第一幕太快」）
  // 第二幕（停泊→调相→转移→接近→三次制动）：2026-10-23 用户「这段可以适当慢一些」
  //   0.8 → 57.5 s 拉长到 ~72 s；点火段看得清，轨道线也不会一闪而过。
  act2: 0.8,
  cruise: 0.8,    // 第三幕环月：纯绕飞/收拢，略慢便于看清轨道
  descent: 0.3,   // 第三幕动力下降（#95「下降阶段适当慢一些」）
  act4: 0.5,      // 第四幕玉兔巡视（2026-10-23 用户「太快」：0.7→0.5 整体再放慢，玉兔推进更从容）
};
// 第二幕 ↔ changE1 时间轴：SEGS 第 0..14 段（park … lb3）映射进 [card1End, act2End]。
//   段内**相对节奏**与参考项目完全一致（各段 dur 之比原样保留），只是整体压缩到 57.5 s。
const ACT2_T_END = CE1.SEG_BY_KEY.lb3.t1;      // ≈103.24 s（参考项目动画时刻）
const ACT2_RT_END = CE1.SEG_BY_KEY.lb3.rt1;    // 对应真实任务秒数
/** 全局进度 pp → changE1 动画时刻 t（0..ACT2_T_END） */
function act2Time(pp) {
  return clamp01((pp - T.card1End) / (T.act2End - T.card1End)) * ACT2_T_END;
}
function rateAt(pp) {
  if (pp < T.liftEnd) return ACT_RATE.act1;
  if (pp >= T.card1End && pp < T.act2End) return ACT_RATE.act2;
  // 环月段（制动+巡航连续一节点）：纯绕飞/收拢，略慢便于看清轨道
  if (pp >= T.card2End && pp < T.cruiseEnd) return ACT_RATE.cruise;
  // 动力下降段慢放（#95「下降阶段适当慢一些」；2026-10-22 用户：动力下降后高清瓦片
  //   来不及加载 → 整体减速，且接近月面段(s>0.45)继续指数级减速，给 LRO WAC 瓦片落盘时间）
  if (pp >= T.cruiseEnd && pp < T.touchEnd) {
    const s = (pp - T.cruiseEnd) / (T.touchEnd - T.cruiseEnd);
    return ACT_RATE.descent * (1 - 0.55 * clamp01((s - 0.45) / 0.55));
  }
  if (pp >= T.touchEnd) return ACT_RATE.act4;
  return 1;
}
// 演示时间加速倍率（用户拍板「时间可以加速」）：第二幕真实任务时长 ÷ 演示时长。
const CH_SPEEDUP = {
  act2: Math.round(ACT2_RT_END / ((T.act2End - T.card1End) * BASE_DURATION)),
};
/** 第二幕归一化进度（0..1 = card1End..act2End）。旧名保留，语义已改为「幕内线性进度」。
 *  ⚠ 全项目凡需要「地月段进度」的地方一律走这里，禁止再写旧的分段拼接式。 */
function act2Progress(pp) {
  return clamp01((pp - T.card1End) / (T.act2End - T.card1End));
}
/** 真实任务时间格式化：T+3 天 12 时 */
function fmtElapsed(h) {
  const d = Math.floor(h / 24), hh = Math.floor(h % 24);
  return d > 0 ? `T+${d} 天 ${hh} 时` : `T+${hh} 时`;
}
// 幕节点（进度条跳转锚点）——合并后共 4 幕
// ⭐ 2026-10-23 校订命名：合并后共 **4 幕 + 2 个幕卡**，锚点名须与真实分界一一对应
//   第一幕 点火起飞 0 → liftEnd           （38 s）
//   幕卡1  入轨     liftEnd → card1End    （3.6 s）
//   第二幕 奔月与捕获 card1End → act2End  （57.5 s：205 km 停泊 → 调相 → 转移 → 接近 → 三次制动）
//   幕卡2  定场     act2End → card2End    （3.6 s）
//   第三幕 环月+下降 card2End → touchEnd  （37.2 s：环月 cruiseEnd 前，下降 touchEnd 前）
//   第四幕 着陆巡视 touchEnd → 1          （7.3 s）
// ⭐ 2026-10-24 精简（用户「时间轴上的点太多了…为何各幕卡前后都会点？删掉后面那个」）：
//   旧版 8 个锚点——每个幕卡的**前后各有一个点**（liftEnd 与 card1End、act2End 与 card2End
//   两两成对），同一个分界在轴上出现两次，既重复又让人以为有两段不同内容。
//   改：**每幕仅一个锚点**，落在该幕的起始时刻（幕卡是幕间过场，不再单独占点）。
const ACTS = [
  { f: 0, name: '第一幕 · 点火起飞' },
  { f: T.card1End, name: '第二幕 · 奔月与捕获' },
  { f: T.card2End, name: '第三幕 · 环月与动力下降' },
  { f: T.touchEnd, name: '第四幕 · 月面着陆与巡视' },
];
// ⭐ 第一幕分离时序（2026-10-23 用户定序，务必按此顺序；旧版 FAIRING(0.78) < STAGE2(0.90) 顺序颠倒已修）
//   0 整箭起飞 → 1 四枚次级助推器分离 → 2 主助推器（芯一级）分离 → 3 抛整流罩
//   → 4 星箭分离（二级脱离），卫星露出、**帆板收拢** → 5 帆板展开
const BOOSTER_SEP = T.liftEnd * 0.34;  // ① 四枚捆绑助推器分离
const CORE_SEP = T.liftEnd * 0.52;     // ② 主助推器（芯一级）分离，二级接力点火
const FAIRING_SEP = T.liftEnd * 0.70;  // ③ 抛整流罩（两瓣左右抛离），卫星露出
const STAGE2_SEP = T.liftEnd * 0.84;   // ④ 星箭分离：二级脱离，飞船上面级独立（帆板仍收拢）
const PANEL_FROM = STAGE2_SEP + T.liftEnd * 0.04;  // ⑤ 帆板展开起点（与星箭分离 0.84 拉开 0.04 间隔，间隔更明显）
const PANEL_WIN = T.liftEnd * 0.12;                //    展开窗口（≈4.5 s，比旧 0.08 更慢、铰链转动全程可读）
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
// 2026-10-23 用户「玉兔太快且跑出页面」：240 → 90（行程大幅缩短，配合相机 range 320 稳稳收进画面，
//   不再冲出视野；位置推进速度≈1/3，且轮转倍率对齐后不再有「滑行感」）。
const ROVER_LEN = 90;                               // 巡视行程（米）
// 2026-10-22 用户「把着陆器和玉兔(含行进方向)都转 180°」：0=车头朝驶离方向(默认,远离着陆器)；
// 若整体反向，把此值设 Math.PI 即可（配合着陆器/路线一并反向时再开）。
const ROVER_HEADING_FLIP = 0;
// 2026-10-22：着陆器整体偏航（默认 0=与玉兔驶离方向一致；设 Math.PI 则绕天顶翻 180°）。
// 太阳能板 deployPanels 按 landerPos ENU 独立布放、不随此姿态，翻它只转着陆器本体。
const LANDER_YAW = 0;
// 2026-10-22 用户「沿 -z 想转 +z、轨道也调过来」：巡视路线基准航向（自北顺时针）。
// 96°(原, ESE) → 276°(WNW) = 整条弧线绕着陆器旋转 180°，配合车头朝新航向即「+z 方向行进」。
const ROVER_BASE_HDG = 276;
// 2026-10-23 用户「玉兔起始位置不能是着陆器原点，至少隔一个车身」：2.5 → 4.0 m
//   （玉兔车体 ~1.2 m ≈ 3 个车身；且着陆器已 ×1.4，腿尖 2.33 m —— 4 m 起步不穿模）。
const ROVER_START_BACK = 4.0;                       // 起点相对着陆器的后移量（米）
let _roverPathCache = null;                         // { key, pts }
let _diveBlend = null;                              // 第三幕末「切着陆机位」推近混合 { t0 }

/** 玉兔巡视路线（可重规划；相机只跟随路线，不决定朝向）
 *   路线即一串 [{lon,lat,h,heading}]，相机 applyFollow 取着陆器↔玉兔中点跟随——
 *   玉兔走哪边完全由这里决定，与镜头方向无关（2026-10-22 末用户澄清：不要为「朝镜头」去改镜头，
 *   要改就改这条路线）。
 *   ROVER_ROUTE 切换路线类型（想换只改这一行，无需动相机）：
 *     'arc'        —— 默认：着陆器旁起步、沿 ~96° 航向缓弯驶离、终点更远（ROVER_LEN）
 *     'greatcircle'—— 沿大圆行驶（用户后续需求）：起点同 arc、按初始方位角走 ROVER_LEN 的大圆弧，
 *                      端点越远越能看出月面曲率；要肉眼可见曲率把 ROVER_LEN 调到百米~公里级即可
 *                      （注：45 m 的大圆与切线几乎重合，看不出弯；调大 ROVER_LEN 才弯得出来）。 */
const ROVER_ROUTE = 'arc';

function roverPath(site) {
  if (ROVER_ROUTE === 'greatcircle') return roverPathGreatCircle(site);
  return roverPathArc(site);
}

// —— 默认缓弯弧线（着陆器旁起步、沿航向 outward 至更远处）——
function roverPathArc(site) {
  const key = `arc:${site.lon},${site.lat}`;
  if (_roverPathCache && _roverPathCache.key === key) return _roverPathCache.pts;
  const N = 64;
  const ds = ROVER_LEN / N;
  // 起点 = 着陆器沿初始航向的反方向后退 ROVER_START_BACK（出着陆腿环）
  const h0 = Cesium.Math.toRadians(ROVER_BASE_HDG);
  let lon = site.lon - (ROVER_START_BACK * Math.sin(h0)) / (MOON_M_PER_DEG * Math.max(0.2, Math.cos(Cesium.Math.toRadians(site.lat))));
  let lat = site.lat - (ROVER_START_BACK * Math.cos(h0)) / MOON_M_PER_DEG;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const s = i / N;
    const heading = Cesium.Math.toRadians(ROVER_BASE_HDG + 30 * s);   // 航向（自北顺时针，缓弯）
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

// —— 大圆路线（球面 slerp；用户后续需求，随时切 ROVER_ROUTE 启用）——
function roverPathGreatCircle(site) {
  const key = `gc:${site.lon},${site.lat}`;
  if (_roverPathCache && _roverPathCache.key === key) return _roverPathCache.pts;
  const N = 64;
  const bearing = Cesium.Math.toRadians(96);          // 初始方位角（自北顺时针）
  const s0 = _destLL(site.lon, site.lat, -ROVER_START_BACK, bearing);  // 起点（着陆器旁）
  const sEnd = _destLL(site.lon, site.lat, ROVER_LEN, bearing);       // 终点（更远）
  const p0 = _llToUnit(s0.lon, s0.lat, new Cesium.Cartesian3());
  const p1 = _llToUnit(sEnd.lon, sEnd.lat, new Cesium.Cartesian3());
  const pts = [];
  const pA = new Cesium.Cartesian3(), pB = new Cesium.Cartesian3();
  for (let i = 0; i <= N; i++) {
    const ll = _unitToLL(_slerpUnit(p0, p1, i / N, pA));
    const h = sampleMoonHeight(ll.lon, ll.lat);
    let heading;
    if (i < N) {
      const llN = _unitToLL(_slerpUnit(p0, p1, (i + 1) / N, pB));
      heading = _bearingLL(ll, llN);                  // 大圆航向（自然随曲率变化）
    } else {
      heading = pts[N - 1].heading;                   // 末点沿用前一段
    }
    pts.push({ lon: ll.lon, lat: ll.lat, h, heading });
  }
  _roverPathCache = { key, pts };
  return pts;
}

// 球面小工具（玉兔大圆路线用）：经纬度↔单位向量、两点间方位角、单位向量 slerp
function _destLL(lonDeg, latDeg, distM, brngRad) {
  const d = distM / MOON_R;
  const lat1 = Cesium.Math.toRadians(latDeg), lon1 = Cesium.Math.toRadians(lonDeg);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brngRad));
  const lon2 = lon1 + Math.atan2(Math.sin(brngRad) * Math.sin(d) * Math.cos(lat1),
    Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lon: Cesium.Math.toDegrees(lon2), lat: Cesium.Math.toDegrees(lat2) };
}
function _llToUnit(lonDeg, latDeg, out) {
  const la = Cesium.Math.toRadians(latDeg), lo = Cesium.Math.toRadians(lonDeg);
  return Cesium.Cartesian3.fromElements(Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la), out);
}
function _unitToLL(p) {
  const mag = Cesium.Cartesian3.magnitude(p) || 1;
  const lat = Math.asin(p.z / mag);
  const lon = Math.atan2(p.y, p.x);
  return { lon: Cesium.Math.toDegrees(lon), lat: Cesium.Math.toDegrees(lat) };
}
function _slerpUnit(a, b, f, out) {
  const dot = Math.min(1, Math.max(-1, Cesium.Cartesian3.dot(a, b)));
  const theta = Math.acos(dot);
  if (theta < 1e-9) return Cesium.Cartesian3.clone(a, out);
  const s = Math.sin(theta);
  const wa = Math.sin((1 - f) * theta) / s, wb = Math.sin(f * theta) / s;
  return Cesium.Cartesian3.fromElements(a.x * wa + b.x * wb, a.y * wa + b.y * wb, a.z * wa + b.z * wb, out);
}
function _bearingLL(a, b) {   // 弧度，自北顺时针为正
  const la1 = Cesium.Math.toRadians(a.lat), la2 = Cesium.Math.toRadians(b.lat);
  const dLon = Cesium.Math.toRadians(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return Math.atan2(y, x);
}

// 着陆点周边高清瓦片预热（2026-10-22 用户：动力下降近距离段月面空白 → 提前经 /tiles/lunar
//   代理拉取并落盘，下降时直接本地读）。仅在高清层开启时预热；每次进入任务对同一着陆点只预热一次。
const _warmedSites = new Set();
function warmLunarTiles(site) {
  const key = `${site.lon},${site.lat}`;
  if (_warmedSites.has(key)) return;
  if (typeof isLunarHiRes === 'function' && !isLunarHiRes()) return;
  _warmedSites.add(key);
  // GeographicTilingScheme：列数=2^(z+1)、行数=2^z（与 proxy_lunar_tile 越界保护一致；z>7 上游 400）
  for (let z = 4; z <= 7; z++) {
    const cols = 2 ** (z + 1), rows = 2 ** z;
    const cx = Math.floor(((site.lon + 180) / 360) * cols);
    const cy = Math.floor(((90 - site.lat) / 180) * rows);
    const R = z <= 5 ? 1 : 2;
    for (let dx = -R; dx <= R; dx++) for (let dy = -R; dy <= R; dy++) {
      const xx = ((cx + dx) % cols + cols) % cols;
      const yy = cy + dy;
      if (yy < 0 || yy >= rows) continue;
      fetch(`/tiles/lunar/${z}/${xx}/${yy}.jpg`).catch(() => {});
    }
  }
}

// ====== glTF 3D 模型（异步加载 + billboard 兜底；2026-10-17） ======
// 模型约定（tools/build/make_mission_models.py）：Y-up；火箭/飞船机头 +Y，原点=发动机喷口面；
// 着陆器/月球车接地 y=0；火焰/RCS 原点=喷口、焰柱 +Y。
// Cesium 对 glTF 自动做 Y→Z 校正，故 modelMatrix = ENU(pos) * R 时 R=identity 即竖直向上。
// minimumPixelSize 标定（2026-10-17 实测，勿照理论公式）：
//   Cesium Model 的最小像素钳制（vendored index.js 的 J0t）：钳制生效时
//     computedScale = minPx · s / (2 · _initialRadius)，包围球直径被归一化到 ≈minPx 像素，
//     **与模型真实长度无关**（s=相机处米/像素，远距时钳制必然生效：整箭 36m@20km 自视界仅 ~1.5px）。
//   ⇒ minPx 必须按模型真实长度（≈包围球直径）**等比**设置，否则各形态被钳成同一表观尺寸。
//   ⚠ 2026-10-23 用户「芯一级分离后火箭长度没有缩短」：rocketUpper 曾与整箭/芯级同用 260，
//     17.2m 的二级被钳到与 36m 芯级同一屏幕尺寸（实测角尺寸 0.2714 vs 0.2685 rad，几乎相等）。
//   ⚠⚠ 2026-10-23 用户续馈「不是变短、是整体缩小」：只调 minPx 不够——钳制是**整体等比**，
//     旧二级模型本身 Ø2.5m（芯级 Ø4.5m，直径比 0.556），屏幕上"又短又细"。真长五二级与
//     芯一级同径。故 make_mission_models.py 重做 upper glb：箭体直径对齐芯级（r1.65）/
//     整流罩与整箭同卵形几何 R1.65 H8.0，总长 24.6m = 芯级的 68%；**喷口**为独立钟形
//     收敛-扩张喷管（出口 r1.45，明显细于芯级 r2.25 外张尾裙），芯级分离后可见大喷口坠离→小钟形接力；
//     minPx = 260×24.6/36 ≈ 179（∝长度 → 屏幕「像素/米」与芯级一致 → 粗细不变、短一截）。
//   验证（archive/quarantine-tools/scripts-onepass/act1-length-probe.mjs，同机位差分剪影）：见当轮日志。
//   已按比例者：助推器 120/16.4m、整箭&芯级 260/36m、二级 179/24.6m；分离件火焰/RCS 不参与。
const MODEL_DEFS = {
  // 2026-10-23 用户「看不出形态变化」：分离高度上相机 15–38km 远，minPx 150（~35px）下
  //   助推器/整流罩/二级的剪影差异完全不可辨 → 提到 260（~60px），四种形态肉眼可分。
  rocket:     { url: '/models/longmarch5.glb',      minPx: 260 },  // 第一幕整箭（36m）
  rocketCore: { url: '/models/longmarch5_core.glb', minPx: 260 },  // 抛助推器后芯级箭（仍带整流罩，36m）
  // 二级 + 整流罩 + 罩内卫星（2026-10-23）：芯一级分离后接管，抛整流罩时把「整流罩」节点缩到 0
  // minPx=179（2026-10-23 重做模型后）：24.6m×Ø4.5m（直径已对齐芯级）→ 260×24.6/36 按长度
  //   等比。旧值 124 对应 17.2m×Ø2.5m 的细短模型（用户实测「整体缩小」而非「变短」）。
  rocketUpper: { url: '/models/longmarch5_upper.glb', minPx: 179 },
  // 抛整流罩后纯探测器（转移/环月/离轨；无芯级/尾裙）。
  // minPx 200→240（2026-10-23 用户「帆板展开没有动画」：第一幕卫星 ~55px，
  //   两段式铰链转动 + 跨度 6.8→12 m 的剪影变化才看得清；第二/三幕仍走 CRAFT_PX_TRANSFER=75）
  craft:      { url: '/models/probe.glb',          minPx: 240 },
  loiCraft:   { url: '/models/probe.glb',          minPx: 150 },  // 月球 viewer 独立实例（同上纯探测器）
  booster:    { url: '/models/booster.glb',         minPx: 120 },  // 分离件（每枚独立实例）
  fairing:    { url: '/models/fairing.glb',         minPx: 120 },
  lander:     { url: '/models/moon_lander.glb',     minPx: 120 },
  rover:      { url: '/models/yutu_rover.glb',      minPx: 53 },   // 第四幕（6 轮滚动动画；2026-10-24 随 ×2/3 缩小从 80 同步下调）
  flame:      { url: '/models/flame.glb',           minPx: 24 },   // 发动机火焰（远距不消失、近距自然大小）
  rcs:        { url: '/models/rcs.glb',             minPx: 16 },   // RCS 姿控喷气
};

const slots = [];           // 全部存活 slot 登记（stop 时统一销毁）
let rocketSlot = null;      // 单例：整箭 / 芯级箭 / 上面级 / 环月飞船 / 着陆器 / 月球车
let rocketCoreSlot = null;
let rocketUpperSlot = null; // 二级（带整流罩 + 罩内卫星）2026-10-23 新增
let craftSlot = null;
let loiCraftSlot = null;
let landerSlot = null;
let roverSlot = null;
let earthViewerRef = null;  // 由 createMoonMission 赋值
let moonViewerRef = null;
const fxSlots = new Map();  // viewer → { flame, rcs }（特效模型按 viewer 各一份）
// ⚠ 模块级状态：下列变量被【模块级】helper（updateDust/deployPanels 等）与 createMoonMission
//   内部共同读写，必须声明在模块作用域，否则模块级函数引用会抛 ReferenceError（2026-10-23 修复：
//   此前误放在 createMoonMission 闭包内，导致第四/五幕 render 每帧 ReferenceError → 画面冻结）。
let landerPanelL = null;     // 着陆器左太阳能翼（着陆后展开）
let landerPanelR = null;     // 着陆器右太阳能翼（着陆后展开）
const _dustPsMap = new Map();// 着陆月尘粒子系统（按 viewer 缓存）

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
    // 加载失败是「第四/五幕只看到 2D 图标、没有 3D 模型」的最可能根因，直接打到屏幕横幅
    try {
      const b = document.getElementById('missionError');
      const msg = '模型加载失败 ' + def.url + '：' + ((e && e.message) || e);
      if (!b) {
        const el = document.createElement('div');
        el.id = 'missionError';
        el.style.cssText = 'position:fixed;left:8px;bottom:8px;max-width:46vw;z-index:99999;'
          + 'background:rgba(176,28,28,.93);color:#fff;font:12px/1.5 ui-monospace,Consolas,monospace;'
          + 'padding:8px 10px;border-radius:6px;white-space:pre-wrap;pointer-events:none;';
        (document.body || document.documentElement).appendChild(el);
        el.textContent = '⚠ ' + msg;
      } else {
        b.textContent = '⚠ ' + msg + '\n' + b.textContent;
      }
    } catch { /* 忽略 DOM 异常 */ }
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
function getRocketUpperSlot() { if (!rocketUpperSlot) rocketUpperSlot = loadSlot('rocketUpper', earthViewerRef); return rocketUpperSlot; }
function getCraftSlot() { if (!craftSlot) craftSlot = loadSlot('craft', earthViewerRef); return craftSlot; }
function getLoiCraftSlot() {
  if (!loiCraftSlot) loiCraftSlot = loadSlot('loiCraft', moonViewerRef);
  else if (!loiCraftSlot.viewer && moonViewerRef) loiCraftSlot.viewer = moonViewerRef;  // 时序兜底：viewer 未就绪时补上
  return loiCraftSlot;
}
function getLanderSlot() {
  if (!landerSlot) landerSlot = loadSlot('lander', moonViewerRef);
  else if (!landerSlot.viewer && moonViewerRef) landerSlot.viewer = moonViewerRef;
  return landerSlot;
}
function getRoverSlot() {
  if (!roverSlot) roverSlot = loadSlot('rover', moonViewerRef);
  else if (!roverSlot.viewer && moonViewerRef) roverSlot.viewer = moonViewerRef;
  return roverSlot;
}
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
const _qt = new Cesium.Quaternion();   // 分离件姿态合成临时量（翻滚 ∘ 基准）
const _m3 = new Cesium.Matrix3();
const _rotM = new Cesium.Matrix4();
const _scaleM = new Cesium.Matrix4();
const _enuM = new Cesium.Matrix4();
const _dir = new Cesium.Cartesian3();
const _dir2 = new Cesium.Cartesian3();
const _dir3 = new Cesium.Cartesian3();
const _vec = new Cesium.Cartesian3();
const _lvlF = new Cesium.Cartesian3();   // LVLH 姿控临时：世界前向
const _lvlS = new Cesium.Cartesian3();   // LVLH 姿控临时：侧轴
const _lvlT = new Cesium.Cartesian3();   // ⭐ 2026-10-24：去径向分量专用临时。禁止复用 _vec——
                                         //   调用方常把共享暂存 _vec 当作 fwd 传入（如第二幕
                                         //   ce1DirENU(st, cart, _vec)），写脏它会让之后的读取
                                         //   （喷流 exh = clone(_vec)）拿到垃圾值 → 喷火方向错误。
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
// 飞船朝向（#89）临时量：世界速度 → ENU 表达
const _oE = new Cesium.Cartesian3();
const _oN = new Cesium.Cartesian3();
const _oU = new Cesium.Cartesian3();
const _oV = new Cesium.Cartesian3();
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

/** LVLH 轨道姿控（2026-10-22 修 #26/#89/#末/#轴：卫星沿椭圆翻滚、帆板朝月、喷口朝天/对月、喷口扎月、火焰变加速）：
 *   构造**完整三轴**姿控四元数，使模型（Cesium 已做 Y→Z 校正 → 模型 +Z=机头/天线、−Z=发动机喷口、
 *   帆板沿 ±X）呈「发动机朝前（逆行制动）姿态」——全程机体躺在轨道切平面内、无径向伸出、帆板平行月面：
 *     −Z = 水平速度前向 fwdH → **发动机喷口朝前**（排气沿前向喷出 → 推力向后 = 减速；用户 2026-10-22 末：
 *          喷口既不朝天也不对月、且须对着行进方向，火焰从喷口出才能减速而非加速）
 *     +Z = 水平速度反向 −fwdH（机头/天线朝后向，制动段天线不挡喷流）
 *     +X = Up×fwdH（水平侧轴）→ **帆板连线(±X)恒平行月面**（与 #26 帆板不朝月一致；
 *          相对「机头朝前」版绕帆板轴转 180°，帆板轴不变、仍水平、不戳月）
 *     +Y = −Up（模型厚度轴沿径向，机体不戳进月球）
 *   三轴全约束 → 姿态随轨道平滑、不翻滚；X×Y=Z 满足右手正交。
 *   fwd 为**世界系**速度向量（fwdIsENU=false）；若传 ENU 系切向向量则 fwdIsENU=true。
 *   level=true（默认）：去径向分量、机头取**水平横向投影**——月面制动/环月段定稿姿态
 *     （机体躺在切平面、帆板平行月面、不戳月，2026-10-22 用户逐项确认）。
 *   level=false（2026-10-24 用户「卫星没有沿着轨道改变方向」）：机头沿**全速度**（含径向
 *     爬升/俯冲分量）——像飞机沿轨道「飞」：爬升段抬头、下降段低头，帆板轴仍取轨道法向
 *     （Up×fwd，与 level 版完全相同，不额外翻滚）。第一幕重力转弯本就走完整切线，本模式
 *     让第二幕地心系段（调相/转移/接近）与第一幕读感一致。
 *   ⚠ 与 quatUpTo 的本质区别：quatUpTo 只约束 +Z=某方向、roll 完全自由 → 速度方向沿轨道一变
 *     最小旋转轴就变 → 模型翻滚、帆板扫过径向扎进月球。本函数三轴全约束 → 姿态随轨道平滑、不翻滚。
 *   调用后 _eastV/_northV/_upV 保留为该点 ENU 轴（供喷流 ENU 方向复用）。 */
function orientLvLH(cart, fwd, out, fwdIsENU, ellipsoid = MOON_ELLIPSOID, noseForward = false, level = true) {
  Cesium.Transforms.eastNorthUpToFixedFrame(cart, ellipsoid, _enuT);
  const E = Cesium.Matrix4.getColumn(_enuT, 0, _eastV);   // 世界 East
  const N = Cesium.Matrix4.getColumn(_enuT, 1, _northV);  // 世界 North
  const U = Cesium.Matrix4.getColumn(_enuT, 2, _upV);     // 世界 Up（径向）
  // fwd → 世界向量
  let fwdW = _lvlF;
  if (fwdIsENU) {
    Cesium.Cartesian3.multiplyByScalar(E, fwd.x, _lvlF);
    Cesium.Cartesian3.multiplyByScalar(N, fwd.y, _lvlS);
    Cesium.Cartesian3.add(_lvlF, _lvlS, _lvlF);
    Cesium.Cartesian3.multiplyByScalar(U, fwd.z, _lvlS);
    Cesium.Cartesian3.add(_lvlF, _lvlS, _lvlF);
  } else {
    Cesium.Cartesian3.clone(fwd, _lvlF);
  }
  // 前向取水平投影（去径向分量）→ 飞行前向
  const upc = Cesium.Cartesian3.dot(_lvlF, U);
  const fwdH = Cesium.Cartesian3.subtract(_lvlF, Cesium.Cartesian3.multiplyByScalar(U, upc, _lvlT), _lvlS);
  if (Cesium.Cartesian3.magnitudeSquared(fwdH) < 1e-12) Cesium.Cartesian3.clone(N, fwdH);
  else Cesium.Cartesian3.normalize(fwdH, fwdH);
  // 发动机朝前（逆行制动）姿态帧：相对「机头朝前」版绕帆板轴(模型 +X)转 180°，
  //   帆板轴(±X)不变、仍水平平行月面；机头(+Z)/喷口(−Z)互换 → 喷口朝前、火焰从喷口出。
  //   模型 +Z=机头/天线、−Z=发动机喷口。下列为**经 Y→Z 校正后**期望的最终世界朝向：
  //     −Z(喷口) = 水平速度前向 fwdH → 喷口朝前（排气沿前向 → 推力向后 = 减速，不加速）；
  //     +Z(机头) = −fwdH（后向）；
  //     +X = Up×fwdH（水平侧轴）→ 帆板连线恒平行月面（2026-10-22 用户确认：帆板水平）；
  //     +Y = −Up（厚度轴径向，但机体整体躺在切平面、不戳月）。
  //   右手正交校验：X×Y = (Up×fwdH)×(−Up) = −((Up×fwdH)×Up) = −fwdH = Z ✓
  // ⚠ Cesium 对 glTF 做 Y→Z 轴校正：模型局部轴→ENU 实测为 (+X→北, +Y→天顶, +Z→东)，
  //   即局部 (x,y,z)→(z,x,y)。orientLvLH 的 R 还要再被 modelMatrix=ENU*R 左乘，
  //   所以「落进 R 的列」须整体循环移位，才能抵消校正、落到预期姿态：
  //     预期（cheat-sheet 确认正确）：模型 +X(帆板)→side 水平、+Y(厚)→−Up 径向、+Z(机头)→−fwdH。
  //     page = ENU * R * R_corr，R_corr(e_X)=e_Y、R_corr(e_Y)=e_Z、R_corr(e_Z)=e_X；
  //     令 R 列 = [col0=−fwdH, col1=side, col2=−Up]（即旧列的 c2,c0,c1 循环移位）即可命中预期。
  const fx0 = Cesium.Cartesian3.dot(fwdH, E), fy0 = Cesium.Cartesian3.dot(fwdH, N);
  // col0 = sgn·fwdH：逆行制动(默认 noseForward=false)=−fwdH（机头后向、喷口朝前减速）；
  //   顺行入轨/转移(noseForward=true)=+fwdH（机头朝前、喷口在后 → 第一/二/三幕飞船）。
  const sgn = noseForward ? 1 : -1;
  let xx, xy, xz, yx, yy, yz, zx, zy, zz;
  if (level) {
    // —— level=true（月面段定稿）：col0=sgn·fwdH（水平）、col1=side=Up×fwdH、col2=sgn·Up ——
    xx = sgn * fx0; xy = sgn * fy0; xz = 0;
    yx = -fy0; yy = fx0;  yz = 0;   // col1 = side = Up×fwdH（帆板连线水平，平行月面）
    zx = 0;   zy = 0;   zz = sgn;  // col2 = sgn·Up（⚠ 必须与 col0 同号：绕帆板轴转 180° 要同时翻 col0/col2，只翻一个会 det=−1 变镜像）
  } else {
    // —— level=false（第二幕地心系段：沿全速度「飞」）——
    //   col0 = sgn·fwd（机头沿全速度，含径向爬升/俯冲 → 沿椭圆改变方向）；
    //   col1 = Up×fwd（帆板轴仍沿轨道法向，与 level 版一致）；
    //   col2 = col0×col1（厚度轴 = 径向去掉沿轨分量；平飞时朝天、大爬升时后仰）。
    Cesium.Cartesian3.normalize(fwdW, fwdW);
    const fx = Cesium.Cartesian3.dot(fwdW, E), fy = Cesium.Cartesian3.dot(fwdW, N), fz = Cesium.Cartesian3.dot(fwdW, U);
    const hl = Math.hypot(fx, fy);
    if (hl < 1e-9) {
      // 速度近径向（直线起竖/径向点火的退化情形）：帆板轴取北向，厚度轴 = col0×col1
      xx = 0; xy = 0; xz = sgn * fz;
      yx = 0; yy = 1; yz = 0;
      zx = -sgn * fz; zy = 0; zz = 0;
    } else {
      xx = sgn * fx; xy = sgn * fy; xz = sgn * fz;
      yx = -fy / hl; yy = fx / hl; yz = 0;
      zx = sgn * (-fz * fx / hl); zy = sgn * (-fz * fy / hl); zz = sgn * ((fx * fx + fy * fy) / hl);
    }
  }
  Cesium.Matrix3.fromArray([xx, xy, xz,  yx, yy, yz,  zx, zy, zz], 0, _m3t);
  return Cesium.Quaternion.fromRotationMatrix(_m3t, out);
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

// 制动/点火粒子喷流特效（2026-10-22 用户要求「切点减速做个喷火动效/粒子特效」）：
// 自包含——canvas 径向渐变贴图 + Cesium.ParticleSystem，按 viewer 缓存；初始化失败静默回退模型火焰。
const _burnPsMap = new Map();
const _burnEnuM = new Cesium.Matrix4();
const _burnE = new Cesium.Cartesian3(), _burnN = new Cesium.Cartesian3(), _burnU = new Cesium.Cartesian3(), _burnW = new Cesium.Cartesian3();
let _burnTex = null;
function getBurnTexture() {
  if (_burnTex) return _burnTex;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,232,165,0.95)');
  grd.addColorStop(0.6, 'rgba(255,140,55,0.5)');
  grd.addColorStop(1, 'rgba(255,90,20,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  _burnTex = c.toDataURL();
  return _burnTex;
}
function updateBurnFx(viewer, cart, exhaustDirENU, scale, ellipsoid) {
  if (!viewer || !viewer.scene) return;
  let ps = _burnPsMap.get(viewer);
  if (ps && ps.isDestroyed && ps.isDestroyed()) { _burnPsMap.delete(viewer); ps = null; }
  if (!cart || !exhaustDirENU || !(scale > 0)) {
    if (ps) { ps.show = false; ps.emissionRate = 0; }
    return;
  }
  try {
    if (!ps) {
      ps = viewer.scene.primitives.add(new Cesium.ParticleSystem({
        image: getBurnTexture(),
        emissionRate: 0,
        startScale: 0.8,
        endScale: 2.6,
        minimumParticleLife: 0.3,
        maximumParticleLife: 0.75,
        minimumSpeed: 1600,
        maximumSpeed: 5200,
        startColor: Cesium.Color.fromCssColorString('#fff0b0').withAlpha(0.95),
        endColor: Cesium.Color.fromCssColorString('#ff6a1a').withAlpha(0.0),
        imageSize: new Cesium.Cartesian2(3500, 3500),
        lifetime: Number.MAX_VALUE,
        emitter: new Cesium.CircleEmitter(0.5),
        sizeInMeters: true,
        modelMatrix: Cesium.Matrix4.IDENTITY,
        emitterModelMatrix: Cesium.Matrix4.IDENTITY,
      }));
      _burnPsMap.set(viewer, ps);
    }
    ps.show = true;
    ps.emissionRate = Math.round(70 * scale);
    // 喷流方向：调用方传 **ENU 分量**（与喷流/姿态同源），先按 cart+椭球转成世界方向再定位 emitter。
    //   CircleEmitter 沿局部 +Z 喷出；逆行/制动：排气朝「前」(+速度) → 推力朝后 = 减速。
    Cesium.Transforms.eastNorthUpToFixedFrame(cart, ellipsoid || Cesium.Ellipsoid.MOON, _burnEnuM);
    const bE = Cesium.Matrix4.getColumn(_burnEnuM, 0, _burnE);
    const bN = Cesium.Matrix4.getColumn(_burnEnuM, 1, _burnN);
    const bU = Cesium.Matrix4.getColumn(_burnEnuM, 2, _burnU);
    const emit = new Cesium.Cartesian3();
    Cesium.Cartesian3.multiplyByScalar(bE, exhaustDirENU.x, emit);
    Cesium.Cartesian3.multiplyByScalar(bN, exhaustDirENU.y, _burnW); Cesium.Cartesian3.add(emit, _burnW, emit);
    Cesium.Cartesian3.multiplyByScalar(bU, exhaustDirENU.z, _burnW); Cesium.Cartesian3.add(emit, _burnW, emit);
    if (Cesium.Cartesian3.magnitudeSquared(emit) < 1e-12) Cesium.Cartesian3.clone(bN, emit);
    Cesium.Cartesian3.normalize(emit, emit);
    const x = new Cesium.Cartesian3();
    Cesium.Cartesian3.cross(emit, Cesium.Cartesian3.UNIT_Z, x);
    if (Cesium.Cartesian3.magnitudeSquared(x) < 1e-12) Cesium.Cartesian3.clone(Cesium.Cartesian3.UNIT_X, x);
    Cesium.Cartesian3.normalize(x, x);
    const y = new Cesium.Cartesian3();
    Cesium.Cartesian3.cross(emit, x, y);
    Cesium.Cartesian3.normalize(y, y);
    const rot = new Cesium.Matrix3(x.x, x.y, x.z, y.x, y.y, y.z, emit.x, emit.y, emit.z);
    ps.emitterModelMatrix = Cesium.Matrix4.fromRotationTranslation(rot, cart, new Cesium.Matrix4());
  } catch (e) {
    console.warn('[burn] 粒子喷流特效初始化失败，已回退模型火焰', e);
    _burnPsMap.delete(viewer);
  }
}

// 着陆月尘粒子（2026-10-22 末用户：着陆时扬起月尘的粒子效果）：复用燃烧贴图(径向 alpha)，
//   灰色调、低速向上(+U)喷起后散开；仅在着陆瞬间强触发，随后收住。
function updateDust(viewer, cart, intensity) {
  if (!viewer || !viewer.scene) return;
  let ps = _dustPsMap.get(viewer);
  if (ps && ps.isDestroyed && ps.isDestroyed()) { _dustPsMap.delete(viewer); ps = null; }
  try {
    if (!ps) {
      ps = viewer.scene.primitives.add(new Cesium.ParticleSystem({
        image: getBurnTexture(),
        emissionRate: 0,
        startScale: 0.6, endScale: 2.2,
        minimumParticleLife: 0.5, maximumParticleLife: 1.1,
        minimumSpeed: 4, maximumSpeed: 14,
        startColor: Cesium.Color.fromCssColorString('#cfc9bd').withAlpha(0.85),
        endColor: Cesium.Color.fromCssColorString('#8e897e').withAlpha(0.0),
        imageSize: new Cesium.Cartesian2(7, 7),
        lifetime: Number.MAX_VALUE,
        emitter: new Cesium.CircleEmitter(0.7),
        sizeInMeters: true,
        modelMatrix: Cesium.Matrix4.IDENTITY,
        emitterModelMatrix: Cesium.Matrix4.IDENTITY,
      }));
      _dustPsMap.set(viewer, ps);
    }
    if (!cart || !(intensity > 0)) { if (ps) { ps.show = false; ps.emissionRate = 0; } return; }
    ps.show = true;
    ps.emissionRate = Math.round(55 * intensity);
    // 月尘沿着陆点本地 +U(天顶) 喷起散开（用局部向量，避免与共享 _dir* 别名）
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(cart);
    const emit = Cesium.Cartesian3.normalize(Cesium.Matrix4.getColumn(enu, 2, new Cesium.Cartesian3()), new Cesium.Cartesian3());
    const x = new Cesium.Cartesian3();
    Cesium.Cartesian3.cross(emit, Cesium.Cartesian3.UNIT_Z, x);
    if (Cesium.Cartesian3.magnitude(x) < 1e-6) Cesium.Cartesian3.clone(Cesium.Cartesian3.UNIT_X, x);
    Cesium.Cartesian3.normalize(x, x);
    const y = new Cesium.Cartesian3();
    Cesium.Cartesian3.cross(emit, x, y);
    Cesium.Cartesian3.normalize(y, y);
    const rot = new Cesium.Matrix3(x.x, x.y, x.z, y.x, y.y, y.z, emit.x, emit.y, emit.z);
    ps.emitterModelMatrix = Cesium.Matrix4.fromRotationTranslation(rot, cart, new Cesium.Matrix4());
  } catch (e) {
    console.warn('[dust] 着陆月尘粒子初始化失败，已回退椭圆激尘', e);
    _dustPsMap.delete(viewer);
  }
}

// 着陆器两翼展开（2026-10-22 末用户：着陆后打开两翼太阳能板）：pd=0 折叠(竖立 +U)、
//   pd=1 展开(平铺 +E/−E)，绕北向铰链 N 旋转；box 本地 X=翼长、Y=厚度、Z=宽。
//   ⚠ 用局部 Cartesian3，避免与模块共享 _dir* 别名（placeWing 内 N 与 _dir2 曾别名致右翼污染）。
function deployPanels(landerPos, pd) {
  if (!landerPanelL || !landerPanelR || !landerPos) return;
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(landerPos);
  const E = Cesium.Matrix4.getColumn(enu, 0, new Cesium.Cartesian3());
  const N = Cesium.Matrix4.getColumn(enu, 1, new Cesium.Cartesian3());
  const U = Cesium.Matrix4.getColumn(enu, 2, new Cesium.Cartesian3());
  const topH = 2.2, halfLen = 1.9, width = 2.0, thick = 0.06;
  const ang = (1 - pd) * Math.PI / 2;            // 0=展平，π/2=竖立
  const sa = Math.sin(ang), ca = Math.cos(ang);
  const wR = new Cesium.Cartesian3(
    E.x * sa + U.x * ca, E.y * sa + U.y * ca, E.z * sa + U.z * ca);
  const hinge = new Cesium.Cartesian3(
    landerPos.x + U.x * topH, landerPos.y + U.y * topH, landerPos.z + U.z * topH);
  placeWing(landerPanelR, hinge, wR, N, halfLen, width, thick);
  placeWing(landerPanelL, hinge, Cesium.Cartesian3.negate(wR, new Cesium.Cartesian3()), N, halfLen, width, thick);
}
function placeWing(ent, hinge, wingDir, N, halfLen, width, thick) {
  const c = new Cesium.Cartesian3();
  Cesium.Cartesian3.multiplyByScalar(wingDir, halfLen, c);
  Cesium.Cartesian3.add(hinge, c, c);
  ent.position = c;
  const Yc = new Cesium.Cartesian3();
  Cesium.Cartesian3.cross(N, wingDir, Yc);
  Cesium.Cartesian3.normalize(Yc, Yc);
  // 旋转基 [wingDir(长), Yc=×N(厚), N(宽)]，右手正交
  ent.orientation = Cesium.Quaternion.fromRotationMatrix(
    Cesium.Matrix3.fromArray([
      wingDir.x, wingDir.y, wingDir.z,
      Yc.x, Yc.y, Yc.z,
      N.x, N.y, N.z], 0, _m3t), new Cesium.Quaternion());
  ent.box.dimensions = new Cesium.Cartesian3(halfLen * 2, thick, width);
  ent.show = true;
}

// 第一幕「整流罩分离后展开太阳能板」（2026-10-22 用户；2026-10-23 重设为两段式铰链折叠）
//   驱动 probe.glb 的 panelLIn/LOut/RIn/ROut 四节点：外段绕段间铰链从 ~100° 收拢转到 0° 拉直。
//   prog: 0=收拢,1=展开。
//   ⚠ 兜底：getNode/matrix 任一失败即保持节点默认(=展开态)，绝不弄坏第二~四幕。
//   ⚠⚠ 2026-10-23 致命坑（本轮用户「星舰分离时帆板已是展开态」逼出）：ModelNode 原型
//     只有 name/id/show/matrix/originalMatrix——**没有 transform**！node.transform= 是
//     静默 expando（赋值不抛异常、try/catch 永远抓不到）→ 两段式铰链动画从未生效，
//     帆板一直卡在 glb 默认展开态。必须用 node.matrix（setter 代理 _runtimeNode.transform）。
/** 帆板展开（2026-10-23 两段式折叠，替代旧版整体缩放变形——用户反馈「展开没有动画」）
 *  prog=0 折叠：外段绕段间铰链竖起 ~100°（跨度 6.8 m，剪影明显收窄）
 *  prog=1 展开：内外段拉直（跨度 12.0 m）
 *  ⚠ 2026-10-23 起 probe.glb 为**两段式折叠翼**（panelLIn/LOut/RIn/ROut 四节点，
 *    几何以各自内端为原点烘焙、部署态 translation 到铰链）：内段固定 T(±0.8)，
 *    外段 T(±3.4)·Rz(±a)（a=100°→0°）——真机械铰链动画（用户：「帆板展开没有动画」）。
 *    旧版整体缩放变形（panelL/panelR 单节点）保留为兜底：四节点缺失时自动回退。 */
const CRAFT_PANEL_HINGE = 0.8;                    // 翼根铰链 x（机身半宽 0.7 外）
const CRAFT_PANEL_SEG = 2.6;                      // 单段翼长
const CRAFT_PANEL_FOLD = Cesium.Math.toRadians(100);  // 外段收拢角（竖起略过 90°，更紧凑）
function deployCraftPanels(slot, prog) {
  if (!slot || !slot.model || slot.model.isDestroyed()) return;
  const m = slot.model;
  const s = clamp01(prog);
  const e = 1 - Math.pow(1 - s, 3);   // easeOutCubic：展开先快后慢
  const a = (1 - e) * CRAFT_PANEL_FOLD;
  let inNode = null;
  try { inNode = (typeof m.getNode === 'function') ? m.getNode('panelRIn') : null; } catch { inNode = null; }
  if (inNode) {
    // —— 两段式铰链（2026-10-23 主路径）——
    // ⚠ Cesium 的 node.transform 按**引用**存储（不拷贝）：每次赋值必须用全新 Matrix4，
    //   复用暂存矩阵会被后一次赋值改掉（实测 panelRIn 的平移被 panelROut 的 T(3.4) 覆写）。
    for (const [inN, outN, sgn] of [['panelLIn', 'panelLOut', -1], ['panelRIn', 'panelROut', 1]]) {
      try {
        const nIn = m.getNode(inN);
        // ⚠ ModelNode 只有 matrix（getter/setter 代理 _runtimeNode.transform），没有 transform
        //   属性——node.transform= 是静默 expando（2026-10-23 实测帆板卡在 glb 默认展开态）。
        if (nIn) nIn.matrix = Cesium.Matrix4.fromTranslation(
          new Cesium.Cartesian3(sgn * CRAFT_PANEL_HINGE, 0, 0), new Cesium.Matrix4());
      } catch { /* 节点不可写：保持默认 */ }
      try {
        const nOut = m.getNode(outN);
        if (nOut) {
          // T(±3.4)·Rz(±a)：先绕自身原点（=段间铰链）转，再平移到铰链 → 绕铰链旋转
          const t = Cesium.Matrix4.fromTranslation(
            new Cesium.Cartesian3(sgn * (CRAFT_PANEL_HINGE + CRAFT_PANEL_SEG), 0, 0), new Cesium.Matrix4());
          const r = Cesium.Matrix4.fromRotationTranslation(
            Cesium.Matrix3.fromRotationZ(a * sgn, new Cesium.Matrix3()), Cesium.Cartesian3.ZERO, new Cesium.Matrix4());
          nOut.matrix = Cesium.Matrix4.multiply(t, r, new Cesium.Matrix4());
        }
      } catch { /* 节点不可写：保持默认展开态 */ }
    }
    return;
  }
  // —— 旧 GLB 兜底（panelL/panelR 单节点）：整体缩放变形 ——
  const cx = lerp(0.55, 3.4, e);
  const sx = lerp(0.08, 1, e), sy = lerp(17, 1, e);
  for (const [name, sgn] of [['panelL', -1], ['panelR', 1]]) {
    let node = null;
    try { node = (typeof m.getNode === 'function') ? m.getNode(name) : null; } catch { node = null; }
    if (!node) continue;
    try {
      const sc = Cesium.Matrix4.fromScale(new Cesium.Cartesian3(sx, sy, 1), new Cesium.Matrix4());
      const t = Cesium.Matrix4.fromTranslation(new Cesium.Cartesian3(sgn * cx, 0, 0), new Cesium.Matrix4());
      node.matrix = Cesium.Matrix4.multiply(t, sc, new Cesium.Matrix4());
    } catch { /* 保持默认展开态 */ }
  }
}

/** 运行时显示/隐藏模型里的单个节点（用于「抛整流罩」「下坠件去罩」这类形态切换）。
 *  ⚠⚠ 2026-10-23 源码级实锤（archive/quarantine-tools/scripts-onepass/node-hide-diag.mjs 同帧 A/B）：vendored Cesium 的
 *    ModelNode 原型只有 name/id/show/matrix/originalMatrix——**没有 transform**！
 *    旧实现 `node.transform = fromScale(...)` 是静默 expando（赋值不抛异常、try/catch 永远
 *    抓不到）→ 「抛整流罩露出卫星」「下坠件去整流罩」从未生效，用户实测「分离的助推器
 *    带着整流罩，不可能」。改用 node.show（setter → runtimeNode.show）：
 *    实测剪影顶边下沉 21px、像素数 -22%，与 node.matrix=fromScale(0) 等效（备选）。
 *  ⚠ 节点须在 glTF 里有名字（getNode 按名查找，中文名可用；make_mission_models.py 已命名）。 */
function setNodeShow(slot, name, visible) {
  if (!slot || !slot.model || slot.model.isDestroyed()) return;
  let node = null;
  try { node = (typeof slot.model.getNode === 'function') ? slot.model.getNode(name) : null; } catch { node = null; }
  if (!node) return;
  try { node.show = !!visible; } catch { /* 节点不可写：保持默认形态 */ }
}

// 运行时调整槽位最小像素尺寸（2026-10-23 用户反馈「第二幕卫星显得太大」）：
//   表观像素 ≈ 0.231 × minPx。第一幕（近地、机位近）沿用标定值 150（~35px）；
//   第二/三幕（地月系全局取景，跨度 76 万 km）缩到 75（~17px），卫星回归「星点」体量。
//   act1/act2/act3 共用同一 craft 实例，故每幕显式设定，进度条来回拖拽也立刻恢复。
const CRAFT_PX_TRANSFER = 75;
function setSlotPixelSize(slot, px) {
  if (!slot || !slot.model || slot.model.isDestroyed()) return;
  try { slot.model.minimumPixelSize = px; } catch { /* 旧版 Cesium 无此属性则忽略 */ }
}

// 第五幕「着陆器太阳能板打开」**建模动画**（2026-10-22 用户：此前 GLB 根本没有翼，看不到展开）：
//   驱动 moon_lander.glb 的 panelL/panelR 节点绕各自铰链（机身侧面 ±0.92, y=2.6）旋转——
//   折叠 = 竖立贴机身(+Y)、展开 = 平铺(±X)。
//   翼几何**内端对齐原点**（tools/build/make_mission_models.py 的 wing()）→
//   node.matrix = T(铰链)·Rz(a·sx)：右翼 sx=+1 抬 +X 端、左翼 sx=−1 抬 −X 端，两翼都向上收拢。
//   pd: 0=折叠, 1=展开。⚠ 兜底：getNode/transform 任一失败返回 false，交回 box 版 deployPanels。
const LANDER_HINGE = { x: 0.92, y: 2.6, z: 0 };
// 2026-10-23 用户「着陆器要比玉兔更大才合理」：整体放大 1.4×（腿距 1.66→2.33 m、
//   翼展 4.05→5.67 m，对玉兔（1.2 m 车体）形成清晰的体量对比；铰链/节点随模型矩阵同步缩放）。
const LANDER_SCALE = 2.0;   // 2026-10-23 用户「着陆器比玉兔小」：1.4 → 2.0（腿距 1.65×2.0≈3.3m < 玉兔起步 4.0m，不穿腿环）
// 2026-10-24 用户「月兔号还是相对着陆器太大了，需要再缩小 1/3」→ 玉兔车体 ×2/3。
// ⚠ minimumPixelSize 钳制生效时表观尺寸 ∝ minPx、与几何长度无关（见项目备忘）：
//   只改几何缩放而不同步降 minPx，远机位下月兔**不会变小**。故 rover 的 minPx 同步 80→53（×2/3）。
const ROVER_SCALE = 2 / 3;
// 第四幕（着陆巡视）标准机位——第三幕末 CAP 收尾即收敛到此，保证 3-6→4-1 零跳变（2026-10-24）
const ACT4_CAM = { heading: 1.9, pitchDeg: -24, range: 320 };
function deployLanderPanels(slot, pd) {
  if (!slot || !slot.model || slot.model.isDestroyed()) return false;
  const m = slot.model;
  // easeInOutQuad（2026-10-23 用户「第四幕也没有动画」）：线性旋转在短窗口里像「瞬移」，
  //   慢启慢停才有机械展开的读感；窗口同步放到 0.30（~4.3 s）。
  const p = clamp01(pd);
  const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
  const a = (1 - e) * Math.PI / 2;   // 折叠角：0=展开，π/2=竖立
  let ok = false;
  for (const [name, sx] of [['panelR', 1], ['panelL', -1]]) {
    let node = null;
    try { node = (typeof m.getNode === 'function') ? m.getNode(name) : null; } catch { node = null; }
    if (!node) continue;
    try {
      const h = new Cesium.Cartesian3(LANDER_HINGE.x * sx, LANDER_HINGE.y, LANDER_HINGE.z);
      // ⚠ 同 deployCraftPanels：ModelNode 无 transform 属性，必须写 matrix（静默 expando 坑）
      node.matrix = Cesium.Matrix4.fromRotationTranslation(
        Cesium.Matrix3.fromRotationZ(a * sx, new Cesium.Matrix3()), h, new Cesium.Matrix4());
      ok = true;
    } catch { /* 保持默认展开态 */ }
  }
  return ok;
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
let focusTarget = null;       // 焦点跟踪目标（模块层：updateCamBadge 需读；赋值均在 createMoonMission 内）
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
  } else {
    // ⭐ 遮挡补偿：主体从「整屏中心」上移到「未被时间轴遮挡区域的中心」
    try { v.camera.lookAtTransform(Cesium.Matrix4.IDENTITY); } catch { /* 忽略 */ }
    panDownScreen(v, occlusionPanM(v, range));
  }
  enforceMinCamAlt(v, minCamAltM(v));
}

/** 世界位姿版 applyCamera（第二幕顶视用）：直接给相机位置/视线/上方向。
 *  先清 lookAt 参考系——残留参考系会让用户拖拽绕旧目标转、且 MANUAL 判定失准。
 *  rangeM（可选）= 相机到主体的距离（米），给遮挡补偿用。 */
function applyCameraPose(v, camPos, dir, up, rangeM) {
  if (!v) return;
  if (camOverride) return;
  try { v.camera.lookAtTransform(Cesium.Matrix4.IDENTITY); } catch { /* 忽略 */ }
  v.camera.setView({ destination: camPos, orientation: { direction: dir, up } });
  if (!(blendT > 0 && blendFrom)) panDownScreen(v, occlusionPanM(v, rangeM || 0));
  blendCameraTo(v, camPos, dir, up);
  enforceMinCamAlt(v, minCamAltM(v));
}

/** MANUAL 模式：关注点跟随 + 用户视角保持（2026-10-18 双模式核心）。
 *  相机处于 lookAt 参考系时读 camera.heading/pitch/range（= 用户拖拽/缩放的结果），
 *  再 lookAt 到移动后的目标——参考系原点跟着飞行器走，用户视角原样保留；
 *  无参考系/读数异常时静默跳过 = 完全自由视角（第二幕即走这条路）。
 *  右上角 cesium-navigation 控件（指南针/缩放）的「绕谁转」由 vendored 的
 *  Utils.getCameraFocus / ZoomNavigationControl.zoom 补丁决定——二者在相机处于
 *  lookAt 参考系(transform≠单位阵)时改取参考系原点(巡游物)，故控件也绕巡游物而非球体。 */
const _enuFrame = new Cesium.Matrix4();
const _enuInv = new Cesium.Matrix4();
const _offsetW = new Cesium.Cartesian3();
const _offsetL = new Cesium.Cartesian3();

/**
 * 自由相机（transform=单位阵）下从世界位姿反算 HPR。
 * ⭐⭐ 2026-10-24 修「焦点跟踪按钮点击后，鼠标一调整就失焦」的**真因**：
 *   脚本机位一律 `lookAt(...)` 后紧跟 `lookAtTransform(IDENTITY)` + 遮挡平移（见 applyCamera），
 *   相机处于**无参考系**状态 → `camera.heading/pitch/range` 全返回 **NaN**（headless 实测）。
 *   用户一拖拽/滚轮 → camOverride=true → applyManualFollow 的 `isFinite(r)` 守卫直接 bail
 *   → 关注点再也不锚目标 → 主体飘走（表现为「失焦」）。
 *   修法：NaN 时用「相机世界位置 − 目标」在目标 ENU 系下反解 h/p/r，语义与 lookAt 完全一致
 *   （h=atan2(东,北)、p=asin(天/r)），首帧即把参考系锚回目标 → 后续用户拖拽照常改 hpr，
 *   目标移动时相机保持相对机位跟随（round-trip 实测位置不变）。
 */
function cameraHPRFromWorld(v, target) {
  const cam = v.camera;
  Cesium.Cartesian3.subtract(cam.positionWC, target, _offsetW);
  const r = Cesium.Cartesian3.magnitude(_offsetW);
  if (!(r > 0) || !isFinite(r)) return null;
  const ell = (v.scene.globe && v.scene.globe.ellipsoid) ? v.scene.globe.ellipsoid : Cesium.Ellipsoid.WGS84;
  Cesium.Matrix4.inverseTransformation(
    Cesium.Transforms.eastNorthUpToFixedFrame(target, ell, _enuFrame), _enuInv);
  Cesium.Matrix4.multiplyByPoint(_enuInv, _offsetW, _offsetL);
  const h = Math.atan2(_offsetL.x, _offsetL.y);
  const pitch = Math.asin(Cesium.Math.clamp(_offsetL.z / r, -1, 1));
  return new Cesium.HeadingPitchRange(h, pitch, r);
}

function applyManualFollow(v, target) {
  if (!v || !camOverride || !target) return;
  try {
    let h = v.camera.heading;
    let pi = v.camera.pitch;
    let r = v.camera.range;
    if (!isFinite(h) || !isFinite(pi) || !isFinite(r) || !(r > 0)) {
      // 自由相机（脚本机位/用户接管后）：读数全 NaN → 从世界位姿反算，保持焦点跟踪不中断
      const hpr = cameraHPRFromWorld(v, target);
      if (!hpr) return;
      h = hpr.heading; pi = hpr.pitch; r = hpr.range;
    }
    // 防手动镜头钻入球体内部（用户反馈）：target 在球面时，pitch 越过地平线到目标下方
    // （pitch>0，仰视）即穿球；range 过小则近裁剪面切入地表。两处各加一道下限。
    const ell = (v.scene.globe && v.scene.globe.ellipsoid) ? v.scene.globe.ellipsoid : Cesium.Ellipsoid.WGS84;
    const minR = ell.maximumRadius * 0.0008;            // 到 target 的最小距离（地球 ~5.1km / 月球 ~1.4km）
    if (r < minR) r = minR;
    const maxPitch = Cesium.Math.toRadians(-3);          // 不允许仰视越过地平线（防穿球；俯视/侧视全保留）
    if (pi > maxPitch) pi = maxPitch;
    v.camera.lookAt(target, new Cesium.HeadingPitchRange(h, pi, r));
    // ⭐ 手动视角同样防钻进星球内部（2026-10-23 末）
    enforceMinCamAlt(v, minCamAltM(v));
  } catch { /* 无参考系：自由视角 */ }
}

/** 轨道面顶视图机位（2026-10-22 用户定稿）：相机放在**轨道面（site.lon 子午面）法向**上、
 *  以月心为中心正对轨道面俯瞰——任务设计图视角：整颗月球居中，黄色制动椭圆 + 蓝色 100km
 *  目标环全部入画（轨道最小半径 1837 km > 月球半径 1737 km，顶视下无任何遮挡）。
 *  制动段与巡航段调用**同一机位**（相机相对月心固定、不随卫星运动）→ 全程不切镜头，
 *  过极点也不会翻转；MANUAL 模式仍归用户。 */
function applyMoonPlaneTopCam(mv, lon) {
  if (!mv || camOverride) return;
  const Rcam = 9.0e6;   // 距月心 9000 km：月球角半径 asin(1737/9000)≈11.1°（半视场 30° 内约占 37% 半高，
                        //   整球居中且留白充足）；远月点 2537 km 半张角 atan(2537/9000)≈15.7° 仍入画
  const lam = Cesium.Math.toRadians(lon);
  // 子午面法向 = 该经度的东向单位向量（ẑ × 指向该经度的赤道向量）
  const n = new Cesium.Cartesian3(-Math.sin(lam), Math.cos(lam), 0);
  const camPos = Cesium.Cartesian3.multiplyByScalar(n, Rcam, new Cesium.Cartesian3());
  const dir = Cesium.Cartesian3.negate(n, new Cesium.Cartesian3());
  const up = new Cesium.Cartesian3(0, 0, 1);   // n⊥ẑ → 屏幕上方=北极，轨道面完全正对相机
  applyCameraPose(mv, camPos, dir, up, Rcam);
}

/** 视角模式徽标（AUTO=自动视角 / 焦点跟踪或 MANUAL 时=🎯 推荐视角按钮可点） */
function updateCamBadge() {
  const b = document.getElementById('tourCamMode');
  if (!b) return;
  // ⚠ 2026-10-24 修「点了跟踪按钮后没法切换回推荐视角」：焦点跟踪中（focusTarget 有效、
  //   camOverride=false）旧版徽标只显示「👁 自动视角」且点击无响应 → 用户无处回推荐机位。
  //   现把「焦点跟踪中」与「MANUAL 接管」统一视为可回退态：徽标变「🎯 推荐视角」，点击即取消
  //   跟踪并从当前世界位姿平滑混合回本幕脚本机位。
  if (camOverride || focusTarget) {
    b.textContent = '🎯 推荐视角';
    b.title = focusTarget && !camOverride
      ? '正在跟踪焦点物体；点击取消跟踪，回到本幕推荐机位'
      : '当前为手动视角（跨幕恢复默认）；点击回到本幕推荐机位';
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

  // ⚠⚠ 渲染崩溃兜底（2026-10-23 RangeError: invalid array length @ createPotentiallyVisibleSet / LBt）：
  //   **真因**：某渲染图元（地形瓦片 / 任务实体）包围球含 NaN → Cesium 在算「到相机平面距离区间极值」
  //   n/i 时变 NaN → LBt 里 f = ceil(log(i/n)/log(s)) = NaN → frustumCommandsList.length = NaN → 崩。
  //   表现为「点击探月任务 / 按点火」即崩、地球火箭都不加载。
  //   **根因修复在 vendored Cesium 的 LBt**（public/vendor/cesium/index.js，并已同步进 tools/build/vendor-cesium.mjs
  //   随 npm run vendor 重建存活）：把 n/i 的 NaN 兜底成相机 frustum 的 near/far（= 标准全深度分割，正是正确行为），
  //   顺手把 s（farToNearRatio/logarithmicDepthFarToNearRatio，该版本默认 undefined）也兜底成有限值。
  //   下面这道 frameState 兜底是与 Cesium 内部无关的二层保险（任何读 frameState ratio 的路径都不致 NaN），常驻。
  function installFrameStateGuard() {
    const stamp = (v) => {
      const fs = v && v.scene && v.scene.frameState;
      if (!fs) return;
      if (typeof fs.farToNearRatio !== 'number' || !isFinite(fs.farToNearRatio)) fs.farToNearRatio = 1000;
      if (typeof fs.logarithmicDepthFarToNearRatio !== 'number' || !isFinite(fs.logarithmicDepthFarToNearRatio)) fs.logarithmicDepthFarToNearRatio = 1e9;
    };
    stamp(earthViewer);
    earthViewer.scene.preRender.addEventListener(() => stamp(earthViewer));
    try { const mv = env.getMoonViewer(); if (mv && mv.scene) { stamp(mv); mv.scene.preRender.addEventListener(() => stamp(mv)); } } catch { /* 月球 viewer 可能尚未创建 */ }
    console.log('[SPHERE-FIX] frameState ratio 兜底已装（earth + moon）');
  }
  installFrameStateGuard();

  // 可选 NaN 扫描器（仅在控制台执行 window.__SPHERE_NAN_DEBUG = true 后启用）：逐帧查相机/实体/图元/地形包围球，
  // 抓到 NaN 即 console.error 出具体元凶，+ window.__SPHERE_NAN_BREAK = true 可让 DevTools 自动暂停。
  // 与上方崩溃兜底互不依赖——崩溃兜底解决的是 ratio，扫描器解决的是"未来若还有某个图元位置 NaN"。
  function installNanScan() {
    const J = () => Cesium.JulianDate.now();
    const bad = (c) => !c || !isFinite(c.x) || !isFinite(c.y) || !isFinite(c.z);
    function scan(v, tag) {
      if (!window.__SPHERE_NAN_DEBUG) return;
      const cam = v.camera;
      if (bad(cam.positionWC)) { console.error('[SPHERE-NAN] camera.positionWC', tag, cam.positionWC); if (window.__SPHERE_NAN_BREAK) debugger; return; }
      for (const e of v.entities.values) {
        if (e.show === false) continue;
        try {
          if (e.position && e.position.getValue) { const pos = e.position.getValue(J()); if (bad(pos)) { console.error('[SPHERE-NAN] entity.position', tag, e.id, pos); if (window.__SPHERE_NAN_BREAK) debugger; return; } }
          if (e.polyline && e.polyline.positions && e.polyline.positions.getValue) { const ps = e.polyline.positions.getValue(J()); if (ps) for (let i = 0; i < ps.length; i++) if (bad(ps[i])) { console.error('[SPHERE-NAN] entity.polyline', tag, e.id, 'idx', i, ps[i]); if (window.__SPHERE_NAN_BREAK) debugger; return; } }
        } catch { /* 单实体探测异常不阻断扫描 */ }
      }
      const prims = v.scene && v.scene.primitives;
      if (prims) for (let i = 0; i < prims.length; i++) { const pr = prims.get(i); const bv = pr && (pr.boundingVolume || (pr._boundingVolume)); if (bv && bv.center && bad(bv.center)) { console.error('[SPHERE-NAN] primitive.boundingVolume', tag, pr.constructor && pr.constructor.name, bv); if (window.__SPHERE_NAN_BREAK) debugger; return; } }
    }
    earthViewer.scene.preRender.addEventListener(() => scan(earthViewer, 'earth'));
    try { const mv = env.getMoonViewer(); if (mv) mv.scene.preRender.addEventListener(() => scan(mv, 'moon')); } catch { /* 月球 viewer 可能尚未创建 */ }
    window.__sphereNanScanNow = () => scan(earthViewer, 'earth');
    console.log('[SPHERE-NAN] 扫描钩子已装；控制台执行 window.__SPHERE_NAN_DEBUG = true 开启（+ window.__SPHERE_NAN_BREAK = true 自动暂停）');
  }
  installNanScan();

  let raf = 0, last = 0;
  let p = 0, playing = false, mult = 1;
  let launchSiteKey = 'wenchang';
  let landingSiteKey = 'imbrium';
  let inMoon = false;
  // 2026-10-24：原「动力下降→玉兔巡视跨幕相机混合」已取消（末端机位本就一致，blend 反而让主体出画），
  //   本标志仅保留为下降段状态记录，不再触发任何相机动作。
  let _prevInDescent = false;
  let _wasPlaying = false;  // 拖拽进度条前的播放态（松手恢复）
  let _trackDragging = false; // 只有时间轴上按下才 seek（2026-10-17：画布拖动不再影响时序）

  // 路径数据（start/seekTo 时生成）
  let earthPath = [];      // 第一幕上升段 [lon,lat,alt]
  let transferCarts = [];  // 第二幕转移椭圆（霍曼）Cartesian3（画线用，实线：行径弧）
  let mirrorCarts = [];    // 转移椭圆未飞的对称半段（淡虚线：让椭圆形状可读）
  let emLineCarts = [];    // 地月连线（虚直线：地球质心 ↔ 月心，随月球移动）
  let moonOrbitCarts = []; // 月球绕地轨道环 Cartesian3
  // 已飞发射轨迹：launchTrail = [{p, pos, c}]（**按进度索引**，支持回拖裁剪），
  //   launchCarts 是其 Cartesian3 投影（折线 CallbackProperty 直接读它）
  let launchTrail = [];
  let launchCarts = [];
  let trailCarts = [];     // 已飞转移轨迹 Cartesian3（每帧取前缀）
  let phasingCarts = [];   // 调相段 2 圈渐扩椭圆（画线用）
  let ringCarts = [];      // 捕获段环月轨道环（月心系静态图：绕**当前**月心的四条离散轨道）
  let phasingRelCarts = [];   // 调相段已飞轨迹的**月系相对坐标**（每点 − 自己时刻的月心，捕获幕用）
  let transferRelCarts = [];  // 转移段已飞弧（前缀）的月系相对坐标（同上；demos 月球面板 Marr 同思路）
  let ghostCarts = [];     // ⭐ 捕获幕「来时路」：mc(当前) + transferRelCarts（虚线，见 transferGhostEnt）

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
  let transferGhostEnt = null; // ⭐ 捕获幕「来时路」虚线：地月转移大弧线（月系相对版，见 updateTransferTrail）
  let transferLabelEnt = null; // 转移轨道标注
  let moonEnt = null;          // 月球实体（球体 + 标签）
  // ⭐ 月面贴图预加载（2026-10-20 → 2026-10-21 五修）：
  //   演化史——① URL 直挂（异步白球窗口 + 失败不重试）；② Resource.fetchImage 返回 ImageBitmap，
  //   部分 GPU（ANGLE/D3D11 实机）纹理上传静默失败；③ ImageBitmap→canvas 同样翻车；
  //   ④ 原生 <img>（与画中画同源）——用户实机 2026-10-21 反馈**仍白球**。
  //   ⑤ 本次：候选链 `/lunar/lunar_wac_bright_2k.jpg` → `/lunar/lunar_wac.jpg`（画中画已证可用）
  //     → 灰兜底；且挂材质后启动**自动扫盘自检**（moonPixelStats）：圆盘中位亮度 >200 仍具
  //     白/灰球特征 → 自动换下一候选重试并记入 debugState.moonTexAuto，无需用户敲命令。
  //   ⑥ 2026-10-22+ 终局：实体椭球 ImageMaterialProperty 在本机 GPU 反复白球（画中画 globe 走另一条
  //     纹理管线才正常）。故第二幕月球实体**默认用着色器程序化月面**（MoonSurfaceMaterialProperty，
  //     灰底+月海暗斑+颗粒+球面明暗，自发光，任何 GPU/headless 必出）；真实 WAC 照片作为增强由自检
  //     循环尝试挂载，扫盘白球则自动回退程序化月面。手动强制见 __moonMission.debugMoonTex('bright'|'proc')。
  const MOON_TEX_SOURCES = ['/lunar/lunar_wac_bright_2k.jpg', '/lunar/lunar_wac.jpg'];
  let _moonTexImg = null;          // 最终挂到材质的纹理源（HTMLImageElement）
  let _moonTexState = 'loading';   // loading | ok | fail:<原因>
  let _moonTexMode = 'proc';       // proc（默认程序化月面）| image:<源下标>（真实照片已挂）| proc-fallback（白球回退）
  let _moonTexAuto = 'pending';    // 自检：pending | ok | switched:<file> | exhausted | err:<msg>
  let _moonTexIdx = -1;            // 当前生效候选下标
  const _moonTexCache = [];        // 已加载的 Image 元素（按下标）
  function _setMoonMaterial(img, idx) {
    _moonTexImg = img; _moonTexIdx = idx;
    _moonTexState = 'ok'; _moonTexMode = 'image:' + idx;   // 仅记录；实体默认程序化月面，真实照片由自检循环挂载
  }
  function _loadMoonTex(i) {
    return _moonTexCache[i] || new Promise((res, rej) => {
      const im = new Image();
      // 不设 crossOrigin：同源 /lunar/ 图片即便不带 CORS 头也不会污染 canvas，且画中画
      // 正是这样用的——保持与已验证链路完全一致。
      im.onload = () => { _moonTexCache[i] = im; res(im); };
      im.onerror = () => rej(new Error('img onerror: ' + MOON_TEX_SOURCES[i]));
      im.src = MOON_TEX_SOURCES[i];
    });
  }
  const _moonTexPromise = (async () => {
    for (let i = 0; i < MOON_TEX_SOURCES.length; i++) {
      try {
        const img = await _loadMoonTex(i);
        _setMoonMaterial(img, i);
        return img;
      } catch (e) {
        _moonTexState = 'fail[' + i + ']: ' + e.message;
        console.warn('[moon] 月面贴图候选失败：', e.message);
      }
    }
    _moonTexMode = 'fallback';
    console.warn('[moon] 月面贴图全部候选失败，使用灰色兜底：', _moonTexState);
    return null;
  })();
  // ⭐⭐ 第二幕月球材质定义（2026-10-22 从 ensureTransferScene 上移至此）：
  //   自检循环（下方 IIFE）与 debugMoonTex 都在 createMoonMission 顶层作用域，
  //   而材质类原先定义在 ensureTransferScene 内部 → 跨作用域引用直接
  //   ReferenceError（实机报 MoonTexMaterialProperty is not defined、自检 err 退出）。
  //   函数声明不会跨作用域提升，故整块上移；ensureTransferScene 内可正常引用本层定义。
  // ⭐ 程序化月面材质（MoonSurface，2026-10-22+ 默认）：着色器生成灰底 + 近面月海暗斑 +
  //   颗粒噪声 + 球面明暗，**不依赖任何外部图片/纹理上传**——绕开本机 GPU（ANGLE/D3D11）对
  //   实体椭球 ImageMaterialProperty 纹理上传静默失败的「白球」坑（画中画 globe 走 SingleTileImageryProvider
  //   另一条纹理管线才正常）。自发光（emission）保证暗面也可见，且 headless/SwiftShader 必出。
  //   真实 WAC 照片由自检循环尝试挂载（emission 自发光，判据「非黑」），失败自动回退本材质。
  function MoonSurfaceMaterialProperty() {
    this._definitionChanged = new Cesium.Event();
  }
  Object.defineProperties(MoonSurfaceMaterialProperty.prototype, {
    isConstant: { get: function () { return false; } },
    definitionChanged: { get: function () { return this._definitionChanged; } },
  });
  MoonSurfaceMaterialProperty.prototype.getType = function () { return 'SphereMoon'; };
  MoonSurfaceMaterialProperty.prototype.getValue = function (time, result) {
    if (!Cesium.defined(result)) result = {};
    return result;
  };
  MoonSurfaceMaterialProperty.prototype.equals = function (other) {
    return this === other || (other instanceof MoonSurfaceMaterialProperty);
  };
  if (!Cesium.Material._materialCache.getMaterial('SphereMoon')) {
    Cesium.Material._materialCache.addMaterial('SphereMoon', {
      fabric: {
        type: 'SphereMoon',
        uniforms: {},
        source:
          'float sphereMoonHash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }\n' +
          'float sphereMoonNoise(vec2 p){ vec2 i=floor(p), f=fract(p);\n' +
          '  float a=sphereMoonHash(i), b=sphereMoonHash(i+vec2(1.0,0.0)), c=sphereMoonHash(i+vec2(0.0,1.0)), d=sphereMoonHash(i+vec2(1.0,1.0));\n' +
          '  vec2 u=f*f*(3.0-2.0*f); return mix(mix(a,b,u.x),mix(c,d,u.y),u.y); }\n' +
          'float sphereMoonHash2(vec2 p){ return fract(sin(dot(p, vec2(269.5,183.3)))*43758.5453); }\n' +
          'vec2 sphereMoonCell(vec2 id, float k){ return vec2(sphereMoonHash2(id+k*13.1), sphereMoonHash2(id+k*3.7+7.3)); }\n' +
          'float sphereMoonCraters(vec2 st){\n' +     // 4 层密集环形山场：rim 提亮、floor 压暗
          '  float acc = 0.0;\n' +
          '  for (int k=0;k<4;k++){\n' +
          '    float fk = float(k);\n' +
          '    float scale = 13.0 * pow(1.7, fk);\n' +
          '    vec2 g = st*scale; vec2 id = floor(g); vec2 f = fract(g)-0.5;\n' +
          '    vec2 rnd = sphereMoonCell(id, fk)-0.5;\n' +
          '    float rad = 0.12 + 0.18*sphereMoonHash2(id+fk*5.3);\n' +
          '    float d = length(f - rnd*0.55);\n' +
          '    float rim = smoothstep(rad*1.3, rad, d) * (1.0 - smoothstep(rad, rad*0.65, d));\n' +
          '    float flr = 1.0 - smoothstep(rad*0.6, rad*0.95, d);\n' +
          '    acc += rim*0.16 - flr*0.20;\n' +
          '  }\n' +
          '  return acc;\n' +
          '}\n' +
          'czm_material czm_getMaterial(czm_materialInput materialInput) {\n' +
          '  czm_material material = czm_getDefaultMaterial(materialInput);\n' +
          '  vec2 st = materialInput.st;\n' +
          '  vec3 base = vec3(0.60,0.61,0.64);\n' +      // 月球高地浅灰
          '  float maria = 0.0;\n' +                    // 近面月海暗斑（固定经纬度 s,t，仿真实月海布局）
          '  maria = max(maria, 1.0 - smoothstep(0.0, 0.150, distance(st, vec2(0.40,0.66))));\n' +  // 雨海 Imbrium
          '  maria = max(maria, 1.0 - smoothstep(0.0, 0.090, distance(st, vec2(0.50,0.60))));\n' +  // 静海 Serenitatis
          '  maria = max(maria, 1.0 - smoothstep(0.0, 0.085, distance(st, vec2(0.55,0.55))));\n' +  // 澄海 Tranquillitatis
          '  maria = max(maria, 1.0 - smoothstep(0.0, 0.072, distance(st, vec2(0.63,0.52))));\n' +  // 危海 Crisium
          '  maria = max(maria, 1.0 - smoothstep(0.0, 0.205, distance(st, vec2(0.33,0.52))));\n' +  // 风暴洋 Procellarum(大)
          '  maria = max(maria, 1.0 - smoothstep(0.0, 0.115, distance(st, vec2(0.45,0.44))));\n' +  // 云海 Nubium
          '  maria = max(maria, 1.0 - smoothstep(0.0, 0.088, distance(st, vec2(0.36,0.38))));\n' +  // 湿海 Humorum
          '  maria = max(maria, 1.0 - smoothstep(0.0, 0.098, distance(st, vec2(0.60,0.46))));\n' +  // 丰富海 Fecunditatis
          '  vec3 mariaCol = vec3(0.30,0.31,0.36);\n' +   // 月海更暗，拉开对比
          '  vec3 col = mix(base, mariaCol, clamp(maria,0.0,1.0));\n' +
          '  float cr = sphereMoonCraters(st);\n' +       // 密集环形山场（rim 提亮、floor 压暗）
          '  col *= (1.0 + cr*0.9);\n' +
          '  float n = sphereMoonNoise(st*300.0);\n' +    // 高地细颗粒（碎屑）
          '  float n2 = sphereMoonNoise(st*80.0);\n' +
          '  col *= 0.82 + 0.30*n;\n' +
          '  col = mix(col, vec3(0.78,0.79,0.82), smoothstep(0.80,0.97,n2)*0.22);\n' +
          '  vec3 N = normalize(materialInput.normalEC.xyz);\n' +   // 固定眼空间光源 → 晨昏线，看起来被照亮
          '  vec3 L = normalize(vec3(-0.35, 0.42, 0.84));\n' +
          '  float diff = clamp(dot(N, L), 0.0, 1.0);\n' +
          '  float lit = 0.12 + 0.88 * pow(diff, 0.85);\n' +   // 暗面留 12% 自发光基线，亮面满
          '  material.diffuse = vec3(0.0);\n' +
          '  material.emission = clamp(col * lit, 0.0, 1.0);\n' +   // ⭐ 自发光+晨昏：绕开实体椭球不受光坑
          '  material.alpha = 1.0;\n' +
          '  return material;\n' +
          '}',
      },
      translucent: function () { return false; },
    });
  }
  // ⭐ 诊断用：把球面 UV (st) 直接画成颜色（红=经度、绿=纬度），验证 Entity 椭球的 st 是否变化。
  //   若月球显出红绿渐变 → st 正常、程序化月海/撞击坑应可见；若整球单色 → st 异常（需改用法线推导 UV）。
  if (!Cesium.Material._materialCache.getMaterial('SphereMoonST')) {
    Cesium.Material._materialCache.addMaterial('SphereMoonST', {
      fabric: {
        type: 'SphereMoonST',
        uniforms: {},
        source:
          'czm_material czm_getMaterial(czm_materialInput materialInput) {\n' +
          '  czm_material material = czm_getDefaultMaterial(materialInput);\n' +
          '  vec2 st = materialInput.st;\n' +
          '  material.diffuse = vec3(0.0);\n' +
          '  material.emission = vec3(st, 0.5);\n' +     // ⚠ 必须用 emission：只给 diffuse 时无光照会渲成全黑
                                                        //   （曾用 diffuse 导致「看不到渐变」的假否定，实为黑球）
          '  material.alpha = 1.0;\n' +
          '  return material;\n' +
          '}',
      },
      translucent: function () { return false; },
    });
  }
  function MoonSTMaterialProperty() { this._definitionChanged = new Cesium.Event(); }
  Object.defineProperties(MoonSTMaterialProperty.prototype, {
    isConstant: { get: function () { return false; } },
    definitionChanged: { get: function () { return this._definitionChanged; } },
  });
  MoonSTMaterialProperty.prototype.getType = function () { return 'SphereMoonST'; };
  MoonSTMaterialProperty.prototype.getValue = function (time, result) {
    if (!Cesium.defined(result)) result = {}; return result; };
  MoonSTMaterialProperty.prototype.equals = function (other) {
    return this === other || (other instanceof MoonSTMaterialProperty); };
  // ⭐⭐ 自发光贴图材质（2026-10-22 定案）：实测「纯白 ColorMaterialProperty 也渲染成全黑」(p25=6)
  //   ⇒ 第二幕实体椭球在本场景**不受光**。而 Cesium 的 ImageMaterialProperty 只写 material.diffuse，
  //     无光照即黑球——这就是「贴图看不见」的真根因（不是白球、不是 st、不是图片缺失）。
  //   故改为自定义 fabric：把 texture2D 采样结果写进 **material.emission**，绕开光照，任何情况都可见。
  if (!Cesium.Material._materialCache.getMaterial('SphereMoonTex')) {
    Cesium.Material._materialCache.addMaterial('SphereMoonTex', {
      fabric: {
        type: 'SphereMoonTex',
        uniforms: {
          image: (Cesium.Material && Cesium.Material.DefaultImageId) || '',
          gamma: 1.0, brightness: 1.0,
        },
        source:
          'czm_material czm_getMaterial(czm_materialInput materialInput) {\n' +
          '  czm_material material = czm_getDefaultMaterial(materialInput);\n' +
          '  #if (__VERSION__ >= 300)\n' +   // WebGL2/GLSL ES 3.00 里 texture2D 已删除 → 用 texture
          '    vec4 t = texture(image, materialInput.st);\n' +
          '  #else\n' +                       // WebGL1/GLSL ES 1.00 回退
          '    vec4 t = texture2D(image, materialInput.st);\n' +
          '  #endif\n' +
          '  vec3 col = pow(clamp(t.rgb, 0.0, 1.0), vec3(1.0 / gamma)) * brightness;\n' +
          '  material.diffuse = vec3(0.0);\n' +
          '  material.emission = clamp(col, 0.0, 1.0);\n' +   // ⭐ 自发光：绕开实体椭球不受光的坑
          '  material.alpha = 1.0;\n' +
          '  return material;\n' +
          '}',
      },
      translucent: function () { return false; },
    });
  }
  /** 自发光贴图材质属性：image 可为 URL 字符串 / HTMLImageElement / Canvas */
  function MoonTexMaterialProperty(image, gamma, brightness) {
    this._image = image;
    this._gamma = gamma == null ? 1.0 : gamma;
    this._brightness = brightness == null ? 1.0 : brightness;
    this._definitionChanged = new Cesium.Event();
  }
  Object.defineProperties(MoonTexMaterialProperty.prototype, {
    isConstant: { get: function () { return false; } },
    definitionChanged: { get: function () { return this._definitionChanged; } },
  });
  MoonTexMaterialProperty.prototype.getType = function () { return 'SphereMoonTex'; };
  MoonTexMaterialProperty.prototype.getValue = function (time, result) {
    if (!Cesium.defined(result)) result = {};
    result.image = this._image; result.gamma = this._gamma; result.brightness = this._brightness;
    return result; };
  MoonTexMaterialProperty.prototype.equals = function (other) {
    return this === other || (other instanceof MoonTexMaterialProperty && other._image === this._image); };
  // ⭐ 自发光纯色材质（对照组用）：同理，纯色也必须走 emission 才可见
  if (!Cesium.Material._materialCache.getMaterial('SphereMoonFlat')) {
    Cesium.Material._materialCache.addMaterial('SphereMoonFlat', {
      fabric: {
        type: 'SphereMoonFlat',
        uniforms: { color: new Cesium.Color(1, 1, 1, 1) },
        source:
          'czm_material czm_getMaterial(czm_materialInput materialInput) {\n' +
          '  czm_material material = czm_getDefaultMaterial(materialInput);\n' +
          '  material.diffuse = vec3(0.0);\n' +
          '  material.emission = color.rgb;\n' +   // Color uniform 是 vec4 → 取 .rgb
          '  material.alpha = 1.0;\n' +
          '  return material;\n' +
          '}',
      },
      translucent: function () { return false; },
    });
  }
  function MoonFlatMaterialProperty(color) {
    this._color = color || Cesium.Color.WHITE;
    this._definitionChanged = new Cesium.Event();
  }
  Object.defineProperties(MoonFlatMaterialProperty.prototype, {
    isConstant: { get: function () { return false; } },
    definitionChanged: { get: function () { return this._definitionChanged; } },
  });
  MoonFlatMaterialProperty.prototype.getType = function () { return 'SphereMoonFlat'; };
  MoonFlatMaterialProperty.prototype.getValue = function (time, result) {
    if (!Cesium.defined(result)) result = {};
    result.color = this._color; return result; };
  MoonFlatMaterialProperty.prototype.equals = function (other) {
    return this === other || (other instanceof MoonFlatMaterialProperty &&
      Cesium.Color.equals(other._color, this._color)); };
  // ⭐ 第二幕主视图月球表面 = 程序化着色器（路径 A，2026-10-22 用户确认放弃 globe 路线后定稿）：
  //   - 实体椭球 fabric 的 image 采样器在本机 GPU（ANGLE/D3D11）上**间歇失效**：round16 紫/亮图均显白，
  //     且 round19 发现「moonTexAuto=ok 但实机时而月面、时而白球」⇒ 单帧自检抽样那刻是灰度(ok)、
  //     下一刻采样器又掉回默认白纹理(白球)——**任何「抽一帧判断」都保证不了稳定**。
  //   - 故主视图月球**不再尝试挂真实照片**，永久用 SphereMoon 程序化月面（灰底+8 月海+密集环形山+晨昏线，
  //     emission 自发光，任何 GPU/headless 必出、必稳定）。告别白闪/间歇白球。
  //   - 真实照片仅保留手动入口 __moonMission.debugMoonTex('bright'|'purple') 供其它 GPU 自测；
  //     主流程不再因照片引发任何不稳定。要在主视图上真实照片的正确做法是 globe/imagery 管线（第三幕同源，
  //     即 B 路线），但会与用户「主视图地球惯性系」铁律冲突，故当前不启用。
  //   - moonEnt 默认材质已是 MoonSurfaceMaterialProperty（line ~1795），这里只需确认状态、并继续预载图片。
  _moonTexMode = 'proc';
  _moonTexAuto = 'proc(default)';
  // 仍预载图片（debugMoonTex('bright') 手动对比用），但不自动挂到 moonEnt，避免间歇白球。
  (async () => {
    try { await _moonTexPromise; } catch (e) { /* 不影响主流程 */ }
  })();
  let moonOrbitEnt = null;     // 月球绕地轨道环（淡）
  let padDustEnt = null;       // 发射台灰尘（第一幕点火初期）
  let landDustEnt = null;      // 触月激尘（第三幕末）
  // 注：landerPanelL / landerPanelR / _dustPsMap 已上移到模块级（供模块级 helper 访问，见 ~455 行）
  let moonRing = null;
  let moonBrakeEllipse = null;  // LOI 制动椭圆（完整黄色椭圆弧，近月点与 100km 目标环相切）
  let brakeGeom = null;         // 制动椭圆几何缓存（makeBrakeEllipse 结果，ensureMoonScene 重建）
  let moonCraft = null;
  let descentArcEnt = null;  // 动力下降段子午线大圆弧（淡虚线）
  let loiTrailEnt = null;    // LOI 已飞行径弧（赤道）
  let loiTrailCarts = [];
  let roverTrackEnt = null;   // 玉兔车辙（已行驶路线）
  let roverTrackCarts = [];   // 车辙 Cartesian3（逐帧前缀）
  // 分离件（第一幕临时实体）
  let boosters = [];    // [{ent, dir, axis, slot}]
  let fairings = [];    // [{ent, dir, axis, slot}]
  let cores = [];       // 二级/芯级分离件（2026-10-22 补二级脱离过程）

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
      // 航迹角（与水平面夹角）：竖直起步(90°)，重力转弯下垂，入轨点收敛到 0°（水平）。
      // ⚠ 2026-10-19 用户反馈「第一幕最后阶段轨道上翘不自然」：旧版末端 γ=8°（仍在爬升），
      //   入轨注入点应是转移轨道**近地点**（速度水平）→ 改为 90·(1−s)^1.6，末端严格水平。
      const gamma = 90 * Math.pow(1 - s, 1.6) * Cesium.Math.RADIANS_PER_DEGREE;
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
  /** 时间进度 s → 归一化偏近点角 E/2π（开普勒方程，飞船真实时序，勿动）。 */
  function transferENorm(s01) { return keplerE(EM.Menc * clamp01(s01), EM.e) / (Math.PI * 2); }

  /** 按**偏近点角**取点：E 均匀 ⇒ 空间间距近似均匀，画线专用。
   *  ⚠ 2026-10-19 用户反馈「地月转移大弧线近地段不是光滑弧线而是折线」真因：
   *    画线原用 transferCartAt(i/256) = **均匀平近点角 M** 采样。转移椭圆 e=0.966 →
   *    近地点 dE/dM = 1/(1−e) = 29.6、远地点 1/(1+e) = 0.51，均匀 M 下近地点一步跨
   *    ΔE≈42°、远地点仅 0.5°，弧长间距相差约 57 倍 → 近地段肉眼可见的折线。
   *    改 E 均匀采样后间距不均匀度 57× → 3.9×，点数 256 → 768，近地段完全光滑。
   *    飞船位置仍走 transferCartAt（= 本函数(transferENorm(s))），真实开普勒时序不变。 */
  function transferCartAtENorm(eN) {
    const E = Math.PI * 2 * clamp01(eN);
    const r = EM.a * (1 - EM.e * Math.cos(E));
    const nu = Math.atan2(Math.sqrt(1 - EM.e * EM.e) * Math.sin(E), Math.cos(E) - EM.e);
    const cart = new Cesium.Cartesian3();
    Cesium.Cartesian3.multiplyByScalar(TR.e1, r * 1000 * Math.cos(nu), cart);
    Cesium.Cartesian3.multiplyByScalar(TR.e2, r * 1000 * Math.sin(nu), _tTmp);
    return Cesium.Cartesian3.add(cart, _tTmp, cart);
  }
  function transferCartAt(s) { return transferCartAtENorm(transferENorm(s)); }

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
  /** 世界坐标点 → 月系相对坐标（该点自己时刻 sOwn 的月心为原点）。
   *  捕获幕渲染时加回「当前月心」= demos/transfer-full-dual-demo 月球面板的 Marr 表达。 */
  function relToMoonFrame(cart, sOwn) {
    return Cesium.Cartesian3.subtract(cart, moonCartAt(sOwn), new Cesium.Cartesian3());
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
        // ⚠ 2026-10-19 用户反馈「只绕了 5 圈没有 7 圈」真因之一：旧版返回
        //   `cu: last ? 1 : clamp01(...)`——最后一圈命中区间时 last=true → cu 恒 =1 →
        //   卫星钉死在末圈近地点（nu=2π），第 7 圈（48h 档）根本不绕。删掉 last 特判，
        //   正常按区间进度算；循环走完（u=1/浮点误差）才兜底 cu=1。
        if (h < acc + per) return { oi, li, cu: clamp01((h - acc) / per) };
        acc += per;
      }
    }
    const lastOi = orbits.length - 1, lastLi = orbits[lastOi].laps - 1;
    return { oi: lastOi, li: lastLi, cu: 1 };
  }
  const phasingState = (u) => orbitState(PH, CH_H.phasing, u);

  /** 捕获段进度 u∈[0,1]（与真实小时线性）→ { oi 轨道序号, li 段内圈序号, cu 圈内进度, segU 段内进度 }。
   *  ⚠ 2026-10-19 重做（用户反馈「地月转移与月球捕获衔接点反向，科学性错误」，参照 demos/）：
   *    seg0「地月转移抵达」= 半圈，自**远月点**（M=π，背地 +rhat，距月心 20,599 km
   *    = 转移远地点 405,000 − 地月距 384,400 = 转移可达最远处）起跑，摆到**近月点**
   *    （M=2π，向地 −rhat）完成 LOI-1；其余段自近月点（M=0）整圈起跑。
   *    相邻轨道近月点共享（200/211/200/195 km）→ 换轨只在远月点收缩，无任何位置跳变。 */
  function captureState(u) {
    const h = clamp01(u) * CH_H.capture;
    let acc = 0;
    for (let oi = 0; oi < CH_CAPTURE.length; oi++) {
      const o = CH_CAPTURE[oi];
      const segH = o.laps * o.per;                    // 该段真实耗时（seg0 = 0.5 圈 = 6h）
      if (h < acc + segH || oi === CH_CAPTURE.length - 1) {
        // ⚠ 末段（127min 圆轨道）必须用真实段内进度 (h-acc)/segH，绝不能强制 segU=1：
        //   旧版对最后一段强制 segU=1 → M 恒为 2π → 整段塌缩成近月点一个**点**，
        //   飞船在捕获段最后 ~4.6% 冻住不动、四条环月轨道里最后一条圆轨道根本没画出来，
        //   用户看到「捕获段轨道不连续 / 锐角连接」（实为末轨缺失）。
        const segU = clamp01((h - acc) / segH);
        const li = o.laps >= 1 ? Math.min(o.laps - 1, Math.floor(segU * o.laps)) : 0;
        const cu = o.laps >= 1 ? clamp01(segU * o.laps - li) : segU;
        return { oi, li, cu, segU };
      }
      acc += segH;
    }
    return { oi: CH_CAPTURE.length - 1, li: 0, cu: 1, segU: 1 };
  }

  /** 调相段位置（世界坐标，米）：三条离散椭圆 16h→24h→48h 共 7 圈，每圈自近地点起跑。
   *  ⭐ 三条椭圆的近地点几乎重合（6583 / 6971 / 6971 km）→ 左端汇聚一点、向远地点层层张开，
   *    一眼就是三个渐扩的圈（旧版连续渐变 = 螺旋，读不出圈）。 */
  function phasingCartAt(u) {
    const { oi, cu } = phasingState(u);
    const o = PH[oi];
    // ⚠ 2026-10-19 用户反馈「环地调相绕行太快」+「T+5~T+7 卫星一直卡在近地点」：
    //   旧版 M = 2π·cu（开普勒均匀平近点角）在 e≈0.99 的高偏心椭圆上 →
    //   远地点角速度≈0（T+5~T+7 真近点角 2 小时仅从 177.7° 爬到 179.3°，视觉冻结=「卡住」）、
    //   近地点飞掠（「太快」）。改为**均匀真近点角**（等角速度绕行）：两问题都消。
    //   代价：不严格遵守开普勒面积律（真实任务卫星大部分时间在远地点）——演示观感优先；
    //   轨迹线 phasingCarts / 画中画 buildPipPath / 飞船位置同走本函数，三者自动一致。
    //   圈起点 cu=0 → nu=0 仍在近地点，phasingBurn 的 cu<0.06 点火判据不受影响。
    const nu = Math.PI * 2 * cu;
    const r = o.a * (1 - o.e * o.e) / (1 + o.e * Math.cos(nu));
    const px = r * Math.cos(nu), py = r * Math.sin(nu);
    const cart = Cesium.Cartesian3.multiplyByScalar(TR.e1, px * 1000, new Cesium.Cartesian3());
    Cesium.Cartesian3.multiplyByScalar(TR.e2, py * 1000, _tTmp);
    return Cesium.Cartesian3.add(cart, _tTmp, cart);
  }

  /** 捕获段基向量：**冻结在会合时刻** s=P2.enc（与 demos/transfer-full-dual-demo 一致——
   *  demo 的捕获椭圆 dir=3π/2+ν 固定，不随月球公转旋转）。⚠ 若随各自 s 旋转（旧版）：
   *  规划环（绕当前月心、sNow 基向量）与已飞黄线（各点自己时刻 s_i 的基向量）相差
   *  moonOmega×Δs 的转角（捕获全程月球走 25.3°）→ 黄线从环上「拧」开、月系轨迹永远
   *  无法与环重合。冻结后三者（规划环 / 已飞黄线 / 飞船位置）共用同一套基向量。 */
  let _capRhat = null, _capThat = null;
  // ⚠ 捕获段绕行方向开关（2026-10-22 用户手绘确认图定稿）：
  //   CAP_FLIP_Y=+1 = 捕获轨道在远月点（远端/背地侧 +rhat）与入站转移**相切连续**
  //     （速度同向，读作「接着大弧走」、无 V 形掉头）——这是用户手绘图里明确的几何：
  //     ghost 从上往下探到远端、捕获顺势顺时针继续（远端处速度向下 = 与入站同向）。
  //   CAP_FLIP_Y=-1 = 把 captureBasis 的 that 取反 = 捕获初速与入站反向 180°（V 形/掉头），
  //     是 2026-10-21 用户第 6 轮曾拍板、第 12 轮恢复的旧观感；与本图互斥，保留为运行时
  //     debugState().setCapFlip(-1) 可一键切回对比（切换整体换向，建议暂停时切）。
  //   · 为什么改基向量就够：规划环 captureRingCartAt / 飞船位置 captureCartAt / 已飞弧
  //     （ringCarts 前缀）/ 画中画 四者共用 captureBasis，改这里即同步翻转。
  //   · 起点位置不受影响：seg0 从 M=π（远月点）起跑 sinν=0→py=0，镜像前后位置相同
  //     ⇒ 与转移段会合点（+rhat，20,599 km）位置衔接严格不变（jumpKm=0）。
  let CAP_FLIP_Y = 1;
  function captureBasis() {
    if (!_capRhat) {
      _capRhat = Cesium.Cartesian3.clone(moonDirAt(P2.enc), new Cesium.Cartesian3());
      _capThat = Cesium.Cartesian3.cross(_capRhat, TR.nrm, new Cesium.Cartesian3());
      if (CAP_FLIP_Y < 0) Cesium.Cartesian3.negate(_capThat, _capThat);
    }
    return [_capRhat, _capThat];
  }

  /** 捕获段位置（世界坐标，米）：四条轨道，seg0 半圈自远月点起跑，其余自近月点整圈。
   *  ⭐ 几何（2026-10-19 定稿，与 demos/transfer-full-dual-demo 一致）：
   *     · 远月点 = 背地方向（+rhat），近月点 = 向地方向（−rhat）——抵达就在远月点；
   *     · 远月点处运动方向 = +that（that = rhat × n̂）＝ 飞船**相对月球**的抵达方向
   *       （地心系里月球 1.02 km/s 顺行远超飞船 0.18 km/s，相对速度即 +that），
   *       故捕获轨道在远月点沿 +that 起步与转移严格衔接、两个坐标系里都不反向；
   *     · 轨道面法向 = −n̂（逆行环月，L = r × v = −n̂ 方向）——真实地月抵达的相对运动学；
   *     · 基向量冻结在会合时刻（见 captureBasis），椭圆只随月心平移、不随公转旋转。
   *  ⚠ 环月轨道随月球视觉倍率 exag 等比缩放（默认捕获段 ×1 真实比例）。 */
  function captureCartAt(u, exag = MOON_EXAG_NEAR, orbits = CA) {
    const u01 = clamp01(u);
    const { oi, segU } = captureState(u01);
    const o = orbits[oi];
    const seg = CH_CAPTURE[oi];
    const s = P2.enc + (1 - P2.enc) * u01;   // 该时刻地月段进度（月球在动）
    const mc = moonCartAt(s);
    const [rhat, that] = captureBasis();     // 冻结基向量（不随 s 旋转）
    // 段内进度 → 平近点角：seg0 自 M=π（远月点）出发走半圈；其余段自 M=0（近月点）整圈
    const M = (oi === 0 ? Math.PI : 0) + Math.PI * 2 * segU * seg.laps;
    // 椭圆基：d1 = −rhat（近月点在向地侧）、d2 = −that（远月点沿 +that 运动 = 与抵达衔接）
    const d1 = Cesium.Cartesian3.negate(rhat, new Cesium.Cartesian3());
    const d2 = Cesium.Cartesian3.negate(that, new Cesium.Cartesian3());
    const [px, py] = ellipseKM(o.a, o.e, M, d1, d2);
    const cart = Cesium.Cartesian3.multiplyByScalar(d1, px * 1000, new Cesium.Cartesian3());
    Cesium.Cartesian3.multiplyByScalar(d2, py * 1000, _tTmp);
    Cesium.Cartesian3.add(mc, Cesium.Cartesian3.add(cart, _tTmp, cart), cart);
    return cart;
  }

  /** 环月轨道环（月心系**静态图**，2026-10-19）：与 captureCartAt 同一椭圆几何、同一档位
   *  划分，但月心/基向量固定取**当前时刻** sNow（而非各点自己的 s(u)）——
   *  ⚠ 为什么需要它：captureCartAt 的月心随 u 移动（捕获 46 h 月球走 25.3° ≈ 17 万 km），
   *    整条折线被抹散成 17 万 km 长的 smear，捕获幕里只有 u≈当前 的局部弧在屏内
   *    （实测 blue=425，用户看不到「一圈圈椭圆」）。轨道环绕当前月心画 = demos/
   *    transfer-full-dual-demo.html 月球面板 Marr（月心相对坐标）同思路：四条离散轨道
   *    （抵达半圈 + 12h + 3.5h + 127min）作为「轨道图」可读，飞船此刻正走在对应的环上。
   *  ⚠ 捕获幕相机跟随月球，环心必须贴住月心：月心每移动 >~154 km 或倍率变化 >0.02 重建一次
   *    （841 点开普勒求解 ≈ 每 1.2 帧一次，与已飞轨迹折线的每帧重建同量级，可接受）。 */
  let ringBuiltS = -1, ringBuiltExag = -1;
  // ⚠ 2026-10-21 用户反馈 #92「捕获减速轨道展示视角抖动」真因：原阈值 2e-4 → 仅当月心移动
  //   ~270 km 才重建环月轨道。但捕获段已慢放（rateAt.capture=0.68），逐帧月心仅移动 ~117 km
  //   < 阈值 → 轨道环每 ~3 帧才重建一次，而相机/飞船每帧都随月心更新 → 轨道线相对月球「跳步」
  //   即用户看到的抖动。阈值降到远低于逐帧进度增量 → 播放时**每帧重建**，轨道环紧贴月心不滞后。
  //   暂停时 sNow 不变 → 不触发重建（无浪费）。
  const RING_REBUILD_DS = 1e-7;
  function captureRingCartAt(u, sNow, exag = MOON_EXAG_NEAR, orbits = CA) {
    const u01 = clamp01(u);
    const { oi, segU } = captureState(u01);
    const o = orbits[oi];
    const seg = CH_CAPTURE[oi];
    const mc = moonCartAt(sNow);                                          // ← 当前月心（非 s(u)）
    const [rhat, that] = captureBasis();                                  // 冻结基向量（同已飞黄线）
    const M = (oi === 0 ? Math.PI : 0) + Math.PI * 2 * segU * seg.laps;
    const d1 = Cesium.Cartesian3.negate(rhat, new Cesium.Cartesian3());   // 近月点在向地侧
    const d2 = Cesium.Cartesian3.negate(that, new Cesium.Cartesian3());   // 远月点沿 +that
    const [px, py] = ellipseKM(o.a, o.e, M, d1, d2);
    const cart = Cesium.Cartesian3.multiplyByScalar(d1, px * 1000, new Cesium.Cartesian3());
    Cesium.Cartesian3.multiplyByScalar(d2, py * 1000, _tTmp);
    Cesium.Cartesian3.add(mc, Cesium.Cartesian3.add(cart, _tTmp, cart), cart);
    return cart;
  }
  function rebuildCaptureRings(sNow, exag) {
    ringCarts = [];
    ringBuiltS = sNow; ringBuiltExag = exag;
    const orbits = caAt(exag);
    for (let i = 0; i <= 840; i++) ringCarts.push(captureRingCartAt(i / 840, sNow, exag, orbits));
  }
  function updateCaptureRings(sNow) {
    const ex = _moonExagNow;
    if (!ringCarts.length || Math.abs(ex - ringBuiltExag) > 0.02
      || Math.abs(sNow - ringBuiltS) > RING_REBUILD_DS) rebuildCaptureRings(sNow, ex);
  }

  /** 调相段喷焰：只在「换轨」那一圈的近地点点火（16h→24h、24h→48h）。
   *  ⚠ 同轨道内重复绕行不点火——真实 24h 轨道连飞 3 圈是把 1 天发射窗口扩成 3 天，期间无动力。 */
  function phasingBurn(u) {
    const { oi, li, cu } = phasingState(u);
    return (li === 0 && oi > 0 && cu < 0.06) ? 1.5 : 0;
  }

  /** 捕获段喷焰：每段结束 = **近月点**（向地侧）逆行制动 LOI-1 / LOI-2 / LOI-3。
   *  ⚠ 2026-10-19：制动点从远月点改到近月点（参照 demos：相邻轨道近月点共享
   *    200/211/200/195 km → 位置连续，仅远月点逐档收缩 20,599→8,500→1,729→195，
   *    读作「刹一脚、轨道小一圈」；旧版远月点制动 = 外圈 apolune 直接跳内圈 ≈ 1 万 km 跳变）。 */
  function captureBurn(u) {
    const h = clamp01(u) * CH_H.capture;
    let acc = 0;
    for (let oi = 0; oi < CH_CAPTURE.length - 1; oi++) {   // 末段（127min 圆轨道）之后无制动
      acc += CH_CAPTURE[oi].laps * CH_CAPTURE[oi].per;
      if (Math.abs(h - acc) < 0.9) return 1.2;
    }
    return 0;
  }

  function buildPathData() {
    const pad = LAUNCH_SITES[launchSiteKey];
    earthPath = makeEarthPath(pad);
    buildTransferGeom(pad);
    transferCarts = [];
    mirrorCarts = [];
    // ⭐ 画线按**偏近点角 E 均匀**取点（空间间距近似均匀），不用均匀 M——否则近地点稀疏呈折线
    //   （见 transferCartAtENorm 注释）。飞船时序/取景/会合点全部不受影响。
    for (let i = 0; i <= 768; i++) {
      const c = transferCartAtENorm(i / 768);
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
    // 月系相对坐标（demos/transfer-full-dual-demo 月球面板 Marr 同思路）：每点减去
    // 「自己时刻的月心」。捕获幕里加回当前月心 → 黄线随月球走、与规划环逐点重合、
    // 转移弧以「月系来向」扫入且末端与环起点严格衔接（encHandoff 0 km）。
    // ⚠ 转移只取**已飞前缀**：transferCarts 是完整椭圆（E 0→2π），飞船只飞到 E_enc
    //   （≈π，前半）——旧 capture 分支 concat 整条数组把未飞后半也画进黄线（四分五裂元凶之一）。
    phasingRelCarts = [];
    for (let i = 0; i <= 1200; i++) {
      phasingRelCarts.push(relToMoonFrame(phasingCarts[i], P2.phasingEnd * i / 1200));
    }
    transferRelCarts = [];
    const KT = Math.max(1, Math.round(transferENorm(1) * 768));   // 已飞前缀末索引（E_enc/2π≈0.5）
    for (let j = 0; j < KT; j++) {
      const E = Math.PI * 2 * (j / 768);
      const M = E - EM.e * Math.sin(E);                           // E → M（正解，无需迭代）
      const sOwn = P2.phasingEnd + (P2.enc - P2.phasingEnd) * (M / EM.Menc);
      transferRelCarts.push(relToMoonFrame(transferCarts[j], sOwn));
    }
    // 末点不用索引取整（E 网格落不到 E_enc，实测留 ~516 km 缝）——直接取精确会合点：
    // transferCartAt(1) − moonCartAt(enc) 与捕获环起点偏移严格相等（encHandoff 0 km）。
    transferRelCarts.push(relToMoonFrame(transferCartAt(1), P2.enc));
    updateCaptureRings(0);     // 环月轨道环先建一次（之后由折线 CallbackProperty 按需重建）
    buildPipPath();            // 画中画月心系路径（调相+转移段，固定预计算）
    _ovView = null;          // 定场取景缓存随轨迹重建失效
    ghostCarts = [];         // 捕获幕「来时路」虚线随轨迹重建失效（render 捕获分支每帧重填）
    launchTrail = [];
    launchCarts = [];
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
        hideSlot(rocketCoreSlot); hideSlot(rocketUpperSlot); hideSlot(craftSlot); showSlot(slot);
        placeModel(slot, cart, Cesium.Quaternion.IDENTITY, Cesium.Ellipsoid.WGS84);
      } else {
        earthRocket.billboard.show = true;
        earthRocket.billboard.image = FULL_ROCKET_ICON;
        earthRocket.billboard.rotation = 0;
      }
      const eastM = 2400, southM = 1500;                 // 水平偏移（发射台东南侧，×10 配合 5000m 高度保持俯角）
      const latOff = -southM / 110946;
      const lonOff = eastM / (111319.5 * Math.max(0.15, Math.cos(Cesium.Math.toRadians(pad.lat))));
      const camPos = Cesium.Cartesian3.fromDegrees(
        pad.lon + lonOff, pad.lat + latOff, groundH + 5000);
      // ⚠ 2026-10-19 用户要求：预览时比例尺（DistanceLegend）显示 ~500m、可见发射台周边全貌
      //   → 相机抬到 5000m 高度。原 500m 高度让比例尺只读 ~50m（火箭占满近景）。水平偏移同步
      //   ×10（240→2400 / 150→1500）保持 ~30° 俯角，仅整体后撤 10 倍、构图不变。
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
      // 捕获段：绕显示月球四条离散环月轨道（抵达半圈 + 12h + 3.5h + 127min）共 7.5 圈，
      // 每次过**近月点**（向地侧）逆行制动、远月点逐档收缩 20,599→8,500→1,729→195 km。
      // 2026-10-19：捕获段起真实比例（×1），轨道尺寸与显示月球一致，不再需要跟着放大。
      captureEnt = earthViewer.entities.add({
        id: 'moonCaptureOrbits',
        polyline: {
          positions: new Cesium.CallbackProperty(() => {
            updateCaptureRings(act2Progress(p));
            return ringCarts;
          }, false),
          width: 2.2,
          // 2026-10-22：捕获段轨道改为黄色（地月转移/虚线保留蓝色 #9ec1ff），便于对照检查
          material: Cesium.Color.fromCssColorString('#ffd24a').withAlpha(0.8),
          depthFailMaterial: Cesium.Color.fromCssColorString('#ffd24a').withAlpha(0.35),
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
      // ⚠ 2026-10-19：捕获段标注锚点必须跟随当前月心（旧版固定世界坐标 → 月球走 177° 后
      //    标注被甩在几万 km 外，转移幕里根本看不见）；phasing/transfer 是地心系，固定即可。
      const capLabelU = (CH_CAPTURE[0].laps * CH_CAPTURE[0].per
        + CH_CAPTURE[1].laps * CH_CAPTURE[1].per * 0.5) / CH_H.capture;
      phaseLabelEnts = [
        mk('moonPhaseLabel1', '调相段 · 16h → 24h → 48h（7 圈 · 7 天）',
          phasingCartAt((CH_PHASING[0].laps * CH_PHASING[0].per + CH_PHASING[1].laps * CH_PHASING[1].per + CH_PHASING[2].per * 0.5) / CH_H.phasing)),
        mk('moonPhaseLabel2', '地月转移段 · 114 小时', transferCartAt(0.5)),
        mk('moonPhaseLabel3', '月球捕获段 · 抵达 → 12h → 3.5h → 127min',
          new Cesium.CallbackProperty(() => captureRingCartAt(
            capLabelU, act2Progress(p), _moonExagNow, caAt(_moonExagNow)), false)),
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
    if (!transferGhostEnt) {
      // ⭐ 2026-10-21 用户要求「捕获段补接原来地月转移的大弧线（虚线）」：
      //   捕获幕已隐藏地心系规划线（showPlan 只到 card2End）与黄线（去黄线需求），画面里
      //   「飞船从哪来」完全没有参照 → 用淡蓝虚线把**月系相对版**的转移弧补回来：
      //   mc(当前月心) + transferRelCarts（各点 − 自己时刻的月心）= demos 月球面板 Marr，
      //   末端严格落在会合点（= 环起点，encHandoff 0 km），来向与转移段后段（T+11d4h）一致。
      //   ⚠ 为什么不能直接用 transferFullEnt（地心系实线椭圆）：月球 46 h 公转 25.3°，
      //      地心系弧末端锚在旧会合点 → 残尖漂离月球，与规划环叠成重影（「四分五裂」旧观感）。
      // ⚠ dashLength 单位是**米**，且必须与取景尺度匹配：这条弧长 38 万 km，若沿用
      //   emLineEnt 的 22 m（世界单位），一个 dash 远小于 1 像素 → 抗锯齿后退化成均匀
      //   半透明实线，用户看到的仍是「一条实线」而非虚线。改为按相机到月心的距离动态取：
      //   dash ≈ 取景半径 × 0.022 ≈ 屏幕上 8 px 一段（取景半径映射约 360 px）。
      const ghostDash = new Cesium.CallbackProperty(() => {
        try {
          if (!moonEnt) return 6e5;
          const mc = moonEnt.position.getValue(Cesium.JulianDate.now());
          if (!mc) return 6e5;
          const dKm = Cesium.Cartesian3.distance(earthViewer.camera.positionWC, mc) / 1000;
          return Math.max(2e4, dKm * 22);
        } catch (e) { return 6e5; }
      }, false);
      transferGhostEnt = earthViewer.entities.add({
        id: 'moonTransferGhost',
        polyline: {
          positions: new Cesium.CallbackProperty(() => ghostCarts, false),
          // 2026-10-22 用户反馈「没见到承接前一幕的大弧蓝线」：原 1.8/0.55 又细又暗，
          // 叠加近会合点切向接近本就近直线 → 几乎不可见。加粗到 3.0、提亮到 0.92，
          // 让入站来向在月心特写里也清晰可读（与捕获黄弧在会合点相切续接）。
          width: 3.0,
          material: new Cesium.PolylineDashMaterialProperty({
            color: Cesium.Color.fromCssColorString('#9ec1ff').withAlpha(0.92),
            dashLength: ghostDash,
          }),
          depthFailMaterial: new Cesium.PolylineDashMaterialProperty({
            color: Cesium.Color.fromCssColorString('#9ec1ff').withAlpha(0.45),
            dashLength: ghostDash,
          }),
          arcType: Cesium.ArcType.NONE,
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
    // ⭐ 月球材质类（MoonSurface/MoonST/MoonTex/MoonFlat + 对应 fabric 注册）已上移到
    //   createMoonMission 顶部（2026-10-22）：自检循环与 debugMoonTex 在该层作用域，
    //   定义在 ensureTransferScene 内会导致跨作用域 ReferenceError（MoonTexMaterialProperty is not defined）。
    if (!moonEnt) {
      moonEnt = earthViewer.entities.add({
        id: 'moonTransferTarget',
        position: Cesium.Cartesian3.fromDegrees(0, 0, (EM.moonDist - EM.rE) * 1000),
        ellipsoid: {
          // 2026-10-19：半径随视觉倍率 LOD 变化（远景 ×3 让月球作为靶标可见；捕获段 ×1 真实比例，
          // 保证转移远地点 405,000 − 地月距 384,400 = 20,599 km 与捕获远月点严格衔接）
          radii: new Cesium.CallbackProperty(() => {
            const r = EM.moonR * _moonExagNow * 1000;
            return new Cesium.Cartesian3(r, r, r);
          }, false),
          // ⚠ 2026-10-19 用户反馈「第二幕月球需要有月面图片蒙皮」：原用 lunar_wac.jpg
          //   （WAC 反照率产品）整体偏暗（球体像素均值 ~28），且 8192×4096 / 10 MB 压到
          //   十几像素后黑成一坨 = 看着像没蒙皮。改用提亮版 2K 贴图（out = src^(1/1.45)×1.35，
          //   与 lunar.js LUNAR_LAYER_OPTS 同一口径；由 tools/lunar/make-lunar-bright.py 生成）。
          // 2026-10-21 终修「白球」：纹理源改用原生 <img> HTMLImageElement（见 _moonTexPromise），
          //   与画中画同源，绕开 ImageBitmap/canvas 在部分 GPU 上上传静默失败的坑；
          //   未就绪/失败时灰色兜底。
          // 2026-10-22+ 默认：着色器程序化月面（灰底+月海+颗粒+球面明暗，绕开实体椭球纹理上传白球坑）。
          //   真实 WAC 照片由自检循环尝试挂载，白球则自动回退本材质；手动强制见 debugMoonTex('bright'|'proc')。
          material: new MoonSurfaceMaterialProperty(),
          // 2026-10-22 实机反馈「球体上有密密麻麻网格线」：outline:true 会把 96×48 经纬剖分线框
          //   叠在贴图上（纹理出现后尤其刺眼）→ 关掉。细分保留（保证球缘圆滑）。
          outline: false,
          // 放大到 ×6 后屏幕直径 ~26 px，默认细分会出现可辨的多边形棱角 → 提高经纬分割数
          slicePartitions: 96,
          stackPartitions: 48,
        },
        label: {
          // 旧标注写「体积 ×8」是错的：放大的是**半径（半径 ×8 = 体积 ×512）；×1 时即真实比例
          text: new Cesium.CallbackProperty(
            // 2026-10-30 用户：「月球（真实比例）」改回「月球」（×1 即真实尺寸，无需再声明）
            () => _moonExagNow < 1.05 ? '月球'
              : '月球（半径 ×' + _moonExagNow.toFixed(1) + ' 示意）', false),
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
  /** 已飞发射轨迹（第一幕）。⭐ 2026-10-23 用户反馈「暂停后拖回时间轴，轨道线分叉」：
   *  根因——旧实现只向数组尾部**追加** Cartesian3，回拖后新点接在旧点之后，
   *  折返段被折线连起来 → 分叉/毛刺（残影）。修复：轨迹按进度 p 索引，每帧先弹出
   *  所有 p ≥ 当前 p 的点（回溯裁剪），再按节流条件追加，保证轨迹始终是「当前时刻的前缀」。
   *  另：launchTrailEnt 的 positions 是 CallbackProperty(() => launchCarts)，故需整体重赋。 */
  function pushLaunchTrail(pos, pp) {
    while (launchTrail.length && launchTrail[launchTrail.length - 1].p >= pp - 1e-9) {
      launchTrail.pop();
    }
    const prev = launchTrail.length ? launchTrail[launchTrail.length - 1] : null;
    if (!prev) {
      launchTrail.push({ p: pp, pos: pos.slice(), c: Cesium.Cartesian3.fromDegrees(pos[0], pos[1], pos[2]) });
      launchCarts = launchTrail.map((e) => e.c);
      return;
    }
    const dh = Math.abs(pos[2] - prev.pos[2]);
    const dl = Math.abs(pos[0] - prev.pos[0]) + Math.abs(pos[1] - prev.pos[1]);
    if (dh > 1200 || dl > 0.012) {
      launchTrail.push({ p: pp, pos: pos.slice(), c: Cesium.Cartesian3.fromDegrees(pos[0], pos[1], pos[2]) });
      launchCarts = launchTrail.map((e) => e.c);
    }
  }

  // 转移已飞轨迹 = 规划航线前缀
  function updateTransferTrail(s) {
    // 已飞弧 = 调相（1200 点）+ 转移（768 点，按偏近点角均匀）+ 捕获（840 点）三段按进度拼接
    const NP = 1200, NC = 840;
    let pts;
    if (s < P2.phasingEnd) {
      const k = Math.max(1, Math.round((s / P2.phasingEnd) * NP));
      pts = phasingCarts.slice(0, k + 1);
    } else if (s < P2.enc) {
      const u = (s - P2.phasingEnd) / (P2.enc - P2.phasingEnd);
      // ⚠ 画线数组已改为**偏近点角 E 均匀**索引，时间进度 u 不能直接当比例：必须经
      //   transferENorm(u)（开普勒）换算，否则已飞弧端点与飞船实际位置错位。
      const k = Math.max(1, Math.round(transferENorm(u) * (transferCarts.length - 1)));
      pts = phasingCarts.concat(transferCarts.slice(0, k + 1));
    } else {
      const u = (s - P2.enc) / (1 - P2.enc);
      const k = Math.max(1, Math.round(u * NC));
      // ⭐ 2026-10-19 用户反馈「轨道四分五裂，参考 demo 重做（尤其转移→捕获衔接）」：
      //   捕获幕主视图 = demos/transfer-full-dual-demo 的「月球原点」面板——整条已飞轨迹
      //   以**月系相对坐标**（每点 − 自己时刻的月心）加到**当前月心**旁：
      //   · 捕获段 = ringCarts 前缀（与规划环逐点重合，基向量已冻结见 captureBasis）；
      //   · 转移已飞弧以「月系来向」扫入，末端与环起点严格重合（encHandoff 衔接 0 km）
      //     → 黄线全程连续、无撕裂无 smear；
      //   · 调相圈月系下远在地球方向 ~38 万 km 外，捕获幕取景内不可见（无害）。
      //   旧版两种画法都不对：环前缀版（地心系转移弧 vs 随月平移的环）在会合点撕成 V 形；
      //   真实行径版（各点绕自己时刻月心）被月球 46h 公转 25.3° 拖成横穿屏幕的 smear。
      updateCaptureRings(s);
      const mc = moonCartAt(s);
      pts = [];
      // ⭐ 连续已飞轨迹（捕获段）：转移弧（月系相对 + 当前月心，Earth→会合点）+ 捕获环已飞前缀
      //   （会合点→当前飞船）。与转移段黄线在会合点无缝衔接 → 跨 card2End 不再硬切/变色，
      //   飞船头始终在轨迹末、尾始终在地球，读起来是「一条连续飞行的黄线」而非两个场景。
      //   （旧版在此 prepend 整段 phasingRelCarts，调相圈在地球侧 ~38 万 km 外、捕获取景内
      //   不可见，且会在 30 万 km 抵达框突然入屏造成 pop，故去掉 —— 转移段黄线本身已含调相。）
      for (let j = 0; j < transferRelCarts.length; j++)
        pts.push(Cesium.Cartesian3.add(mc, transferRelCarts[j], new Cesium.Cartesian3()));
      // ⭐ 2026-10-21 用户要求「捕获段补接原来地月转移的大弧线（虚线）」：
      //   同一段循环里顺便给 ghostCarts 填点（transferGhostEnt 的虚线），避免重复开普勒计算。
      //   几何与 trail 捕获分支的转移弧**逐点同源** → 虚线末端严格落在会合点（= 环起点），
      //   来向 = 转移段后段（T+11d4h ≈ 268 h）在月球系里看到的同一条扫入轨迹。
      // ⭐ 2026-10-21 二修「竖直线 + 绿弧伪影」（用户截图红箭头）：ghost 全弧从地球方向扫入
      //   （最远 38.8 万 km），捕获取景仅 2~5 万 km → 远端顶点投影到**屏幕外 ±1 万像素**：
      //   ① 远端在消失点方向收敛成一条「竖直线」（实测就是 ghost 材质 #9ec1ff×0.55）；
      //   ② 超大屏幕外线段在部分实机 GPU 上环绕渲染出杂色条纹（用户截图的「绿弧」，
      //      headless SwiftShader 正确裁剪 → 复现不出）。
      //   修法（2026-10-21 三修）：粗裁（月心 clipKm 内）只做预过滤——camKm×4 ≈ 6.8 万 km
      //   的点在半高 ~5,500 km 的取景下仍投影到屏幕外**数千像素**，build 088 用户实测
      //   竖线仍在。终案：按**投影窗口坐标**精裁——从远端向近端找第一个投影落在
      //   视口内（±margin）的点，只保留其后的连续后缀（点序从远到近单调趋近会合点）。
      //   → 折线所有顶点都在屏幕上（或贴边 64px 内），超大屏幕外顶点数为 0，伪影无从产生；
      //     拉远相机时自然有更多弧段入屏，无需再调参数。
      ghostCarts = [];
      let camKm = 20000;
      try { camKm = Cesium.Cartesian3.distance(earthViewer.camera.positionWC, mc) / 1000; } catch (e) { /* 保底 */ }
      const clipKm = Math.min(450000, Math.max(50000, camKm * 4));
      let j0 = 0;
      while (j0 < transferRelCarts.length) {
        // transferRelCarts[j] 是月系相对向量，其模长 = 该点离月心距离（粗裁，压投影计算量）
        if (Cesium.Cartesian3.magnitude(transferRelCarts[j0]) / 1000 <= clipKm) break;
        j0++;
      }
      // 精裁：投影逐点判视口（CSS 像素，worldToWindowCoordinates 与 canvas.clientWidth 同系）
      const GHOST_MARGIN = 64;
      let jCut = transferRelCarts.length - 1; // 兜底：全部出界也至少保留会合点
      let projFound = false;
      {
        const scene = earthViewer.scene;
        const cw = scene.canvas.clientWidth || scene.canvas.width;
        const ch = scene.canvas.clientHeight || scene.canvas.height;
        for (let j = j0; j < transferRelCarts.length; j++) {
          let sw = null;
          try {
            sw = Cesium.SceneTransforms.worldToWindowCoordinates(
              scene, Cesium.Cartesian3.add(mc, transferRelCarts[j], new Cesium.Cartesian3()));
          } catch (e) { sw = null; }
          if (sw && isFinite(sw.x) && isFinite(sw.y) &&
              sw.x >= -GHOST_MARGIN && sw.x <= cw + GHOST_MARGIN &&
              sw.y >= -GHOST_MARGIN && sw.y <= ch + GHOST_MARGIN) {
            jCut = j; projFound = true;
            break;
          }
        }
      }
      // ⚠ 健壮性：投影在部分环境（如 headless / canvas 尺寸未就绪）取不到有效视口坐标时，
      //   projFound=false → 回退到 km 粗裁（j0），避免折线塌缩成 1 个点（入屏段照出、远端
      //   顶点虽在屏外，但实机 GPU 对「仅 km 粗裁」的环绕伪影已远弱于整弧；真实浏览器里
      //   投影正常，仍走上面的精裁）。
      if (!projFound) jCut = j0;
      for (let j = jCut; j < transferRelCarts.length; j++) {
        const w = Cesium.Cartesian3.add(mc, transferRelCarts[j], new Cesium.Cartesian3());
        pts.push(w);
        ghostCarts.push(w);
      }
      for (let i = 0; i <= k; i++) pts.push(ringCarts[i]);
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
    for (const c of cores) {
      earthViewer.entities.remove(c.ent);
      destroySlot(c.slot);
    }
    boosters = [];
    fairings = [];
    cores = [];
    sepCam = null;
  }

  /** ⭐ 只销毁某一类分离件（2026-10-23：四个分离事件并存，整清会误伤未结束的其它类） */
  function dropSep(kind) {
    let list = null;
    if (kind === 'booster') list = boosters;
    else if (kind === 'fairing') list = fairings;
    else list = cores;
    const keep = [];
    for (const it of list) {
      const same = kind === 'core' || kind === 'stage2' ? it.kind === kind : true;
      if (!same) { keep.push(it); continue; }
      earthViewer.entities.remove(it.ent);
      destroySlot(it.slot);
    }
    if (kind === 'booster') boosters = keep;
    else if (kind === 'fairing') fairings = keep;
    else cores = keep;
    if (!boosters.length && !fairings.length && !cores.length) sepCam = null;
  }

  function spawnSeparators(kind) {
    const sepP = kind === 'booster' ? BOOSTER_SEP : kind === 'core' ? CORE_SEP
      : kind === 'stage2' ? STAGE2_SEP : FAIRING_SEP;
    const base = rocketPosAt(sepP);
    const baseCart = Cesium.Cartesian3.fromDegrees(base[0], base[1], base[2]);
    // ⚠ flightDirENU 返回共享临时量 _dir：多次 spawn 会互相覆盖（旧的分离件飞行方向被改写），
    //   这里统一克隆一份存进分离件。
    const fdir = Cesium.Cartesian3.clone(flightDirENU(sepP), new Cesium.Cartesian3());   // ENU 切向
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
    } else if (kind === 'fairing') {
      // ⭐ 2026-10-24 用户「抛整流罩也应该沿轨道径向飞走，而不是径向垂直地面」：
      //   两瓣半壳的正交基——① 纵轴 fdir（沿飞行方向，锥尖朝前）；② side（水平侧向，
      //   = fdir×ẑ）；③ upF（= side×fdir，在含 fdir 与天顶的平面内且⊥fdir，取向上为正）。
      //   姿态基准 = 机头/锥尖沿 fdir（与芯级、二级同源），翻滚轴取 fdir 自身
      //   （绕自身纵轴滚转 = 半壳外翻的观感），位移只在 (fdir, side, upF) 三方向展开，
      //   彻底不再用 ENU 天顶的重力抛物（旧 fall 项才是「垂直坠地」的来源）。
      const upF = Cesium.Cartesian3.cross(side, fdir, new Cesium.Cartesian3());
      Cesium.Cartesian3.normalize(upF, upF);
      const baseQ = Cesium.Quaternion.clone(quatUpTo(fdir, _q), new Cesium.Quaternion());
      for (const d of [-1, 1]) {
        fairings.push({
          dir: d, base, baseCart, fdir, side, upF, baseQ,
          axis: Cesium.Cartesian3.clone(fdir, new Cesium.Cartesian3()),   // 绕自身纵轴滚转（半壳外翻）
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
    } else {
      // ② 主助推器（芯一级）/ ④ 二级：整个级翻滚下坠脱离
      //   core = 芯一级（较大、翻滚快）；stage2 = 二级（较小、翻滚慢）(2026-10-23 时序重排)
      const isCore = kind === 'core';
      const dSlot = loadSlot(isCore ? 'rocketCore' : 'rocketUpper', earthViewerRef);
      // ⭐ 2026-10-23 末用户「分离的箭应该沿轨道飞走，而不是径向垂直地面」：
      //   旧版姿态从**单位四元数**起步 = 模型 +Y(机头) 朝 ENU 天顶 → 分离瞬间箭体竖直站立、
      //   再叠翻滚 → 观感就是「一根竖直的圆筒径向掉下去」。改：姿态基准 = 机头沿飞行方向
      //   （quatUpTo 把 ENU 天顶旋到 fdir；模型 +Y 即机头），翻滚轴取**水平侧向 side**
      //   （垂直于轨道）→ 箭体始终躺在大圆切平面内、绕轨道侧向端-over-end 缓翻，不朝地。
      const baseQ = Cesium.Quaternion.clone(quatUpTo(fdir, _q), new Cesium.Quaternion());
      // 「整流罩」节点的隐藏改到 updateSeparators 每帧执行：模型异步加载，spawn 时的
      // 一次性 setNodeShow 会抢在 model ready 之前成为空操作（2026-10-23）。
      cores.push({
        kind, base, baseCart, fdir, side, baseQ,
        axis: Cesium.Cartesian3.clone(side, new Cesium.Cartesian3()),   // 绕水平侧向翻滚（轨道面内端-over-end）
        spinRate: isCore ? 0.30 : 0.18,    // 翻滚速率 rad/s（飞行方向为基准，慢翻即可读）
        slot: dSlot,
        ent: earthViewer.entities.add({
          position: baseCart,
          billboard: {
            image: STAGE1_ICON,   // 二级沿用芯级图标，靠尺寸(30/24)与翻滚速率区分
            width: isCore ? 30 : 24, height: isCore ? 30 : 24, rotation: 0,
            alignedAxis: Cesium.Cartesian3.UNIT_Z,
            heightReference: Cesium.HeightReference.NONE,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        }),
      });
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
    /** 分离件存活 s 秒对应的进度窗口（用于 spawn 触发条件，避免越界后仍反复重建） */
    const sepWin = (secs) => secs * ACT_RATE.act1 / D;
    // ⭐ 回拖清理（2026-10-23「轨道线/分离件残影」同源问题）：拖到分离时刻之前时，
    //   正在飘的分离件不会因为 dt<0 而消失（旧逻辑 dt<0 直接跳过）→ 卡在画面上不动。
    if (p < BOOSTER_SEP && boosters.length) dropSep('booster');
    if (p < FAIRING_SEP && fairings.length) dropSep('fairing');
    if (p < CORE_SEP && cores.some((c) => c.kind === 'core')) dropSep('core');
    if (p < STAGE2_SEP && cores.some((c) => c.kind === 'stage2')) dropSep('stage2');
    // 助推器（生命期 6.5 s：须在下一次分离 core 0.0898 之前结束，避免两组同屏抢镜）
    if (p >= BOOSTER_SEP && boosters.length === 0 && p < BOOSTER_SEP + sepWin(6.5)) {
      spawnSeparators('booster');
    }
    if (boosters.length) {
      // 墙钟秒数：p 的推进已被 ACT_RATE 慢放，换算回真实秒要除以倍率（分离动效保持原速度）
      const dt = (p - BOOSTER_SEP) * D / ACT_RATE.act1;
      if (dt > 6.5) {
        dropSep('booster');
      } else if (dt >= 0) {
        for (const b of boosters) {
          // 四散弹开 + 下漂 + 重力抛物；翻滚 ~0.36 rad/s（8s≈0.46 圈）
          // ⚠ 2026-10-19 用户反馈「助推器分离散得不够开」：旧参数共同平移（drift 前移 + fall 下坠）
          //   过大 → 四枚质心远离火箭 → focusSeparators 的 range 被撑大 → 四枚挤在画面中心一小块，
          //   四枚间横向/上下差异（eject）占比过小 → 看着不散。修复：压低共同平移（drift/fall），
          //   同时大幅增大四枚间弹开差异（eject 基础 + 侧向/上下系数），让四散真正铺开、仍同框。
          // ⚠ 2026-10-19 用户反馈「助推器和整流罩再散开些」：在上轮基础上再增大四枚间差异、
          //   并同步压共同平移；focusSeparators range 系数 3.5→4.2 给竖直余量（防向下枚出底边）。
          const drift = 800 * dt;              // 沿飞行方向共同前移（压低，避免撑大 range）
          const eject = 360 * dt;              // 四枚间弹开基础（横向/上下差异）
          const fall = 0.5 * 220 * dt * dt;    // 共同下坠（固定机位下直接体现为屏幕下坠）
          const cart = offsetENU(
            b.baseCart,
            b.fdir.x * drift + b.side.x * b.sgnSide * eject * 2.4,
            b.fdir.y * drift + b.side.y * b.sgnSide * eject * 2.4,
            b.fdir.z * drift + b.sgnUp * eject * 1.5 - fall,
            new Cesium.Cartesian3());
          b.ent.position = cart;
          if (attachIfReady(b.slot)) {
            b.ent.billboard.show = false;
            placeModel(b.slot, cart, tumbleQuat(b.axis, b.spin * 0.36 * dt, _q), Cesium.Ellipsoid.WGS84);
          } else {
            b.ent.billboard.rotation = b.spin * 0.36 * dt;
          }
        }
        setPhase('第一幕 · 四枚次级助推器分离');
      }
    }
    // 整流罩（生命期 5 s：须在 stage2 0.1451 之前结束）
    if (p >= FAIRING_SEP && fairings.length === 0 && p < FAIRING_SEP + sepWin(5)) {
      spawnSeparators('fairing');
    }
    if (fairings.length) {
      const dt = (p - FAIRING_SEP) * D / ACT_RATE.act1;
      if (dt > 5) {
        dropSep('fairing');
      } else if (dt >= 0) {
        for (const f of fairings) {
          // ⭐ 2026-10-24「抛整流罩沿轨道径向飞走」：位移全部在自身正交基 (fdir, side, upF) 内——
          //   ① 沿 fdir 与母体同向前飞（不是掉下去）；② 沿 ±side 横向张开（锥壳横截面径向）；
          //   ③ 沿 +upF 少量外翻（⊥飞行方向、在轨道面法内），模拟绕铰链张开的蚌壳。
          //   旧实现第③项是 ENU 天顶的 **−190·dt²/2 重力抛物**，那才是「径向垂直地面」的真因。
          // ⚠ 2026-10-19 用户反馈「助推器和整流罩再散开些」：旧参数同助推器老问题——共同平移
          //   (drift/fall) 过大、两瓣侧向差(eject)过小 → 两瓣几乎不分。这里保持大侧向差。
          const drift = 620 * dt;
          const eject = 430 * dt;
          const open = 0.5 * 120 * dt * dt;      // ⊥飞行方向的外翻（二次项，开口越来越大）
          const cart = offsetENU(
            f.baseCart,
            f.fdir.x * drift + f.side.x * f.dir * eject + f.upF.x * open,
            f.fdir.y * drift + f.side.y * f.dir * eject + f.upF.y * open,
            f.fdir.z * drift + f.side.z * f.dir * eject + f.upF.z * open,
            new Cesium.Cartesian3());
          f.ent.position = cart;
          if (attachIfReady(f.slot)) {
            f.ent.billboard.show = false;
            // 姿态 = 滚转(绕自身纵轴) ∘ 基准(锥尖沿飞行方向)
            const tq = tumbleQuat(f.axis, f.dir * 0.22 * dt, _qt);
            Cesium.Quaternion.multiply(tq, f.baseQ || Cesium.Quaternion.IDENTITY, _q);
            placeModel(f.slot, cart, _q, Cesium.Ellipsoid.WGS84);
          } else {
            f.ent.billboard.rotation = f.dir * 0.22 * dt;
          }
        }
        setPhase('第一幕 · 抛整流罩');
      }
    }
    // ② 主助推器（芯一级）分离 + ④ 星箭分离（二级脱离）
    if (p >= CORE_SEP && !cores.some((c) => c.kind === 'core') && p < CORE_SEP + sepWin(6.5)) {
      spawnSeparators('core');
    }
    if (p >= STAGE2_SEP && !cores.some((c) => c.kind === 'stage2') && p < STAGE2_SEP + sepWin(5.5)) {
      spawnSeparators('stage2');
    }
    if (cores.length) {
      for (const c of cores) {
        const t0 = c.kind === 'core' ? CORE_SEP : STAGE2_SEP;
        const life = c.kind === 'core' ? 6.5 : 5.5;
        const dt = (p - t0) * D / ACT_RATE.act1;
        if (dt > life) { dropSep(c.kind); break; }
        if (dt < 0) continue;
        // 分离的级：沿飞行反方向（**轨道切线**）后退，远离继续上升的上面级。
        // ⭐ 2026-10-23 末用户：二级要「沿轨道飞走」而不是「径向垂直地面」→
        //   ① 位移只保留**切向**分量：把 −fdir 去掉径向（Up）分量后再乘 drift；
        //   ② sink（径向下沉）归零（芯一级低空分离，保留极少量以体现再入下坠）。
        const upC = c.fdir.z;                                            // 飞行方向的径向分量
        const tx = c.fdir.x, ty = c.fdir.y, tz = c.fdir.z - upC;          // 纯水平（轨道切向）
        const drift = (c.kind === 'core' ? 360 : 380) * dt;              // 沿轨道切向后退
        const sink  = (c.kind === 'core' ? 14 : 0) * dt;                 // 径向分量（二级为 0）
        const cart = offsetENU(
          c.baseCart,
          -tx * drift, -ty * drift, -tz * drift - sink,
          new Cesium.Cartesian3());
        c.ent.position = cart;
        if (attachIfReady(c.slot)) {
          c.ent.billboard.show = false;
          // 下坠件一律去掉整流罩（2026-10-23 用户反馈「分离的助推器带着整流罩，不可能」）：
          //   芯一级下坠时整流罩还罩在二级上——它属于继续飞的上面级，下坠件只是下半截；
          //   二级下坠时整流罩更早已抛掉。每帧执行以覆盖模型异步加载晚于 spawn 的情况。
          setNodeShow(c.slot, '整流罩', false);
          // 姿态 = 翻滚(绕水平侧轴) ∘ 基准(机头沿飞行方向)：箭体躺在轨道面内翻滚，不朝地。
          const tq = tumbleQuat(c.axis, (c.spinRate || 0.26) * dt, _qt);
          Cesium.Quaternion.multiply(tq, c.baseQ || Cesium.Quaternion.IDENTITY, _q);
          placeModel(c.slot, cart, _q, Cesium.Ellipsoid.WGS84);
        } else {
          c.ent.billboard.rotation = (c.spinRate || 0.26) * dt;
        }
      }
      // 相位文字：后发生的事件优先（星箭分离 > 芯一级分离）
      if (cores.some((c) => c.kind === 'stage2')) setPhase('第一幕 · 星箭分离（二级脱离）');
      else if (cores.some((c) => c.kind === 'core')) setPhase('第一幕 · 主助推器分离（芯一级）');
    }
  }


  // ---- 月球场景（第三幕）----
  function clearMoonEntities() {
    const mv = env.getMoonViewer();
    if (mv) {
      if (moonRing) { mv.entities.remove(moonRing); moonRing = null; }
      if (moonBrakeEllipse) { mv.entities.remove(moonBrakeEllipse); moonBrakeEllipse = null; }
      brakeGeom = null;
      if (_burnPsMap.has(mv)) { _burnPsMap.delete(mv); }   // 粒子系统随 viewer 销毁，移出缓存
      if (moonCraft) { mv.entities.remove(moonCraft); moonCraft = null; }
      if (descentArcEnt) { mv.entities.remove(descentArcEnt); descentArcEnt = null; }
      if (loiTrailEnt) { mv.entities.remove(loiTrailEnt); loiTrailEnt = null; }
      loiTrailCarts = [];
      if (roverTrackEnt) { mv.entities.remove(roverTrackEnt); roverTrackEnt = null; }
      roverTrackCarts = [];
      if (landDustEnt) { mv.entities.remove(landDustEnt); landDustEnt = null; }
      if (landerPanelL) { mv.entities.remove(landerPanelL); landerPanelL = null; }
      if (landerPanelR) { mv.entities.remove(landerPanelR); landerPanelR = null; }
      if (_dustPsMap.has(mv)) { _dustPsMap.delete(mv); }   // 月尘粒子随 viewer 销毁，移出缓存
      try { mv.camera.lookAtTransform(Cesium.Matrix4.IDENTITY); } catch { /* 忽略 */ }
    }
  }

  // LOI 制动椭圆几何（2026-10-22 用户定稿）：site.lon 子午面内的**完整椭圆**——
  // 远月点 800 km（λa = site.lat-120，承接上一幕捕获段）、近月点 100 km（λp = λa+180，
  // 过北极后的背面），焦点 = 月心。近月点处与 100 km 环月目标圆**相切**（同点同高同向）
  // —— 卫星沿椭圆滑行至此反向点火圆化。参数化：θ=0 在远月点，θ=π 在近月点。
  // 椭圆基：dA = 远月点方向（子午面内），dP = 面内垂直轴（λ+90° 方向）；b=√(ra·rp)（焦点在月心）。
  function makeBrakeEllipse(site) {
    const R = MOON_ELLIPSOID.maximumRadius;
    const ra = R + 800000, rp = R + 100000;
    const a = (ra + rp) / 2, b = Math.sqrt(ra * rp), c = (ra - rp) / 2;
    const lonR = Cesium.Math.toRadians(site.lon);
    const Lx = Math.cos(lonR), Ly = Math.sin(lonR);   // 子午面内：指向 site.lon 的赤道单位向量
    const laR = Cesium.Math.toRadians(site.lat - 120);
    const ca = Math.cos(laR), sa = Math.sin(laR);
    const posAt = (th, out) => {
      const k = c + a * Math.cos(th), m = b * Math.sin(th);
      if (!out) out = new Cesium.Cartesian3();
      out.x = (k * ca - m * sa) * Lx;
      out.y = (k * ca - m * sa) * Ly;
      out.z = k * sa + m * ca;
      return out;
    };
    const carts = [];
    for (let i = 0; i <= 256; i++) carts.push(posAt((i / 256) * Cesium.Math.TWO_PI));
    return { posAt, carts };
  }

  // 100 km 环月目标圆参数化（与 moonRing 同一参数化：f=0 → lat=-90，f 每前进 1/360 = 沿大圆 1°；
  // lat>90 翻到对跖经线 lon+180）。制动段点火缓移与巡航段绕飞共用。
  function circleLL(site, frac) {
    const la = -90 + (((frac % 1) + 1) % 1) * 360;
    return [la > 90 ? wrapLon(site.lon + 180) : site.lon, la > 90 ? 180 - la : la, 100000];
  }
  function circlePosAt(site, frac) {
    const ll = circleLL(site, frac);
    return Cesium.Cartesian3.fromDegrees(ll[0], ll[1], ll[2], MOON_ELLIPSOID);
  }

  /**
   * ⭐ 2026-10-30：底部时间轴（#tourPanel）是单例，历史巡礼 / 路线巡礼 / 天宫 / 探月共用。
   *   切到月球容器时 main 的 enterMoonMode 会 releasePanels() —— 历史巡礼的收尾（hideEraPanel）
   *   会把面板整块 hidden、并清空 #tourTicks，于是「第三幕一开始时间轴不见了」。
   *   探月自己接管时必须把面板取回来、并把幕节点补画上（防御性：任何第三方收尾都能自愈）。
   */
  function ensureTourPanelOwned() {
    const tp = $('tourPanel');
    if (tp) tp.classList.remove('hidden');
    const tw = $('tourTicks');
    if (tw && !tw.children.length) buildTicks();
  }

  function ensureMoonScene() {
    if (inMoon && moonCraft) return;
    const mv = env.showMoon();
    ensureTourPanelOwned();     // 面板可能被 releasePanels 的第三方收尾带走，取回来
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
        // 前半圈（朝向相机，看得见）：实线亮蓝。
        material: Cesium.Color.fromCssColorString('#7fc4ff'),
        // 后半圈（被月球球体遮住）：虚线幽灵（低透明），与代码里其他环同款（rocket.js:1570 等）。
        // ⚠ depthFail 生效前提 = moon viewer 的 globe.depthTestAgainstTerrain=true（lunar.js:254 已设），
        //   旧版用 0.35 纯色蓝叠在亮月面上仍像实线 → 改虚线低透明，被遮挡段一眼读出「在月球背面」。
        depthFailMaterial: new Cesium.PolylineDashMaterialProperty({
          color: Cesium.Color.fromCssColorString('#7fc4ff').withAlpha(0.16),
          dashLength: 14,
        }),
        arcType: Cesium.ArcType.NONE,
      },
    });

    // LOI 制动椭圆（2026-10-22 用户定稿）：**完整椭圆弧**，黄色 #ffd24a（延续上一幕捕获
    // 椭圆用色），同一子午面，远月点 800km → 近月点 100km；近月点与下方 100km 蓝色目标环
    // **相切** —— 卫星沿椭圆滑行至切点反向点火圆化。蓝色 100km 目标环不变。
    brakeGeom = makeBrakeEllipse(site);
    moonBrakeEllipse = mv.entities.add({
      id: 'moonBrakeEllipse',
      polyline: {
        positions: brakeGeom.carts,
        width: 2,
        material: Cesium.Color.fromCssColorString('#ffd24a').withAlpha(0.85),
        depthFailMaterial: new Cesium.PolylineDashMaterialProperty({
          color: Cesium.Color.fromCssColorString('#ffd24a').withAlpha(0.22),
          dashLength: 12,
        }),
        arcType: Cesium.ArcType.NONE,
      },
    });

    // 动力下降段计划弧（与 LOI/环月同一子午线大圆，2026-10-18 定稿）：自环月 100 km
    // （着陆点**以北** 40°，2026-10-24 改：配合逆行巡航，向南滑向着陆点）沿大圆，高度按 descentProfile 真实下滑线。
    if (!descentArcEnt) {
      const arc = [];
      for (let i = 0; i <= 48; i++) {
        const u = i / 48;
        arc.push(site.lon, site.lat + lerp(40, 0, u), descentProfile(u).alt);
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

    // 着陆器两翼太阳能板（着陆后机械展开）：box 实体，ENU 定向，随展开进度从竖立(折叠)
    //   绕北向铰链转平(展开)；初始 show=false，动力下降段隐藏，玉兔段(着陆后)驱动展开。
    if (!landerPanelL || !landerPanelR) {
      const mkPanel = (idSuffix, faceColor) => mv.entities.add({
        id: 'moonLanderPanel' + idSuffix,
        position: Cesium.Cartesian3.fromDegrees(site.lon, site.lat, 2.2, MOON_ELLIPSOID),
        orientation: Cesium.Quaternion.IDENTITY,
        box: {
          dimensions: new Cesium.Cartesian3(3.8, 0.06, 2.0),
          material: Cesium.Color.fromCssColorString(faceColor).withAlpha(0.92),
        },
        show: false,
      });
      landerPanelL = mkPanel('L', '#1b2a55');
      landerPanelR = mkPanel('R', '#1b2a55');
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

  // ⭐ 2026-10-24 幕卡瘦身（用户「太大了…内容不够精简」）：
  //   旧版把 "标题\n「一长串正文」" 直接塞进 textContent —— CSS 默认 white-space:normal，
  //   换行符被折叠成空格 → 整段挤成**一整行**，撑到画面边缘。现拆为标题 + 副行两级排版，
  //   且正文按 padd 后 max-width 折行、不再横向溢出。
  function showCard(text) {
    const c = $('actCard');
    if (!c) return;
    const el = $('actCardText');
    if (!el) return;
    const parts = String(text).split('\n');
    el.innerHTML = '';
    const h = document.createElement('div');
    h.className = 'act-card-title';
    h.textContent = (parts[0] || '').trim();
    el.appendChild(h);
    const sub = (parts.slice(1).join(' ') || '').trim().replace(/^「|」$/g, '');
    if (sub) {
      const d = document.createElement('div');
      d.className = 'act-card-sub';
      d.textContent = sub;
      el.appendChild(d);
    }
    c.classList.remove('hidden');
    c.classList.add('show');
  }
  function hideCard() {
    const c = $('actCard');
    if (!c) return;
    c.classList.remove('show');
    c.classList.add('hidden');
  }
  // ⭐ 2026-10-23 两行布局：相位文字改写入解说行第 1 行的 #snTag（原 #rocketPhase 徽章停用，
  //   避免与 #snTitle 重复）。解说整体显隐由 showNarration/hideNarration 控制。
  function setPhase(text) {
    const el = $('snTag');
    if (el) el.textContent = text || '';
    const n = PHASE_NOTES[text];       // 相位串 → 解说词（第三/四幕）
    if (n) { setNarration(n[0], n[1], n[4], n[2], n[3]); showNarration(false); }
  }
  /** 显示解说行（第 1 行）。tele=true 时同时展开第二幕遥测 7 项。
   *  ⚠ 同时收起 .tour-head（那个「探月任务」标题行）——否则底部会出现 3 行，
   *    与用户要的「时间轴两行」不符；解说行标题已承担阶段标识。 */
  function showNarration(tele) {
    $('stageNarration')?.classList.remove('hidden');
    $('snTele')?.classList.toggle('hidden', !tele);
    document.querySelector('.tour-head')?.classList.add('hidden');
  }
  function hideNarration() {
    $('stageNarration')?.classList.add('hidden');
    document.querySelector('.tour-head')?.classList.remove('hidden');
  }
  /** 写入解说内容。传 idx/title/text/a/b；省略的字段置空 */
  function setNarration(idx, title, text, a, b) {
    const $s = (id, v) => { const e = $(id); if (e) e.innerHTML = v || ''; };
    $s('snIdx', idx); $s('snTitle', title); $s('snText', text);
    $s('snA', a); $s('snB', b);
  }

  // ⭐ 分阶段解说词库（2026-10-23）：编号 = 「幕序-段序」，与底部第 1 行一一对应。
  //   第一幕按进度 p 直接驱动（分离件存在与否不能代表阶段，见 updateAct1Narration）；
  //   第三/四幕由 setPhase 的相位串查表驱动。
  const A1_NOTES = [
    { t: 0, idx: '1-1', title: '点火升空', a: '起飞 869 t', b: '10 台发动机',
      text: '长征五号在文昌点火，<b>4 枚捆绑助推器 + 芯一级</b>同时工作，垂直起飞后程序转弯。' },
    { t: BOOSTER_SEP, idx: '1-2', title: '四枚次级助推器分离', a: 'T+ 173 s', b: 'h ≈ 60 km',
      text: '助推器燃料耗尽后向两侧<b>扇形弹开</b>，芯一级继续把火箭送出稠密大气。' },
    { t: CORE_SEP, idx: '1-3', title: '主助推器分离（芯一级）', a: 'T+ 200 s', b: 'h ≈ 90 km',
      text: '<b>芯一级</b>翻滚脱离下坠，二级发动机接力点火，推力接续不中断。' },
    { t: FAIRING_SEP, idx: '1-4', title: '抛整流罩', a: 'T+ 220 s', b: 'h ≈ 120 km',
      text: '大气已稀薄，两瓣整流罩左右抛离；嫦娥一号露出，<b>太阳能帆板仍收拢</b>。' },
    { t: STAGE2_SEP, idx: '1-5', title: '星箭分离', a: 'h ≈ 200 km', b: 'v ≈ 7.8 km/s',
      text: '二级关机后与卫星分离，卫星独立飞行，帆板保持收拢等待入轨指令。' },
    { t: PANEL_FROM, idx: '1-6', title: '太阳能帆板展开', a: 'v = 7.786 km/s', b: 'T = 88.4 min',
      text: '双翼平铺、对日定向，卫星进入 <b>205 km 停泊轨道</b>，等待调相点火窗口。' },
  ];
  function updateAct1Narration(pp) {
    let cur = A1_NOTES[0];
    for (const n of A1_NOTES) if (pp >= n.t) cur = n;
    setNarration(cur.idx, cur.title, cur.text, cur.a, cur.b);
    showNarration(false);
  }

  const PHASE_NOTES = {
    '第三幕 · 环月制动（LOI）': ['3-1', '环月制动（LOI）', 'Δv ≈ 0.8 km/s', '12 h 椭圆',
      '进入月球引力主导区后，在近月点<b>逆行点火</b>，把接近双曲线压成绕月椭圆。'],
    '第三幕 · 近月点制动': ['3-2', '近月点制动', '制动 2', '3.5 h 椭圆',
      '在近月点再次制动，进一步压低远月点，轨道逐步圆化。'],
    '第三幕 · 环月滑行巡航': ['3-3', '环月滑行巡航', 'h = 100 km', 'v = 1.59 km/s',
      '在 <b>100 km 圆轨道</b>上绕飞，对着陆区成像、测定轨。'],
    '第三幕 · 离轨制动': ['3-4', '离轨制动', 'Δv ≈ 20 m/s', 'perilune ≈ 0',
      '逆行点火把圆轨道压成近月点贴近月面的转移椭圆，开始着陆程序。'],
    '第三幕 · 环月转移滑行': ['3-5', '转移椭圆滑行', '发动机关机', '惯性飞行',
      '关机后靠惯性滑行，沿椭圆飞向着陆点上空。'],
    '第三幕 · 动力下降': ['3-6', '动力下降', 'v 1.7 → 0 km/s', 'h 100 → 0 km',
      '主发动机反推减速，末段悬停避障，随后<b>软着陆</b>月面。'],
    '第三幕 · 月面着陆完成': ['3-7', '月面着陆完成', '着陆点 雨海', 'h = 0',
      '着陆成功，随后着陆器<b>双翼展开</b>供电，为玉兔号巡视做准备。'],
    '第四幕 · 玉兔驶出巡视': ['4-1', '玉兔驶出巡视', '行程 ≈ 240 m', '六轮贴地',
      '着陆器太阳能翼展开供电，玉兔号沿缓弯弧线驶离着陆器，开展月面巡视。'],
    '第四幕 · 巡视完成': ['4-2', '巡视完成', '行程 240 m', '任务结束',
      '玉兔号完成既定巡视路线，嫦娥一号任务全程结束。'],
  };

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
  let _act2Cam = { rangeKm: 0, targetMagKm: 0, halfKm: 0, dRelayKm: null, relayVis: false };

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
    applyCameraPose(earthViewer, camPos, dir, TR.e2, rangeKm * 1000);
    // 冒烟诊断：暴露本次取景（直接断言「轨道在画面内」，比像素扫描更能定位问题）
    _act2Cam.rangeKm = rangeKm;
    _act2Cam.targetMagKm = Cesium.Cartesian3.magnitude(tgt) / 1000;
  }

  // 画中画定位（2026-10-21 用户反馈 #88「不要遮住地球」）：把地球（地心原点）投影到屏幕，
  // 画中画放到其**对顶角**角落——地球在左上就放右下，反之亦然。地球在画面正中（转移段）时
  // 落到右下角，也避开中央主体；捕获段地球偏一侧时自动让到另一侧。
  // 2026-10-19 用户反馈「地球轨道加速时先放左上」：地月段（调相末 TLI 顺行加速 + 奔月转移，
  //   p < transferEnd）画中画强制左上角——此时主视图主体是地球轨道加速过程，左上不挡视线；
  //   捕获段（p ≥ card2End）起恢复对顶角逻辑（月球在中央，按地球屏幕位置让角）。
  function positionPip(p) {
    const pip = $('moonPip');
    if (!pip) return;
    const sc = earthViewer.scene;
    const W = sc.canvas.clientWidth || sc.canvas.width || 1;
    const H = sc.canvas.clientHeight || sc.canvas.height || 1;
    const scr = sc.cartesianToCanvasCoordinates(Cesium.Cartesian3.ZERO, new Cesium.Cartesian2());
    let right = true, bottom = true, topPx = 16;
    if (p !== undefined && p < T.act2End) {
      right = false; bottom = false;           // 地月加速段：固定左上
      // 2026-10-24：#coordWidget 已从「页面左上浮层」整体移入**左侧栏顶部**（sticky 固定），
      //   不再压在画布上 → 画中画无需再为它让位，固定 top:16 即可。
      //   （旧逻辑动态测其底边下移，2026-10-19 用户反馈「画中画被左上角坐标框遮住」的遗留。）
    } else if (scr) {                // 对顶角：地球在左→画中画在右，地球在上→画中画在下
      right = !(scr.x < W / 2);
      bottom = !(scr.y < H / 2);
    }
    _pip.corner = (right ? 'right' : 'left') + '-' + (bottom ? 'bottom' : 'top');
    pip.style.left = pip.style.top = pip.style.right = pip.style.bottom = 'auto';
    pip.style[right ? 'right' : 'left'] = '16px';
    pip.style[bottom ? 'bottom' : 'top'] = topPx + 'px';
  }

  // —— 月球视觉倍率 LOD 的驱动点 ——
  // _moonExagNow 是「当前实际生效的倍率」：月球实体半径与标签的 CallbackProperty 读它，
  // 环月轨道环也按它缩放（折线 CallbackProperty 内检测倍率变化即重建，月系整体等比）。
  // 幕卡 2 可传 exagOverride 做 ×3 → ×1 平滑下降。
  let _moonExagNow = MOON_EXAG_FAR;
  function setMoonExag(ex) {
    if (Math.abs(ex - _moonExagNow) < 0.02) return;
    _moonExagNow = ex;
  }
  /** 月球沿轨道同步移动 + 地月虚直线刷新 + 环月轨道按当前视觉倍率重建 */
  // ====== changE1 引擎 ↔ 3D 场景桥接（2026-10-22 第二幕合并） ======
  // 引擎解的是**轨道平面内 2D 状态**，这里统一映射到世界 Cartesian3(m)：
  //   位置 = px·TR.e1 + py·TR.e2（km → m），ν 自 TR.e1 起、绕 TR.nrm 转向 TR.e2（与既有约定一致）。
  // ⚠ 全部用**局部 Cartesian3**，绝不回读 entity.position（会被包装成 Property → NaN）。
  const _ceTmp = new Cesium.Cartesian3();
  const _ceM4 = new Cesium.Matrix4();
  const _ceV3 = [new Cesium.Cartesian3(), new Cesium.Cartesian3(), new Cesium.Cartesian3()];

  /** 平面坐标(km) → 世界 Cartesian3(m) */
  function planeCart(xKm, yKm, out) {
    const o = out || new Cesium.Cartesian3();
    Cesium.Cartesian3.multiplyByScalar(TR.e1, xKm * 1000, o);
    Cesium.Cartesian3.multiplyByScalar(TR.e2, yKm * 1000, _ceTmp);
    return Cesium.Cartesian3.add(o, _ceTmp, o);
  }
  /** 月球方向单位向量：轨道面内自 TR.e1 起、绕 TR.nrm 转 ang */
  function moonDirCE1(ang, out) {
    const o = out || new Cesium.Cartesian3();
    Cesium.Quaternion.fromAxisAngle(TR.nrm, ang, _q);
    Cesium.Matrix3.fromQuaternion(_q, _m3t);
    return Cesium.Matrix3.multiplyByVector(_m3t, TR.e1, o);
  }
  /** 月心世界坐标（真实地月距 D_M） */
  function moonCartCE1(ang, out) {
    const o = out || new Cesium.Cartesian3();
    moonDirCE1(ang, o);
    return Cesium.Cartesian3.multiplyByScalar(o, CE1.D_M * 1000, o);
  }
  /** 第二幕的月球 + 地月连线：全程**真实比例 ×1**（参考项目即真实尺度，不放大） */
  function updateMoonCE1(st, mc) {
    const m = mc || moonCartCE1(st.thetaMoon);
    moonEnt.position = m;
    emLineCarts = [new Cesium.Cartesian3(0, 0, 0), m];
    if (emLineEnt) {
      emLineEnt.position = Cesium.Cartesian3.multiplyByScalar(m, 0.42, new Cesium.Cartesian3());
    }
    setMoonExag(MOON_EXAG_NEAR);
    return m;
  }
  /** 引擎速度（平面 km/s）→ 该点的 ENU 分量（供 orientLvLH 做 LVLH 三轴姿态） */
  function ce1DirENU(st, cart, out) {
    let vx = st.vel[0], vy = st.vel[1];
    if (st.frame === 'm') {          // 制动段 st.vel 是月心系相对速度 → 补上月球公转得地心速度
      vx += -CE1.V_MOON * Math.sin(st.thetaMoon);
      vy += CE1.V_MOON * Math.cos(st.thetaMoon);
    }
    const w = planeCart(vx, vy, _ceV3[0]);
    Cesium.Cartesian3.normalize(w, w);
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(cart, Cesium.Ellipsoid.WGS84, _ceM4);
    const E = Cesium.Matrix4.getColumn(enu, 0, _ceV3[1]);
    const N = Cesium.Matrix4.getColumn(enu, 1, _ceV3[2]);
    const U = Cesium.Matrix4.getColumn(enu, 2, _ceTmp);
    out.x = Cesium.Cartesian3.dot(w, E);
    out.y = Cesium.Cartesian3.dot(w, N);
    out.z = Cesium.Cartesian3.dot(w, U);
    return Cesium.Cartesian3.normalize(out, out);
  }

  // ---- 鹊桥中继星 · 地月 L2 晕轨道（2026-10-24 用户新增）----
  // 物理参数：地月质量比 μ = M_月/(M_地+M_月) = 0.01215 → 月心到 L2 的距离
  //   r ≈ D_M·(μ/3)^(1/3) ≈ 61,500 km（月球背地一侧）。真实任务里**鹊桥**（嫦娥四号中继星）
  //   运行在 L2 附近的 **Halo 轨道**：周期约 14 天、南/北振幅约 13,000 km，始终能同时
  //   「看到」地球与月球背面 —— 这是月背通信的唯一中继手段。
  // ⚠ 绘制口径：Halo 是**旋转坐标系**里的周期解，在地球惯性系里会随月球公转整体漂移。
  //   这里画**当前时刻**月位下的整圈 Halo（θ 遍历 0..2π、月位取当前），即教科书上那张图；
  //   中继星按 14 天周期在同一条曲线上推进 → 星与轨道严格同源，不会「星不在线上」。
  const RELAY = {
    distKm: CE1.D_M * Math.cbrt(0.0121505 / 3),   // 月心→L2 ≈ 61,500 km
    periodSec: 14.0 * 86400,                       // Halo 周期（真实≈14 d）
    // ⚠ 2026-10-24 修「鹊桥中继星看着不动」：原振幅 ±9~13k km 相对 400k km 级取景太小、
    //   且相机跟着月球走 → 中继星恒在月背 L2、相对画面几乎静止。放大到 ±22~30k km 量级，
    //   转移/滑行段（≈5 d ≈ 124°）能清楚看到它沿晕轨道绕行；period 仍 14 d（真实量级）。
    ax: 22.0e3,    // 沿月心→L2 径向的振幅（km）
    az: 30.0e3,    // 垂直黄道面方向的振幅（km）
    ay: 14.0e3,    // 轨道面侧向振幅（km，做出真正的三维「晕」）
    N: 120,        // 整圈采样点数
    fromKey: 'trans',   // 自本段起显示（进入地月转移后，L2 才进入取景）
  };
  const _relR = new Cesium.Cartesian3(), _relT = new Cesium.Cartesian3();
  const _relS = new Cesium.Cartesian3(), _relL = new Cesium.Cartesian3();
  const _relayPos = new Cesium.Cartesian3();
  const _relayRing = [];
  const _relayFrame = new Cesium.Cartesian3();   // applyCE1Cam 取景判定用（不与 _relayPos 别名）
  const _relayLink = [new Cesium.Cartesian3(), new Cesium.Cartesian3()];
  let relayEnt = null, relayOrbEnt = null, relayLinkEnt = null, relayTrailEnt = null;
  // ⭐ 2026-10-24 用户「给鹊桥也增加一个相对地月系的轨道行进描绘」：已飞过的中继星轨迹
  //   （地心系绝对坐标 = 相对地月系的行进路径）。与 ceTrail 同源用**星历回填**（固定步长），
  //   密度只由步长定、与帧率/拖拽/取景解耦；回拖时按 t 截断。
  const RELAY_TRAIL_DT = 0.02, RELAY_TRAIL_MAX = 6000;
  let _relayTrail = [], relayTrailCarts = [];

  /** L2 晕轨道上参数角 th 处的地心系坐标（mc = 当前月心世界坐标，米制） */
  function relayCartAt(mc, th, out) {
    Cesium.Cartesian3.normalize(mc, _relR);                                   // r̂ = 月心径向（背地方向）
    Cesium.Cartesian3.cross(TR.nrm, _relR, _relT);                            // t̂ = 轨道面切向
    Cesium.Cartesian3.normalize(_relT, _relT);
    Cesium.Cartesian3.multiplyByScalar(_relR, RELAY.distKm * 1000, _relL);    // L2 相对月心的偏移
    Cesium.Cartesian3.multiplyByScalar(_relR, RELAY.ax * 1000 * Math.cos(th), out);
    Cesium.Cartesian3.multiplyByScalar(_relT, RELAY.ay * 1000 * Math.sin(2 * th), _relS);
    Cesium.Cartesian3.add(out, _relS, out);
    Cesium.Cartesian3.multiplyByScalar(TR.nrm, RELAY.az * 1000 * Math.sin(th), _relS);
    Cesium.Cartesian3.add(out, _relS, out);
    Cesium.Cartesian3.add(out, mc, out);
    return Cesium.Cartesian3.add(out, _relL, out);
  }
  function ensureRelay() {
    if (relayEnt) return relayEnt;
    relayEnt = earthViewer.entities.add({
      id: 'ce1Relay',
      position: new Cesium.CallbackProperty(() => _relayPos, false),
      billboard: {
        image: RELAY_ICON, width: 34, height: 34,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: '鹊桥中继星 · 地月 L2 晕轨道（周期 14 d）',
        font: '12px "Microsoft YaHei",sans-serif',
        fillColor: Cesium.Color.fromCssColorString('#ffd6f2'),
        outlineColor: Cesium.Color.fromAlpha(Cesium.Color.BLACK, 0.75),
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -26),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    relayOrbEnt = earthViewer.entities.add({
      id: 'ce1RelayOrbit',
      polyline: {
        positions: new Cesium.CallbackProperty(() => _relayRing, false),
        width: 1.6,
        // ⚠ 不用 dash：闭合環含近垂直段会被 PolylineDash 的屏幕像素相位判据整段 discard
        //   （2026-10-24 2-12 椭圆半圈事故的同源坑），这里一律纯色。
        material: Cesium.Color.fromCssColorString('#ff9ee0').withAlpha(0.5),
        arcType: Cesium.ArcType.NONE,
        clampToGround: false,
      },
    });
    relayLinkEnt = earthViewer.entities.add({
      id: 'ce1RelayLink',
      polyline: {
        positions: new Cesium.CallbackProperty(() => _relayLink, false),
        width: 1,
        material: Cesium.Color.fromCssColorString('#ff9ee0').withAlpha(0.25),
        arcType: Cesium.ArcType.NONE,
        clampToGround: false,
      },
    });
    // 已飞轨迹（地心系 = 相对地月系的行进路径）：亮粉粗线，与淡色整圈 Halo 环区分
    relayTrailEnt = earthViewer.entities.add({
      id: 'ce1RelayTrail',
      polyline: {
        positions: new Cesium.CallbackProperty(() => relayTrailCarts, false),
        width: 2.4,
        // ⚠ 同 ce1RelayOrbit：禁用 dash 材质（屏幕像素相位判据会整段 discard），一律纯色
        material: Cesium.Color.fromCssColorString('#ff8fd8'),
        arcType: Cesium.ArcType.NONE,
        clampToGround: false,
      },
    });
    return relayEnt;
  }
  function setRelayVisible(v) {
    if (v) {
      ensureRelay();
      relayEnt.show = true; relayOrbEnt.show = true; relayLinkEnt.show = true;
      if (relayTrailEnt) relayTrailEnt.show = relayTrailCarts.length > 1;
    } else if (relayEnt) {
      relayEnt.show = false; relayOrbEnt.show = false; relayLinkEnt.show = false;
      if (relayTrailEnt) relayTrailEnt.show = false;
    }
  }
  /** 第二幕每帧：更新中继星位置 / 整圈 Halo 曲线 / 月心→L2 连线（visible=false 时整体隐藏） */
  function updateRelayCE1(mc, realSec, visible) {
    if (!visible) { setRelayVisible(false); return; }
    const th = 2 * Math.PI * (realSec / RELAY.periodSec);
    Cesium.Cartesian3.clone(relayCartAt(mc, th, _relayPos), _relayPos);
    for (let i = 0; i <= RELAY.N; i++) {
      if (!_relayRing[i]) _relayRing[i] = new Cesium.Cartesian3();
      relayCartAt(mc, 2 * Math.PI * i / RELAY.N, _relayRing[i]);
    }
    Cesium.Cartesian3.clone(mc, _relayLink[0]);
    Cesium.Cartesian3.clone(_relayPos, _relayLink[1]);
    setRelayVisible(true);
  }
  /** 任意 tCE 的中继星地心坐标（月心取该时刻的月球位置，th 取该时刻的晕轨道相位） */
  function relayCartAtT(tCE, out) {
    const st = CE1.stateAt(tCE);
    const mc = moonCartCE1(st.thetaMoon);
    const th = 2 * Math.PI * (CE1.realAt(tCE) / RELAY.periodSec);
    return relayCartAt(mc, th, out);
  }
  /** 是否显示：自地月转移段起（L2 与月球才同时进入取景尺度） */
  function relayVisibleAt(tCE) {
    const k = CE1.SEG_BY_KEY[RELAY.fromKey];
    return !!k && tCE >= k.t0;
  }
  /** 中继星已飞轨迹（地心系）：星历回填 + 回拖截断 */
  function updateRelayTrail(tCE) {
    if (_relayTrail.length && tCE < _relayTrail[0].t - 1e-6) _relayTrail = [];
    while (_relayTrail.length > 1 && _relayTrail[_relayTrail.length - 1].t > tCE + 1e-6) _relayTrail.pop();
    const last = _relayTrail[_relayTrail.length - 1];
    if (!last) {
      _relayTrail.push({ t: tCE, c: relayCartAtT(tCE, new Cesium.Cartesian3()) });
    } else {
      const gap = tCE - last.t;
      if (gap >= RELAY_TRAIL_DT && _relayTrail.length < RELAY_TRAIL_MAX) {
        const n = Math.min(600, Math.max(1, Math.ceil(gap / RELAY_TRAIL_DT)));
        for (let k = 1; k < n && _relayTrail.length < RELAY_TRAIL_MAX; k++) {
          const tt = last.t + gap * k / n;
          _relayTrail.push({ t: tt, c: relayCartAtT(tt, new Cesium.Cartesian3()) });
        }
        _relayTrail.push({ t: tCE, c: relayCartAtT(tCE, new Cesium.Cartesian3()) });
      }
    }
    relayTrailCarts = _relayTrail.map((e) => e.c);
    if (relayTrailEnt) relayTrailEnt.show = relayTrailCarts.length > 1;
  }

  // 已飞轨迹（第二幕）：按 changE1 动画时刻 t 递增追加，拖拽回退时截断
  let ceTrail = [], ceOrbitEnt = null;
  let _dbgAct2 = null;    // 第二幕每帧视诊断快照（key/burning/cart/flameENU/velENU/matCols），供 debugState 读取
  let _dbgAct4 = null;    // 第四幕时序快照（s4/dust/pd/rs4：扬尘→展翼→玉兔相位），供 debugState 读取
  // ⭐ 2026-10-23 二修「24h 调相椭圆仍呈折线段」：旧实现**每帧最多补 1 个点**（时间门
  //   0.018 / 距离门 gate 双条件），点密度 = 帧率 × 门限命中率的乘积——远地点低速 +
  //   大取景（gate 放大到 camD×0.09%）时两个门限可连续几十帧都不触发，顶点间隔拉到
  //   ~2 h 任务时间 → 整圈只剩十来个顶点的长直弦（用户截图的六边形）。
  //   治本：**星历回填**——last.t→tCE 的空窗按固定动画步长 CE_TRAIL_DT 用 CE1.stateAt
  //   补齐中间点，密度只由 dt 决定、与帧率/拖拽/取景全无关；距离门仅保留作近景加密。
  const CE_TRAIL_DT = 0.02;      // 动画秒（×16080 压缩 → 322 s 任务时间 ≈ 每圈 ~269 点）
  const CE_TRAIL_MAX = 6000;     // 硬上限（全幕回填 ~3,500 点 + 近景加密余量）
  const CE_TRAIL_MAX_ADD = 2500; // 单帧回填上限（跨幕大跳 seek 的一次性成本，防卡帧）
  // 任意 tCE 的世界坐标（与 render 第二幕分支严格同源：frame 'e' 地心绝对 / 'm' 加月心）
  function ce1CartAt(tCE) {
    const st = CE1.stateAt(tCE);
    const mcE = moonCartCE1(st.thetaMoon);
    return st.frame === 'm'
      ? Cesium.Cartesian3.add(mcE, planeCart(st.px, st.py), new Cesium.Cartesian3())
      : planeCart(st.px, st.py);
  }
  function updateCE1Trail(cart, tCE) {
    if (ceTrail.length && tCE < ceTrail[0].t - 1e-6) ceTrail = [];
    while (ceTrail.length > 1 && ceTrail[ceTrail.length - 1].t > tCE + 1e-6) ceTrail.pop();
    const last = ceTrail[ceTrail.length - 1];
    if (!last) {
      ceTrail.push({ t: tCE, c: Cesium.Cartesian3.clone(cart) });
    } else {
      const gap = tCE - last.t;
      const d = Cesium.Cartesian3.distance(last.c, cart);
      // 距离门随取景尺度自适应（近景加密用；远观的平滑度由星历回填保证，不靠它）
      try {
        const cam = earthViewer && earthViewer.camera;
        if (cam) {
          const camD = Cesium.Cartesian3.distance(cam.positionWC, cart);
          _ceTrailGate = Math.min(3e6, Math.max(5e4, camD * 0.0009));
        }
      } catch { /* 相机未就绪：沿用上门限 */ }
      const gate = Math.max(5e4, _ceTrailGate);   // 默认 50 km，随取景尺度自适应放大
      if (gap >= CE_TRAIL_DT && ceTrail.length < CE_TRAIL_MAX) {
        // 星历回填：按固定动画步长补齐 last.t→tCE 的中间点（帧率/拖拽无关）
        const n = Math.min(CE_TRAIL_MAX_ADD, Math.max(1, Math.ceil(gap / CE_TRAIL_DT)));
        for (let k = 1; k < n && ceTrail.length < CE_TRAIL_MAX; k++) {
          const tt = last.t + gap * k / n;
          ceTrail.push({ t: tt, c: ce1CartAt(tt) });
        }
        ceTrail.push({ t: tCE, c: Cesium.Cartesian3.clone(cart) });   // 末点用现成 cart，免重算
      } else if (d > gate && ceTrail.length < CE_TRAIL_MAX) {
        ceTrail.push({ t: tCE, c: Cesium.Cartesian3.clone(cart) });
      }
    }
    // ⚠ 直接原地改 trailCarts（transferTrailEnt 的 positions 是 CallbackProperty(() => trailCarts)）——
    //   若改成整体赋值 .positions，Cesium 每帧都要重建折线几何，长轨迹下会明显掉帧。
    trailCarts = ceTrail.map((e) => e.c);
    if (transferTrailEnt) transferTrailEnt.show = trailCarts.length > 1;
  }
  /** 当前轨道线实体（懒建）：位置走 CallbackProperty，随 st.orb 每帧重算 */
  function ensureCEOrbitEnt() {
    if (ceOrbitEnt) return ceOrbitEnt;
    ceOrbitEnt = earthViewer.entities.add({
      id: 'ce1Orbit',
      polyline: {
        positions: new Cesium.CallbackProperty(() => ceOrbitCarts(), false),
        width: 1.5,
        // ⭐ 2026-10-24 修「2-12 月球周围椭圆只显示半圈」：真因是 PolylineDash 材质 shader
        //   用 **gl_FragCoord.xy（屏幕像素坐标）** 计算虚线间隔（vendored Hz shader：
        //   dashPosition = fract(pos.x / dashLength)），闭合椭圆左右两侧的近垂直段
        //   屏幕坐标 x 几乎不变 → dash 模式冻结 → 若冻结值落在 gap 位整段被 discard；
        //   且 dashLength 单位是**像素**而非米（此前按米传 4.3e5 加剧异常）。headless 与实机一致。
        //   → 换纯色淡蓝细线，与已飞轨迹（亮黄粗线）靠颜色/宽度区分；材质二分实测纯色下椭圆完整闭合。
        material: Cesium.Color.fromCssColorString('#9ec1ff').withAlpha(0.45),
        arcType: Cesium.ArcType.NONE,
        clampToGround: false,
        show: true,
      },
    });
    return ceOrbitEnt;
  }
  function hideCEOrbit() {
    if (ceOrbitEnt) ceOrbitEnt.show = false;
    ceTrail = [];
  }

  // 第二幕轨道线：当前轨道（椭圆按偏近点角均匀采样——近地点不出现折线；双曲线按双曲近点角）
  let _ceSt = null, _ceMoon = null;
  // ⭐ 2026-10-23 修 ReferenceError: _ceTrailGate is not defined（updateCE1Trail 每帧调用 →
  //   整个第二幕 render 抛异常、动画冻结）。语义：已飞轨迹补点的**位移门限**（米）——
  //   位移超过它就补点（防高速段一条长直弦穿过去），随相机到飞船的距离自适应放大。
  let _ceTrailGate = 2e5;
  function ceOrbitCarts() {
    const st = _ceSt;
    if (!st || !st.orb) return [];
    // ⭐ 点火段（burn / burnM）st.orb 是 from→to 的插值轨道，**每帧都在变** → 画出来的
    //   椭圆一直在「呼吸」，看着就不是一条完整稳定的椭圆。改为画**目标轨道** s.to。
    const seg = st.seg;
    let o = st.orb;
    if (seg && (seg.kind === 'burn' || seg.kind === 'burnM') && seg.to) o = seg.to;
    const N = 512;   // 256 → 512：转移大椭圆（周长 ~31.6 万 km）弦高误差再降 4 倍
    const out = [];
    // ⭐⭐ 2026-10-23 末「2-12 月球的蓝色椭圆轨道要按卫星绕行重绘」——真因：
    //   月心系（frame 'm'）里飞船位置是 px,py = r·(cos(peria+ν), sin(peria+ν))（见 changE1
    //   stateAt：st.angRel = HYP.peria + nu），即**整条椭圆相对解析式整体旋转了 HYP.peria**；
    //   而这里按 ν 从 0 起画（未旋转）→ 蓝椭圆与实际飞行路径差一个近月点方向角，
    //   卫星压根不骑在线上。补上这个旋转角即与卫星绕行严格重合。
    const rot = st.frame === 'm' ? (CE1.HYP ? CE1.HYP.peria : 0) : 0;
    if (o.e < 1) {
      const sq = Math.sqrt(1 - o.e * o.e);
      for (let i = 0; i <= N; i++) {
        const E = Math.PI * 2 * i / N;
        const r = o.a * (1 - o.e * Math.cos(E));
        const nu = Math.atan2(sq * Math.sin(E), Math.cos(E) - o.e);
        const a2 = nu + rot;
        const c = planeCart(r * Math.cos(a2), r * Math.sin(a2), new Cesium.Cartesian3());
        if (st.frame === 'm' && _ceMoon) Cesium.Cartesian3.add(_ceMoon, c, c);
        out.push(c);
      }
    } else {
      // 双曲线接近段：H 从 −H_SOI 到 +H_SOI，近月点方向偏 peria，frame 'e' 需加月球位置
      const HS = CE1.H_SOI, k = Math.sqrt((o.e + 1) / (o.e - 1));
      const mx = CE1.D_M * Math.cos(st.thetaMoon), my = CE1.D_M * Math.sin(st.thetaMoon);
      for (let i = 0; i <= N; i++) {
        const H = -HS + 2 * HS * i / N;
        const r = o.a * (o.e * Math.cosh(H) - 1);
        const nu = 2 * Math.atan2(k * Math.tanh(H / 2), 1);
        const a2 = CE1.HYP.peria + nu;
        out.push(planeCart(mx + r * Math.cos(a2), my + r * Math.sin(a2), new Cesium.Cartesian3()));
      }
    }
    return out;
  }
  /** 第二幕遥测 + 16 段解说（复刻参考项目左侧信息栏；数字全部由 changE1 常量算出） */
  /** 第二幕解说 + 遥测：写入底部面板**第 1 行**（#stageNarration），7 项遥测同步展开 */
  function updateCEPanel(st, tCE) {
    const nd = CE1.NOTES[st.key];
    if (nd) {
      setNarration(nd.idx, nd.title, nd.text, nd.a, nd.b);
    }
    showNarration(true);
    const rt = CE1.realAt(tCE);
    const geo = st.frame === 'e' && st.kind !== 'hyp';    // 地心段：地心距/高度；否则月心距/月面高
    $('ceMet').textContent = (rt / 86400).toFixed(2);
    $('ceDistL').textContent = geo ? '地心距' : '月心距';
    $('ceDist').textContent = Math.round(st.r).toLocaleString('en-US');
    $('ceAlt').textContent = Math.round(Math.max(0, st.r - (geo ? CE1.R_E : CE1.R_M))).toLocaleString('en-US');
    $('ceSpd').textContent = st.speed.toFixed(3);
    $('cePer').textContent = (st.orb && st.orb.T) ? (st.orb.T / 3600).toFixed(st.orb.T < 7200 ? 2 : 1) : '—';
    if (st.frame === 'e') {
      let g = (CE1.SOI_PATCH.nu - st.thetaMoon) * 180 / Math.PI;
      g = ((g % 360) + 360) % 360;
      $('ceGap').textContent = g.toFixed(1);
    } else {
      $('ceGap').textContent = '—';
    }
    const seg = CE1.segAt(tCE);
    $('ceRate').textContent = '×' + Math.round(seg.rt / seg.dur).toLocaleString('en-US');
  }
  function hideCEPanel() { hideNarration(); }

  /** 镜头调度（移植参考项目 targetCam）：注视点 = 地心→月心按 w 混合，取景半径 = camSpec.halfKm */
  function applyCE1Cam(st, mc, tCE, cart) {
    if (camOverride) { applyManualFollow(earthViewer, earthRocket.position.getValue(Cesium.JulianDate.now())); return; }
    const spec = CE1.camSpec(st);
    // ⭐ 2026-10-23：任务 8.5 d 后局部镜头拉近约 3 倍（用户「拉近3倍左右」）
    //   ⚠ 2026-10-24 修「2-11~2-15 环月制动段推太近、椭圆被裁切」：该 /3 只针对**地心系大尺度**
    //   （转移/接近段，halfKm 数十万 km，拉近后仍能框住）；环月制动是 frame 'm'（lunar），
    //   halfKm 仅 ~1.2 万 km，/3 → ~4000 km，远月点 1 万 km 的椭圆被框到画外。故 lunar 段豁免 /3，
    //   直接用 camSpec 按远月点自适应的 halfKm（留 18% 余量），椭圆与飞船完整入画。
    let halfKm = spec.halfKm;
    if (tCE != null && !spec.lunar && CE1.realAt(tCE) / 86400 >= 8.5) halfKm = spec.halfKm / 3;
    const focus = new Cesium.Cartesian3();
    if (spec.lunar) {
      Cesium.Cartesian3.clone(mc, focus);
    } else {
      Cesium.Cartesian3.multiplyByScalar(mc, spec.w, focus);   // w=0 地心、w→1 月心
      // ⭐⭐ 2026-10-23 末用户「2-10 要始终保持卫星和月球持续处于页面中」：
      //   接近段（trans/appr）旧逻辑把注视点直接锚到**月心**、半尺寸只按 JUNC_HALF(9.5 万 km)/3
      //   收敛到 ~3.2 万 km —— 而飞船此刻距月球 6.6 万 km，必然在画外。
      //   修：注视点向「月球↔飞船中点」插值（w 越大越靠中点），并给半尺寸加下限
      //   「间距/2 + 月球本体」，保证两者始终同框（w=0 的地月全景段不受影响）。
      if (cart && (st.kind === 'hyp' || st.key === 'trans' || st.key === 'appr')) {
        const dMoon = st.distMoon;                       // km（frame 'm' 时 = 月心距）
        const need = dMoon * 0.5 + CE1.R_M * 1.35;       // 月球半径留 1.35× 余量
        if (isFinite(need) && need > halfKm) halfKm = need;
        const mid = Cesium.Cartesian3.midpoint(mc, cart, new Cesium.Cartesian3());
        Cesium.Cartesian3.lerp(focus, mid, spec.w, focus);
      }
    }
    // ⭐ 2026-10-24 用户「第二幕始终把卫星、鹊桥和月球都显示在画面内」：鹊桥自转移段起可见，
    //   锚在月背 L2（距月心 6.15 万 km，晕轨道再叠 ±2~4 万 km）。地心系段（trans/appr）
    //   把取景**外扩**到能同时框住 飞船+月球+鹊桥——焦点不变、只放大 halfKm（最小改动，
    //   保留「地球远去/月球逼近」的原有叙事）；环月制动段（frame 'm'）以月球+椭圆为绝对
    //   主体（用户定稿「椭圆要完整」），强行外扩会把月球压成 ~2% 的小点，故不扩。
    if (!spec.lunar && tCE != null && relayVisibleAt(tCE)) {
      relayCartAt(mc, 2 * Math.PI * (CE1.realAt(tCE) / RELAY.periodSec), _relayFrame);
      const dRelay = Cesium.Cartesian3.distance(focus, _relayFrame) / 1000;
      const dCraft = cart ? Cesium.Cartesian3.distance(focus, cart) / 1000 : 0;
      const dMoonC = Cesium.Cartesian3.distance(focus, mc) / 1000;
      const need = Math.max(dRelay, dCraft, dMoonC) * 1.06;   // 6% 余量（含月球本体半径）
      if (isFinite(need) && need > halfKm) halfKm = need;
      _act2Cam.dRelayKm = Math.round(dRelay);
      _act2Cam.relayVis = true;
    } else {
      _act2Cam.dRelayKm = null; _act2Cam.relayVis = false;
    }
    _act2Cam.halfKm = Math.round(halfKm);
    applyTopPose(focus, fitRangeKm(halfKm, halfKm, 0.9));
  }

  function updateMoonAndLine(s, exagOverride) {
    // ⚠ 2026-10-21 修**真 bug**：`moonEnt.position = mc` 之后，Cesium 会把赋给 Entity.position
    //   的 Cartesian3 **自动包装成 ConstantPositionProperty** —— 此后再读 `moonEnt.position`
    //   拿到的是 Property 对象而**不是 Cartesian3**。旧代码把它当坐标用：
    //     · emLineCarts = [0, moonEnt.position]        → 折线第二个端点是 Property（x/y/z 全 undefined）
    //     · multiplyByScalar(moonEnt.position, 0.42)   → result.x = undefined × 0.42 = NaN
    //   后果（实测探针 nan-scan，转移段/幕卡 3 100% 复现）：
    //     ① 地月连线端点 NaN、「地月连线 · 384,400 km」标签锚点 NaN → 这条线一直没画对；
    //     ② 含 NaN 的折线几何污染场景包围盒 → createPotentiallyVisibleSet 里 frustum 分割
    //        f = ceil(log(i/n)/log(s)) 的 near/far 变 NaN → `d.length = NaN` 抛
    //        `RangeError: Invalid array length` → **Cesium 停止渲染**（本次冒烟
    //        noConsoleErrors 失败的直接原因：An error occurred while rendering. Rendering has stopped.）。
    //   修法：一律用局部 Cartesian3 `mc`，不回读 Entity.position。
    const mc = moonCartAt(s);
    moonEnt.position = mc;
    emLineCarts = [new Cesium.Cartesian3(0, 0, 0), mc];
    if (emLineEnt) {
      emLineEnt.position = Cesium.Cartesian3.multiplyByScalar(mc, 0.42, new Cesium.Cartesian3());
    }
    setMoonExag(exagOverride === undefined ? moonExagAt(s) : exagOverride);
  }

  // —— 画中画：月球坐标系（2026-10-19 用户反馈「如果能做两个坐标系同步演示则最好」）——
  // 主视图 = 地心系顶视（取景跟随 {地,月,船} 包围盒）；画中画 = 月心系（原点固着月球，
  // 地球绕原点转）。两者由同一任务时钟 s 驱动 → 永远同时刻，互证「飞船在动还是月球在动」。
  // 转移段 fitR 42 万 km（地月同框，读「奔月」），捕获段 2.4 万 km（四条环月轨道全帧）——
  // 与 demos/transfer-full-dual-demo.html 月球面板同一视觉语言（该 demo 用户已认可）。
  let pipCv = null, pipCtx = null, pipImg = null;
  let pipFitKm = 420000, _pipLast = 0;
  let pipRelCarts = [];      // 调相+转移段月心相对路径（固定，buildPipPath 预计算）
  let pipTransRel = [];      // ⭐ 转移段月系相对路径的**平面 km 坐标**（捕获段画中画虚线用，预计算）
  const PIP_N = 300;         // 预计算采样数（前 150 = 调相，后 150 = 转移）
  const PIP_RING_STEP = 4;   // 环月轨道环降采样步长（841 → 211 点，画布足够）
  let _pip = { rel: [0, 0], craftPx: null, fitKm: 420000, corner: null };   // 冒烟诊断（debugPip）

  /** 画中画路径预计算（调相 + 转移两段，月心相对坐标 km）：
   *  每点取**各自时刻**的月心（= demos Marr 定义）→ 月球系里看到的轨迹：转移椭圆随月球
   *  公转缓缓摆动，地球绕原点转。捕获段不预计算——它就是 ringCarts（月心系静态环）。 */
  function buildPipPath() {
    pipRelCarts = [];
    for (let i = 0; i <= PIP_N; i++) {
      const t = i / PIP_N;
      const s = t < 0.5 ? t * 2 * P2.phasingEnd
        : P2.phasingEnd + (t - 0.5) * 2 * (P2.enc - P2.phasingEnd);
      const c = s < P2.phasingEnd ? phasingCartAt(s / P2.phasingEnd)
        : transferCartAt((s - P2.phasingEnd) / (P2.enc - P2.phasingEnd));
      const [x, y] = toPlaneKM(c);
      const [mx, my] = toPlaneKM(moonCartAt(s));
      pipRelCarts.push([x - mx, y - my]);
    }
    // ⭐ 捕获段画中画「来时路」虚线（2026-10-21）：复用主视图 transferRelCarts 的几何
    //   （各点 − 自己时刻的月心），预先投到轨道面平面 km。它是**常量**（不随 s 变），
    //   每帧只需缩放平移，避免 385 点 ×2 次点积的重复开销。
    pipTransRel = transferRelCarts.map((c) => toPlaneKM(c));
  }

  /** 点火信息（画中画火焰/标注用）：pro = 顺行加速（近地点点火/TLI），retro = 逆行制动（LOI） */
  function pipBurn(ss) {
    if (ss < P2.phasingEnd) {
      return phasingBurn(ss / P2.phasingEnd) > 0 ? { type: 'pro' } : null;
    }
    if (ss < P2.enc) {
      const u = (ss - P2.phasingEnd) / (P2.enc - P2.phasingEnd);
      return u < 0.05 ? { type: 'pro' } : null;
    }
    return captureBurn((ss - P2.enc) / (1 - P2.enc)) > 0 ? { type: 'retro' } : null;
  }

  /** 画中画绘制。s = 地月段统一时钟；showCraft = 飞船是否在 3D 主视图里可见（幕卡期间同步隐藏）。 */
  function drawPip(s, showCraft) {
    if (!pipCv) {
      pipCv = $('moonPipCanvas');
      if (!pipCv) return;
      pipCtx = pipCv.getContext('2d');
      if (!pipImg) {   // 月面贴图与 3D 月球同源（WAC）；失败则灰盘兜底
        pipImg = new Image();
        pipImg.src = '/lunar/lunar_wac.jpg';
      }
    }
    const ctx = pipCtx;
    if (!ctx) return;
    const W = pipCv.width, H = pipCv.height;
    // fitR 实时平滑（用真实墙钟 dt，不用封顶 0.1 的 frameDt——SwiftShader 下也要 1 s 内到位）
    const now = performance.now();
    const dt = _pipLast ? Math.min(0.5, (now - _pipLast) / 1000) : 0.016;
    _pipLast = now;
    const fitT = s < P2.enc ? 420000 : 24000;
    pipFitKm += (fitT - pipFitKm) * Math.min(1, dt * 4);
    const px = (H * 0.46) / pipFitKm;             // km → px（fitR ↔ 46% 画高，同 demo）
    const cx = W / 2, cy = H / 2 + 6;
    const X = (km) => cx + km * px, Y = (km) => cy - km * px;

    ctx.clearRect(0, 0, W, H);
    // 月球公转参考圆（= 地球绕月轨道半径）：淡虚线
    ctx.strokeStyle = 'rgba(154,164,184,.28)';
    ctx.setLineDash([5, 5]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, EM.moonC * px, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    const [mx, my] = toPlaneKM(moonCartAt(s));
    // 地球（月心系位置 = −月心）：蓝点 + 标注（fitR 42 万时约 2.5px，捕获段出画）
    const er = Math.max(2.5, EM.rE * px);
    if (Math.abs(X(-mx) - cx) < W && Math.abs(Y(-my) - cy) < H) {
      ctx.fillStyle = '#185fa5';
      ctx.beginPath(); ctx.arc(X(-mx), Y(-my), er, 0, Math.PI * 2); ctx.fill();
      if (er >= 3.5) {
        ctx.fillStyle = '#cfe0f5'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('地球', X(-mx), Y(-my) + er + 14);
      }
    }
    // 月球（原点）：WAC 贴图盘（裁剪圆 + drawImage），加载失败灰盘兜底
    const mr = Math.max(5, EM.moonR * _moonExagNow * px);
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, mr, 0, Math.PI * 2); ctx.closePath(); ctx.clip();
    if (pipImg && pipImg.complete && pipImg.naturalWidth) {
      ctx.drawImage(pipImg, cx - mr, cy - mr, mr * 2, mr * 2);
    } else {
      ctx.fillStyle = '#6b7280';
      ctx.fillRect(cx - mr, cy - mr, mr * 2, mr * 2);
    }
    ctx.restore();
    ctx.strokeStyle = 'rgba(154,164,184,.5)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, mr, 0, Math.PI * 2); ctx.stroke();
    if (mr >= 10) {
      ctx.fillStyle = '#aeb8c6'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('月球', cx, cy + mr + 14);
    }

    // 完整轨迹（淡蓝，与 3D 规划航线同色系）+ 已飞轨迹（亮黄，与 3D 已飞轨迹 #ffd24a 同色）
    const stroke = (pts, upto, color, width, dash) => {
      ctx.strokeStyle = color; ctx.lineWidth = width;
      ctx.setLineDash(dash || []);
      ctx.beginPath();
      const n = Math.min(upto, pts.length - 1);
      for (let i = 0; i <= n; i++) {
        const sx = X(pts[i][0]), sy = Y(pts[i][1]);
        i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    };
    // 捕获段环（月心相对 = ringCarts − 当前月心）；ringCarts 未就绪时跳过
    let ringRel = [];
    if (ringCarts.length) {
      for (let i = 0; i < ringCarts.length; i += PIP_RING_STEP) {
        const [x, y] = toPlaneKM(ringCarts[i]);
        ringRel.push([x - mx, y - my]);
      }
    }
    stroke(pipRelCarts, PIP_N, 'rgba(158,193,255,.28)', 1.1);       // 调相+转移全貌（淡）
    if (ringRel.length) stroke(ringRel, ringRel.length - 1, 'rgba(158,193,255,.28)', 1.1);
    // 已飞前缀：调相+转移按 s 切；捕获段环按 u 切
    const iPh = s < P2.phasingEnd ? Math.round(s / P2.phasingEnd * (PIP_N / 2))
      : s < P2.enc ? Math.round(PIP_N / 2 + (s - P2.phasingEnd) / (P2.enc - P2.phasingEnd) * (PIP_N / 2))
        : PIP_N;
    // ⚠ 2026-10-21 用户要求「捕获段去掉黄色线」：画中画同步——捕获段不再画亮黄已飞弧
    //   （主视图已隐藏，画中画保留会让两个视图不一致，且黄线随月心平移会与规划环叠重影）。
    //   捕获段画中画只留淡蓝全貌（调相+转移+四条环），已飞进度改由飞船光点位置表达。
    if (s < P2.enc) stroke(pipRelCarts, iPh, '#ffd24a', 2);
    // ⭐ 捕获段「来时路」虚线（2026-10-21 与主视图 transferGhostEnt 同步）：transferRelCarts
    //   是月系相对向量，画中画原点即月球 → 直接用平面坐标，不再减 mx/my（与 ringCarts 不同）。
    //   385 点（E 均匀）比 pipRelCarts 后 150 点密，近月端不呈折线。
    if (s >= P2.enc && pipTransRel.length) {
      stroke(pipTransRel, pipTransRel.length - 1, 'rgba(158,193,255,.55)', 1.3, [6, 5]);
    }

    // 飞船 + 月心系速度箭头（有限差分，与 debugAct2Dir 同思路）
    let craftPx = null, relKm = 0;
    const relAt = (ss) => {
      const c = ss < P2.phasingEnd ? phasingCartAt(ss / P2.phasingEnd)
        : ss < P2.enc ? transferCartAt((ss - P2.phasingEnd) / (P2.enc - P2.phasingEnd))
          : captureCartAt((ss - P2.enc) / (1 - P2.enc));
      const [x, y] = toPlaneKM(c);
      const [mx2, my2] = toPlaneKM(moonCartAt(ss));
      return [x - mx2, y - my2];
    };
    const cur = relAt(s);
    relKm = Math.hypot(cur[0], cur[1]);
    if (showCraft) {
      const eps = 2e-4;
      const a = relAt(s - eps), b = relAt(s + eps);
      let vx = b[0] - a[0], vy = b[1] - a[1];
      const vl = Math.hypot(vx, vy) || 1; vx /= vl; vy /= vl;
      craftPx = [X(cur[0]), Y(cur[1])];
      ctx.strokeStyle = 'rgba(232,180,90,.8)'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(craftPx[0], craftPx[1]);
      ctx.lineTo(craftPx[0] + vx * 16, craftPx[1] - vy * 16); ctx.stroke();
      ctx.fillStyle = '#e0922f';
      ctx.beginPath(); ctx.arc(craftPx[0], craftPx[1], 5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = '#e8b56b'; ctx.font = '11px sans-serif'; ctx.textAlign = 'left';
      ctx.fillText('飞船', craftPx[0] + 8, craftPx[1] - 6);
      // 点火火焰 / 滑行标记（与 3D 主视图同源判据）
      const burn = pipBurn(s);
      if (burn) {
        const col = burn.type === 'pro' ? '#e8740c' : '#2f7fd8';
        ctx.save(); ctx.translate(craftPx[0], craftPx[1]);
        ctx.fillStyle = col; ctx.globalAlpha = 0.9;
        for (let k = 0; k < 5; k++) {
          const ang = Math.random() * Math.PI * 2, rr = 4 + Math.random() * 7;
          ctx.beginPath(); ctx.arc(Math.cos(ang) * rr, -Math.sin(ang) * rr, 1.6, 0, Math.PI * 2); ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.fillStyle = col; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(burn.type === 'pro' ? '▲ 加速' : '▼ 减速', 0, -14);
        ctx.restore();
      } else {
        const nearPeri = s < P2.phasingEnd
          ? (() => { const st = phasingState(s / P2.phasingEnd); return st.cu < 0.1 || st.cu > 0.9; })()
          : (() => { const cs = captureState((s - P2.enc) / (1 - P2.enc)); return cs.cu < 0.1 || cs.cu > 0.9; })();
        if (s >= P2.phasingEnd && nearPeri) {
          ctx.fillStyle = 'rgba(150,160,175,.85)'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
          ctx.fillText('◯ 滑行（无动力）', craftPx[0], craftPx[1] + 18);
        }
      }
    }
    // 读数行（与主视图相位条同一时钟）
    const burn = pipBurn(s);
    $('pipTime').textContent = fmtElapsed(CH_TOTAL_H * s);
    $('pipRel').textContent = '月心距 ' + Math.round(relKm).toLocaleString() + ' km';
    $('pipState').textContent = burn ? (burn.type === 'pro' ? '点火加速' : '近月制动')
      : s < P2.phasingEnd ? '调相滑行' : s < P2.enc ? '转移巡航' : '环月巡航';
    _pip = { rel: [Math.round(cur[0]), Math.round(cur[1])], craftPx, fitKm: Math.round(pipFitKm) };
  }

  /** 幕卡 3「地月全景定场」：一次性把整条轨迹装进画面——绕地三圈 + 转移大椭圆 + 绕月四档轨道环。
   *  尺度跨度 6,971（近地点）→ 405,000 km（远地点）= 58 倍，所以正片里没有任何一帧能同框；
   *  这里按真实包围盒取景给 3.6 s 定场，地球约 23 px、绕月轨道环约 41% 画宽。
   *  ⚠ 环月轨道取 ringCarts（月心系静态环，绕 s=1 月心）而非世界行径——后者被月球 25.3°
   *    公转抹散 ±8.5 万 km，包围盒会被撑爆、绕月部分糊成一团。 */
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
      updateCaptureRings(1);   // 直接 seek 到幕卡3 时也要把环月轨道按 s=1 建好再进包围盒
      for (const c of phasingCarts) push(c);                              // 绕地三圈
      for (const c of ringCarts) push(c);                                 // 绕月四档轨道环
      _ovView = {
        tgt: planeToCart((minX + maxX) / 2, (minY + maxY) / 2, new Cesium.Cartesian3()),
        rangeKm: fitRangeKm((maxX - minX) / 2, (maxY - minY) / 2, 0.9),
      };
    }
    applyTopPose(_ovView.tgt, _ovView.rangeKm);
  }

  // ⭐⭐ 地球惯性系固定锚点取景（2026-10-20 定稿，用户口径「是否始终逆时针绕轨道」）
  // 屏幕运动方向 = v_craft − v_target。月球公转 1.0227 km/s，而飞船会合时仅 0.183 km/s
  // （角动量守恒硬上限：h ≤ r_p·v_esc = 6971×11.09 = 77,300 km²/s ⇒ 月球距离处切向速度
  //  ≤ 0.192 km/s，永远只有月球的 18.7%）→ 只要 v_target 沾上月球公转分量，飞船屏幕
  //  位移就被翻成相对月球的 v_rel（+e2 向上），与地球系（−e2 向下）**正好相反**。
  //  这正是「转移从上往下、捕获从下往上」跨幕反直觉的唯一根因——跟参考系「切换」无关，
  //  只跟相机**跟不跟月球**有关。
  //  修复：两幕相机目标都钉在地球惯性系的**固定锚点**上（转移段 = 会合点；捕获段 = 沿月球
  //  轨道以 CAP_ANCHOR_A 倍角速度缓慢移动的点，连续无跳变）⇒ 屏幕位移 = 绝对速度，
  //  绕地恒为逆时针、接近段向 −e2（下），两幕同向。数值证明见 archive/quarantine-tools/scripts-onepass/screen-sense-scan.mjs。
  const CAP_ANCHOR_A = 0.15;        // 捕获段锚点对月球的跟随比例（<0.179 才能保持地球系方向）
  let _frameEarth = true;           // true=地球系定稿；false=旧「跟随月球」版（debugState 可切）
  let _anchorEnc = null;
  function anchorEnc() {
    if (!_anchorEnc) _anchorEnc = toPlaneKM(moonCartAt(P2.enc));
    return _anchorEnc;
  }
  /** 捕获段地球系锚点 = 捕获段**中点**的月球位置（地球惯性系固定点，全程不动）。
   *  ⚠ 不能用「沿轨道慢移」的锚点：它相对月球持续落后，46 h 累计落后 14.4 万 km →
   *    月球直接飞出画面（实测 |n| 达 22.8）。固定锚点 + 一次覆盖整段漂移才是正解。 */
  function capAnchorCart() {
    return moonCartAt(P2.enc + (1 - P2.enc) * 0.5);
  }
  /** 捕获段地球系取景半径：覆盖「整段月球漂移半幅 + 最大绕月远月点」。
   *  46.1 h 内月球漂移 16.97 万 km ⇒ 半幅 8.49 万 + 20,599 km ⇒ ≈ 3.82e5 km。
   *  此取景下月球可视直径约 22% 屏高（清晰可辨），绕月大弧亦完整可见；
   *  更细微的环月轨道细节由画中画（月系）承担——正符合「月系演示在画中画」的设计。 */
  const CAP_RANGE_EARTH = (() => {
    const halfDrift = EM.moonDist * EM.moonOmega * CH_H.capture * 3600 / 2;
    const half = halfDrift + CA[0].ra;
    return fitRangeKm(half, half, 0.85);
  })();

  function lookAtTransfer() {
    const s = act2Progress(p);
    const mc = moonCartAt(s);
    // —— A 调相段：定焦在最外 48h 椭圆的包围盒（三条椭圆如教科书般居中、向远地点层层张开）
    const aT = planeToCart(-PH[2].a * PH[2].e, 0, new Cesium.Cartesian3());
    const aR = PH_RANGE;
    // —— B 转移段：目标 = {地球, 月球, 飞船} 包围盒中心，距离随月球方位自适应
    //     （竖直 fov 仅 36°，月球转到画面上下方时必须拉远，否则地月会出画——旧版 8.0e5 km
    //      是拍脑袋的固定值，月球在上下方时照样出画）
    // ⚠ 2026-10-19 用户反馈「TLI 加速至地月转移轨道时，可视内容完全处于下方（时间轴背后），
    //    啥都看不到了」：旧 tgt = 包围盒**几何中点** ≈ 月球方向 1/3 处（探针实测：TLI 后地球
    //    被投影到屏幕 (610,546)——下方 0.55 屏高、右偏 0.73 半宽；后段 (815,495) 右偏 0.87
    //    几乎贴右边缘）——视觉锚点地球被推到画面下方贴近底部时间轴，主体内容堆在下 2/3。
    //    修复：取景中心向地心偏 40%（tgt = 0.6 × 中点），R 按新中心到 {地心,月,船} 最远距离
    //    重算。代价是 R 增大约 40%（内容略小），换来地球回画面中心区域、地月同框叙事完整。
    const uT = clamp01((s - P2.phasingEnd) / (P2.enc - P2.phasingEnd));
    const xs = [0], ys = [0];                     // 地心 + 月球 + 飞船（面内 km）
    {
      const [mx0, my0] = toPlaneKM(mc);
      const [sx0, sy0] = toPlaneKM(transferCartAt(uT));
      xs.push(mx0, sx0); ys.push(my0, sy0);
    }
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2 * 0.6;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2 * 0.6;
    const bT = planeToCart(cx, cy, new Cesium.Cartesian3());
    let hx = 0, hy = 0;
    for (let i = 0; i < xs.length; i++) {
      hx = Math.max(hx, Math.abs(xs[i] - cx));
      hy = Math.max(hy, Math.abs(ys[i] - cy));
    }
    let bR = fitRangeKm(hx, hy);
    // ⭐ 2026-10-19 用户反馈「地月转移接近月球时视角元素都挤到页面左边去了（是不是应该
    //    基于卫星，而不是地球？）」：转移后段三者（地心/月/船）近似**共线于地月连线** →
    //    包围盒取景把月球+飞船推到屏幕边缘（共线跨度 ~40 万 km，月/船距中心 ~28 万 km
    //    ≈ 0.83 半宽贴边），pull=1.2 再放大问题。修复：uT∈[0.7,0.9] 平滑渐切「卫星+月球」
    //    双星取景——中心 = 月/船中点、R 只覆盖二者 + 月球可视半径（地球退出画面，前段
    //    已充分展示），pull 同步回到 1.0。
    // ⚠ 2026-10-21 真 bug（跨幕镜头抽动的根因）：approach 原只在 `s < P2.enc` 分支内赋值，
    //    一旦跨过会合点（s > P2.enc）就掉回初值 0 → bR 从「月/船双星」mR ≈ 75,000 km 瞬间
    //    弹回「地心+月+船包围盒」≈ 787,000 km（11 倍！），再与捕获段 cR 混合 → 跨幕后镜头
    //    **先猛拉远再拉近**（实测 p=0.532 camKm=40,344 km → p=0.536 暴涨到 187,405 km，
    //    之后才逐步收回）。修复：approach 用 clamp01(uT) 无条件计算——uT ≥ 1（转移段已结束）
    //    时恒为 1，取景停留在 mR。⚠ 渐变块必须**无条件执行**（不能包在 `if (uT < 1)` 里）：
    //    uT 已 clamp01，uT=1 时 xs/ys 取 transferCartAt(1)（会合点，合法），mT 收敛到月心、
    //    bR 停在 mR ≈ 75,000 km —— 正是跨幕后段间混合需要的 bR 起点。
    const approach = easeInOut(clamp01((uT - 0.58) / 0.37));
    if (_frameEarth) {
      // —— 地球系：目标钉死在会合点锚点（地球惯性系固定点，全程不动）——
      //   屏幕位移 = 飞船绝对速度 ⇒ 绕地恒逆时针、接近段向 −e2（下），与捕获幕同向。
      //   取景距离按视锥现算：覆盖 {地心, 月球, 飞船} 相对锚点的偏移 + 月球可视半径，
      //   随三者逼近锚点自然收缩（1.5e6 → 6.8e4 km），全程不出画。
      const [ax, ay] = anchorEnc();
      const rMoonVis = moonRadiusAt(s);
      let ex = rMoonVis, ey = rMoonVis;
      for (let i = 1; i < xs.length; i++) {          // i=1 月球、i=2 飞船（必在画面内）
        ex = Math.max(ex, Math.abs(xs[i] - ax));
        ey = Math.max(ey, Math.abs(ys[i] - ay));
      }
      // 地心权重随接近渐隐：全景段仍含地球（看地月大弧），逼近会合点后只看月/船，
      // 取景自然从 ≈1.13e6 km 收缩到 ≈6.8e4 km（range 变化只改缩放，不影响屏幕方向）
      const wE = 1 - approach;
      ex = Math.max(ex, Math.abs(ax) * wE);
      ey = Math.max(ey, Math.abs(ay) * wE);
      planeToCart(ax, ay, bT);
      bR = fitRangeKm(ex, ey, 0.85);
    } else {
      // ⭐⭐ 跨幕「飞船从上往下扎到底、再反向往上」的**真因（2026-10-20 独立复算）**：
      //   不是参考系切换，也不是几何反向，而是**接近段取景 range 算错**——
      //   旧式 mR = dm + 2·moonR·exag + 30000 完全没考虑视锥（半屏高只有 range×TAN_V≈0.325·range）。
      //   数值扫描 archive/quarantine-tools/scripts-onepass/approach-framing-scan.mjs 实测：飞船屏幕纵向位置 ny 从 −0.11 一路被
      //   推到 −0.90（画面底部），窗口 (0.45,0.80) 下甚至 |n|=1.68 **完全出画**，随后 uT
      //   0.95→1.0 又被猛拉回中心 —— 这就是用户看到的「向下接近、然后反向」。
      //   **修复（两处）**：
      //     ① 取景中心收敛到「月/船中点」midT（而非月心 mc）——月球与飞船对称分居中心
      //        两侧、各距 dm/2，随 dm 缩小自然靠拢，屏幕位置单调、永不出画；
      //        飞船屏幕位移 = v_craft − (v_craft+v_moon)/2 = v_rel/2，与捕获幕（跟月心，
      //        位移 = v_rel）**同向**，跨幕连续（数值已证 ∠(vR_transfer,vR_capture)=5.3°）。
      //     ② range 改用 fitRangeKm 按**当前 tgt 到 {月球,飞船} 的偏移**现算（margin 0.85），
      //        并叠加「地球权重随 approach 渐隐」——approach=0 时仍含地球（= 全景 bR），
      //        approach=1 时只含月/船（= mEnd），全程 |n| ≤ 0.85，飞船与月球恒在画面内。
      //   ⚠ 轨迹数据（entity.position）自始至终是地球惯性系，本处只改**取景**，未动轨道几何。
      if (approach > 0) {
        const midX = (xs[1] + xs[2]) / 2, midY = (ys[1] + ys[2]) / 2;   // 月/船中点（面内 km）
        const tx = lerp(cx, midX, approach), ty = lerp(cy, midY, approach);
        const rMoonVis = moonRadiusAt(s);                               // 月球可视半径（km，含 exaggeration）
        const wE = 1 - approach;                                        // 地球权重渐隐
        const hxN = Math.max(Math.abs(xs[1] - tx), Math.abs(xs[2] - tx), rMoonVis, Math.abs(0 - tx) * wE);
        const hyN = Math.max(Math.abs(ys[1] - ty), Math.abs(ys[2] - ty), rMoonVis, Math.abs(0 - ty) * wE);
        const need = fitRangeKm(hxN, hyN, 0.85);
        const mEnd = fitRangeKm(Math.max(Math.abs(xs[2] - midX), rMoonVis),
                                Math.max(Math.abs(ys[2] - midY), rMoonVis), 0.85);
        planeToCart(tx, ty, bT);
        bR = Math.max(need, lerp(bR, mEnd, approach));
      }
    }
    // —— C 捕获段：跟随月球，取景随环月轨道收缩（抵达 20,599 km → 12h 8,500 → 3.5h 1,729
    //     → 127min 195 km，真实比例），在每次近月制动瞬间平滑拉近（与 LOI 点火同步，
    //     像真实任务那样「刹一脚看清楚一点」）
    const uC = clamp01((s - P2.enc) / (1 - P2.enc));
    // 地球系：锚点沿月球轨道以 CAP_ANCHOR_A 倍角速度移动（连续无跳变）；
    // 旧模式：目标 = 月心（完全跟随 ⇒ 屏幕变成月球系，飞船翻成 +e2 向上）
    const cT = _frameEarth ? capAnchorCart() : mc;
    // ⭐ 抵达段取景节奏（2026-10-22 定稿打磨）：uJ = 抵达子段进度（首次制动前）。
    //   ① uJ<0.25：从 CAP_JOIN_KM 近景（衔接相切弯道清晰可见）平滑拉远到 CAP_WIDE_KM；
    //   ② uJ∈[0.25,0.5)：保持 CAP_WIDE_KM 看蓝色来时路大弧；
    //   ③ uJ≥0.5：收敛到 CA_RANGE[0]，首次制动瞬间再依次收紧看环月轨道。
    //   （根因：宽取景下衔接点仅 ~30px，相切/掉头肉眼不可辨——近景起手让定稿样式真正可见。）
    const uJ = clamp01(uC / Math.max(1e-6, CA_SWITCH[0]));
    let cR;
    if (_frameEarth) {
      // 地球系：锚点与取景半径全程恒定（相机完全静止）⇒ 屏幕位移 = 飞船绝对速度。
      // 代价（几何必然）：月球在画面内以 0.87 km/s 漂移（46 h 横穿约 44% 半宽的行程），
      // 这正是地球系的正确表现——飞船绕月的轨迹呈**螺旋**而非闭合椭圆。
      cR = CAP_RANGE_EARTH;
    } else {
      if (uJ < 0.25) cR = lerp(CAP_JOIN_KM, CAP_WIDE_KM, easeInOut(uJ / 0.25));
      else if (uJ < 0.5) cR = CAP_WIDE_KM;
      else cR = lerp(CAP_WIDE_KM, CA_RANGE[0], easeInOut((uJ - 0.5) / 0.5));
      for (let i = 0; i < CA_SWITCH.length; i++) {
        cR = lerp(cR, CA_RANGE[i + 1], easeInOut(clamp01((uC - CA_SWITCH[i]) / 0.1 + 0.5)));
      }
    }
    // 防御（#92 安全网）：相机距月心恒 > 月半径，极端情况下也不会让近裁剪面切进地表
    cR = Math.max(cR, moonRadiusAt(s) * 1.3);
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
    // 2026-10-21：第二幕整体再拉远 ~20%（用户反馈「第二幕也要再拉远一段」）。
    // 仅调相/转移段生效，捕获段保持贴月取景（看得到环月轨道环）。
    // 2026-10-19：接近段（approach→1）pull 同步回 1.0——卫星+月球取景不应再被拉远，
    // 否则刚从贴边救回来的月/船又被推小（用户同一条反馈的另一半根因）。
    // 地球系取景已含 margin 0.85 的留白，不再额外拉远（拉远会让地月都缩得更小）
    const pull = (!_frameEarth && s < P2.enc) ? lerp(1.2, 1.0, approach) : 1.0;
    applyTopPose(tgt, rangeKm * pull);
  }

  let _lastFocusRange = 3.0e5;   // 最近一次跟火箭机位距离（分离镜头混合起点用）

  function focusEarth(alt, wide) {
    const pos = earthRocket ? earthRocket.position.getValue(Cesium.JulianDate.now()) : null;
    if (!pos) return;
    if (wide) {                       // 死分支：保留旧全景接口（当前无调用方）
      applyFollow(earthViewer, pos, 0, Cesium.Math.toRadians(-38), 3.0e7);
      _lastFocusRange = 3.0e7;
      return;
    }
    // ⚠ 2026-10-19：发射起步与预览（5000m/比例尺~500m）无缝接续。
    //   相机偏移完全复用 previewLaunchSite 的东南斜俯（east2400/south1500/up5000），
    //   仅按高度放大系数 k 整体后撤——方向不变 ⇒ 角度不变、只是平滑拉远，消除 5000m→900m 硬跳。
    //   k=1（近地）时相机位姿与预览逐像素一致；随火箭升高 k 增大、视野拉开。
    const k = Cesium.Math.clamp(1 + alt / 30000, 1, 25);
    const c = Cesium.Cartographic.fromCartesian(pos);
    const lon = Cesium.Math.toDegrees(c.longitude);
    const lat = Cesium.Math.toDegrees(c.latitude);
    const h = c.height;
    const eastM = 2400 * k, southM = 1500 * k;
    const lonOff = eastM / (111319.5 * Math.max(0.15, Math.cos(Cesium.Math.toRadians(lat))));
    const latOff = -southM / 110946;
    const camPos = Cesium.Cartesian3.fromDegrees(lon + lonOff, lat + latOff, h + 5000 * k);
    const dir = Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.subtract(pos, camPos, new Cesium.Cartesian3()), new Cesium.Cartesian3());
    const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(pos, new Cesium.Cartesian3());
    applyCameraPose(earthViewer, camPos, dir, up, Cesium.Cartesian3.distance(camPos, pos));
    _lastFocusRange = Cesium.Cartesian3.distance(camPos, pos);
  }

  /** 分离镜头（2026-10-17）：机位从「跟火箭」1.2s 混合到「分离件质心 ↔ 火箭主体」同框。
   *  不这么做的话：118 km 外 760 m 的弹开距离 ≈ 2 像素，「四散分开」用户永远看不到；
   *  只盯质心的话火箭主体出画（2026-10-18 用户反馈）——目标取两者中点、距离盖住两者。 */
  function focusSeparators() {
    const list = boosters.length ? boosters : fairings.length ? fairings : cores.length ? cores : null;
    if (!list || !sepCam) { focusEarth(rocketPosAt(p)[2]); return; }
    const centroid = debrisCentroid(list);
    const rocketCart = earthRocket ? earthRocket.position.getValue(Cesium.JulianDate.now()) : null;
    if (!rocketCart) { focusEarth(rocketPosAt(p)[2]); return; }
    const k = easeInOut(Math.min(1, (performance.now() - sepCam.t0) / 1200));
    // ⚠ 2026-10-19 用户反馈：助推器分离后火箭跑到画面顶端快看不到了。
    //   根因：旧 tgt 取「助推器质心↔火箭中点」，分离动画含向下坠落(fall)，质心落到火箭
    //   前下方 → 取景中心跟着下偏 → 火箭被顶到画面顶端。修复：取景中心改回**火箭本体**
    //   (始终居中)，分离件靠 range 拉远纳入同框(距中心 spread，range≥spread*1.9 即在画面内)。
    const tgt = rocketCart;
    // ⚠ 2026-10-19 用户反馈「下坠速度再快些」：旧 range=spread*4.2 随共同下坠(fall)同比拉远相机 →
    //   屏幕下坠位移被抵消（分离件几乎悬在固定屏幕高度，看不出下坠）。改为**固定机位**：
    //   相机不随 spread 增长，下坠/四散直接在屏幕上呈现（屏幕下坠从近中心加速掉向底边）。
    //   R 须覆盖最大散开+下坠（不出画）：助推器 dt8 向下枚 D_v≈fall+up≈1.1 万 m → R=20000
    //   （竖直半高≈1.3 万 m）；整流罩 dt6.5 → R=8000；芯级/二级 → R=10000。
    //   2026-10-23 用户「看不出形态变化」：旧 38000/15000/20000 取景过远，火箭只有 ~35px、
    //   形态切换读不出来 → 收紧一半，分离件快速飞出画面正好强化「分离」的观感。
    const R = boosters.length ? 20000 : fairings.length ? 8000 : 10000;
    const range = lerp(sepCam.fromRange, R, k);
    applyFollow(earthViewer, tgt, 0, Cesium.Math.toRadians(-30), range);
  }

  // 飞行方向单位向量（ENU）：取样 ±0.4% 进度处两点求切向（竖直起步时回退天顶）
  function flightDirENU(pp) {
    const e = 0.004;
    // ⚠ 2026-10-19 用户反馈「第一幕末尾卫星轻微上翘」：pp+0.004 在 pp 接近 liftEnd 时会越过
    //   边界、命中 rocketPosAt 第二幕分支(phasingCartAt)——转移轨道近地点后朝远地点轻微爬升、
    //   切线带向上分量 → 机头被算成「朝月方向上翘」。修复：采样点钳制在第一幕内(≤liftEnd)，
    //   末端切线取 earthPath 真实末向（γ 已 90·(1−s)^1.6 严格水平），消除跨幕突变。
    const hi = T.liftEnd - 1e-6;
    const a = rocketPosAt(Math.max(0, Math.min(pp - e, hi)));
    const b = rocketPosAt(Math.min(pp + e, hi));
    return tangentENU(a, b, _dir);
  }

  // 飞船世界坐标（与 render 各分支同源）：第一幕 lon/lat/alt→Cartesian；
  // 第二/三幕直接返回各轨道的 WORLD Cartesian（绝不走 lon/lat/alt 反解）。
  // ⚠ 关键（2026-10-21 用户反馈 #89「卫星机头必须沿轨道切线」）：捕获段轨道圈极小
  // （远月点 2 万 km、近月点 ~200 km），若用 lon/lat/alt 反解再求 ENU 切向，高度分量会
  // 主导 → 模型机头被算成「径指向地心」而非「沿轨道切线」；这里取世界速度有限差分，
  // 再投影到该点 ENU，切线方向在任何尺度下都正确。
  function craftWorldAt(pp) {
    if (pp < T.liftEnd) {
      const pos = rocketPosAt(pp);
      return Cesium.Cartesian3.fromDegrees(pos[0], pos[1], pos[2]);
    }
    const s = act2Progress(pp);
    if (s < P2.phasingEnd) return phasingCartAt(s / P2.phasingEnd);
    if (s < P2.enc) return transferCartAt((s - P2.phasingEnd) / (P2.enc - P2.phasingEnd));
    return captureCartAt((s - P2.enc) / (1 - P2.enc));
  }
  // 模型机头朝向（ENU）：世界速度有限差分 → 投影到该点 ENU 基 → quatUpTo 对齐 +Z（机头）
  function craftOrientDir(pp) {
    const e = 0.004;
    const p0 = craftWorldAt(Math.max(0, pp - e));
    const p1 = craftWorldAt(Math.min(1, pp + e));
    const v = Cesium.Cartesian3.subtract(p1, p0, _oV);
    if (Cesium.Cartesian3.magnitude(v) < 1e-9)
      return Cesium.Cartesian3.clone(Cesium.Cartesian3.UNIT_Z, _dir);
    Cesium.Cartesian3.normalize(v, v);
    const cart = craftWorldAt(pp);
    Cesium.Transforms.eastNorthUpToFixedFrame(cart, Cesium.Ellipsoid.WGS84, _enuM);
    const east = Cesium.Matrix4.getColumn(_enuM, 0, _oE);
    const north = Cesium.Matrix4.getColumn(_enuM, 1, _oN);
    const up = Cesium.Matrix4.getColumn(_enuM, 2, _oU);
    const ex = Cesium.Cartesian3.dot(v, east);
    const ny = Cesium.Cartesian3.dot(v, north);
    const uz = Cesium.Cartesian3.dot(v, up);
    const dir = new Cesium.Cartesian3(ex, ny, uz);
    if (Cesium.Cartesian3.magnitude(dir) < 1e-9)
      return Cesium.Cartesian3.clone(Cesium.Cartesian3.UNIT_Z, _dir);
    return Cesium.Cartesian3.normalize(dir, _dir);
  }

  /** 火箭/飞船模型：就绪则落位返回 true（调用方据此隐藏 billboard 兜底）。
   *  lvlh=true（飞船上面级/probe）：走 orientLvLH（三轴全约束 + 补偿 glTF Y→Z 校正）——
   *    机头(+Z)顺行进向、帆板(+X)水平、厚度(+Y)径向，不因速度变向翻滚；
   *    level=false 时机头沿**全速度**（含径向爬升/俯冲）——第二幕地心系段「沿轨道飞」；
   *  lvlh=false（整箭/芯级，Y-up）保持 quatUpTo。 */
  function updateRocketModel(slot, cart, dir, lvlh = false, level = true) {
    if (!slot) return false;
    if (!attachIfReady(slot)) return false;
    if (lvlh) placeModel(slot, cart, orientLvLH(cart, dir, _q, true, Cesium.Ellipsoid.WGS84, true, level), Cesium.Ellipsoid.WGS84);
    else placeModel(slot, cart, quatUpTo(dir, _q), Cesium.Ellipsoid.WGS84);
    return true;
  }

  // ---- 逐帧渲染 ----
  // 跨幕相机重置（用户拍板 2026-10-18：MANUAL 不跨幕保留，跨幕回默认机位）。
  // 同 viewer 内平滑混合；地月跨 viewer（容器都换了）瞬切。
  // a2 = 第二幕「奔月与捕获」（含三次制动，仍在地心惯性系、地球 viewer 上）；
  // c2 = 幕卡 2（全景定场）。a2c / c3 两个键在 2026-10-22 合并幕后已废止。
  const ACT_VIEWER = {
    a1: 'earth', c1: 'earth', a2: 'earth', c2: 'earth',
    a3l: 'moon', a3d: 'moon', a4: 'moon',
  };
  let _lastActKey = null;
  function actKeyOf(pp) {
    // 合并后共 4 幕：a1 点火 / c1 幕卡1 / a2 奔月与捕获（原二+三幕）/ c2 幕卡2 全景定场
    //                / a3l 环月 / a3d 动力下降 / a4 着陆巡视
    return pp < T.liftEnd ? 'a1' : pp < T.card1End ? 'c1' : pp < T.act2End ? 'a2'
      : pp < T.card2End ? 'c2' : pp < T.cruiseEnd ? 'a3l' : pp < T.touchEnd ? 'a3d' : 'a4';
  }
  function viewerOfAct(key) {
    return ACT_VIEWER[key] === 'moon' ? env.getMoonViewer() : earthViewer;
  }
/* ==================== 焦点物体跟随（2026-10-24 用户需求） ====================
 * 底部面板第一行放一排「可聚焦物体」按钮：点选后相机切到该物体的推荐机位并**持续跟踪**；
 * 再点一次取消（回脚本机位）。用户拖拽/滚轮仍可接管（camOverride → applyFollow 自动转
 * 手动跟随，关注点继续锁在焦点物体上）；点「🎯 推荐视角」回推荐机位。
 * 各物体世界坐标由 render 每帧写入 FOCUS_POS（key → {cart, v}，v=该物体所在 viewer）。 */
const FOCUS_POS = {};
// focusTarget 声明在模块层（updateCamBadge 需要），此处不再重复声明
const FOCUS_DEFS = {
  rocket: { name: '长征五号', icon: FULL_ROCKET_ICON, pitchDeg: -26, range: 1600, hdg: 0 },
  craft:  { name: '探月飞船', icon: SPACECRAFT_ICON, pitchDeg: -26, range: 1600, hdg: 0 },
  earth:  { name: '地球', icon: EARTH_ICON, pitchDeg: -30, range: 2.6e7, hdg: 0 },
  moon:   { name: '月球', icon: MOON_ICON, pitchDeg: -26, range: 9.5e6, hdg: 0 },
  lander: { name: '着陆器', icon: LANDER_ICON, pitchDeg: -24, range: 320, hdg: 1.9 },
  rover:  { name: '玉兔号', icon: ROVER_ICON, pitchDeg: -24, range: 320, hdg: 1.9 },
};
function setFocusPos(key, cart, v) {
  if (!cart || !isFinite(cart.x)) return;
  FOCUS_POS[key] = { cart: Cesium.Cartesian3.clone(cart), v };
}
/** 焦点机位：有效返回 true（覆盖脚本机位）；camOverride 时 applyFollow 自动转手动跟随 */
function applyFocusCam() {
  if (!focusTarget) return false;
  const def = FOCUS_DEFS[focusTarget];
  const fp = FOCUS_POS[focusTarget];
  if (!def || !fp || !fp.cart || !fp.v) return false;
  // MANUAL（用户拖拽接管）时只跟随关注点、机位归用户（与各幕行为一致）
  if (camOverride) applyManualFollow(fp.v, fp.cart);
  else applyFollow(fp.v, fp.cart, def.hdg, Cesium.Math.toRadians(def.pitchDeg), def.range);
  return true;
}
/** 当前幕的可聚焦物体（按钮文案第一幕 craft=火箭） */
function focusKeysFor() {
  if (p < T.card1End) return ['craft', 'earth'];
  if (p < T.act2End) return ['craft', 'earth', 'moon'];
  if (p < T.touchEnd) return ['craft', 'moon'];
  return ['lander', 'rover', 'moon'];
}
let _focusRowKeys = '';
function updateFocusRow() {
  const keysArr = focusKeysFor();
  const keySig = keysArr.join(',');
  if (keySig !== _focusRowKeys) {
    _focusRowKeys = keySig;
    const row = $('focusRow');
    if (row) {
      row.classList.remove('hidden');
      // 只重建 .focus-btn 与 .focus-label，保留（可能已被移入本行的）tourCamMode 及其监听器
      // ⚠ 2026-10-24 修「视角键左侧显示 跟踪 跟踪」：旧代码只删 .focus-btn，label 每轮重建
      //   再 append → act1→2→3→4 每次换 keySig 都多留一个「跟踪」（第四幕会叠到 4 个）。
      row.querySelectorAll('.focus-btn, .focus-label').forEach((b) => b.remove());
      const cb = $('tourCamMode');
      if (cb) cb.remove();                 // 先摘下来，保证最终顺序 = label → 物体按钮 → 视角按钮
      const label = document.createElement('span');
      label.className = 'focus-label';
      label.textContent = '跟踪';
      row.appendChild(label);
      for (const k of keysArr) {
        const def = (k === 'craft' && p < T.card1End) ? FOCUS_DEFS.rocket : FOCUS_DEFS[k];
        const b = document.createElement('button');
        b.className = 'focus-btn';
        b.dataset.key = k;
        if (def.icon) {
          const img = document.createElement('img');
          img.src = def.icon; img.className = 'focus-ic'; img.alt = '';
          b.appendChild(img);
        }
        const span = document.createElement('span');
        span.textContent = def.name;
        b.appendChild(span);
        b.addEventListener('click', () => {
          const on = focusTarget === k;
          focusTarget = on ? null : k;
          // 开/关都从当前世界位姿平滑混合（关 = 回脚本机位；2026-10-24 补，避免硬跳）
          startBlendFrom(camHookViewer || earthViewerRef);
          updateFocusRow();
          updateCamBadge();
        });
        row.appendChild(b);
      }
      if (cb) row.appendChild(cb);           // 视角按钮挪到第一行末尾
    }
  }
  document.querySelectorAll('#focusRow .focus-btn').forEach((b) => {
    b.classList.toggle('on', b.dataset.key === focusTarget);
  });
}
/** 每帧收集各物体世界坐标（render 末尾调用；部分由各幕分支直接写入更精确） */
function collectFocus() {
  if (earthRocket && earthRocket.position && earthRocket.show !== false) {
    try {
      const c = earthRocket.position.getValue(earthViewerRef.clock.currentTime);
      if (c && isFinite(c.x)) FOCUS_POS.craft = { cart: Cesium.Cartesian3.clone(c), v: earthViewerRef };
    } catch { /* 忽略 */ }
  }
  FOCUS_POS.earth = { cart: Cesium.Cartesian3.ZERO, v: earthViewerRef };
  try {
    const mv = env.getMoonViewer();
    if (mv && p >= T.card2End) FOCUS_POS.moon = { cart: Cesium.Cartesian3.ZERO, v: mv };   // 月球 viewer 原点=月心
  } catch { /* 忽略 */ }
  try {
    const mv = env.getMoonViewer();
    if (mv && moonCraft && moonCraft.position) {
      const c = moonCraft.position.getValue(mv.clock.currentTime);
      if (c && isFinite(c.x)) FOCUS_POS[p >= T.touchEnd ? 'rover' : 'craft'] = { cart: Cesium.Cartesian3.clone(c), v: mv };
    }
  } catch { /* 忽略 */ }
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
    // 鹊桥中继星只在第二幕出现：非第二幕一律隐藏（每帧兜底，跨幕/跨 viewer 都不会残留）
    if (actKey !== 'a2') setRelayVisible(false);
    // 画中画（月心系同步视图）：⚠ 2026-10-22 第二幕改用 changE1 引擎后，drawPip 仍按旧轨道参数
    //   （phasingCartAt / transferCartAt / captureCartAt）取点，画出来与新引擎不一致 → 暂时关闭。
    //   待办：把 drawPip 的输入换成 CE1 的「相对月心坐标」即可恢复（引擎已直接给出 frame 'm' 的
    //   px/py 与 frame 'e' 的 (px−月心x, py−月心y)，无需再走旧函数）。
    const pipShow = false;
    $('moonPip')?.classList.toggle('hidden', !pipShow);
    // —— 地球侧（第一幕 / 幕卡 1 / 第二幕奔月与捕获 / 幕卡 2 全景定场）——
    // ⚠ 捕获段仍在地球 viewer（地心惯性系 + 绕月取景），月球侧从幕卡 2 之后才开始
    if (p < T.card2End) {
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
      // ⭐ 2026-10-19 用户反馈「四分五裂，参考 demo 重做」：捕获幕 = demo「月球原点」面板，
      //   地心系规划线（调相圈 / 转移椭圆 / 镜像虚线）全部隐藏——转移椭圆末端锚在旧会合点，
      //   月球继续公转后残尖漂离月球，与月系黄线/规划环叠在一起正是「四分五裂」的观感之一。
      // ⭐⭐ 2026-10-22 新第二幕改由 changE1 引擎驱动 → **旧模型的地心规划线一律关闭**：
      //   调相圈 / 转移椭圆 / 镜像虚线 / 捕获环 / 三段标注的几何都来自旧轨道参数
      //   （rp=6964 / ra=405000 / 无影响球），与新引擎的 rp=6576 / ra=384400 / 66,000 km
      //   拼接圆锥不一致，画上去就是错的。当前轨道改由 ceOrbitEnt（CallbackProperty，
      //   随 st.orb 每帧重算）绘制，已飞轨迹由 updateCE1Trail 接管。
      const inAct2 = p >= T.card1End && p < T.act2End;
      // 制动段（frame 'm'）镜头贴月特写：任何含地球方向远端顶点的 polyline 都会投影到
      // 屏幕外 ±1 万像素，在部分实机 GPU 上环绕出杂色条纹（2026-10-21 二修「绿弧/竖线伪影」）
      // → 地月连线、月球轨道圈、发射轨迹一律隐藏。
      const ceSeg = inAct2 ? CE1.segAt(act2Time(p)) : null;
      const lunarClose = !!(ceSeg && ceSeg.frame === 'm');
      if (emLineEnt) emLineEnt.show = showEm && !lunarClose;
      if (launchTrailEnt) launchTrailEnt.show = !lunarClose;
      if (moonOrbitEnt) moonOrbitEnt.show = !lunarClose;
      if (transferTrailEnt) transferTrailEnt.show = false;   // 由 updateCE1Trail 接管
      if (transferGhostEnt) transferGhostEnt.show = false;
      if (transferMirrorEnt) transferMirrorEnt.show = false;
      if (transferFullEnt) transferFullEnt.show = false;
      // 2026-10-23：旧「霍曼转移轨道」标注指向已隐藏的旧规划线几何（新第二幕由 changE1 引擎
      //   驱动，不画那条椭圆）→ 一并隐藏，免得第二幕天上悬一行解释不存在曲线的文字。
      if (transferLabelEnt) transferLabelEnt.show = false;
      if (phasingEnt) phasingEnt.show = false;
      if (captureEnt) captureEnt.show = false;
      if (phaseLabelEnts[0]) phaseLabelEnts[0].show = false;
      if (phaseLabelEnts[1]) phaseLabelEnts[1].show = false;
      if (phaseLabelEnts[2]) phaseLabelEnts[2].show = false;
      if (!inAct2) { hideCEOrbit(); hideCEPanel(); }

      if (p < T.liftEnd) {
        // 第一幕：点火起飞（上升 + 分离动效 + 发射轨迹 + 火焰/灰尘/RCS）
        earthRocket.show = true;
        updateAct1Narration(p);     // 第 1 行解说（按 p 直接驱动六阶段）
        const pos = rocketPosAt(p);
        const cart = Cesium.Cartesian3.fromDegrees(pos[0], pos[1], pos[2]);
        earthRocket.position = cart;
        const dir = flightDirENU(p);
        // ⭐ 形态随分离阶段切换（2026-10-23 补「二级 + 抛整流罩」两个形态，解决「看不出变化」）：
        //   整箭 → ①抛四助推器 → 芯级(带罩) → ②抛主助推器 → **二级(带罩)** → ③抛整流罩 →
        //   **二级(罩已抛、露出卫星)** → ④星箭分离 → 卫星(帆板收拢) → ⑤帆板展开。
        // 显式 showSlot + hideSlot 其它：进度条来回拖拽也不会卡在错误形态（2026-10-17 修）。
        const stage = p < BOOSTER_SEP ? 'rocket' : p < CORE_SEP ? 'rocketCore'
          : p < STAGE2_SEP ? 'upper' : 'craft';
        const slot = stage === 'rocket' ? getRocketSlot()
          : stage === 'rocketCore' ? getRocketCoreSlot()
            : stage === 'upper' ? getRocketUpperSlot() : getCraftSlot();
        if (updateRocketModel(slot, cart, dir, stage === 'craft')) {
          earthRocket.billboard.show = false;
          hideSlot(rocketSlot); hideSlot(rocketCoreSlot); hideSlot(rocketUpperSlot);
          hideSlot(craftSlot);
          showSlot(slot);
          // 抛整流罩：把二级模型的「整流罩」节点隐藏 → 露出罩内卫星（形态变化可辨）
          //   ⚠ setNodeShow（node.show），勿改回 node.transform——原型无此 setter（2026-10-23 实锤）
          if (stage === 'upper') setNodeShow(slot, '整流罩', p < FAIRING_SEP);
        } else {
          earthRocket.billboard.show = true;
          earthRocket.billboard.rotation = 0;
          earthRocket.billboard.image = stage === 'craft' ? SPACECRAFT_ICON
            : stage === 'rocket' ? FULL_ROCKET_ICON : STAGE1_ICON;
        }
        if (p >= PANEL_FROM) {
          earthRocket.label.text = '长征五号 · 帆板展开';
        } else if (p >= STAGE2_SEP) {
          earthRocket.label.text = '长征五号 · 星箭分离';
        } else if (p >= FAIRING_SEP) {
          earthRocket.label.text = '长征五号 · 抛整流罩';
        } else if (p >= CORE_SEP) {
          earthRocket.label.text = '长征五号 · 主助推器分离';
        } else if (p >= BOOSTER_SEP) {
          earthRocket.label.text = '长征五号 · 四助推器分离';
        } else {
          earthRocket.label.text = '长征五号 · 点火升空';
        }
        // ⭐ 帆板：抛整流罩后卫星以**收拢态**露出，星箭分离后才展开（2026-10-23 用户定序）
        if (stage === 'craft') {
          deployCraftPanels(getCraftSlot(), clamp01((p - PANEL_FROM) / PANEL_WIN));
          setSlotPixelSize(getCraftSlot(), MODEL_DEFS.craft.minPx);   // 第一幕：恢复标定尺寸（~35px）
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
        pushLaunchTrail(pos, p);
        updateSeparators();
        // 分离相位文字由 updateSeparators() 内部按阶段设置（四散弹开/整流罩分离），
        // 这里只在无分离件时才设通用相位——否则会覆盖掉分离窗口的说明（2026-10-17 修）
        if (!boosters.length && !fairings.length && !cores.length) setPhase('第一幕 · 点火起飞');
        // MANUAL（用户拍板 2026-10-18）：关注点跟随火箭本体，分离特写不生效；
        // AUTO：分离窗口内切分离镜头（四散/翻滚可读），其余时间跟火箭
        if (camOverride) {
          applyManualFollow(earthViewer, cart);
        } else if (boosters.length || fairings.length || cores.length) {
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
        setNarration('1-7', '入轨 · 205 km 停泊轨道',
          '点火起飞段结束，卫星入 <b>205 km 圆轨道</b>，等待调相点火窗口。',
          'v = 7.786 km/s', 'T = 88.4 min');
        showNarration(false);
        showCard('第一幕 · 点火起飞完成\n入泊轨道 205 km · 7.79 km/s · 周期 88 min');
        setPhase('幕间');
        if (camOverride && earthRocket.position) {
          applyManualFollow(earthViewer, earthRocket.position.getValue(Cesium.JulianDate.now()));
        } else {
          focusEarth(200000);
        }
      } else if (p < T.act2End) {
        // ⭐⭐ 第二幕（原二、三幕合并，2026-10-22）：全程由 changE1.js 嫦娥一号引擎驱动
        //   205 km 停泊 → 16/24/48 h 调相各 1 圈 → TLI → 转移椭圆 → 影响球 66,000 km 处
        //   拼接圆锥（双曲线接近 v∞≈0.739、近月点 420 km）→ 三次近月制动 321/283/211 m/s。
        //   段内节奏、取景与解说全部来自引擎（SEGS / camSpec / NOTES），与参考项目一致。
        clearSeparators();   // 跨幕 seek 不经过幕卡分支，这里兜底清分离件
        earthRocket.show = true;
        showNarration(false);
        const tCE = act2Time(p);
        const st = CE1.stateAt(tCE);
        const mcE = moonCartCE1(st.thetaMoon);
        setFocusPos('moon', mcE, earthViewerRef);   // 第二幕月球在 earth viewer，焦点跟踪用真实月心
        // frame 'e' 的 px/py 已是地心绝对坐标；frame 'm' 是相对月心 → 加回月心
        const cart = st.frame === 'm'
          ? Cesium.Cartesian3.add(mcE, planeCart(st.px, st.py), new Cesium.Cartesian3())
          : planeCart(st.px, st.py);
        earthRocket.position = cart;
        updateMoonCE1(st, mcE);
        _ceSt = st; _ceMoon = mcE;
        // 鹊桥中继星 · 地月 L2 晕轨道（自转移段起显示）
        updateRelayCE1(mcE, CE1.realAt(tCE), relayVisibleAt(tCE));
        // 已飞轨迹只在**地心系段**累积：制动段（frame 'm'）相机框月球，L2 在 6 万 km 外
        //   必然出画，继续累积只是白烧 CPU 且会顶到容量上限。
        if (st.frame === 'e' && relayVisibleAt(tCE)) updateRelayTrail(tCE);
        // 飞船模型：LVLH 三轴约束（机头沿轨道切向）。制动段 st.vel 是月心系相对速度，
        //   ce1DirENU 已补上月球公转 → 屏幕方向仍按**地球惯性系**判读（跨幕方向定稿结论）。
        //   ⭐ 2026-10-24 用户「卫星没有沿着轨道改变方向」：地心系段（frame 'e'）走
        //   level=false——机头沿**全速度**（含径向爬升/俯冲），像飞机沿椭圆飞：转移段
        //   远地点附近大爬升时明显抬头、接近段低头，与第一幕重力转弯读感一致；
        //   月心系制动段（frame 'm'）沿用 level=true 定稿姿态（机体躺切平面、帆板平行月面）。
        //   ⚠ level 语义 = 「保持水平（剥径向分量）」：要「沿全速度飞」必须传 false，
        //     故这里传 st.frame !== 'e'（frame 'e' → false）。
        ce1DirENU(st, cart, _vec);
        let craftMatCols = null;
        if (updateRocketModel(getCraftSlot(), cart, _vec, true, st.frame !== 'e')) {
          earthRocket.billboard.show = false;
          showSlot(craftSlot);
          hideSlot(rocketSlot); hideSlot(rocketCoreSlot); hideSlot(rocketUpperSlot);
          deployCraftPanels(getCraftSlot(), 1);
          setSlotPixelSize(getCraftSlot(), CRAFT_PX_TRANSFER);
          // 姿态诊断（2026-10-24 用户「卫星没有沿着轨道改变方向」排查用）：modelMatrix 上 3×3 三列。
          //   world = modelMatrix·R_corr·local（R_corr: (x,y,z)→(z,x,y)）→ col0=机头、col1=帆板侧轴、col2=厚度径向。
          const cs = getCraftSlot();
          if (cs && cs.mat) {
            const g = (c) => {
              const v = Cesium.Matrix4.getColumn(cs.mat, c, new Cesium.Cartesian3());
              Cesium.Cartesian3.normalize(v, v);
              return [+v.x.toFixed(4), +v.y.toFixed(4), +v.z.toFixed(4)];
            };
            craftMatCols = { nose: g(0), panel: g(1), radial: g(2) };
          }
        } else {
          earthRocket.billboard.show = true;
          earthRocket.billboard.rotation = flightRotation(p);
          earthRocket.billboard.image = SPACECRAFT_ICON;
        }
        // 点火火焰：burn = 顺行加速（喷流向后）/ burnM = 逆行制动（喷流朝前）
        const exh = new Cesium.Cartesian3();
        if (st.burning) {
          const flick = 0.9 + 0.1 * Math.sin(performance.now() * 0.053);
          if (st.kind === 'burnM') Cesium.Cartesian3.clone(_vec, exh);
          else Cesium.Cartesian3.negate(_vec, exh);
          updateFlame(earthViewer, cart, exh, 1.5 * flick, Cesium.Ellipsoid.WGS84);
        } else {
          updateFlame(earthViewer, null, null, 0, Cesium.Ellipsoid.WGS84);
        }
        // 视诊断快照：喷流 ENU 方向 exh 与飞船世界坐标 cart，供 probes/debugState 判定加减速
        _dbgAct2 = {
          key: st.key, burning: !!st.burning, kind: st.kind,
          cart: [cart.x, cart.y, cart.z],
          velENU: [+_vec.x.toFixed(4), +_vec.y.toFixed(4), +_vec.z.toFixed(4)],
          matCols: craftMatCols,
          flameENU: st.burning ? [exh.x, exh.y, exh.z] : null,
        };
        // 轨道线 + 已飞轨迹 + 镜头
        // ⭐ 2026-10-23 用户「月球带着线飞过来看着很奇怪」：接近段（<9.38 d）计划轨道线
        //   （淡蓝虚线 ceOrbitEnt）锚在月心系随月球动 → 隐藏；任务 9.38 d 起进入近月制动，
        //   显示**跟随月球的减速椭圆**（蓝虚线 ceOrbitCarts 取当前捕获椭圆），作「怎么被月亮抓住」的参照。
        if (CE1.realAt(tCE) / 86400 >= 9.38) ensureCEOrbitEnt().show = true;
        else if (ceOrbitEnt) ceOrbitEnt.show = false;
        updateCE1Trail(cart, tCE);
        applyCE1Cam(st, mcE, tCE, cart);
        const nm = CE1.NAMES[st.key] || '';
        earthRocket.label.text = '探月飞船 · ' + nm + (st.burning ? ' · 点火' : '');
        updateCEPanel(st, tCE);
        setPhase('第二幕 · ' + nm + ' · ' + fmtElapsed(CE1.realAt(tCE) / 3600)
          + '（演示加速 ×' + CH_SPEEDUP.act2 + '）');
      } else {
        // 幕卡 2：地月全景定场（3.6 s）——整条轨迹唯一一次同框。
        //   第二幕末状态 = 三次制动完成后的 200 km 极轨（O_L3），位置/月球方位都取自 changE1。
        clearSeparators();
        earthRocket.show = true;
        updateFlame(earthViewer, null, null, 0, Cesium.Ellipsoid.WGS84);
        hideCEOrbit();
        const stEnd = CE1.stateAt(ACT2_T_END);
        const mcEnd = moonCartCE1(stEnd.thetaMoon);
        const cart = Cesium.Cartesian3.add(mcEnd, planeCart(stEnd.px, stEnd.py), new Cesium.Cartesian3());
        earthRocket.position = cart;
        ce1DirENU(stEnd, cart, _vec);
        if (updateRocketModel(getCraftSlot(), cart, _vec, true)) {
          earthRocket.billboard.show = false;
          showSlot(craftSlot);
          hideSlot(rocketSlot); hideSlot(rocketCoreSlot); hideSlot(rocketUpperSlot);
          deployCraftPanels(getCraftSlot(), 1);   // 非第一幕：帆板恒展开（防进度条拖拽卡在半展开）
          setSlotPixelSize(getCraftSlot(), CRAFT_PX_TRANSFER);   // 全局取景：卫星缩为星点
        } else {
          earthRocket.billboard.show = true;
          earthRocket.billboard.image = SPACECRAFT_ICON;
        }
        updateMoonCE1(stEnd, mcEnd);
        if (transferTrailEnt) transferTrailEnt.show = ceTrail.length > 1;
        showCard('第二幕 · 三次近月制动完成\n停泊→调相→转移→影响球→三次制动 321/283/211 m/s，入 200 km 极轨');
        setPhase('幕间');
        setNarration('2-17', '地月全景 · 定场',
          '整条轨迹首次同框：绕地调相 → 地月转移大椭圆 → 三次制动入 <b>200 km 极轨</b>。',
          '任务 10.97 d', 'Δv 合计 3.947 km/s');
        showNarration(false);
        lookAtOverview();
      }
      return;
    }

    // —— 月球侧（第三幕：环月 + 动力下降；第四幕：着陆 → 玉兔驶出巡视）——
    hideCard();
    hideCEPanel(); hideCEOrbit();
    hideNarration();
    if (earthRocket) earthRocket.show = false;
    clearSeparators();
    ensureMoonScene();
    const mv = env.getMoonViewer();
    if (!mv || !moonCraft) return;
    const site = MOON_LANDING_SITES[landingSiteKey];
    warmLunarTiles(site);   // 预热着陆点周边 LRO WAC 瓦片（动力下降近距离段直接本地读）

    // 轨道线分阶段显隐（2026-10-21 用户反馈 #94「着陆前轨道线太多、太冗余」；2026-10-22 定稿）：
    //   环月制动 LOI 段：黄色完整制动椭圆 + 蓝色 100km 目标环（已飞轨迹与规划线完全重合，不再画已飞弧）
    //   环月滑行巡航段：仅蓝色 100km 目标环——卫星骑在它上面绕飞
    //   动力下降段：隐藏计划环(已离轨) → 仅留下降计划弧，画面清爽
    //   着陆/巡视段：全部隐藏
    const inLoi = p < T.cruiseEnd;            // 环月段（制动+巡航连续，时间轴无节点分割）
    const inDescent = p >= T.cruiseEnd && p < T.touchEnd;
    if (moonRing) moonRing.show = inLoi;
    if (descentArcEnt) descentArcEnt.show = inDescent;
    if (loiTrailEnt) loiTrailEnt.show = false;             // 已飞弧退役：规划线已完整覆盖实际路径

    // 动力下降 → 玉兔巡视：**不再启动 blend**（2026-10-24 订正）。
    //   两端机位参数已完全一致（末段收敛到 ACT4_CAM），位置也已连续（见下降段 latT 的末段收敛），
    //   直接由第四幕接管即可无缝。旧代码在这里 startBlendFrom(mv) 反而制造了两个问题：
    //   ① blend 期间 applyCamera 走的是「从旧世界位姿插值」分支，**不施加遮挡补偿** → 主体先掉到
    //      画面正中（y 354）再弹回时间轴上方（y 272）；
    //   ② 只要目标位置有米级~百米级残差，相机就得分 1.4 s 慢慢转过去，主体在这段时间里横掠出画。
    _prevInDescent = inDescent;

    // 非玉兔段（环月/下降）：确保两翼收起、月尘粒子关闭（避免上轮残留）
    if (p < T.touchEnd) {
      if (landerPanelL) landerPanelL.show = false;
      if (landerPanelR) landerPanelR.show = false;
      updateDust(mv, null, 0);
    }

    if (inLoi) {
      // 环月段（2026-10-22 用户定稿：制动+巡航**连续**一个节点，时间轴不再分制动/巡航）：
      //   前 BRAKE_FRAC 走黄色制动椭圆（远月点 800km 滑行 → 近月点 100km 反向点火圆化），
      //   后 (1-BRAKE_FRAC) 走蓝色 100km 圆轨道巡航至下降起点。全程轨道面顶视图、月心居中、
      //   不切镜头；卫星用同一飞船上面级模型（不切换）。
      _diveBlend = null;
      const u = clamp01((p - T.card2End) / (T.cruiseEnd - T.card2End));   // 整段归一化
      const BRAKE_FRAC = 0.6;                 // 制动椭圆滑行占比（余下为圆轨道巡航）
      const brake = brakeGeom || (brakeGeom = makeBrakeEllipse(site));
      // ⭐ 2026-10-24 修「3-4/3-5 没和 3-3 接续、行进又变顺时针」：
      //   巡航段是逆行（f 递减 → 沿子午线大圆**向南**），而旧下降却从 site.lat−40 **向北**飞到
      //   site.lat —— 方向在衔接点直接反折。现把下降起点改到**着陆点以北 40°**（f0 同步），
      //   全程向南滑到着陆点，与逆行巡航同弧同向。
      const f0 = (site.lat + 40 + 90) / 360;   // 下降起点 lat=site.lat+40 对应的环参数
      const fP = (site.lat + 60 + 90) / 360;  // 近月点（圆化点）对应的环参数
      // ⭐ 2026-10-23 用户：第三幕环月改为**逆行**（与月球自转相反，阿波罗/嫦娥实际入轨方式）。
      //   LOI_RETRO = -1 把制动椭圆 θ、近月点点火 f、圆轨道巡航 f 的推进方向整体反转；
      //   近/远月点位置不变（椭圆对称），下降衔接点 f0 不变 → 下降段无缝衔接。
      //   喷流方向由速度切向 velDir 推导，方向自动跟随反转，无需单独取反。
      const LOI_RETRO = -1;
      let craftPos, velDir;
      if (u < BRAKE_FRAC) {
        // —— 制动椭圆滑行 + 切点反向点火 ——
        const s = u / BRAKE_FRAC;
        const BURN_AT = 0.82;                 // s<0.82 椭圆滑行；s≥0.82 近月点反向点火
        if (s < BURN_AT) {
          // 椭圆滑行：θ 0→3π·RETRO（远月点出发、终于近月点）；指数 1.12 使近月点更快
          // （开普勒第二定律趋势：近月点速度大）；滑行段不点火。
          const uu = s / BURN_AT;
          const th = LOI_RETRO * 3 * Math.PI * Math.pow(uu, 1.12);
          craftPos = brake.posAt(th);
          velDir = Cesium.Cartesian3.subtract(
            brake.posAt(th + 0.004, _dir2), brake.posAt(th - 0.004, _dir3), new Cesium.Cartesian3());
          Cesium.Cartesian3.normalize(velDir, velDir);
          // ⭐⭐ 2026-10-23 末：下面两处有限差分求的都是「参数增大方向」的切向，而实际推进
          //   方向是 LOI_RETRO（逆行时参数**递减**）→ 不乘这个符号的话 velDir 指向运动的反方向：
          //   卫星模型的机头朝后、近月点喷火朝后（= 加速而非减速）。必须取实际运动方向。
          Cesium.Cartesian3.multiplyByScalar(velDir, LOI_RETRO, velDir);
          moonCraft.label.text = '环月制动 · 椭圆轨道滑行（近月点点火）';
          setPhase('第三幕 · 环月制动（LOI）');
          updateFlame(mv, null, null, 0, MOON_ELLIPSOID);
          updateBurnFx(mv, null, null, 0);     // 熄火
        } else {
          // 近月点反向点火：椭圆与 100km 圆相切处，喷流沿速度方向（= 反向减速）→ 圆化入轨；
          // 点火期间沿圆轨道缓移一小段（~4.3°），与巡航段起点无缝衔接。
          const uu = (s - BURN_AT) / (1 - BURN_AT);
          const f = fP + LOI_RETRO * 0.012 * uu;
          craftPos = circlePosAt(site, f);
          // 世界速度切向（喂 LVLH 姿控；orientLvLH 调用后 _eastV/_northV/_upV=该点 ENU 轴）
          velDir = Cesium.Cartesian3.subtract(
            circlePosAt(site, f + 0.003), circlePosAt(site, f - 0.003), new Cesium.Cartesian3());
          Cesium.Cartesian3.normalize(velDir, velDir);
          // ⭐ 逆行时 f 递减 → 实际运动方向 = −(f 增大方向)（同椭圆滑行段的处理）
          Cesium.Cartesian3.multiplyByScalar(velDir, LOI_RETRO, velDir);
          moonCraft.label.text = '近月点反向点火 · 制动圆化入轨 100 km';
          setPhase('第三幕 · 近月点制动');
          const burn = 1.2 * (0.85 + 0.15 * Math.sin(performance.now() * 0.06));   // 喷流脉动
          // 喷流方向 = 速度同向（减速制动），以 ENU 坐标喂火焰（orientLvLH 已写入 ENU 轴）
          const exh = new Cesium.Cartesian3(
            Cesium.Cartesian3.dot(velDir, _eastV),
            Cesium.Cartesian3.dot(velDir, _northV),
            Cesium.Cartesian3.dot(velDir, _upV));
          updateFlame(mv, craftPos, exh, burn, MOON_ELLIPSOID);
          updateBurnFx(mv, craftPos, exh, burn, MOON_ELLIPSOID);   // 粒子喷流特效
        }
        if (moonBrakeEllipse) moonBrakeEllipse.show = true;
      } else {
        // —— 圆轨道巡航（近月点圆化后真在 100km 环上绕飞至下降起点）——
        const sC = (u - BRAKE_FRAC) / (1 - BRAKE_FRAC);
        // ⭐ 2026-10-23 修「环月滑行没有接续逆行」两个真 bug：
        //   ① F0 必须与制动段点火**结束处严格相等**：点火 f = fP + LOI_RETRO·0.012·uu，
        //      uu=1 时落在 fP + LOI_RETRO·0.012 —— 旧版恒写 fP+0.012，逆行时巡航起点
        //      跳到点火终点的另一侧（差 0.024 ≈ 8.6°），观感「滑行段断开了」。
        //   ② fEnd 公式方向写反：逆行要 f **递减**，旧版 2·F0−f0−2 使 fEnd<F0 → 实际顺行
        //      1.73 圈（根本没逆行）。正确 retro：fEnd = 2·F0−f0+1（>F0，f 递减），
        //      f(1)=2F0−fEnd = f0−1 ≡ f0，反向绕 ~1.27 圈后仍落回下降起点。
        //   ③ 标签引用未定义变量 F1（一进巡航段就 ReferenceError 整个 render 冻结）→ 改 fEnd。
        const F0 = fP + LOI_RETRO * 0.012;         // 制动段点火结束处（无缝衔接）
        // 逆行：巡航终点取 2·F0−f0+1（反向绕飞约 1.27 圈后仍落回 f0，与下降起点严格衔接）
        const fEnd = LOI_RETRO > 0 ? f0 + 2 : 2 * F0 - f0 + 1;
        const f = F0 + LOI_RETRO * (fEnd - F0) * sC;   // sC=1 时 f≡f0(mod1) → 回到下降起点
        craftPos = circlePosAt(site, f);
        // 世界速度切向（喂 LVLH 姿控，保证与制动段坐标系一致、点火瞬间不跳变）
        velDir = Cesium.Cartesian3.subtract(
          circlePosAt(site, f + 0.003), circlePosAt(site, f - 0.003), new Cesium.Cartesian3());
        Cesium.Cartesian3.normalize(velDir, velDir);
        moonCraft.label.text = '环月滑行巡航（100 km 圆轨道 · ' + Math.abs(fEnd - F0).toFixed(1) + ' 圈' + (LOI_RETRO < 0 ? ' · 逆行' : '') + '）';
        setPhase('第三幕 · 环月滑行巡航');
        updateFlame(mv, null, null, 0, MOON_ELLIPSOID);
        updateBurnFx(mv, null, null, 0);         // 巡航无点火
        if (moonBrakeEllipse) moonBrakeEllipse.show = false;
      }
      moonCraft.position = craftPos;
      // 卫星模型：制动+巡航全程同一飞船上面级（不切换）
      const slot = getLoiCraftSlot();
      if (attachIfReady(slot)) {
        moonCraft.billboard.show = false;
        hideSlot(landerSlot); hideSlot(roverSlot); showSlot(slot);
        placeModel(slot, craftPos, orientLvLH(craftPos, velDir, _q, false), MOON_ELLIPSOID);
      } else {
        moonCraft.billboard.show = true;
        moonCraft.billboard.image = SPACECRAFT_ICON;
      }
      // 相机：轨道面顶视图，月心居中；MANUAL 接管时**绕月心**旋转（不甩月，滚轮仅缩放）
      if (camOverride) applyManualFollow(mv, Cesium.Cartesian3.ZERO);
      else applyMoonPlaneTopCam(mv, site.lon);
    } else if (inDescent) {
      // 离轨 + 动力下降（2026-10-18 定稿）：与 LOI **同一子午线大圆**继续南滑
      // （着陆点以北 40° → 0°），高度 descentProfile（100 km → 0）——全程同弧同向无直角。
      //   相机：滑翔段保持 260 万 m 远机位（弧线在画面上 ~30% 高、可读不糊），
      //         触月前 1.4s 平滑推近到着陆机位（广播式「切着陆机位」）。
      const s = clamp01((p - T.cruiseEnd) / (T.touchEnd - T.cruiseEnd));
      const ground = sampleMoonHeight(site.lon, site.lat);
      // ⭐⭐ 2026-10-24 修「3-6 末段镜头跟不住着陆器 / 着陆器出画」的**真因**（headless 播放态实测）：
      //   下降段位置是「剩余里程 rem=1−s」的线性函数（横向 40°×rem、高度 100km×(1−(1−rem)^2.4)），
      //   而 p 是**按帧离散推进**的：末帧步长 ds≈3e-4（实机）~3.4e-3（headless 6 fps）→ 跨幕那一刻
      //   实体还差 **320 m 横向 + 240 m 高度**没走完。第四幕却直接把它钉到真实着陆点 → 位置瞬移，
      //   旧代码又用 1.4 s blend 补，相机必须甩 60°，着陆器先横掠出画再飘回（实测夹角 5.7°→35.9°）。
      //   治本：把 rem 做末段收敛——**最后 6% 里程按 3 次幂更快归零**（rem≥0.06 与旧版逐点重合，
      //   路径形状、姿态切线、激尘时序全不变），跨幕残差降到米级 → 零位移，镜头无需甩。
      //   ⚠ 窗口/指数按**最坏帧率**定：6 fps 下残差也只 3 m 级（实机 60 fps <1 m）；若用 2% 窗 + 2.2 次幂，
      //   6 fps 下仍会残留 240 m 的地面跳变。
      const TAIL = 0.06, TAIL_N = 3.0;
      const remRaw = 1 - s;                               // 剩余里程（旧版：横向 40°·rem、高度依此降）
      const rem = remRaw >= TAIL ? remRaw : TAIL * Math.pow(remRaw / TAIL, TAIL_N);
      const se = 1 - rem;                                 // 有效参数：末段提前到位（供高度剖面用）
      const prof = descentProfile(se);
      const alt = ground + prof.alt;
      const latT = site.lat + 40 * rem;                   // 自着陆点以北 40° 向南滑（接逆行巡航，同向）
      const craftPos = Cesium.Cartesian3.fromDegrees(site.lon, latT, alt, MOON_ELLIPSOID);
      moonCraft.position = craftPos;
      // 姿态：大圆切向（北滑）→ 竖直（离轨段平滑过渡）
      const e = 0.01;
      const sa = Math.max(0, 1 - e), sb = Math.min(1, 1 + e);
      const a = [site.lon, site.lat + lerp(40, 0, sa), ground + descentProfile(sa).alt];
      const b = [site.lon, site.lat + lerp(40, 0, sb), ground + descentProfile(sb).alt];
      const orbitDir = tangentENU(a, b, _dir2);
      const u = s < 0.55 ? s / 0.55 : 1;   // 姿态：滑行段保持大圆切向，末段(动力下降)平滑转为竖直
      const dir = new Cesium.Cartesian3(
        lerp(orbitDir.x, 0, easeIn(u)),
        lerp(orbitDir.y, 0, easeIn(u)),
        lerp(orbitDir.z, 1, easeIn(u)));
      Cesium.Cartesian3.normalize(dir, dir);
      if (s < 0.10) {
        // 离轨制动段：逆行点火，把 100km 圆轨道压成转移椭圆（perilune≈月面）。飞船上面级 + 逆向火焰。
        moonCraft.label.text = '离轨制动（逆行点火 · 转入转移椭圆）';
        setPhase('第三幕 · 离轨制动');
        const slot = getLoiCraftSlot();
        if (attachIfReady(slot)) {
          moonCraft.billboard.show = false;
          hideSlot(landerSlot); hideSlot(roverSlot); showSlot(slot);
          //   ⭐⭐ 2026-10-24 修「3-5 帆板突然被扭转 90°」：`orbitDir = tangentENU(...)` 返回的是
          //   **ENU 分量**(东,北,天)，旧代码却以 fwdIsENU=false 传入 orientLvLH → 被当成世界 XYZ
          //   解算 → 随机旋转矩阵，卫星前后轴与行进方向不垂直（歪 90°）、帆板被拧。必须传 true。
          placeModel(slot, craftPos, orientLvLH(craftPos, orbitDir, _q, true), MOON_ELLIPSOID);
        } else {
          moonCraft.billboard.show = true;
          moonCraft.billboard.image = SPACECRAFT_ICON;
        }
        const burn = 0.95 * (0.9 + 0.1 * Math.sin(performance.now() * 0.051));
        updateFlame(mv, craftPos, dir, burn, MOON_ELLIPSOID);
        updateBurnFx(mv, craftPos, dir, burn, MOON_ELLIPSOID);   // 离轨制动粒子喷流
        if (landDustEnt) landDustEnt.ellipse.material = Cesium.Color.WHITE.withAlpha(0);
      } else if (s < 0.55) {
        // 转移椭圆滑行段（近 apolune，高度基本维持 ~100km，发动机基本关机，靠惯性飞向 perilune）。
        moonCraft.label.text = '转移椭圆滑行（惯性飞向着陆点）';
        setPhase('第三幕 · 环月转移滑行');
        const slot = getLoiCraftSlot();
        if (attachIfReady(slot)) {
          moonCraft.billboard.show = false;
          hideSlot(landerSlot); hideSlot(roverSlot); showSlot(slot);
          // LVLH 姿控：+Z=径向天顶、帆板水平，与制动段一致不翻滚（orbitDir 是 ENU → fwdIsENU=true）
          placeModel(slot, craftPos, orientLvLH(craftPos, orbitDir, _q, true), MOON_ELLIPSOID);
        } else {
          moonCraft.billboard.show = true;
          moonCraft.billboard.image = SPACECRAFT_ICON;
        }
        updateFlame(mv, null, null, 0, MOON_ELLIPSOID);   // 滑行无点火
        updateBurnFx(mv, null, null, 0);
        if (landDustEnt) landDustEnt.ellipse.material = Cesium.Color.WHITE.withAlpha(0);
      } else {
        // 动力下降段：着陆器（与飞船分离后）+ 主发动机火焰（油门曲线）+ 末段 RCS 精调
        moonCraft.label.text = site.name + ' · 动力下降';
        setPhase(s >= 1 ? '第三幕 · 月面着陆完成' : '第三幕 · 动力下降');
        const slot = getLanderSlot();
        if (attachIfReady(slot)) {
          moonCraft.billboard.show = false;
          hideSlot(loiCraftSlot); hideSlot(roverSlot); showSlot(slot);
          placeModelS(slot, craftPos, Cesium.Quaternion.IDENTITY, LANDER_SCALE, MOON_ELLIPSOID);  // 2026-10-23：着陆器 ×1.4（体量压过玉兔）
          deployLanderPanels(slot, 0);        // 下降段双翼保持折叠，触陆后再展开（才有「打开」过程）
        } else {
          moonCraft.billboard.show = true;
          moonCraft.billboard.image = LANDER_ICON;
        }
        const flick = 0.9 + 0.1 * Math.sin(performance.now() * 0.057);
        const flamePos = offsetUp(craftPos, 0.8, new Cesium.Cartesian3());
        Cesium.Cartesian3.negate(Cesium.Cartesian3.UNIT_Z, _vec);
        updateFlame(mv, flamePos, _vec, (0.5 + prof.thrust) * flick, MOON_ELLIPSOID);
        // 末段姿态微调 RCS（左右交替，触月前收）
        if (s > 0.9) {
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
      // 相机（2026-10-22 末「环月转移滑行并到前面第四幕」：离轨制动+环月转移滑行 s<0.55
      //   仍属环月轨道段，沿用制动/巡航的**轨道面顶视图**——月心居中、同飞船模型、不切镜；
      //   仅动力下降 s≥0.55 才切到着陆俯冲机位，读「逐渐下降着陆」过程）。
      if (s < 0.55) {
        _diveBlend = null;
        if (camOverride) applyManualFollow(mv, Cesium.Cartesian3.ZERO);
        else applyMoonPlaneTopCam(mv, site.lon);
      } else {
        // ⭐ 2026-10-24 修「3-6→4-1 镜头切换太快、着陆器一度出画」：
        //   旧实现是**墙钟驱动**（performance.now() 2200ms 推近）→ 不受播速/拖时间轴控制，
        //   拖过时 k 停在中间、range 还停在百万米级而飞船已落地 → 着陆器只剩一个像素（像消失）；
        //   且终点参数与第四幕机位不一致，跨幕还有一次硬跳变。
        //   新实现：① DIVE_FROM 之前沿用既定远机位（近了地形会糊成频闪，2026-10-17 定稿）；
        //          ② 最后 30% 改为**进度驱动**（到期/拖时间轴都一致），并一路收敛到**与第四幕
        //             完全相同**的机位参数（heading/pitch/range），第四幕接手时零跳变。
        const DIVE_FROM = 0.70;   // 最后 30% 进度开始推近着陆机位
        if (s < DIVE_FROM) {
          _diveBlend = null;
          // #[95] 由 −22°（斜俯，看得到月面弧线 → 有「在下降」的体感）渐变到 −40°
          const pd = lerp(-22, -40, easeInOut(clamp01(s / DIVE_FROM)));
          if (camOverride) applyManualFollow(mv, craftPos);
          else applyFollow(mv, craftPos, 0, Cesium.Math.toRadians(pd), 2.6e6);
        } else {
          const w = easeInOut(clamp01((s - DIVE_FROM) / (1 - DIVE_FROM)));
          const pd = lerp(-40, ACT4_CAM.pitchDeg, w);
          // range 不小于触陆前的近机位（再近 = 提前钻进月面）；末端与第四幕 320 m 一致
          const nearRef = Math.max(ACT4_CAM.range, (alt - ground) * 2.4);
          const rg = Math.exp(lerp(Math.log(2.6e6), Math.log(nearRef), w));
          if (camOverride) applyManualFollow(mv, craftPos);
          else applyFollow(mv, craftPos, lerp(0, ACT4_CAM.heading, w), Cesium.Math.toRadians(pd), rg);
        }
      }
    } else {
      // 第四幕：玉兔驶出巡视（着陆器驻留 + 月球车 6 轮滚动节点动画）
      const s4 = clamp01((p - T.touchEnd) / (1 - T.touchEnd));
      const ground = sampleMoonHeight(site.lon, site.lat);
      const landerPos = Cesium.Cartesian3.fromDegrees(site.lon, site.lat, ground, MOON_ELLIPSOID);
      setFocusPos('lander', landerPos, mv);   // 焦点跟踪：着陆器（月球 viewer）
      // 着陆后机械动作时序（2026-10-24 用户订正：**先扬尘、后展太阳翼，不是同时**）：
      //   s4 ∈ [0, 0.12]   着陆扬尘粒子渐隐（≈1.7 s）；
      //   s4 ∈ [0.12, 0.40] 双翼太阳能板展开（≈4 s，缓动可读）；
      //   s4 ∈ [0.40, 1]   玉兔驶出巡视（≈8.6 s）。
      // 建模动画优先：GLB 节点驱动（真·太阳能板）；节点不可用时回退 box 版。
      updateDust(mv, landerPos, clamp01(1 - s4 / 0.12));   // 着陆瞬间月尘粒子，渐隐
      // 下降段触月激尘椭圆至此渐隐（旧实现拖到第四幕仍留 0.168 透明度的残影）
      if (landDustEnt) {
        landDustEnt.ellipse.material = Cesium.Color.fromCssColorString('#b9b4ab')
          .withAlpha(0.42 * clamp01(1 - s4 / 0.12));
      }
      const pd = clamp01((s4 - 0.12) / 0.28);          // 扬尘结束后才展开双翼
      const glbPanels = deployLanderPanels(getLanderSlot(), pd);
      // 时序诊断（2026-10-24 用户「先扬尘后展翼」验收用）：尘强/展翼进度/玉兔行程三者的相位关系
      _dbgAct4 = { s4: +s4.toFixed(3), dust: +clamp01(1 - s4 / 0.12).toFixed(3), pd: +pd.toFixed(3), rs4: +clamp01((s4 - 0.40) / 0.60).toFixed(3), roverLen: ROVER_LEN };
      if (glbPanels) {
        if (landerPanelL) landerPanelL.show = false;   // 建模翼已生效 → 收掉 box 补丁
        if (landerPanelR) landerPanelR.show = false;
      } else {
        deployPanels(landerPos, pd);                   // 兜底：程序化 box 翼
      }
      // 行进路线（2026-10-17 修正，见 roverPath 注释）：缓弯弧线 + 逐点 DEM 贴地；
      //   玉兔在双翼展开后(s4>0.40)才滑出着陆器，朝行进方向驶离（起点在着陆器旁）。
      const pts = roverPath(site);
      const rs4 = clamp01((s4 - 0.40) / 0.60);       // 玉兔实际行程进度（展翼后才开始）
      const fi = rs4 * (pts.length - 1);
      const i0 = Math.min(pts.length - 2, Math.floor(fi));
      const fr = fi - i0;
      const pa = pts[i0], pb = pts[i0 + 1];
      const rLon = lerp(pa.lon, pb.lon, fr);
      const rLat = lerp(pa.lat, pb.lat, fr);
      const rGround = lerp(pa.h, pb.h, fr);
      const heading = lerp(pa.heading, pb.heading, fr);
      const roverPos = Cesium.Cartesian3.fromDegrees(rLon, rLat, rGround, MOON_ELLIPSOID);
      // 车头对准行进方向（2026-10-22 订正：回退到 UNIT_Z）：
      // 实测教训——绕 UNIT_Y 会让玉兔绕**水平体轴**滚转（右侧轮陷月、左侧翘天、肚子朝前=翻车），
      // 因 yutu 模型绕 +Y 不是竖直升举轴；绕 **UNIT_Z** 才是在月面偏航（保持车身平躺、不翻车）。
      // 车头对准路线方位角 heading；ROVER_HEADING_FLIP=π 可整体反向（默认 0=朝驶离方向）。
      const roverQuat = Cesium.Quaternion.fromAxisAngle(
        Cesium.Cartesian3.UNIT_Z, -heading + ROVER_HEADING_FLIP, new Cesium.Quaternion());
      // 车辙 = 已行驶前缀（含当前点）
      roverTrackCarts = [];
      for (let i = 0; i <= i0; i++) {
        roverTrackCarts.push(Cesium.Cartesian3.fromDegrees(pts[i].lon, pts[i].lat, pts[i].h, MOON_ELLIPSOID));
      }
      roverTrackCarts.push(roverPos);
      moonCraft.position = roverPos;
      moonCraft.label.text = '玉兔号 · 月面巡视';
      setPhase(s4 >= 1 ? '第四幕 · 巡视完成' : '第四幕 · 玉兔驶出巡视');
      // 着陆器驻留（identity 竖直）
      const ls = getLanderSlot();
      const landerQuat = Cesium.Quaternion.fromAxisAngle(Cesium.Cartesian3.UNIT_Y, LANDER_YAW, new Cesium.Quaternion());
      if (attachIfReady(ls)) { showSlot(ls); placeModelS(ls, landerPos, landerQuat, LANDER_SCALE, MOON_ELLIPSOID); }  // ×1.4 与下降段一致
      hideSlot(loiCraftSlot);
      // 月球车：前进 +X（Y→Z 轴校正后即 ENU 东向），按航向绕天顶旋转；
      // 轮子动画 REPEAT ×1.85（模型内一圈 0.86s ≈ 1.16 转/秒 ≈ 1.16 m/s；
      // 26 m ÷ 12 s ≈ 2.17 m/s → 倍率 2.17/1.16 ≈ 1.85）
      const rs = getRoverSlot();
      if (attachIfReady(rs)) {
        moonCraft.billboard.show = false;
        if (rs4 <= 0) {
          hideSlot(rs);   // 双翼展开前玉兔仍在着陆器上，不单独显示
        } else {
          showSlot(rs);
          // 2026-10-24：×2/3 缩小（用户「月兔相对着陆器太大」），minPx 同步降到 53 保证远机位也变小
          placeModelS(rs, roverPos, roverQuat, ROVER_SCALE, MOON_ELLIPSOID);
          // 坑（2026-10-17 冒烟实测）：sceneGraph 要模型首次 update 后才有，未就绪时
          // activeAnimations.add 抛 TypeError，且异常穿出 tick 会杀死整个 rAF 循环（第四幕冻住）。
          // 判 sceneGraph 存在再 add；本帧未就绪则下一帧 render 自然重试（animOn 仍为 false）。
          if (rs.animCount > 0 && !rs.animOn && !rs.model.isDestroyed() && rs.model.sceneGraph) {
            // 2026-10-23 对齐轮转与位置速度（9.3 m/s ≈ 位置 ~10 m/s，消除滑行感；之前 1.3× 太慢像飘）
            rs.model.activeAnimations.add({ index: 0, loop: Cesium.ModelAnimationLoop.REPEAT, multiplier: 8 });
            rs.animOn = true;
          }
        }
      } else {
        moonCraft.billboard.show = true;
        moonCraft.billboard.image = SPACECRAFT_ICON;
      }
      updateFlame(mv, null, null, 0, MOON_ELLIPSOID);
      updateRcs(mv, null, null, 0, MOON_ELLIPSOID);
      // 相机取着陆器与月球车中点、沿行进方向（航向 ~109°）俯瞰；2026-10-22 末用户：镜头拉起
      //   ~5 个滚轮范围（38→240m），以露出月面瓦片细节（过于放大只剩灰扑扑一片）。
      const mid = Cesium.Cartesian3.midpoint(landerPos, roverPos, new Cesium.Cartesian3());
      if (camOverride) applyManualFollow(mv, mid);
      // 2026-10-24：参数收进 ACT4_CAM，第三幕末已提前收敛到此 → 跨幕不再有机位跳变
      else applyFollow(mv, mid, ACT4_CAM.heading, Cesium.Math.toRadians(ACT4_CAM.pitchDeg), ACT4_CAM.range);
    }
  }

  // ---- 进度跳转：跨幕时同步补建/清理场景与实体 ----
  function seekTo(f) {
    // ⭐ 2026-10-24 NaN 入口加固：非有限进度直接忽略（保留上一帧 p）。
    //   踩坑实录：冒烟脚本用过时的 timeline() 键名（transferEnd/captureEnd/card3End/loiEnd，
    //   2026-10-22 五幕合并后已不存在）算出 seek(NaN) → clamp01(NaN)=NaN 一路传到第四幕
    //   pts[NaN]=undefined → TypeError @5218 + Cesium「normalized result is not a number」
    //   整渲染停摆。拖拽/外部调用同样可能喂 NaN，这里统一挡掉。
    if (!Number.isFinite(f)) return;
    p = clamp01(f);
    // ⭐ 2026-10-23「回拖后轨道线分叉」：跳转是**任意方向**的（可能从 0.9 拖回 0.05），
    //   渐进裁剪只在逐帧推进时生效，跳变处必须显式复位轨迹与分离件，否则旧点/旧件残留。
    launchTrail = [];
    launchCarts = [];
    ceTrail = [];
    _relayTrail = []; relayTrailCarts = [];   // 鹊桥已飞轨迹随 seek 复位（回拖截断/跳转变清空）
    trailCarts = transferCarts.length ? transferCarts.slice(0, 1) : [];
    clearSeparators();
    if (!transferCarts.length) buildPathData();
    if (p < T.card2End) {
      // 地球侧（含捕获幕与幕卡 3）：若在月球段则切回
      _prevInDescent = false;
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
    // 2026-10-23 加固：seek 内的 render 也包 try/catch——此前拖进度条到第四/五幕若 render 抛错
    // 会作为 Uncaught 杀死事件处理（拖拽卡死）。正常路径不应触发（根因 ReferenceError 已修复）。
    try { render(); } catch (e) { reportMissionError(e, 'seekRender'); }
    ensureTourPanelOwned();      // 拖进度条跨幕：面板可能被第三方收尾带走，顺手取回
    const bar = $('tourBar');
    if (bar) bar.style.width = (p * 100).toFixed(2) + '%';
    const txt = $('tourProgressText');
    if (txt) txt.textContent = Math.round(p * 100) + '%';
  }

  // —— 渲染/异常上报（2026-10-23 加固）：真实报错直接打到屏幕横幅，用户无需开 devtools ——
  function reportMissionError(e, tag) {
    const key = tag + '::' + ((e && e.message) || String(e));
    if (!tick._warned) tick._warned = new Set();
    if (!tick._warned.has(key)) {
      tick._warned.add(key);
      console.warn('[moonMission] ' + tag + ' 异常（循环继续）：', e);
    }
    showMissionErrorBanner(tag, e);
  }
  function showMissionErrorBanner(tag, e) {
    let el = document.getElementById('missionError');
    if (!el) {
      el = document.createElement('div');
      el.id = 'missionError';
      el.style.cssText = 'position:fixed;left:8px;bottom:8px;max-width:46vw;z-index:99999;'
        + 'background:rgba(176,28,28,.93);color:#fff;font:12px/1.5 ui-monospace,Consolas,monospace;'
        + 'padding:8px 10px;border-radius:6px;white-space:pre-wrap;pointer-events:none;';
      (document.body || document.documentElement).appendChild(el);
    }
    const msg = (e && e.message) || String(e);
    // 去重计数，避免同错刷屏
    const t = (tick._errCount = (tick._errCount || 0) + 1);
    el.textContent = '⚠ 探月渲染异常[' + tag + ']：' + msg
      + '\n（进度继续推进；请截图/复制反馈 · 累计 ' + t + ' 次）';
  }

  // ---- 3-1 幕间等待：月面影像/地形瓦片落盘前冻结进度（2026-10-24 用户需求）----
  //   判据沿用左上 #tileDot 的同源公开 getter：globe.tilesLoaded（O(1)，无需事件钩子，
  //   且天然兼容月球 viewer 的销毁重建）。
  //   minMs = 无论如何都停这么久（给观众一个清晰的「进入月面场景」呼吸）；
  //   maxMs = 兜底上限，网络再慢也不能把演示卡死（headless / 离线时走这条）。
  const MOON_GATE = { minMs: 1400, maxMs: 9000, t0: 0, started: false, passed: false };
  function moonSceneReady() {
    let mv = null;
    try { mv = env.getMoonViewer(); } catch { return false; }
    if (!mv) return false;
    if (typeof mv.isDestroyed === 'function' && mv.isDestroyed()) return false;
    try {
      return !!(mv.scene && mv.scene.globe && mv.scene.globe.tilesLoaded);
    } catch { return false; }
  }
  /** 返回 true = 本帧冻结进度（不推进 p） */
  function moonGateHold(curP) {
    if (curP < T.card2End || curP >= T.touchEnd) {   // 不在第三幕窗口 → 复位（支持回拖重播）
      MOON_GATE.started = false; MOON_GATE.passed = false;
      return false;
    }
    if (MOON_GATE.passed) return false;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (!MOON_GATE.started) { MOON_GATE.started = true; MOON_GATE.t0 = now; }
    const waited = now - MOON_GATE.t0;
    if (waited >= MOON_GATE.maxMs || (waited >= MOON_GATE.minMs && moonSceneReady())) {
      MOON_GATE.passed = true;
      return false;
    }
    try {
      setPhase('第三幕 · 环月与动力下降 · 等待月面影像加载… ' + (waited / 1000).toFixed(1) + ' s');
    } catch { /* 忽略 */ }
    return true;
  }

  function tick(now) {
    if (!playing && p >= 1) { raf = 0; return; }
    // 2026-10-23 加固：整段包 try/catch + 末尾无条件 reschedule —— 任何异常都绝杀不死 rAF 循环
    // （此前若 render 在第四/五幕每帧抛错被吞，会表现为「进度/画面冻住」）。
    try {
      const dt = last ? (now - last) / 1000 : 0;
      last = now;
      frameDt = Math.min(0.1, Math.max(0.001, dt));
      if (playing) {
        const prevP = p;
        // ⭐ 2026-10-24 用户「3-1 幕间停顿一会，等月球贴图加载完毕再开始后续动画」：
        //   第三幕开头先蹲 MOON_GATE.minMs，并可续等到最多 maxMs——判据 = 月球 viewer 的
        //   globe.tilesLoaded（公开 O(1) getter，与左上 #tileDot 同源）。任阶段 render 照常执行，
        //   只是**不推进进度**，观众看到的是「画面已就位、解说停在等待」而不是「在白球上播完」。
        if (moonGateHold(p)) {
          /* 冻结进度：不 p += ... */
        } else {
          p += (dt / BASE_DURATION) * mult * rateAt(p);
        }
        // p NaN/Inf 守卫：一旦为非法值，回退上一帧并告警，避免进度永久卡死（模型消失+冻结的根因之一）
        if (!isFinite(p)) {
          console.error('[moonMission] 进度 p 变 NaN，已回退上一帧', { dt, mult, prevP, rate: rateAt(prevP) });
          showMissionErrorBanner('pNaN', { message: '进度 p 变 NaN（dt=' + dt + ' mult=' + mult + '）' });
          p = prevP;
        } else if (p >= 1) {
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
        reportMissionError(e, 'render');
      }
      // —— 焦点物体跟随（2026-10-24）：render 内部有多处提前 return（地球侧/月球侧），
      //    所以放在 render 调用之后、tick 的 try 块内——任何路径每帧都会执行：
      //    ① collectFocus 收集各物体世界坐标；② focusTarget 有效时覆盖脚本机位（推荐视角+跟踪）；
      //    ③ 刷新底部第一行「跟踪」按钮排（内部有 key 缓存，仅在幕变化时重建 DOM）。
      try {
        collectFocus();
        applyFocusCam();
        updateFocusRow();
      } catch (e) {
        console.error('[focus-err]', e && (e.stack || e.message) || e);
        reportMissionError(e, 'focus');
      }
      // requestRenderMode 下必须主动请求渲染，否则静态相机帧里火箭/飞船不重绘（画面冻住）。
      // ⚠ 地球容器在第四/五幕被 display:none 隐藏——对隐藏 viewer 调 requestRender 在部分
      //   Cesium/浏览器下会抛错，且原代码它位于 try/catch 之外 → 会杀死整个 rAF 循环（表现为
      //   「第四/五幕冻结 + 卫星 3D 模型停在 2D 图标」）。故：① 包 try/catch；② 隐藏时直接跳过。
      try {
        const ec = document.getElementById('cesiumContainer');
        if (!ec || !ec.classList.contains('hidden')) earthViewer.scene.requestRender();
      } catch (e) { reportMissionError(e, 'earthRender'); }
      const mv = env.getMoonViewer();
      if (mv) { try { mv.scene.requestRender(); } catch (e) { reportMissionError(e, 'moonRender'); } }
      const bar = $('tourBar');
      if (bar) bar.style.width = (p * 100).toFixed(2) + '%';
      const txt = $('tourProgressText');
      if (txt) txt.textContent = Math.round(p * 100) + '%';
    } catch (e) {
      // 兜底层：任何意外异常都不能杀死 rAF 循环
      reportMissionError(e, 'tick');
    }
    raf = requestAnimationFrame(tick);
  }

  function bindPanel() {
    const pb = $('tourPause');
    if (pb) {
      pb.classList.remove('hidden');
      pb.textContent = '暂停';
    }
    // 视角模式按钮（2026-10-18 双模式）：AUTO 时只显示状态；MANUAL/焦点跟踪中点击回推荐机位
    const cb = $('tourCamMode');
    if (cb) {
      cb.classList.remove('hidden');
      cb.addEventListener('click', () => {
        // ⚠ 2026-10-24 修「焦点跟踪中无法回推荐视角」：除 MANUAL 外，焦点跟踪态
        //   （camOverride=false 但 focusTarget 有效）也可通过本按钮取消跟踪、回脚本机位。
        if (!camOverride && !focusTarget) return;
        if (focusTarget) { focusTarget = null; updateFocusRow(); }
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
    // ⭐ 2026-10-23 修「分离瞬间旧形态残留」：四种形态模型在 start 时并行预热加载。
    //   旧逻辑里 rocketUpper/craft 槽位直到 stage 切换才首次创建 → 冷加载 1–2s 内
    //   updateRocketModel 返回 false、上一形态 model.show 仍是 true（画面残留旧火箭）。
    //   提前加载后分离瞬间模型必然就绪，形态切换无缝。
    getRocketCoreSlot(); getRocketUpperSlot(); getCraftSlot();
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
    $('moonPip')?.classList.add('hidden');   // 画中画随任务停止收起（render 循环已停，必须显式隐藏）
    setRelayVisible(false);                  // 鹊桥中继星（entity 仍在 earthViewer，须显式移除）
    if (relayEnt) { earthViewer.entities.remove(relayEnt); relayEnt = null; }
    if (relayOrbEnt) { earthViewer.entities.remove(relayOrbEnt); relayOrbEnt = null; }
    if (relayLinkEnt) { earthViewer.entities.remove(relayLinkEnt); relayLinkEnt = null; }
    if (relayTrailEnt) { earthViewer.entities.remove(relayTrailEnt); relayTrailEnt = null; }
    _relayTrail = []; relayTrailCarts = [];
    clearSeparators();          // 内含分离件 slot 销毁
    for (const s of slots.slice()) destroySlot(s);
    rocketSlot = rocketCoreSlot = rocketUpperSlot = craftSlot = loiCraftSlot = landerSlot = roverSlot = null;
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
    if (transferGhostEnt) { earthViewer.entities.remove(transferGhostEnt); transferGhostEnt = null; }
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
    hideNarration();
    inMoon = false;
    $('rocketPhase')?.classList.add('hidden');
    $('tourPanel')?.classList.add('hidden');
    $('tourPause')?.classList.add('hidden');
    $('tourTicks').innerHTML = '';
    env.onStatus?.('探月任务已停止', '');
  }

  /** ⭐ 月球圆盘像素统计（闭包内共享，供 debugMoonPixels / debugMoonTex 用）。
   *  ⚠ preserveDrawingBuffer=false：drawImage(webglCanvas) 必须同一同步块内紧跟 render，
   *    跨 await 后缓冲已被合成器清空 → 读到全黑（2026-10-20 排查实测）。 */
  function moonPixelStats() {
    const v = earthViewer, ent = moonEnt;
    if (!ent) return { err: 'moonEnt 未创建' };
    const now = Cesium.JulianDate.now();
    v.scene.requestRender(); v.scene.render(now);
    const pos = ent.position.getValue(now);
    const sw = Cesium.SceneTransforms.worldToWindowCoordinates(v.scene, pos);
    if (!sw) return { err: '月心不在屏幕内' };
    const R = ent.ellipsoid.radii.getValue(now).x;
    const right = Cesium.Cartesian3.normalize(v.camera.rightWC, new Cesium.Cartesian3());
    const p2 = Cesium.Cartesian3.add(pos,
      Cesium.Cartesian3.multiplyByScalar(right, R, new Cesium.Cartesian3()), new Cesium.Cartesian3());
    const sw2 = Cesium.SceneTransforms.worldToWindowCoordinates(v.scene, p2);
    const pr = Math.max(8, Math.abs(sw2.x - sw.x));
    const cv = v.canvas;
    const c2 = document.createElement('canvas'); c2.width = cv.width; c2.height = cv.height;
    const g2 = c2.getContext('2d'); g2.drawImage(cv, 0, 0);
    const RR = Math.round(pr * 0.62);
    const x0 = Math.max(0, Math.round(sw.x) - RR), y0 = Math.max(0, Math.round(sw.y) - RR);
    const wpx = Math.min(2 * RR, c2.width - x0), hpx = Math.min(2 * RR, c2.height - y0);
    const dd = g2.getImageData(x0, y0, wpx, hpx).data;
    const L = [], LR = [], LG = [], LB = [];
    for (let i = 0; i < dd.length; i += 4) {
      if (dd[i + 3] < 200) continue;
      const px = (i / 4) % wpx, py = Math.floor((i / 4) / wpx);
      const dx = px - wpx / 2, dy = py - hpx / 2;
      if (dx * dx + dy * dy > RR * RR * 0.9) continue;
      LR.push(dd[i]); LG.push(dd[i + 1]); LB.push(dd[i + 2]);
      L.push(dd[i] * 0.3 + dd[i + 1] * 0.6 + dd[i + 2] * 0.1);
    }
    L.sort((a, b) => a - b);
    const q = (f) => Math.round(L[Math.floor(L.length * f)] || 0);
    // ⭐ 逐通道中位数：把「贴图到底有没有上屏」变成**可判定数字**，不再靠肉眼。
    //   判据：紫图成功 medB >> medG 且 medR 居中(#8a2be2 ⇒ 138/43/226，受明暗缩放同比例)；
    //         白球(纹理上传失败) ⇒ medR≈medG≈medB≈255；灰程序化 ⇒ 三通道接近且明显低于 255。
    const qc = (arr) => { if (!arr.length) return -1;
      const c = arr.slice().sort((a, b) => a - b); return c[Math.floor(c.length * 0.5)]; };
    return { pxRadius: +pr.toFixed(1), n: L.length, p25: q(0.25), med: q(0.5), p75: q(0.75),
      medR: qc(LR), medG: qc(LG), medB: qc(LB) };
  }
  /** 多帧渲染等待（换材质后 Cesium 要重建 batch，只渲一帧读到的还是旧画面） */
  // ⚠ 实测：只等 3×60ms 不够——换材质后画面还在过渡，builtin/white 扫出来与 bright 无区别
  //   （2026-10-20）。6×80ms ≈ 0.5s 足够稳定（实机 GPU 每帧 ~16ms）。
  //   ⚠ 别再加大：SwiftShader 每帧数秒，headless 冒烟里这段会拖到几分钟。
  async function moonRenderFrames(n = 6, gap = 80) {
    const v = earthViewer;
    for (let i = 0; i < n; i++) {
      v.scene.requestRender(); v.scene.render(Cesium.JulianDate.now());
      await new Promise((r) => setTimeout(r, gap));
    }
  }

  const apiRef = {
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
        act2HalfKm: _act2Cam.halfKm,
        act2DRelayKm: _act2Cam.dRelayKm,
        act2RelayVis: _act2Cam.relayVis,
      },
      // 各 viewer 的相机位姿 + 焦点世界坐标（诊断「主体是否真的在视锥里」：看们的世界关系，
      //   而不是只看屏幕坐标——屏幕坐标 off-canvas 时无法区分「相机还没转过去」与「目标跑远」）
      views: (() => {
        const dumpCam = (v) => {
          try {
            if (!v || (typeof v.isDestroyed === 'function' && v.isDestroyed())) return null;
            const c = v.camera;
            const p = new Cesium.Cartesian3(), d = new Cesium.Cartesian3();
            Cesium.Cartesian3.clone(c.positionWC, p); Cesium.Cartesian3.clone(c.directionWC, d);
            return { pos: [p.x, p.y, p.z], dir: [d.x, d.y, d.z] };
          } catch { return null; }
        };
        let mv = null;
        try { mv = env.getMoonViewer(); } catch { /* 忽略 */ }
        const fw = {};
        for (const k of Object.keys(FOCUS_POS)) {
          const fp = FOCUS_POS[k];
          if (fp && fp.cart && isFinite(fp.cart.x)) fw[k] = [fp.cart.x, fp.cart.y, fp.cart.z];
        }
        return { earth: dumpCam(earthViewerRef), moon: dumpCam(mv), focusW: fw };
      })(),
      // 各焦点物体的屏幕像素坐标（含所在 viewer 的画布尺寸）：判断「主体是否在画面可见区内」
      focusScreen: (() => {
        const out = {};
        for (const k of Object.keys(FOCUS_POS)) {
          const fp = FOCUS_POS[k];
          const v = fp && fp.v;
          if (!v || !fp.cart) continue;
          try {
            if (typeof v.isDestroyed === 'function' && v.isDestroyed()) continue;
            const cv = v.scene && v.scene.canvas;
            const sw = Cesium.SceneTransforms.worldToWindowCoordinates(v.scene, fp.cart, new Cesium.Cartesian2());
            out[k] = {
              scr: sw ? [Math.round(sw.x), Math.round(sw.y)] : null,
              canvas: cv ? [cv.clientWidth, cv.clientHeight] : null,
            };
          } catch { /* 忽略 */ }
        }
        return out;
      })(),
      relay: (() => {
        if (!relayEnt) return null;
        return {
          show: !!relayEnt.show,
          ringN: _relayRing.length,
          // Halo 环是否闭合（首尾点距离，km）：≈0 表示整圈完整，不闭合=画成了半圈/开口弧
          ringClosedKm: _relayRing.length > 1
            ? +(Cesium.Cartesian3.distance(_relayRing[0], _relayRing[_relayRing.length - 1]) / 1000).toFixed(0)
            : null,
          dMoonKm: _ceMoon ? Math.round(Cesium.Cartesian3.distance(_relayPos, _ceMoon) / 1000) : null,
          dEarthKm: Math.round(Cesium.Cartesian3.magnitude(_relayPos) / 1000),
          trailN: _relayTrail.length,
          trailSpanKm: _relayTrail.length > 1
            ? Math.round(Cesium.Cartesian3.distance(_relayTrail[0].c, _relayTrail[_relayTrail.length - 1].c) / 1000)
            : null,
          trailShow: relayTrailEnt ? !!relayTrailEnt.show : null,
        };
      })(),
      // 第二幕每帧快照（视诊断：喷流 ENU 方向 vs 飞船位置，用来判断「点火是加速还是减速」；
      //   matCols = 姿态三轴世界方向，用来判断「卫星是否沿轨道改变方向」）
      act2dbg: _dbgAct2 || null,
      // 第四幕每帧快照（时序诊断：扬尘/展翼/玉兔三者的进度相位）
      act4dbg: _dbgAct4 || null,
      // 当前焦点跟踪目标（视角按钮「🎯 推荐视角」行为判定用）
      focus: focusTarget,
      // 第一幕分离件快照（每瓣世界坐标，用来判断「沿轨道飞走」还是「垂直坠地」）
      sepdbg: (() => {
        const mapV = (v) => ({ x: v.x, y: v.y, z: v.z });
        // 母体（火箭/飞船）当前世界坐标：用于把「分离件相对漂移」投影到**飞行方向**上判定
        //   「沿轨道飞走」还是「径向垂直地面」（诊断用，取不到时给 null）
        let rk = null;
        try {
          const c = earthRocket && earthRocket.position
            && earthRocket.position.getValue(earthViewerRef.clock.currentTime);
          if (c && isFinite(c.x)) rk = mapV(c);
        } catch { /* 忽略 */ }
        return {
          rocket: rk,
          booster: boosters.map((b) => mapV(b.baseCart)),
          fairing: fairings.map((f) => ({ pos: mapV(f.ent.position.getValue(Cesium.JulianDate.now()) || f.baseCart), base: mapV(f.baseCart) })),
          core: cores.map((c) => ({ pos: mapV(c.ent.position.getValue(Cesium.JulianDate.now()) || c.baseCart), base: mapV(c.baseCart) })),
        };
      })(),
      moonTex: _moonTexState,           // 月面贴图状态：loading | ok | fail:<原因>
      moonTexMode: _moonTexMode,       // proc（默认程序化）| image:<i>（真实照片已挂）| proc-fallback（白球回退）
      moonTexAuto: _moonTexAuto,       // 自检结论：ok | reverted-to-proc(...) | wait:... | err:...
      moonTexReady: !!_moonTexImg,
      // ⭐ 捕获幕「来时路」虚线诊断（2026-10-21）：ghost = 主视图 transferGhostEnt 的折线；
      //   pipTransRel = 画中画虚线的预计算平面坐标（与主视图同源，长度应 ≈385）
      ghost: (() => {
        const n = ghostCarts.length;
        if (!n) return { n: 0, show: transferGhostEnt ? !!transferGhostEnt.show : null };
        const mc = moonCartAt(act2Progress(p));
        const km = (c) => Math.round(Cesium.Cartesian3.distance(c, mc) / 1000);
        return {
          n, show: transferGhostEnt ? !!transferGhostEnt.show : null,
          firstKm: km(ghostCarts[0]),                       // 2026-10-21 裁剪后 ≈ clipKm（原为地月距）
          lastKm: km(ghostCarts[n - 1]),                    // ≈ 20,599（会合点 = 环起点）
          // T+11d4h = 268 h 在虚线上的对应点：时间进度 → 偏近点角（transferENorm）→ 数组索引。
          //   ⚠ 索引必须乘 **768**（= transferCarts 的 E 均匀网格步长），不是数组长度 385——
          //     transferRelCarts 只是转移弧的**已飞前缀**（E 到 ≈π 为止，约占网格一半）。
          //     交叉验证：该点月心距应与 orbit-continuity-probe 在 h=268 采到的 45,647 km 一致。
          kmAt268h: (() => {
            const s268 = 268 / CH_TOTAL_H;
            const u268 = (s268 - P2.phasingEnd) / (P2.enc - P2.phasingEnd);
            const i = Math.round(transferENorm(u268) * 768);
            // ⚠ 2026-10-21 裁剪后 ghostCarts 是后缀（前 j0 点被裁）→ 直接按 transferRelCarts 索引
            const q = transferRelCarts[Math.min(transferRelCarts.length - 1, i)];
            return { i, km: q ? Math.round(Cesium.Cartesian3.magnitude(q) / 1000) : null };
          })(),
        };
      })(),
      pipTransRelN: pipTransRel.length,
      // 2026-10-21 五修诊断：moonTexMode = image:<候选下标>；moonTexAuto = 自动扫盘自检结果
      moonTexMode: _moonTexMode,
      moonTexAuto: _moonTexAuto,
      gl: (() => {
        try {
          const gl = earthViewer.scene.context._gl;
          const d = gl.getExtension('WEBGL_debug_renderer_info');
          return { renderer: d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'n/a',
            webgl2: !!earthViewer.scene.context.webgl2 };
        } catch { return null; }
      })(),
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
      /** ⭐ 诊断（2026-10-21）：捕获段「入站转移弧」与「捕获环」是否在空间上折了角。
       *  量两个真值（与相机无关）：
       *   · tangentAngleDeg = 转移弧入站切线 与 捕获环起点切线 的夹角：0/180°=平滑连续，90°=折；
       *   · dihedralDeg = 两线各自所在平面法向的夹角：0°=共面，90°=垂直（即空间上折了 90°）；
       *   · junctionKm = 两线在会合点的间距（应≈0，证明位置衔接未撕裂）。
       *  用**未裁剪**的 transferRelCarts + ringCarts 计算，不受视图裁剪影响。 */
      fold: () => {
        try {
          const G = transferRelCarts, R = ringCarts;
          const V = (a, b) => { const x = b.x - a.x, y = b.y - a.y, z = b.z - a.z; const m = Math.hypot(x, y, z) || 1; return { x, y, z }; };
          const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
          const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
          const ang = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * 180 / Math.PI;
          const nG = G.length, nR = R.length;
          const tg = nG >= 3 ? V(G[nG - 2], G[nG - 1]) : null;
          const tr = nR >= 2 ? V(R[0], R[1]) : null;
          const nGv = nG >= 3 ? cross(V(G[0], G[(nG / 2) | 0]), V(G[(nG / 2) | 0], G[nG - 1])) : null;
          const nRv = nR >= 3 ? cross(V(R[0], R[(nR / 2) | 0]), V(R[(nR / 2) | 0], R[nR - 1])) : null;
          const junctionKm = (nG && nR) ? Math.hypot(G[nG - 1].x - R[0].x, G[nG - 1].y - R[0].y, G[nG - 1].z - R[0].z) / 1000 : null;
          return {
            nG, nR,
            tangentAngleDeg: (tg && tr) ? +ang(tg, tr).toFixed(2) : null,
            dihedralDeg: (nGv && nRv) ? +(180 - Math.abs(ang(nGv, nRv) - 180)).toFixed(2) : null,
            junctionKm: junctionKm != null ? +junctionKm.toFixed(2) : null,
            sign: 'tangent 0/180=平滑; 90=折; dihedral 0=共面; 90=垂直折',
          };
        } catch (e) { return { err: String(e) }; }
      },
      /** ⭐ 2026-10-22 第 12 轮：捕获段「上下翻转」运行时 A/B 开关（用户要对比「之前的 demo」）。
       *  setCapFlip(-1) = 第 6 轮翻转版（绕行反向，入站掉头/V 形）；
       *  setCapFlip(+1) = 第 11 轮相切版（入站平滑承接大弧）。
       *  注意：切换会清 captureBasis 缓存 → 捕获环/飞船/已飞弧/画中画整体换向，
       *  建议暂停（tourPause）后再切，切换后 seek 一次或等几帧即稳定。 */
      capFlip: () => CAP_FLIP_Y,
      setCapFlip: (v) => {
        CAP_FLIP_Y = (v < 0) ? -1 : 1;
        _capRhat = null; _capThat = null;   // 清缓存，下次 captureBasis() 重算
        // ⚠ ringCarts（捕获环 + 已飞弧）受 ringBuiltS 缓存、暂停时不重算 → 主动重建，
        //   否则切 flip 后环形反向、ringCarts 仍是旧 flip 方向，fold 量不到、画面不同步。
        if (ringCarts.length && typeof ringBuiltS === 'number') rebuildCaptureRings(ringBuiltS, _moonExagNow);
        else ringBuiltS = -999;   // 触发进入捕获段后首帧重建
        return CAP_FLIP_Y;
      },
      /** ⭐ 2026-10-20 定稿：主视图取景参考系 A/B 开关（用户口径「是否始终逆时针绕轨道」）。
       *  setFrameEarth(true)  = 地球惯性系（定稿）：相机目标钉在地球系固定锚点，
       *    屏幕位移 = 飞船绝对速度 ⇒ 绕地恒逆时针、接近段向 −e2（下），两幕同向。
       *  setFrameEarth(false) = 旧「跟随月球」版：月球居中，但屏幕变成月球系，
       *    飞船翻成 +e2（向上）（因为月球 1.02 km/s ≫ 飞船 0.18 km/s）。 */
      frameEarth: () => _frameEarth,
      setFrameEarth: (v) => {
        _frameEarth = !!v;
        return _frameEarth;
      },
    }),
    /** 调试/冒烟：跳转到指定进度（跨幕自动补建/清理场景） */
    seek: (f) => seekTo(f),
    /** 冒烟诊断：画中画（月心系同步视图）状态。craftPx = 飞船在画中画画布上的像素位置
     *  （showCraft=false 的幕卡期间为 null）；rel = 月心相对坐标 km（面内 e1/e2）。
     *  同步性断言：craftPx 应等于用 rel + fitKm 按 (W/2, H/2+6)、px=(H*0.46)/fitKm 重算的位置。 */
    debugPip: () => ({
      visible: !$('moonPip')?.classList.contains('hidden'),
      fitKm: _pip.fitKm,
      rel: _pip.rel,
      craftPx: _pip.craftPx,
      corner: _pip.corner,
      canvas: pipCv ? [pipCv.width, pipCv.height] : null,
      moonPx: pipCv ? [pipCv.width / 2, pipCv.height / 2 + 6] : null,
    }),
    /** 右上角导航控件是否应锁定：仅第二幕（地月顶视构图）锁，第一/三/四幕保留给用户操作 */
    navLocked: () => p >= T.card1End && p < T.card2End,
    /** ⭐ 诊断：月球圆盘像素统计（2026-10-20 白球排查专用，可在用户浏览器里一键跑）。
     *  直接在用户机器上判定「贴图有没有真的贴上去」：
     *    贴图生效 → now.med ≈ 130~160、p25~p75 有明显月海明暗分布（headless 实测 131/149/163）
     *    白球（材质未生效）→ now.med ≈ 240+ 且与 whiteRef 几乎一致
     *  顺带做一次「临时换成纯白材质」的对照扫描（whiteRef），扫完自动还原。 */
    debugMoonPixels: async () => {
      const out = { tex: _moonTexState, mode: _moonTexMode, p: +p.toFixed(4), moonExag: +_moonExagNow.toFixed(2) };
      try {
        if (!moonEnt) return { ...out, err: 'moonEnt 未创建' };
        await moonRenderFrames();
        out.now = moonPixelStats();
        const saved = moonEnt.ellipsoid.material;
        moonEnt.ellipsoid.material = new Cesium.ColorMaterialProperty(Cesium.Color.WHITE);
        await moonRenderFrames();
        out.whiteRef = moonPixelStats();       // 对照组：纯白球长什么样
        moonEnt.ellipsoid.material = saved;    // 还原
        await moonRenderFrames();
      } catch (e) { out.err = String((e && e.message) || e); }
      return out;
    },
    /** ⭐ 一键换月面材质 + 立刻扫盘（2026-10-20 白球二分定位）。
     *  kind: 'bright'（我们的 2K 提亮图 / canvas 源）| 'builtin'（Cesium 自带 moonSmall 256×128）
     *        | 'gray'（兜底灰 #c9ced8）| 'white'（纯白参照）
     *  用法：A/B 控制实验定位「Entity 椭球能否贴图」：
     *   - debugMoonTex('purple')：纯紫 PNG，与 WAC 同路径(ImageMaterialProperty)。显紫=纹理上传链路正常；
     *     白球/灰=链路坏（依赖程序化）。
     *   - debugMoonTex('st')：把球面 UV 画成颜色(红=经度 绿=纬度)。红绿渐变=st 正常、程序化特征应可见；
     *     整球单色=st 异常（需改用表面法线推导 UV）。
     *   - debugMoonTex('builtin')：Cesium 自带 moonSmall.jpg，独立图片控制。
     *   - debugMoonTex('proc'|'bright'|'gray'|'white')：程序化/真实照片/灰/白。 */
    debugMoonTex: async (kind = 'bright') => {
      if (!moonEnt) return { err: 'moonEnt 未创建' };
      // ⭐ 全部对照组一律走「自发光」材质：本场景实体椭球不受光，任何 diffuse 系材质都会渲染成黑球
      //   （实测纯白 ColorMaterialProperty 的 p25=6），会让所有对照实验假阴性。
      const gray = () => new MoonFlatMaterialProperty(Cesium.Color.fromCssColorString('#c9ced8'));
      if (kind === 'bright') {
        moonEnt.ellipsoid.material = new MoonTexMaterialProperty(_moonTexImg || MOON_TEX_SOURCES[0]);
      } else if (kind === 'builtin') {
        moonEnt.ellipsoid.material = new MoonTexMaterialProperty(
          (window.CESIUM_BASE_URL || '/vendor/cesium/') + 'Assets/Textures/moonSmall.jpg');
      } else if (kind === 'purple') {
        // 控制实验：纯紫 PNG。显紫=贴图链路上得去；黑=纹理上传失败（那就死守程序化）
        moonEnt.ellipsoid.material = new MoonTexMaterialProperty('/lunar/purple_256.png');
      } else if (kind === 'st') {
        moonEnt.ellipsoid.material = new MoonSTMaterialProperty();   // UV 可视化诊断
      } else if (kind === 'proc') {
        moonEnt.ellipsoid.material = new MoonSurfaceMaterialProperty();
      } else if (kind === 'gray') {
        moonEnt.ellipsoid.material = gray();
      } else if (kind === 'white') {
        moonEnt.ellipsoid.material = new MoonFlatMaterialProperty(Cesium.Color.WHITE);
      }
      await moonRenderFrames();
      return { kind, ...(await apiRef.debugMoonPixels()) };
    },
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
    /** 冒烟诊断（2026-10-19「转移→捕获衔接反向」修复的守门断言）：衔接点两侧的速度方向。
     *  返回 { relDegIn/Out, geoDegIn/Out, relFlipDeg, geoFlipDeg, diffDeg, rKm }：
     *   · rel = 月心系速度方向（画中画月球坐标系里看到的）；
     *   · geo = 地心系速度方向（顶视画面里用户看到的「前进方向」）。
     *  ⭐ 旧版反向的数值特征：geoFlipDeg = 144.4°（会合点放在 ×8 近月点，该处月心系速度
     *     2.06 km/s > 月球公转 1.02 km/s → 地心系速度从 −131.6° 翻到 +84°）。
     *  新版（抵达在远月点、真实比例）：geoFlipDeg ≈ 2.4°、relFlipDeg ≈ 5° —— 两个坐标系都不反向。 */
    debugAct2Dir: () => {
      const eps = 2e-4;
      const at = (ss) => {
        const mc = moonCartAt(ss);
        const sc = ss < P2.phasingEnd ? phasingCartAt(ss / P2.phasingEnd)
          : ss < P2.enc ? transferCartAt((ss - P2.phasingEnd) / (P2.enc - P2.phasingEnd))
            : captureCartAt((ss - P2.enc) / (1 - P2.enc));
        const [mx, my] = toPlaneKM(mc);
        const [sx, sy] = toPlaneKM(sc);
        return { rel: [sx - mx, sy - my], rhat: [mx, my] };
      };
      const velAt = (ss) => {
        const a = at(ss - eps), b = at(ss + eps);
        return {
          rel: [b.rel[0] - a.rel[0], b.rel[1] - a.rel[1]],
          geo: [b.rel[0] + b.rhat[0] - a.rel[0] - a.rhat[0], b.rel[1] + b.rhat[1] - a.rel[1] - a.rhat[1]],
          rhat: b.rhat,
        };
      };
      const deg = (v) => Math.atan2(v[1], v[0]) * 180 / Math.PI;
      const flip = (v1, v2) => {
        const m1 = Math.hypot(v1[0], v1[1]) || 1, m2 = Math.hypot(v2[0], v2[1]) || 1;
        return Math.acos(Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (m1 * m2)))) * 180 / Math.PI;
      };
      // 衔接点两侧各取 eps 邻域（转移侧 s=enc−0.001，捕获侧 s=enc+0.001，避免差分跨段）
      const vIn = velAt(P2.enc - 0.001), vOut = velAt(P2.enc + 0.001);
      const rm = Math.hypot(vOut.rhat[0], vOut.rhat[1]) || 1;
      const that = [vOut.rhat[1] / rm, -vOut.rhat[0] / rm];       // rhat × n̂（面内）
      return {
        relDegIn: +deg(vIn.rel).toFixed(2), relDegOut: +deg(vOut.rel).toFixed(2),
        geoDegIn: +deg(vIn.geo).toFixed(2), geoDegOut: +deg(vOut.geo).toFixed(2),
        relFlipDeg: +flip(vIn.rel, vOut.rel).toFixed(2),
        geoFlipDeg: +flip(vIn.geo, vOut.geo).toFixed(2),
        diffDeg: +flip(vOut.rel, that).toFixed(2),                 // 捕获侧 vs +that
        rKm: +rm.toFixed(0),                                       // 会合点月心距（应 = 20,599）
      };
    },
    /** 冒烟用时间轴常量（避免脚本里硬编码进度值，改幕长即失效）
     *  ⭐ 2026-10-24 补 act2 内部分段（五幕合并后冒烟还在找 transferEnd/captureEnd/
     *    card3End/loiEnd 这些死键名 → 算出 seek(NaN) 引发 5218 崩溃链，见 seekTo 加固注释）：
     *    · act2PhasingEnd = 调相段末（全局进度）
     *    · act2Enc        = 会合点 = 转移→捕获衔接（全局进度；两侧方向/位置连续性断言用它） */
    timeline: () => ({
      ...T, boosterSep: BOOSTER_SEP, fairingSep: FAIRING_SEP,
      act2PhasingEnd: T.card1End + (T.act2End - T.card1End) * P2.phasingEnd,
      act2Enc: T.card1End + (T.act2End - T.card1End) * P2.enc,
      rate: { ...ACT_RATE },
    }),
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
  return apiRef;   // 命名返回：debugMoonTex 需引用自身的 debugMoonPixels
}

// 动力下降曲线（第三幕，2026-10-17 重做）：s∈[0,1]
//   0~0.28 离轨制动（仍是飞船上面级）：100 km → 15 km，逆向主发动机
//   0.28~1 动力下降（着陆器）：15 km → 月面，先快后慢，末段收油门
// 水平位移（子午线大圆弧）不在本曲线内——由 render 的 latT = site.lat + lerp(40, 0, s)
// 按进度推进纬度（2026-10-18 定稿：与 LOI 同弧同向、自南向北）。
function descentProfile(s) {
  const s01 = clamp01(s);
  // 转移椭圆（2026-10-22 修 #3）：离轨制动(逆行点火)后转入近抛物/椭圆，apolune≈100km(制动点)，
  // perilune≈月面(着陆点)。按开普勒第二定律「近 apolune 慢、近 perilune 快」→ 高度先缓降(滑行)
  // 后俯冲(动力下降)，路径呈椭圆弧而非直线斜切。
  // ⚠ 简化说明：真实任务转移椭圆 apolune/perilune 相隔 180°(半圈滑行到背面着陆)；此处为「直接下降」
  //   (同近侧子午线，制动点 lat=site.lat-40 → 着陆点 lat=site.lat)，省去半圈滑行，属物理上可行的
  //   低燃料效率方案，但路径明显呈椭圆俯冲而非直线斜切。
  const drop = Math.pow(s01, 2.4);          // 缓→陡（贴合转移椭圆近 perilune 加速）
  const alt = 100000 * (1 - drop);
  const thrust = s01 < 0.1 ? 1 : (s01 > 0.55 ? 1 : 0.12); // 离轨点火 + 末段动力下降主发动机；中段滑行基本关机
  return { alt, thrust };
}

export default createMoonMission;
