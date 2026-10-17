// src/rocket.js — 探月任务四幕剧（3D 版：glTF Model 替代 billboard）
// 四幕结构：
//   第一幕 · 点火起飞   （地球 Viewer：发射段上升 + 助推器/整流罩分离动效 + 发射轨迹线；
//                         长征五号整箭 3D 模型，机头沿速度方向）
//   第二幕 · 月地转移   （地球 Viewer 内「局部太阳系顶视图」：压缩距离示意，
//                         规划航线虚线 + 已飞轨迹亮线 + 示意月球，飞船上面级沿航线飞行）
//   第三幕 · 月球着陆   （月球 Viewer：环月制动 LOI 俯视机位 → 动力下降，
//                         末端按真实月面 DEM 接地，换着陆器 3D 模型）
//   第四幕 · 玉兔巡视   （着陆器驻留，玉兔号月球车驶出，6 轮滚动节点动画）
// 幕间用文字幕卡过渡。复用底部巡游面板：播放/暂停/倍率/进度条拖拽/幕节点跳转/重播。
// 崩溃防护：camera.lookAt 只接受 Cartesian3 —— 禁止把 entity.position（Property）直接传入，
//           否则相机矩阵为 NaN → createPotentiallyVisibleSet 抛 RangeError: invalid array length。
// 3D 模型说明（2026-10-17，Cesium 1.146 实测要点）：
//   - Model.fromGltfAsync({url, minimumPixelSize}) 异步加载；billboard 保留作加载期/失败兜底
//   - 定位必须显式 modelMatrix = eastNorthUpToFixedFrame(pos, ellipsoid) * 旋转，否则躺在原点不可见
//   - glTF 为 Y-up，Cesium 自动做 Y→Z 轴校正：identity 旋转即「竖直向上」
//   - requestRenderMode 下每帧必须 scene.requestRender()（tick 内已做），模型才会随动画重绘

import * as Cesium from 'cesium';
import { MOON_ELLIPSOID, MOON_LANDING_SITES, sampleMoonHeight } from './lunar.js';
import { LANDER_ICON, SPACECRAFT_ICON, descentAltitude } from './moon-landing.js';
import {
  FULL_ROCKET_ICON,
  STAGE1_ICON,
  BOOSTER_ICON,
  FAIRING_LEFT_ICON,
  FAIRING_RIGHT_ICON,
  MOON_ICON,
} from './icons.js';
import { isRouteTourActive } from './route-tour.js';

const MOON_R = 1737400;
const SPEED_STEPS = [0.5, 1, 2, 4, 8];
const BASE_DURATION = 120; // 1× 全程秒数

// 四个发射场中用于探月任务的低纬两个（数据与 moonmission 图层一致）
export const LAUNCH_SITES = {
  jiuquan: { lon: 100.298, lat: 40.96, name: '酒泉' },
  wenchang: { lon: 110.951, lat: 19.614, name: '文昌' },
};

