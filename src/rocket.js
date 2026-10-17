// src/rocket.js — 探月任务四幕剧（3D 版：glTF Model + 火焰/RCS 特效）
// 四幕结构：
//   第一幕 · 点火起飞   （地球 Viewer：发射段上升 + 助推器/整流罩分离动效 + 发射轨迹线；
//                         长征五号整箭 → 抛助推器后芯级箭 → 抛整流罩后飞船上面级（模型随分离切换）；
//                         主发动机火焰 + 发射台灰尘 + 过顶段 RCS 姿控喷气）
//   第二幕 · 月地转移   （地球 Viewer「地月顶视图」：真实比例地月系 + 霍曼转移椭圆，
//                         近地点 200 km → 远地点月距 384,400 km，月球沿轨道同步移动（5 天扫过 ~65°），
//                         飞船上面级沿椭圆飞行，TLI 点火火焰；距离压缩说明见 #compressNote）
//   第三幕 · 月球着陆   （月球 Viewer：环月制动 LOI（轨道倾角 = 着陆点纬度，过着陆点，逆向点火）→
//                         离轨制动（仍是飞船上面级）→ 动力下降（着陆器 + 发动机火焰 + 触月灰尘），
//                         末端按真实月面 DEM 接地）
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
  leoAlt: 200,            // 转移轨道近地点高度 km（入轨点）
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

// 四个发射场中用于探月任务的低纬两个（数据与 moonmission 图层一致）
export const LAUNCH_SITES = {
  jiuquan: { lon: 100.298, lat: 40.96, name: '酒泉' },
  wenchang: { lon: 110.951, lat: 19.614, name: '文昌' },
};

// 幕时间边界（归一化 0..1）
const T = {
  liftEnd: 0.14,      // 第一幕结束（入轨 ~200km）
  card1End: 0.17,     // 幕卡 1 结束
  transferEnd: 0.56,  // 第二幕结束（抵达月球 = 转移轨道远地点）
  card2End: 0.60,     // 幕卡 2 结束
  loiEnd: 0.80,       // 环月制动段结束（开始离轨/动力下降）
  touchEnd: 0.90,     // 第三幕结束（触月）；0.90~1.00 为第四幕「玉兔巡视」
};
// 幕节点（进度条跳转锚点）
const ACTS = [
  { f: 0, name: '点火' },
  { f: T.card1End, name: '转移' },
  { f: T.card2End, name: '入月轨' },
  { f: T.loiEnd, name: '着陆' },
  { f: T.touchEnd, name: '巡视' },
];
// 第一幕内的分离事件时刻
const BOOSTER_SEP = T.liftEnd * 0.45;  // 助推器分离
const FAIRING_SEP = T.liftEnd * 0.78;  // 整流罩分离
// 特效时间窗（第一幕）
const DUST_END = 0.030;    // 发射台灰尘持续时间（归一化）
const RCS_FROM = 0.010;    // 过顶段 RCS 起始（重力转弯窗口）
const RCS_TO = 0.048;      // 过顶段 RCS 结束

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

// —— 相机：脚本机位写入 + 播放中鼠标接管（2026-10-17） ——
// applyCamera 是唯一写任务相位的入口：用户拖拽/滚轮时 camOverride=true，跳过写入（视角随用户）；
// 松手（或滚轮停止 0.9s）后用 1.1s 把相机从「用户最后位姿」混合回「脚本机位」。
// 混合在世界坐标系做（探针验证：lookAt→读回 positionWC/directionWC/upWC→lookAtTransform(IDENTITY)
// 保持世界位姿→直接写 position/direction/up），不受 lookAt 参考系影响。
let camOverride = false;      // 用户拖拽中
let camHookViewer = null;     // 用户正在操作的 viewer
let blendT = 0;               // >0：回归混合进行中（0..1）
let blendFrom = null;         // { pos, dir, up } 拖拽结束时的世界位姿
let wheelAt = 0;              // 最近一次滚轮时间（idle 后触发回归）

function resetCamOverride() {
  camOverride = false; blendT = 0; blendFrom = null; wheelAt = 0;
}

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
}

