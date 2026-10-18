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
const BASE_DURATION = 120; // 1× 全程秒数

// ====== 第二幕：地月转移（真实比例 + 霍曼椭圆，2026-10-17 重做） ======
// 全部距离以 km 计（日心→地心），最终落位时换算成米。
const EM = {
  mu: 398600.4418,        // 地球引力常数 km³/s²
  rE: 6378.137,           // 地球赤道半径 km
  leoAlt: 8000,           // 转移轨道近地点高度 km。⚠ 示意抬升：真实入轨 200 km，但真实比例的
                          // 调相/转移椭圆 e≈0.99，99% 弧长插在地球内部被球体吃掉，「一圈一圈」
                          // 永远不可见（2026-10-18 用户反馈）。与「月球体积 ×8」同类视觉处理，
                          // 抬到 8000 km 让整圈浮出地球圆盘；调相起点仍从 200 km 渐变衔接第一幕。
  moonDist: 384400,       // 地月平均距离 km（月心距）
  moonR: 1737.4,          // 月球真实半径 km
  moonExag: 8,            // 月球视觉放大倍数（轨道尺度真实，仅月球体积放大以便观察，UI 有标注）
  moonPeriod: 27.321661,  // 月球恒星周期（天）
};
EM.rp = EM.rE + EM.leoAlt;
EM.ra = EM.moonDist;
EM.a = (EM.rp + EM.ra) / 2;
EM.e = (EM.ra - EM.rp) / (EM.rp + EM.ra);
EM.tHalf = Math.PI * Math.sqrt(EM.a ** 3 / EM.mu);                 // 霍曼转移半周期（秒）≈ 4.96 天
EM.moonSweep = (2 * Math.PI / (EM.moonPeriod * 86400)) * EM.tHalf;  // 转移期间月球绕地角位移（rad）≈ 1.14

// —— 嫦娥一号式三段轨道（2026-10-18 重做，用户参考图拍板） ——
// 调相段（地球侧 2 圈渐扩椭圆，近地点点火抬升远地点 = 逐圈加速）
// → 地月转移大椭圆（近地快远月慢）→ 月球捕获段（绕月 2 圈渐收椭圆，近月点制动 = 逐圈减速）。
// 全部在 TR 轨道面内。⚠ 月球体积 ×8 示意（EM.moonExag），捕获段轨道相对**显示月球**取值
// 保证视觉自洽（真实 100km 轨道会钻进放大月球内部）。
const CH_RV_KM = EM.moonR * EM.moonExag;              // 显示月半径 km = 13,899
const CH_APO1 = 2.6 * CH_RV_KM;                       // 捕获圈 1 远月点（= 转移远地点与月心的间距）
const CH_RP0 = EM.rE + 200;                           // 调相起点近地点（衔接第一幕 200km 入轨）
const CH_RP1 = EM.rE + EM.leoAlt;                     // 示意近地点（= 转移近地点，圈内渐变衔接）
const CH = {
  phasing: [14000, 60000],   // 调相椭圆远地点高度 km（起点/终点各圈渐扩；近地点 200→8000 渐抬）
  capture: [                 // 捕获椭圆 [远月点, 近月点]（月心距 km，相对显示月球）
    [CH_APO1, 1.07 * CH_RV_KM],   // 圈 1（12h 量级示意）
    [1.45 * CH_RV_KM, 1.03 * CH_RV_KM],  // 圈 2（3.5h 量级示意）
  ],
};
// 第二幕内三段时间分配（s∈[0,1]）：调相 2 圈 → 转移 → 捕获 2 圈
const P2 = { phasingEnd: 0.30, transferEnd: 0.72 };
EM.moonC = EM.moonDist + CH_APO1;   // 捕获段月心距（km）：转移远地点 = 捕获圈 1 远月点

// 四个发射场中用于探月任务的低纬两个（数据与 moonmission 图层一致）
export const LAUNCH_SITES = {
  jiuquan: { lon: 100.298, lat: 40.96, name: '酒泉' },
  wenchang: { lon: 110.951, lat: 19.614, name: '文昌' },
};