// 幕时间边界（归一化 0..1）
const T = {
  liftEnd: 0.14,      // 第一幕结束（入轨 ~200km）
  card1End: 0.17,     // 幕卡 1 结束
  transferEnd: 0.56,  // 第二幕结束（抵达月球影响球）
  card2End: 0.60,     // 幕卡 2 结束
  loiEnd: 0.80,       // 环月制动段结束（开始动力下降）
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

function $(id) { return document.getElementById(id); }
function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function easeIn(t) { return t * t; }

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

// ====== glTF 3D 模型（异步加载 + billboard 兜底；2026-10-17） ======
// 模型约定（tools/make_mission_models.py）：Y-up；火箭/飞船机头 +Y，着陆器/月球车接地 y=0。
// Cesium 对 glTF 自动做 Y→Z 校正，故 modelMatrix = ENU(pos) * R 时 R=identity 即竖直向上。
// minimumPixelSize 标定（2026-10-17 实测，勿照理论公式）：
//   Cesium 的 minPx 放大用 _initialRadius（≠当前 boundingSphere.radius，实测放大量比理论小 ~4×），
//   表观像素 ≈ 0.231 × minPx。取值按「旧 billboard 尺寸」标定：火箭/飞船/分离件 ~35px → 150/120，
//   着陆器下降段 marker ~28px → 120；近距（月球车 30m 机位）走自然尺寸，minPx 不参与。
const MODEL_DEFS = {
  rocket:   { url: '/models/longmarch5.glb',  minPx: 150 },  // 第一幕整箭
  craft:    { url: '/models/spacecraft.glb',  minPx: 150 },  // 第二幕上面级
  loiCraft: { url: '/models/spacecraft.glb',  minPx: 150 },  // 第三幕环月段（月球 viewer 独立实例）
  booster:  { url: '/models/booster.glb',     minPx: 120 },  // 分离件（每枚独立实例）
  fairing:  { url: '/models/fairing.glb',     minPx: 120 },
  lander:   { url: '/models/moon_lander.glb', minPx: 120 },
  rover:    { url: '/models/yutu_rover.glb',  minPx: 80 },   // 第四幕（6 轮滚动动画）
};

const slots = [];           // 全部存活 slot 登记（stop 时统一销毁）
let rocketSlot = null;      // 单例：整箭 / 上面级 / 环月飞船 / 着陆器 / 月球车
let craftSlot = null;
let loiCraftSlot = null;
let landerSlot = null;
let roverSlot = null;
let earthViewerRef = null;  // 由 createMoonMission 赋值
let moonViewerRef = null;

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
function getCraftSlot() { if (!craftSlot) craftSlot = loadSlot('craft', earthViewerRef); return craftSlot; }
function getLoiCraftSlot() { if (!loiCraftSlot) loiCraftSlot = loadSlot('loiCraft', moonViewerRef); return loiCraftSlot; }
function getLanderSlot() { if (!landerSlot) landerSlot = loadSlot('lander', moonViewerRef); return landerSlot; }
function getRoverSlot() { if (!roverSlot) roverSlot = loadSlot('rover', moonViewerRef); return roverSlot; }
function hideSlot(s) { if (s && s.ready && s.model) s.model.show = false; }
function showSlot(s) { if (s && s.ready && s.model) s.model.show = true; }

// —— 旋转/定位辅助（ENU 系内）——
const _q = new Cesium.Quaternion();
const _m3 = new Cesium.Matrix3();
const _rotM = new Cesium.Matrix4();
const _enuM = new Cesium.Matrix4();
const _dir = new Cesium.Cartesian3();

/** 求把 ENU 天顶(0,0,1) 旋到单位向量 dir 的四元数（机头朝速度方向用） */
function quatUpTo(dir, out) {
  const d = Cesium.Cartesian3.dot(Cesium.Cartesian3.UNIT_Z, dir);
  if (d > 0.999999) return Cesium.Quaternion.clone(Cesium.Quaternion.IDENTITY, out);
  if (d < -0.999999) return Cesium.Quaternion.fromAxisAngle(Cesium.Cartesian3.UNIT_X, Math.PI, out);
  Cesium.Cartesian3.cross(Cesium.Cartesian3.UNIT_Z, dir, _dir);
  Cesium.Cartesian3.normalize(_dir, _dir);
  return Cesium.Quaternion.fromAxisAngle(_dir, Math.acos(Math.max(-1, Math.min(1, d))), out);
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

/** 模型绕固定 ENU 轴翻滚（分离件用） */
function tumbleQuat(axis, angle, out) {
  return Cesium.Quaternion.fromAxisAngle(axis, angle, out);
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

  let raf = 0, last = 0;
  let p = 0, playing = false, mult = 1;
  let launchSiteKey = 'wenchang';
  let landingSiteKey = 'imbrium';
  let inMoon = false;
  let _wasPlaying = false;  // 拖拽进度条前的播放态（松手恢复）

  // 路径数据（start/seekTo 时生成）
  let earthPath = [];      // 第一幕上升段 [lon,lat,alt]
  let transferPts = [];    // 第二幕转移航线 [lon,lat,alt]
  let transferCarts = [];  // 转移航线 Cartesian3（画线用）
  let transferMid = null;  // 航线中点 Cartesian3（顶视相机锚点）
  let launchCarts = [];    // 已飞发射轨迹 Cartesian3（逐帧追加）
  let trailCarts = [];     // 已飞转移轨迹 Cartesian3（每帧取前缀）
  let lastLaunch = null;   // 发射轨迹上一次追加点（节流）

  // 实体
  let earthRocket = null;
  let launchTrailEnt = null;   // 发射轨迹线
  let transferFullEnt = null;  // 转移规划航线（虚线）
  let transferTrailEnt = null; // 已飞转移轨迹（亮线）
  let moonIconEnt = null;      // 示意月球
  let moonRing = null;
  let moonCraft = null;
  // 分离件（第一幕临时实体）
  let boosters = [];    // [{ent, dir}]
  let fairings = [];    // [{ent, dir}]

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

  // 转移航线：起点 = 入轨点；经度向东南太平洋推进、纬度中段上拱成弧、高度加速抬升。
  // 终点高度 13500 km（真实月距 384000 km 的约 1/28 压缩示意）。
  function makeTransferPath(pad, liftEndPos) {
    const pts = [];
    const lon1 = pad.lon + 38, lat1 = pad.lat + 8, alt1 = 13500000;
    const N = 120;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      pts.push([
        lerp(liftEndPos[0], lon1, t),
        lerp(liftEndPos[1], lat1, t) + Math.sin(t * Math.PI) * 4,
        lerp(liftEndPos[2], alt1, t * t),
      ]);
    }
    return pts;
  }

  function buildPathData() {
    const pad = LAUNCH_SITES[launchSiteKey];
    earthPath = makeEarthPath(pad);
    transferPts = makeTransferPath(pad, earthPath[earthPath.length - 1]);
    transferCarts = transferPts.map((q) => Cesium.Cartesian3.fromDegrees(q[0], q[1], q[2]));
    const mid = transferPts[Math.floor(transferPts.length / 2)];
    transferMid = Cesium.Cartesian3.fromDegrees(mid[0], mid[1], mid[2]);
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
  }

  // ---- 轨迹与示意月球（地球侧，幂等创建，stop 时统一清理）----
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
      const flat = [];
      for (const q of transferPts) flat.push(q[0], q[1], q[2]);
      transferFullEnt = earthViewer.entities.add({
        id: 'moonTransferPath',
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArrayHeights(flat),
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
    if (!moonIconEnt) {
      const end = transferPts[transferPts.length - 1];
      moonIconEnt = earthViewer.entities.add({
        id: 'moonTransferTarget',
        position: Cesium.Cartesian3.fromDegrees(end[0], end[1], end[2]),
        billboard: {
          image: MOON_ICON,
          width: 46,
          height: 46,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: '月球（示意 · 距离已压缩）',
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
  }

  // 主箭位置（第一、二幕内确定）
  function rocketPosAt(pp) {
    if (pp < T.liftEnd) {
      // 上升段：easeIn 加速爬升
      return samplePath(earthPath, easeIn(clamp01(pp / T.liftEnd)) * 0.999);
    }
    if (pp < T.transferEnd) {
      return samplePath(transferPts, clamp01((pp - T.card1End) / (T.transferEnd - T.card1End)));
    }
    return transferPts[transferPts.length - 1];
  }

  // 飞行方向角（屏幕旋转角）：上升段竖直、转移段沿轨迹切线
  function flightRotation(pp) {
    if (pp < T.liftEnd) return 0;
    const s = clamp01((pp - T.card1End) / (T.transferEnd - T.card1End));
    const a = rocketPosAt(T.card1End + (T.transferEnd - T.card1End) * Math.max(0, s - 0.01));
    const b = rocketPosAt(T.card1End + (T.transferEnd - T.card1End) * Math.min(1, s + 0.01));
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
      try { mv.camera.lookAtTransform(Cesium.Matrix4.IDENTITY); } catch { /* 忽略 */ }
    }
  }

  function ensureMoonScene() {
    if (inMoon && moonCraft) return;
    const mv = env.showMoon();
    inMoon = true;
    if (!mv) return;
    // 月球 viewer 每次进入都会重建（destroyMoonViewer → viewer.destroy()，其 primitives 随之销毁），
    // 旧槽位里的 Model 已不可用：检测换代即销毁重建，避免把死模型挂进新场景。
    if (moonViewerRef !== mv) {
      destroySlot(loiCraftSlot); loiCraftSlot = null;
      destroySlot(landerSlot); landerSlot = null;
      destroySlot(roverSlot); roverSlot = null;
      moonViewerRef = mv;
    }
    const site = MOON_LANDING_SITES[landingSiteKey];

    // 环月轨迹（闭环，即环月段轨迹描绘）
    const flat = [];
    for (let i = 0; i <= 120; i++) {
      flat.push(wrapLon((i / 120) * 360), site.lat, 200000);
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

    // 航天器 / 着陆器（同一实体，末段换图标）
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

  // 第二幕顶视相机：俯瞰整条转移航线（局部太阳系顶视图）
  function lookAtTransfer() {
    if (!transferMid) return;
    earthViewer.camera.lookAt(
      transferMid,
      new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-83), 28000000)
    );
  }

  function focusEarth(alt, wide) {
    // 末端 clamp 900m~300km：3D 火箭仅 36m 高，不 clamp 的话触地/入轨瞬间只剩 1~2 像素
    const range = wide ? 3.0e7 : Cesium.Math.clamp(alt * 2.6, 900, 3.0e5);
    const pos = earthRocket ? earthRocket.position.getValue(Cesium.JulianDate.now()) : null;
    if (!pos) return;
    earthViewer.camera.lookAt(
      pos,
      new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-38), range)
    );
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
      }
      ensureEarthRocket();
      ensureTransferScene();
      hideCard();

      if (p < T.liftEnd) {
        // 第一幕：点火起飞（上升 + 分离动效 + 发射轨迹）
        earthRocket.show = true;
        noteOn(false);
        const pos = rocketPosAt(p);
        const cart = Cesium.Cartesian3.fromDegrees(pos[0], pos[1], pos[2]);
        earthRocket.position = cart;
        // 3D 整箭（机头沿速度方向）；未就绪/失败回退 billboard
        if (updateRocketModel(getRocketSlot(), cart, flightDirENU(p))) {
          earthRocket.billboard.show = false;
          hideSlot(craftSlot);
        } else {
          earthRocket.billboard.show = true;
          earthRocket.billboard.rotation = 0;
          earthRocket.billboard.image = p >= BOOSTER_SEP ? STAGE1_ICON : FULL_ROCKET_ICON;
        }
        if (p >= FAIRING_SEP) {
          earthRocket.label.text = '长征五号 · 整流罩分离';
        } else if (p >= BOOSTER_SEP) {
          earthRocket.label.text = '长征五号 · 助推器分离';
        } else {
          earthRocket.label.text = '长征五号 · 点火升空';
        }
        pushLaunchTrail(pos);
        updateSeparators();
        setPhase('第一幕 · 点火起飞');
        focusEarth(pos[2]);
      } else if (p < T.card1End) {
        // 幕卡 1：点火起飞 → 月地转移
        clearSeparators();
        earthRocket.show = false;
        noteOn(false);
        showCard('第一幕 · 点火起飞完成\n「进入地月转移轨道」');
        setPhase('幕间');
        focusEarth(200000);
      } else if (p < T.transferEnd) {
        // 第二幕：月地转移（局部太阳系顶视图）
        earthRocket.show = true;
        noteOn(true);
        const s = clamp01((p - T.card1End) / (T.transferEnd - T.card1End));
        const pos = rocketPosAt(p);
        const cart = Cesium.Cartesian3.fromDegrees(pos[0], pos[1], pos[2]);
        earthRocket.position = cart;
        // 3D 飞船上面级（机头沿航线切向）
        if (updateRocketModel(getCraftSlot(), cart, flightDirENU(p))) {
          earthRocket.billboard.show = false;
          hideSlot(rocketSlot);
        } else {
          earthRocket.billboard.show = true;
          earthRocket.billboard.rotation = flightRotation(p);
          earthRocket.billboard.image = SPACECRAFT_ICON;
        }
        earthRocket.label.text = '探月飞船 · 地月转移';
        updateTransferTrail(s);
        setPhase('第二幕 · 月地转移（距离已压缩 · 示意）');
        lookAtTransfer();
      } else {
        // 幕卡 2：转移 → 环月/着陆
        clearSeparators();
        earthRocket.show = false;
        showCard('第二幕 · 抵达月球影响球\n「准备环月制动与着陆」');
        setPhase('幕间');
        lookAtTransfer();
      }
      return;
    }

    // —— 月球侧（第三幕：环月制动 → 动力下降着陆；第四幕：玉兔巡视）——
    hideCard();
    noteOn(false);
    if (earthRocket) earthRocket.show = false;
    clearSeparators();
    ensureMoonScene();
    const mv = env.getMoonViewer();
    if (!mv || !moonCraft) return;
    const site = MOON_LANDING_SITES[landingSiteKey];

    if (p < T.loiEnd) {
      // 环月制动 LOI：沿环月轨迹半圈降轨，俯视机位便于观察轨道
      const s = clamp01((p - T.card2End) / (T.loiEnd - T.card2End));
      const lon = wrapLon(site.lon - 180 + 180 * s);
      const alt = lerp(800000, 200000, s);
      const craftPos = Cesium.Cartesian3.fromDegrees(lon, site.lat, alt, MOON_ELLIPSOID);
      moonCraft.position = craftPos;
      moonCraft.label.text = '环月制动 · LOI';
      setPhase('第三幕 · 环月制动（LOI）');
      // 3D 飞船上面级（机头沿环月切向）；未就绪回退 billboard
      const slot = getLoiCraftSlot();
      if (attachIfReady(slot)) {
        moonCraft.billboard.show = false;
        hideSlot(landerSlot);
        hideSlot(roverSlot);
        const e = 0.01;
        const sa = Math.max(0, s - e), sb = Math.min(1, s + e);
        const a = [wrapLon(site.lon - 180 + 180 * sa), site.lat, lerp(800000, 200000, sa)];
        const b = [wrapLon(site.lon - 180 + 180 * sb), site.lat, lerp(800000, 200000, sb)];
        placeModel(slot, craftPos, quatUpTo(tangentENU(a, b, _dir), _q), MOON_ELLIPSOID);
      } else {
        moonCraft.billboard.show = true;
        moonCraft.billboard.image = SPACECRAFT_ICON;
      }
      mv.camera.lookAt(
        Cesium.Cartesian3.ZERO,
        new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-62), MOON_R * 2.9)
      );
    } else if (p < T.touchEnd) {
      // 动力下降着陆（末端按 DEM 真实地形高接地，避免沉入月面）
      const s = clamp01((p - T.loiEnd) / (T.touchEnd - T.loiEnd));
      const ground = sampleMoonHeight(site.lon, site.lat);
      let alt = ground + Math.max(0, descentAltitude(s));
      if (!isFinite(alt)) alt = Math.max(0, descentAltitude(s));
      const craftPos = Cesium.Cartesian3.fromDegrees(site.lon, site.lat, alt, MOON_ELLIPSOID);
      moonCraft.position = craftPos;
      moonCraft.label.text = site.name + ' · 动力下降';
      setPhase(s >= 1 ? '第三幕 · 月面着陆完成' : '第三幕 · 月面着陆');
      // 3D 着陆器（竖直下降：identity 旋转即竖直）；未就绪回退 billboard
      const slot = getLanderSlot();
      if (attachIfReady(slot)) {
        moonCraft.billboard.show = false;
        hideSlot(loiCraftSlot);
        hideSlot(roverSlot);
        placeModel(slot, craftPos, Cesium.Quaternion.IDENTITY, MOON_ELLIPSOID);
      } else {
        moonCraft.billboard.show = true;
        moonCraft.billboard.image = LANDER_ICON;
      }
      // 关键：必须传 Cartesian3 本体；传 Property 会得到 NaN 相机 → 渲染崩溃
      // 末端机位 clamp 到 30m：着陆器仅 ~4.4m 高，不 clamp 的话触月瞬间只有 1~2 像素
      mv.camera.lookAt(
        craftPos,
        new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-22), Math.max(30, (alt - ground) * 2.4))
      );
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
      if (attachIfReady(ls)) placeModel(ls, landerPos, Cesium.Quaternion.IDENTITY, MOON_ELLIPSOID);
      hideSlot(loiCraftSlot);
      // 月球车：前进 +X（Y→Z 轴校正后即 ENU 东向）；轮子动画 REPEAT ×1.2（≈1.5 转/秒，匹配 1.5m/s）
      const rs = getRoverSlot();
      if (attachIfReady(rs)) {
        moonCraft.billboard.show = false;
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
      // 相机取着陆器与月球车中点、30m 机位：两者同框，轮子滚动清晰可辨
      const mid = Cesium.Cartesian3.midpoint(landerPos, roverPos, new Cesium.Cartesian3());
      mv.camera.lookAt(
        mid,
        new Cesium.HeadingPitchRange(0.34, Cesium.Math.toRadians(-26), 30)
      );
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
    if (playing) {
      p += (dt / BASE_DURATION) * mult;
      if (p >= 1) {
        p = 1;
        playing = false;
        const pb = $('tourPause');
        if (pb) pb.textContent = '重播';
      }
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
        seekFromEvent(e);
      };
      onTrackMove = (e) => { if (e.buttons & 1) seekFromEvent(e); };
      onTrackUp = () => {
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
    // 防「月球模式下点火」：任务从地球起步，无条件切回地球（幂等）
    env.showEarth();
    clearSeparators();
    ensureEarthRocket();
    ensureTransferScene();
    earthRocket.show = true;

    const panel = $('tourPanel');
    panel?.classList.remove('hidden');
    $('tourTitle').textContent = '探月任务 · 三幕剧';
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
    clearSeparators();          // 内含分离件 slot 销毁
    for (const s of slots.slice()) destroySlot(s);
    rocketSlot = craftSlot = loiCraftSlot = landerSlot = roverSlot = null;
    if (earthRocket) { earthViewer.entities.remove(earthRocket); earthRocket = null; }
    if (launchTrailEnt) { earthViewer.entities.remove(launchTrailEnt); launchTrailEnt = null; }
    if (transferFullEnt) { earthViewer.entities.remove(transferFullEnt); transferFullEnt = null; }
    if (transferTrailEnt) { earthViewer.entities.remove(transferTrailEnt); transferTrailEnt = null; }
    if (moonIconEnt) { earthViewer.entities.remove(moonIconEnt); moonIconEnt = null; }
    clearMoonEntities();
    try { earthViewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY); } catch { /* 忽略 */ }
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
    preload: () => { getRocketSlot(); getCraftSlot(); },
    /** 冒烟/诊断：各模型槽位状态（含 minimumPixelSize/computedScale 等运行时量）
     *  注意：Model.boundingSphere/computedScale 在 sceneGraph 未就绪（首次 update 前）时
     *  访问会抛异常，必须逐项 safe 包装（2026-10-17 实测）。 */
    debugState: () => ({
      slots: slots.map((s) => {
        const m = s.model;
        const safe = (fn) => { try { return fn(); } catch { return null; } };
        return {
          key: s.key, ready: s.ready, failed: s.failed, added: s.added,
          anim: s.animCount, animOn: !!s.animOn,
          hasSceneGraph: safe(() => !!m && !!m.sceneGraph),
          minPx: safe(() => (m ? m.minimumPixelSize : null)),
          computedScale: safe(() => (m && isFinite(m.computedScale) ? Math.round(m.computedScale * 1000) / 1000 : null)),
          bsRadius: safe(() => (m && m.sceneGraph && m.boundingSphere ? Math.round(m.boundingSphere.radius * 100) / 100 : null)),
          camDist: safe(() => {
            if (!m || m.isDestroyed() || !m.sceneGraph || !m.boundingSphere || !s.viewer) return null;
            return Math.round(Cesium.Cartesian3.distance(s.viewer.camera.positionWC, m.boundingSphere.center));
          }),
        };
      }),
    }),
    /** 调试/冒烟：跳转到指定进度（跨幕自动补建/清理场景） */
    seek: (f) => seekTo(f),
    setLaunchSite: (k) => { launchSiteKey = k; },
    setLandingSite: (k) => { landingSiteKey = k; },
    getLaunchSite: () => launchSiteKey,
    getLandingSite: () => landingSiteKey,
  };
}

export default createMoonMission;