function hookCamera(v) {
  if (!v || !v.scene || !v.scene.canvas || v.__moonCamHook) return;
  v.__moonCamHook = true;
  const canvas = v.scene.canvas;
  // DOM 级监听（不走 ScreenSpaceEventHandler，避免与其他输入动作争抢）
  canvas.addEventListener('pointerdown', () => {
    camHookViewer = v; camOverride = true; blendT = 0; blendFrom = null;
  });
  canvas.addEventListener('wheel', () => {
    camHookViewer = v; camOverride = true; blendT = 0; blendFrom = null; wheelAt = performance.now();
  }, { passive: true });
}

const _bp = new Cesium.Cartesian3();
const _bd = new Cesium.Cartesian3();
const _bu = new Cesium.Cartesian3();

/** 相机混合回归尾部：把相机从 blendFrom 世界位姿插值到目标世界位姿（pos/dir/up） */
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
    blendT += frameDt / 1.1;
    if (blendT >= 1) { blendT = 0; blendFrom = null; }
  }
}

function applyCamera(v, target, heading, pitch, range) {
  if (!v) return;
  if (camOverride) return;   // 用户接管中：不写相机
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

/** 世界位姿版 applyCamera（第二幕顶视用）：直接给相机位置/视线/上方向 */
function applyCameraPose(v, camPos, dir, up) {
  if (!v) return;
  if (camOverride) return;
  v.camera.setView({ destination: camPos, orientation: { direction: dir, up } });
  blendCameraTo(v, camPos, dir, up);
}

function onCamPointerUp() {
  if (!camOverride) return;
  camOverride = false;
  startBlendFrom(camHookViewer || earthViewerRef);
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
  window.addEventListener('pointerup', onCamPointerUp);

  let raf = 0, last = 0;
  let p = 0, playing = false, mult = 1;
  let launchSiteKey = 'wenchang';
  let landingSiteKey = 'imbrium';
  let inMoon = false;
  let _wasPlaying = false;  // 拖拽进度条前的播放态（松手恢复）
  let _trackDragging = false; // 只有时间轴上按下才 seek（2026-10-17：画布拖动不再影响时序）

  // 路径数据（start/seekTo 时生成）
  let earthPath = [];      // 第一幕上升段 [lon,lat,alt]
  let transferCarts = [];  // 第二幕转移椭圆（霍曼）Cartesian3（画线用）
  let moonOrbitCarts = []; // 月球绕地轨道环 Cartesian3
  let launchCarts = [];    // 已飞发射轨迹 Cartesian3（逐帧追加）
  let trailCarts = [];     // 已飞转移轨迹 Cartesian3（每帧取前缀）
  let lastLaunch = null;   // 发射轨迹上一次追加点（节流）

  // 实体
  let earthRocket = null;
  let launchTrailEnt = null;   // 发射轨迹线
  let transferFullEnt = null;  // 转移规划航线（霍曼椭圆，虚线）
  let transferTrailEnt = null; // 已飞转移轨迹（亮线）
  let transferLabelEnt = null; // 转移轨道标注
  let moonEnt = null;          // 月球实体（球体 + 标签）
  let moonOrbitEnt = null;     // 月球绕地轨道环（淡）
  let padDustEnt = null;       // 发射台灰尘（第一幕点火初期）
  let landDustEnt = null;      // 触月激尘（第三幕末）
  let moonRing = null;
  let moonCraft = null;
  // 分离件（第一幕临时实体）
  let boosters = [];    // [{ent, dir, axis, slot}]
  let fairings = [];    // [{ent, dir, axis, slot}]

  // 事件绑定引用
  let onPause = null, onStop = null, onSlower = null, onFaster = null;
  let onTrackDown = null, onTrackMove = null, onTrackUp = null;

  function makeEarthPath(pad) {
    return [
      [pad.lon, pad.lat, 0],
      [pad.lon, pad.lat, 3000],
      [pad.lon + 0.25, pad.lat + 0.12, 22000],
      [pad.lon + 0.8, pad.lat + 0.4, 80000],
      [pad.lon + 2.2, pad.lat + 1.05, 200000], // 入轨 ~200 km
    ];
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
    const inj = [pad.lon + 2.2, pad.lat + 1.05, 200000];   // 入轨注入点（与第一幕终点一致）
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

  /** 月球中心（世界坐标） */
  function moonCartAt(s) {
    return Cesium.Cartesian3.multiplyByScalar(moonDirAt(s), EM.moonDist * 1000, new Cesium.Cartesian3());
  }

  function buildPathData() {
    const pad = LAUNCH_SITES[launchSiteKey];
    earthPath = makeEarthPath(pad);
    buildTransferGeom(pad);
    transferCarts = [];
    for (let i = 0; i <= 200; i++) {
      transferCarts.push(transferCartAt(i / 200));
    }
    moonOrbitCarts = [];
    for (let i = 0; i <= 128; i++) {
      // 月球绕地轨道 = 转移轨道面内的圆（半径 = 地月距）
      const ang = (i / 128) * Math.PI * 2;
      Cesium.Quaternion.fromAxisAngle(TR.nrm, ang, _q);
      Cesium.Matrix3.fromQuaternion(_q, _m3t);
      const d = Cesium.Matrix3.multiplyByVector(_m3t, TR.e1, new Cesium.Cartesian3());
      moonOrbitCarts.push(Cesium.Cartesian3.multiplyByScalar(d, EM.moonDist * 1000, new Cesium.Cartesian3()));
    }
    launchCarts = [];
    lastLaunch = null;
    trailCarts = transferCarts.slice(0, 1);
  }

  // ---- 地球火箭（billboard 沿飞行方向旋转，形态随分离阶段切换）----
  function ensureEarthRocket() {
    if (earthRocket) return;
    const pad = LAUNCH_SITES[launchSiteKey];
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
      transferFullEnt = earthViewer.entities.add({
        id: 'moonTransferPath',
        polyline: {
          positions: new Cesium.CallbackProperty(() => transferCarts, false),
          width: 2,
          material: new Cesium.PolylineDashMaterialProperty({
            color: Cesium.Color.fromCssColorString('#8fa8c8').withAlpha(0.55),
            dashLength: 16,
          }),
          arcType: Cesium.ArcType.NONE,
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
          text: '霍曼转移轨道（近地点 200 km · 远地点 384,400 km）',
          font: '11px "Microsoft YaHei", sans-serif',
          fillColor: Cesium.Color.fromCssColorString('#cfe0ff'),
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
  }

  // 主箭位置（第一、二幕内确定）
  function rocketPosAt(pp) {
    if (pp < T.liftEnd) {
      // 上升段：easeIn 加速爬升
      return samplePath(earthPath, easeIn(clamp01(pp / T.liftEnd)) * 0.999);
    }
    if (pp < T.transferEnd) {
      return transferPosAt(clamp01((pp - T.card1End) / (T.transferEnd - T.card1End)));
    }
    return transferPosAt(1);
  }

  // 飞行方向角（屏幕旋转角，billboard 兜底用）：上升段竖直、转移段沿轨迹切线
  function flightRotation(pp) {
    if (pp < T.liftEnd) return 0;
    const s = clamp01((pp - T.card1End) / (T.transferEnd - T.card1End));
    const a = transferPosAt(Math.max(0, s - 0.01));
    const b = transferPosAt(Math.min(1, s + 0.01));
    return -Math.atan2(b[0] - a[0], b[1] - a[1]);
  }

  // 发射轨迹逐帧追加（节流：水平累计 >0.05° 或高度变化 >5 km 才记一点）
  function pushLaunchTrail(pos) {
    if (!lastLaunch) {
      launchCarts.push(Cesium.Cartesian3.fromDegrees(pos[0], pos[1], pos[2]));
      lastLaunch = pos.slice();
      return;
    }
    const dh = Math.abs(pos[2] - lastLaunch[2]);
    const dl = Math.abs(pos[0] - lastLaunch[0]) + Math.abs(pos[1] - lastLaunch[1]);
    if (dh > 5000 || dl > 0.05) {
      launchCarts.push(Cesium.Cartesian3.fromDegrees(pos[0], pos[1], pos[2]));
      lastLaunch = pos.slice();
    }
  }

  // 转移已飞轨迹 = 规划航线前缀
  function updateTransferTrail(s) {
    const idx = Math.max(1, Math.round(clamp01(s) * (transferCarts.length - 1)));
    trailCarts = transferCarts.slice(0, idx + 1);
  }

  // ---- 分离件：助推器 ×4（斜向弹开 + 翻滚 + 下坠），整流罩 ×2（两侧抛离 + 自转）----
  // 3D 化（2026-10-17）：每枚分离件独立 loadSlot（模型实例不可共享），翻滚用固定 ENU 轴；
  //                    billboard 保留作加载期兜底（slot.ready 后隐藏）。
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
  }

  function spawnSeparators(kind) {
    const base = rocketPosAt(kind === 'booster' ? BOOSTER_SEP : FAIRING_SEP);
    if (kind === 'booster') {
      // 4 枚助推器：东北/东南/西北/西南 斜向弹开，各自反向翻滚
      const dirs = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]];
      for (const [dlon, dlat, spin] of dirs) {
        boosters.push({
          dir: [dlon, dlat, spin],
          axis: Cesium.Cartesian3.normalize(
            new Cesium.Cartesian3(dlon * 0.45, 0.85, dlat * 0.45), new Cesium.Cartesian3()),
          slot: loadSlot('booster', earthViewerRef),
          ent: earthViewer.entities.add({
            position: Cesium.Cartesian3.fromDegrees(base[0], base[1], base[2] - 300),
            billboard: {
              image: BOOSTER_ICON,
              width: 26,
              height: 26,
              rotation: 0,
              alignedAxis: Cesium.Cartesian3.UNIT_Z,
              heightReference: Cesium.HeightReference.NONE,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
            label: {
              text: '助推器分离',
              font: '11px "Microsoft YaHei", sans-serif',
              fillColor: Cesium.Color.fromCssColorString('#ffd24a'),
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 3,
              style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              pixelOffset: new Cesium.Cartesian2(0, -20),
              verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          }),
        });
      }
    } else {
      // 整流罩左右两瓣：向两侧水平抛离并自转
      const defs = [
        { dir: -1, icon: FAIRING_LEFT_ICON, text: '整流罩分离' },
        { dir: 1, icon: FAIRING_RIGHT_ICON, text: '整流罩分离' },
      ];
      for (const d of defs) {
        fairings.push({
          dir: d.dir,
          axis: Cesium.Cartesian3.normalize(
            new Cesium.Cartesian3(1, 0.15, 0.1), new Cesium.Cartesian3()),
          slot: loadSlot('fairing', earthViewerRef),
          ent: earthViewer.entities.add({
            position: Cesium.Cartesian3.fromDegrees(base[0], base[1], base[2] + 200),
            billboard: {
              image: d.icon,
              width: 24,
              height: 24,
              rotation: 0,
              alignedAxis: Cesium.Cartesian3.UNIT_Z,
              heightReference: Cesium.HeightReference.NONE,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
            label: {
              text: d.text,
              font: '11px "Microsoft YaHei", sans-serif',
              fillColor: Cesium.Color.fromCssColorString('#ffd24a'),
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 3,
              style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              pixelOffset: new Cesium.Cartesian2(0, -18),
              verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          }),
        });
      }
    }
  }

  // 逐帧更新分离件（从分离时刻起的弹开/翻滚/下坠动画，结束后销毁）
  function updateSeparators() {
    const D = BASE_DURATION;
    // 助推器
    if (p >= BOOSTER_SEP && boosters.length === 0 && p < BOOSTER_SEP + 0.055) {
      spawnSeparators('booster');
    }
    if (boosters.length) {
      const dt = (p - BOOSTER_SEP) * D;
      if (dt > 8) {
        clearSeparators();
      } else if (dt >= 0) {
        const base = rocketPosAt(BOOSTER_SEP);
        for (const b of boosters) {
          const [dlon, dlat, spin] = b.dir;
          const cart = Cesium.Cartesian3.fromDegrees(
            base[0] + dlon * 0.05 * dt,
            base[1] + dlat * 0.03 * dt,
            Math.max(0, base[2] - 300 + 900 * dt - 130 * dt * dt)
          );
          b.ent.position = cart;
          if (attachIfReady(b.slot)) {
            b.ent.billboard.show = false;
            placeModel(b.slot, cart, tumbleQuat(b.axis, spin * dt * 1.7, _q), Cesium.Ellipsoid.WGS84);
          } else {
            b.ent.billboard.rotation = spin * dt * 1.7;
          }
        }
      }
    }
    // 整流罩
    if (p >= FAIRING_SEP && fairings.length === 0 && p < FAIRING_SEP + 0.045) {
      spawnSeparators('fairing');
    }
    if (fairings.length) {
      const dt = (p - FAIRING_SEP) * D;
      if (dt > 6.5) {
        clearSeparators();
      } else if (dt >= 0) {
        const base = rocketPosAt(FAIRING_SEP);
        for (const f of fairings) {
          const cart = Cesium.Cartesian3.fromDegrees(
            base[0] + f.dir * 0.09 * dt,
            base[1],
            Math.max(0, base[2] + 200 + 250 * dt - 110 * dt * dt)
          );
          f.ent.position = cart;
          if (attachIfReady(f.slot)) {
            f.ent.billboard.show = false;
            placeModel(f.slot, cart, tumbleQuat(f.axis, f.dir * dt * 0.9, _q), Cesium.Ellipsoid.WGS84);
          } else {
            f.ent.billboard.rotation = f.dir * dt * 0.9;
          }
        }
      }
    }
  }

  // ---- 月球场景（第三幕）----
  function clearMoonEntities() {
    const mv = env.getMoonViewer();
    if (mv) {
      if (moonRing) { mv.entities.remove(moonRing); moonRing = null; }
      if (moonCraft) { mv.entities.remove(moonCraft); moonCraft = null; }
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
    }
    const site = MOON_LANDING_SITES[landingSiteKey];

    // 环月目标轨道（100 km 圆轨，纬度 = 着陆点纬度 → 轨道过着陆点，动力下降垂直）
    const flat = [];
    for (let i = 0; i <= 120; i++) {
      flat.push(wrapLon((i / 120) * 360), site.lat, 100000);
    }
    moonRing = mv.entities.add({
      id: 'moonLoiOrbit',
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArrayHeights(flat, MOON_ELLIPSOID),
        width: 2,
        material: Cesium.Color.fromCssColorString('#7fc4ff'),
        depthFailMaterial: Cesium.Color.fromCssColorString('#7fc4ff').withAlpha(0.35),
        arcType: Cesium.ArcType.NONE,
      },
    });

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
    const target = Cesium.Cartesian3.multiplyByScalar(moonCartAt(s), 0.5, new Cesium.Cartesian3());
    const camPos = Cesium.Cartesian3.add(
      target, Cesium.Cartesian3.multiplyByScalar(TR.nrm, 7.5e8, _tTmp), new Cesium.Cartesian3());
    const dir = Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.subtract(target, camPos, _tTmp), new Cesium.Cartesian3());
    applyCameraPose(earthViewer, camPos, dir, TR.e2);   // up 取面内 e2，画面北向稳定
  }

  function focusEarth(alt, wide) {
    // 末端 clamp 900m~300km：3D 火箭仅 36m 高，不 clamp 的话触地/入轨瞬间只剩 1~2 像素
    const range = wide ? 3.0e7 : Cesium.Math.clamp(alt * 2.6, 900, 3.0e5);
    const pos = earthRocket ? earthRocket.position.getValue(Cesium.JulianDate.now()) : null;
    if (!pos) return;
    applyCamera(earthViewer, pos, 0, Cesium.Math.toRadians(-38), range);
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
  function render() {
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
        setPhase('第一幕 · 点火起飞');
        focusEarth(pos[2]);
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
        focusEarth(200000);
      } else if (p < T.transferEnd) {
        // 第二幕：月地转移（真实比例地月顶视图 + 霍曼椭圆）
        clearSeparators();   // 跨幕 seek（如 0.08→0.35）不经过幕卡分支，这里兜底清分离件
        earthRocket.show = true;
        noteOn(true);
        const s = clamp01((p - T.card1End) / (T.transferEnd - T.card1End));
        const pos = transferPosAt(s);
        const cart = Cesium.Cartesian3.fromDegrees(pos[0], pos[1], pos[2]);
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
        // TLI 点火（转移起点喷火加速，随后惯性滑行）
        if (s < 0.1) {
          const flick = 0.9 + 0.1 * Math.sin(performance.now() * 0.053);
          Cesium.Cartesian3.negate(flightDirENU(p), _vec);
          updateFlame(earthViewer, cart, _vec, 1.5 * flick, Cesium.Ellipsoid.WGS84);
        } else {
          updateFlame(earthViewer, null, null, 0, Cesium.Ellipsoid.WGS84);
        }
        // 月球沿轨道同步移动（抵达远地点时与飞船会合）
        moonEnt.position = moonCartAt(s);
        earthRocket.label.text = '探月飞船 · 地月转移';
        updateTransferTrail(s);
        setPhase('第二幕 · 月地转移（真实比例 · 霍曼椭圆）');
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
      // 环月制动 LOI：半圈降轨（800 → 100 km），轨道纬度 = 着陆点纬度（过着陆点）
      const s = clamp01((p - T.card2End) / (T.loiEnd - T.card2End));
      const lon = wrapLon(site.lon - 180 + 180 * s);
      const alt = lerp(800000, 100000, easeIn(s));
      const craftPos = Cesium.Cartesian3.fromDegrees(lon, site.lat, alt, MOON_ELLIPSOID);
      moonCraft.position = craftPos;
      moonCraft.label.text = `环月制动 · LOI（倾角 ${Math.abs(site.lat).toFixed(0)}° · 过着陆点）`;
      setPhase('第三幕 · 环月制动（LOI）');
      // 3D 飞船上面级（机头沿环月切向，与第一/二幕同一模型）；未就绪回退 billboard
      const slot = getLoiCraftSlot();
      if (attachIfReady(slot)) {
        moonCraft.billboard.show = false;
        hideSlot(landerSlot); hideSlot(roverSlot); showSlot(slot);
        const e = 0.01;
        const sa = Math.max(0, s - e), sb = Math.min(1, s + e);
        const a = [wrapLon(site.lon - 180 + 180 * sa), site.lat, lerp(800000, 100000, sa)];
        const b = [wrapLon(site.lon - 180 + 180 * sb), site.lat, lerp(800000, 100000, sb)];
        placeModel(slot, craftPos, quatUpTo(tangentENU(a, b, _dir), _q), MOON_ELLIPSOID);
      } else {
        moonCraft.billboard.show = true;
        moonCraft.billboard.image = SPACECRAFT_ICON;
      }
      // 逆向点火（前 25%）：喷流沿速度方向（减速入轨）
      if (s < 0.25) {
        const e = 0.01;
        const sa = Math.max(0, s - e), sb = Math.min(1, s + e);
        const a = [wrapLon(site.lon - 180 + 180 * sa), site.lat, lerp(800000, 100000, sa)];
        const b = [wrapLon(site.lon - 180 + 180 * sb), site.lat, lerp(800000, 100000, sb)];
        const burn = 1.1 * (0.9 + 0.1 * Math.sin(performance.now() * 0.049)) * (1 - s / 0.25 * 0.35);
        updateFlame(mv, craftPos, tangentENU(a, b, _dir), burn, MOON_ELLIPSOID);
      } else {
        updateFlame(mv, null, null, 0, MOON_ELLIPSOID);
      }
      applyCamera(mv, craftPos, 0, Cesium.Math.toRadians(-42), lerp(700000, 420000, s));
    } else if (p < T.touchEnd) {
      // 离轨 + 动力下降：前 28% 仍是飞船上面级（离轨制动 100→15 km），
      // 之后着陆器分离并动力下降至月面（末端按 DEM 真实地形高接地）
      const s = clamp01((p - T.loiEnd) / (T.touchEnd - T.loiEnd));
      const ground = sampleMoonHeight(site.lon, site.lat);
      const prof = descentProfile(s);
      const alt = ground + prof.alt;
      const lon = site.lon + prof.drift * 0.03;
      const craftPos = Cesium.Cartesian3.fromDegrees(lon, site.lat, alt, MOON_ELLIPSOID);
      moonCraft.position = craftPos;
      // 姿态：环月切向 → 竖直（离轨段平滑过渡）
      const e = 0.01;
      const sa = Math.max(0, 1 - e), sb = Math.min(1, 1 + e);
      const a = [wrapLon(site.lon - 180 + 180 * sa), site.lat, lerp(800000, 100000, sa)];
      const b = [wrapLon(site.lon - 180 + 180 * sb), site.lat, lerp(800000, 100000, sb)];
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
      // 末端机位 clamp 到 60m：着陆器仅 ~4.4m 高，不 clamp 的话触月瞬间只有 1~2 像素
      applyCamera(mv, craftPos, 0, Cesium.Math.toRadians(-22), Math.max(60, (alt - ground) * 2.4));
    } else {
      // 第四幕：玉兔驶出巡视（着陆器驻留 + 月球车 6 轮滚动节点动画）
      const s4 = clamp01((p - T.touchEnd) / (1 - T.touchEnd));
      const ground = sampleMoonHeight(site.lon, site.lat);
      const landerPos = Cesium.Cartesian3.fromDegrees(site.lon, site.lat, ground, MOON_ELLIPSOID);
      // 月球车自着陆器东侧驶出，14m 巡视路线（经度换算按站点纬度余弦）
      const drive = s4 * 14;
      const dLon = drive / (97700 * Math.cos(Cesium.Math.toRadians(site.lat)));
      const roverPos = Cesium.Cartesian3.fromDegrees(site.lon + dLon, site.lat, ground, MOON_ELLIPSOID);
      moonCraft.position = roverPos;
      moonCraft.label.text = '玉兔号 · 月面巡视';
      setPhase(s4 >= 1 ? '第四幕 · 巡视完成' : '第四幕 · 玉兔驶出巡视');
      // 着陆器驻留（identity 竖直）
      const ls = getLanderSlot();
      if (attachIfReady(ls)) { showSlot(ls); placeModel(ls, landerPos, Cesium.Quaternion.IDENTITY, MOON_ELLIPSOID); }
      hideSlot(loiCraftSlot);
      // 月球车：前进 +X（Y→Z 轴校正后即 ENU 东向）；轮子动画 REPEAT ×1.2（≈1.5 转/秒，匹配 1.5m/s）
      const rs = getRoverSlot();
      if (attachIfReady(rs)) {
        moonCraft.billboard.show = false;
        showSlot(rs);
        placeModel(rs, roverPos, Cesium.Quaternion.IDENTITY, MOON_ELLIPSOID);
        // 坑（2026-10-17 冒烟实测）：sceneGraph 要模型首次 update 后才有，未就绪时
        // activeAnimations.add 抛 TypeError，且异常穿出 tick 会杀死整个 rAF 循环（第四幕冻住）。
        // 判 sceneGraph 存在再 add；本帧未就绪则下一帧 render 自然重试（animOn 仍为 false）。
        if (rs.animCount > 0 && !rs.animOn && !rs.model.isDestroyed() && rs.model.sceneGraph) {
          rs.model.activeAnimations.add({ index: 0, loop: Cesium.ModelAnimationLoop.REPEAT, multiplier: 1.2 });
          rs.animOn = true;
        }
      } else {
        moonCraft.billboard.show = true;
        moonCraft.billboard.image = SPACECRAFT_ICON;
      }
      updateFlame(mv, null, null, 0, MOON_ELLIPSOID);
      updateRcs(mv, null, null, 0, MOON_ELLIPSOID);
      // 相机取着陆器与月球车中点、30m 机位：两者同框，轮子滚动清晰可辨
      const mid = Cesium.Cartesian3.midpoint(landerPos, roverPos, new Cesium.Cartesian3());
      applyCamera(mv, mid, 0.34, Cesium.Math.toRadians(-26), 30);
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
      p += (dt / BASE_DURATION) * mult;
      if (p >= 1) {
        p = 1;
        playing = false;
        const pb = $('tourPause');
        if (pb) pb.textContent = '重播';
      }
    }
    // 滚轮停止 0.9s 后启动平滑回归（拖拽松手已在 pointerup 处理）
    if (!camOverride && wheelAt && performance.now() - wheelAt > 900) {
      wheelAt = 0;
      startBlendFrom(camHookViewer || earthViewerRef);
    }
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
        _trackDragging = false;
        if (_wasPlaying && p < 1) playing = true;
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
    /** 冒烟探针专用：原始槽位引用（页内计算用，勿序列化返回） */
    debugSlots: () => slots,
    setLaunchSite: (k) => { launchSiteKey = k; },
    setLandingSite: (k) => { landingSiteKey = k; },
    getLaunchSite: () => launchSiteKey,
    getLandingSite: () => landingSiteKey,
  };
}

// 动力下降曲线（第三幕，2026-10-17）：s∈[0,1]
//   0~0.28 离轨制动（仍是飞船上面级）：100 km → 15 km，逆向主发动机
//   0.28~1 动力下降（着陆器）：15 km → 月面，先快后慢，末段收油门 + 小幅水平机动
function descentProfile(s) {
  const s01 = clamp01(s);
  if (s01 < 0.28) {
    const u = s01 / 0.28;
    return { alt: lerp(100000, 15000, u * 0.25 + u * u * 0.75), thrust: 0.55 + 0.45 * (1 - u), drift: 0 };
  }
  const u = (s01 - 0.28) / 0.72;
  const alt = 15000 * Math.pow(1 - u, 1.7);
  const thrust = u < 0.82 ? 1 : Math.max(0.12, (1 - u) / 0.18);
  return { alt, thrust, drift: clamp01((u - 0.2) / 0.6) };
}

export default createMoonMission;