// 幕时间边界（归一化 0..1）
const T = {
  liftEnd: 0.19,      // 第一幕结束（入轨 ~200km）★2026-10-17 加长：0.14 → 0.19
  card1End: 0.22,     // 幕卡 1 结束
  transferEnd: 0.60,  // 第二幕结束（抵达月球 = 转移轨道远地点）
  card2End: 0.64,     // 幕卡 2 结束
  loiEnd: 0.83,       // 环月制动段结束（开始离轨/动力下降）
  touchEnd: 0.93,     // 第三幕结束（触月）；0.93~1.00 为第四幕「玉兔巡视」
};
// 幕内推进倍率（2026-10-17 用户反馈「第一幕太快」）：tick 内 p += dt/BASE*mult*rateAt(p)。
//   第一幕：0.19 × 120s ÷ 0.6 ≈ 38 s（原 16.8 s，2.3× 慢放）
//   第四幕：0.07 × 120s ÷ 0.7 = 12 s（玉兔 26 m 行程 ≈ 2.17 m/s，与轮速 1.85× 匹配）
const ACT_RATE = { act1: 0.6, act4: 0.7 };
function rateAt(pp) {
  if (pp < T.liftEnd) return ACT_RATE.act1;
  if (pp >= T.touchEnd) return ACT_RATE.act4;
  return 1;
}
// 幕节点（进度条跳转锚点）
const ACTS = [
  { f: 0, name: '点火' },
  { f: T.card1End, name: '转移' },
  { f: T.card2End, name: '入月轨' },
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
 *  无参考系/读数异常时静默跳过 = 完全自由视角（第二幕即走这条路）。 */
function applyManualFollow(v, target) {
  if (!v || !camOverride) return;
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
    const e2 = Cesium.Cartesian3.normalize(Cesium.Cartesian3.subtract(
      _eastV, Cesium.Cartesian3.multiplyByScalar(e1, Cesium.Cartesian3.dot(_eastV, e1), _tTmp),
      _tTmp), _tTmp);
    const nrm = Cesium.Cartesian3.cross(e1, e2, new Cesium.Cartesian3());
    TR = { e1, e2, nrm, inj };
  }

  /** 转移椭圆上位置（世界坐标）：s∈[0,1] 近地点→远地点，位置 = r·(cos ν·e1 + sin ν·e2) */
  function transferCartAt(s) {
    const s01 = clamp01(s);
    const M = Math.PI * s01;
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

  /** 月球方向单位向量（世界）：s=1 时抵达远地点（与飞船会合），转移期间沿轨道面扫过 moonSweep */
  function moonDirAt(s) {
    const ang = Math.PI - EM.moonSweep * (1 - clamp01(s));
    Cesium.Quaternion.fromAxisAngle(TR.nrm, ang, _q);
    Cesium.Matrix3.fromQuaternion(_q, _m3t);
    return Cesium.Matrix3.multiplyByVector(_m3t, TR.e1, _vt);
  }

  /** 月球中心（世界坐标）。⚠ 嫦娥轨道（2026-10-18）：月心比转移远地点远 CH_APO1——
   *  转移远地点（= 飞船抵达点）恰为捕获圈 1 的远月点（月球朝地侧），衔接无缝。 */
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

  /** 调相段位置（世界坐标，米）：u∈[0,1] 两圈整体进度，圈内自近地点起跑（keplerE 天然近地快）。
   *  近地点 200→8000km、远地点 14000→60000km 随进度**连续渐变**（渐扩螺旋，参考嫦娥轨道图）——
   *  近地点渐抬让椭圆浮出地球圆盘（真实 200km 近地点的极扁椭圆 99% 在球内，圈永远不可见）。 */
  function phasingCartAt(u) {
    const per = clamp01(u) * CH.phasing.length;
    const i = Math.min(CH.phasing.length - 1, Math.floor(per));
    const cu = per - i;
    const k = per / CH.phasing.length;
    const rpi = lerp(CH_RP0, CH_RP1, k);                              // 近地点（地心距 km）渐抬
    const rai = EM.rE + lerp(CH.phasing[0], CH.phasing[1], k);        // 远地点（地心距 km）渐扩
    const aKm = (rpi + rai) / 2;
    const eK = (rai - rpi) / (rpi + rai);
    const [px, py] = ellipseKM(aKm, eK, Math.PI * 2 * cu, TR.e1, TR.e2);
    const cart = Cesium.Cartesian3.multiplyByScalar(TR.e1, px * 1000, new Cesium.Cartesian3());
    Cesium.Cartesian3.multiplyByScalar(TR.e2, py * 1000, _tTmp);
    return Cesium.Cartesian3.add(cart, _tTmp, cart);
  }

  /** 捕获段位置（世界坐标，米）：u∈[0,1] 两圈整体进度，自远月点起跑（M 从 π 起）。
   *  近月点方向 = -e1（背地侧），绕行方向与转移末端速度（-e2）连续。 */
  function captureCartAt(u) {
    const per = clamp01(u) * CH.capture.length;
    const i = Math.min(CH.capture.length - 1, Math.floor(per));
    const cu = per - i;
    const [ra, rp] = CH.capture[i];
    const aKm = (ra + rp) / 2;
    const eK = (ra - rp) / (ra + rp);
    const [px, py] = ellipseKM(aKm, eK, Math.PI + Math.PI * 2 * cu, TR.e1, TR.e2);
    const moonC = moonCartAt(1);
    const cart = Cesium.Cartesian3.multiplyByScalar(TR.e1, px * 1000, new Cesium.Cartesian3());
    Cesium.Cartesian3.multiplyByScalar(TR.e2, py * 1000, _tTmp);
    return Cesium.Cartesian3.add(moonC, Cesium.Cartesian3.add(cart, _tTmp, cart), new Cesium.Cartesian3());
  }

  /** 调相段喷焰强度：每圈近地点窗口点火（抬升远地点 = 逐圈加速的可视化） */
  function phasingBurn(u) {
    const per = clamp01(u) * CH.phasing.length;
    const cu = per - Math.floor(per);
    return (cu < 0.07 || cu > 0.93) ? 1.5 : 0;
  }

  /** 捕获段喷焰强度：每圈近月点窗口逆向点火（制动减速 = 逐圈减速的可视化） */
  function captureBurn(u) {
    const per = clamp01(u) * CH.capture.length;
    const cu = per - Math.floor(per);
    return (cu > 0.44 && cu < 0.56) ? 1.2 : 0;
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
    // 嫦娥三段轨道线：调相 2 圈渐扩椭圆（地心系）+ 捕获 2 圈渐收椭圆（绕显示月球）
    phasingCarts = [];
    for (let i = 0; i <= 480; i++) phasingCarts.push(phasingCartAt(i / 480));
    captureCarts = [];
    for (let i = 0; i <= 480; i++) captureCarts.push(captureCartAt(i / 480));
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
      // 调相段：2 圈渐扩椭圆（近地点 200km，远地点 1.4 万→6 万 km）——逐圈加速
      // depthFail：椭圆近地点半圈插在地球内部，无它则被地球实体吃掉只剩「两条触角」（用户看不到圈）
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
      // 捕获段：绕显示月球 2 圈渐收椭圆（相对放大月球取值，视觉自洽）——逐圈减速
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
      // 三段标注（嫦娥一号轨道图样式）：圈 2 远地点 / 转移中段 / 捕获圈 1 近月点
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
      phaseLabelEnts = [
        mk('moonPhaseLabel1', '调相段 · 逐圈加速', phasingCartAt(1.5 / CH.phasing.length)),
        mk('moonPhaseLabel2', '地月转移段', transferCartAt(0.5)),
        mk('moonPhaseLabel3', '月球捕获段 · 逐圈减速', captureCartAt(0.5 / CH.capture.length)),
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
      const R = EM.moonR * EM.moonExag * 1000;
      moonEnt = earthViewer.entities.add({
        id: 'moonTransferTarget',
        position: Cesium.Cartesian3.fromDegrees(0, 0, (EM.moonDist - EM.rE) * 1000),
        ellipsoid: {
          radii: new Cesium.Cartesian3(R, R, R),
          material: '/lunar/lunar_wac.jpg',
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString('#9aa4b8').withAlpha(0.5),
        },
        label: {
          text: '月球（体积 ×8 示意）',
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
    if (pp < T.transferEnd) {
      const s = clamp01((pp - T.card1End) / (T.transferEnd - T.card1End));
      if (s < P2.phasingEnd) return cartToPos(phasingCartAt(s / P2.phasingEnd));
      if (s < P2.transferEnd) return transferPosAt((s - P2.phasingEnd) / (P2.transferEnd - P2.phasingEnd));
      return cartToPos(captureCartAt((s - P2.transferEnd) / (1 - P2.transferEnd)));
    }
    return cartToPos(captureCartAt(1));
  }

  // 飞行方向角（屏幕旋转角，billboard 兜底用）：上升段竖直、转移段沿轨迹切线
  function flightRotation(pp) {
    if (pp < T.liftEnd) return 0;
    const s = clamp01((pp - T.card1End) / (T.transferEnd - T.card1End));
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
    // 已飞弧 = 调相（480 点）+ 转移（256 点）+ 捕获（480 点）三段按进度拼接
    const N = 480;
    let pts;
    if (s < P2.phasingEnd) {
      const k = Math.max(1, Math.round((s / P2.phasingEnd) * N));
      pts = phasingCarts.slice(0, k + 1);
    } else if (s < P2.transferEnd) {
      const u = (s - P2.phasingEnd) / (P2.transferEnd - P2.phasingEnd);
      const k = Math.max(1, Math.round(u * (transferCarts.length - 1)));
      pts = phasingCarts.concat(transferCarts.slice(0, k + 1));
    } else {
      const u = (s - P2.transferEnd) / (1 - P2.transferEnd);
      const k = Math.max(1, Math.round(u * N));
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

  // 第二幕顶视相机：相机悬在转移轨道面法向上方，正对椭圆面俯瞰（真实比例）。
  // 铁律：lookAt 的 pitch 相对目标点局部 ENU——中点处的「下方」恰是地月连线方向，
  // 用 HPR 顶视实际得到沿地月轴的侧视（椭圆压成一条线，地月两点重叠，2026-10-17 实测）。
  // 必须用轨道面法向 TR.nrm 直接摆世界位姿。
  function lookAtTransfer() {
    const s = clamp01((p - T.card1End) / (T.transferEnd - T.card1End));
    // 三段自适应取景（顶视轨道面，沿法向 TR.nrm 摆放）：
    //   调相段 → 框地球 + 调相 2 圈（远地点 ≤60,000 km）
    //   转移段 → 框整个地月转移椭圆（远地点 384,400 km）
    //   捕获段 → 框月球 + 捕获 2 圈（绕放大月球半径 ≤36,000 km）
    // ⚠ 旧值 7.5e8 km 远达 5 AU，地月系统缩成针尖、轨道圈全部重叠不可见（用户反馈）。
    const earthT = new Cesium.Cartesian3(0, 0, 0);
    const moonMid = Cesium.Cartesian3.multiplyByScalar(moonCartAt(s), 0.5, new Cesium.Cartesian3());
    const moonT = moonCartAt(s);
    const A = { t: earthT, r: 1.3e5 };   // km：调相段框地球 + 调相圈
    const B = { t: moonMid, r: 8.0e5 };  // km：转移段框全地月系统
    const C = { t: moonT, r: 1.8e5 };    // km：捕获段框月球 + 捕获圈
    const band = 0.07;                   // 段间过渡带（smoothstep 平滑，避免镜头突变）
    let tgt, rangeKm;
    if (s < P2.phasingEnd - band) { tgt = A.t; rangeKm = A.r; }
    else if (s < P2.transferEnd - band) {
      const w = easeInOut(clamp01((s - (P2.phasingEnd - band)) / (2 * band)));
      tgt = Cesium.Cartesian3.lerp(A.t, B.t, w, new Cesium.Cartesian3());
      rangeKm = lerp(A.r, B.r, w);
    } else if (s < P2.transferEnd + band) { tgt = B.t; rangeKm = B.r; }
    else if (s < 1 - band) {
      const w = easeInOut(clamp01((s - (P2.transferEnd - band)) / (2 * band)));
      tgt = Cesium.Cartesian3.lerp(B.t, C.t, w, new Cesium.Cartesian3());
      rangeKm = lerp(B.r, C.r, w);
    } else { tgt = C.t; rangeKm = C.r; }
    const camPos = Cesium.Cartesian3.add(
      tgt, Cesium.Cartesian3.multiplyByScalar(TR.nrm, rangeKm * 1000, _tTmp), new Cesium.Cartesian3());
    const dir = Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.subtract(tgt, camPos, _tTmp), new Cesium.Cartesian3());
    applyCameraPose(earthViewer, camPos, dir, TR.e2);   // up 取面内 e2，画面北向稳定
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
  const ACT_VIEWER = { a1: 'earth', c1: 'earth', a2: 'earth', c2: 'earth', a3l: 'moon', a3d: 'moon', a4: 'moon' };
  let _lastActKey = null;
  function actKeyOf(pp) {
    return pp < T.liftEnd ? 'a1' : pp < T.card1End ? 'c1' : pp < T.transferEnd ? 'a2'
      : pp < T.card2End ? 'c2' : pp < T.loiEnd ? 'a3l' : pp < T.touchEnd ? 'a3d' : 'a4';
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
    const inAct2 = p >= T.card1End && p < T.card2End;
    // —— 地球侧（第一幕 / 幕卡 1 / 第二幕 / 幕卡 2）——
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
        showCard('第一幕 · 点火起飞完成\n「进入地月转移轨道」');
        setPhase('幕间');
        if (camOverride && earthRocket.position) {
          applyManualFollow(earthViewer, earthRocket.position.getValue(Cesium.JulianDate.now()));
        } else {
          focusEarth(200000);
        }
      } else if (p < T.transferEnd) {
        // 第二幕：嫦娥一号式三段轨道（2026-10-18 重做，用户参考图拍板）
        //   调相段 2 圈（近地点点火逐圈加速）→ 地月转移大椭圆 → 月球捕获 2 圈（近月点制动逐圈减速）
        clearSeparators();   // 跨幕 seek（如 0.08→0.35）不经过幕卡分支，这里兜底清分离件
        earthRocket.show = true;
        noteOn(true);
        const s = clamp01((p - T.card1End) / (T.transferEnd - T.card1End));
        let cart, burn = 0, burnRetro = false;
        if (s < P2.phasingEnd) {
          const u = s / P2.phasingEnd;
          cart = phasingCartAt(u);
          burn = phasingBurn(u);                       // 每圈近地点点火（加速抬升远地点）
        } else if (s < P2.transferEnd) {
          const u = (s - P2.phasingEnd) / (P2.transferEnd - P2.phasingEnd);
          cart = transferCartAt(u);
          burn = u < 0.05 ? 1.5 : 0;                   // TLI：切入转移椭圆
        } else {
          const u = (s - P2.transferEnd) / (1 - P2.transferEnd);
          cart = captureCartAt(u);
          burn = captureBurn(u);                       // 每圈近月点逆向点火（制动减速）
          burnRetro = true;
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
        // 月球沿轨道同步移动（抵达时与飞船在捕获远月点会合）；地月虚直线随月球刷新
        moonEnt.position = moonCartAt(s);
        emLineCarts = [new Cesium.Cartesian3(0, 0, 0), moonEnt.position];
        if (emLineEnt) {
          const mid = Cesium.Cartesian3.multiplyByScalar(moonEnt.position, 0.42, new Cesium.Cartesian3());
          emLineEnt.position = mid;
        }
        earthRocket.label.text = burn > 0
          ? (burnRetro ? '探月飞船 · 近月制动减速' : '探月飞船 · 近地点点火加速')
          : '探月飞船 · ' + (s < P2.phasingEnd ? '调相段' : s < P2.transferEnd ? '地月转移' : '月球捕获');
        updateTransferTrail(s);
        setPhase('第二幕 · 嫦娥轨道（调相 → 转移 → 捕获）');
        lookAtTransfer();
      } else {
        // 幕卡 2：转移 → 环月/着陆
        clearSeparators();
        earthRocket.show = false;
        updateFlame(earthViewer, null, null, 0, Cesium.Ellipsoid.WGS84);
        showCard('第二幕 · 抵达月球（远地点会合）\n「准备环月制动与着陆」');
        setPhase('幕间');
        lookAtTransfer();
      }
      return;
    }

    // —— 月球侧（第三幕：环月制动 → 离轨 → 动力下降着陆；第四幕：玉兔巡视）——
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
      const s = clamp01((p - T.card2End) / (T.loiEnd - T.card2End));
      const latT = site.lat + lerp(-120, -40, easeIn(s));
      const alt = lerp(800000, 100000, easeIn(s));
      const craftPos = Cesium.Cartesian3.fromDegrees(site.lon, latT, alt, MOON_ELLIPSOID);
      moonCraft.position = craftPos;
      moonCraft.label.text = '环月制动 · LOI（过着陆点大圆轨道 100 km）';
      setPhase('第三幕 · 环月制动（LOI）');
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
        setPhase('第三幕 · 离轨制动');
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
        setPhase(s >= 1 ? '第三幕 · 月面着陆完成' : '第三幕 · 动力下降');
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
      setPhase(s4 >= 1 ? '第四幕 · 巡视完成' : '第四幕 · 玉兔驶出巡视');
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
    if (p < T.card2End) {
      // 地球侧：若在月球段则切回
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
      cam: { override: camOverride, blend: +blendT.toFixed(3) },
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
    navLocked: () => p >= T.card1End && p < T.card2End,
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
