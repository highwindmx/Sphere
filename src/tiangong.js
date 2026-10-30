// src/tiangong.js — 天宫空间站轨道（闭环示意）
// 采用简化圆轨道模型（400 km 高、41.5° 倾角、92.5 min 周期）：
//   轨道环在惯性系中是一固定圆，逐帧随 GMST 转到地固系 → 任意时刻都是闭合椭圆环（无断口、无双线）。
//   空间站沿环运动，位置同样随 GMST 变换，保证与轨道环严格一致。
// 面板支持：暂停/继续（时钟）、时间倍率、进度条拖拽跳转相位（4 个相位节点）、跟随空间站机位。
// 勾选框 / 「📡 天宫轨道」按钮 = 加载；再点或取消勾选 = 移除。
import * as Cesium from 'cesium';
import { isRouteTourActive } from './route-tour.js';

const EARTH_R = 6378137;         // m
const ORBIT_ALT = 400000;        // 400 km
const ORBIT_R = EARTH_R + ORBIT_ALT;
const INC = Cesium.Math.toRadians(41.5);
const RAAN = Cesium.Math.toRadians(30);
const PERIOD_S = 92.5 * 60;      // s
const MEAN_MOTION = (2 * Math.PI) / PERIOD_S; // rad/s
const RING_SAMPLES = 200;
// 轨道总览机位：相机置于 (105°E, 22°N) 上空 20,000 km，**视线正对地心**（球体居中）。
// 选低纬是为了让 41.5° 倾角的轨道环呈斜椭圆，比正上方俯视更有立体感。
const VIEW_LON = 105;
const VIEW_LAT = 22;
const VIEW_RANGE = 20000000;

const SPEED_STEPS = [1, 10, 60, 300, 1200];
const ORBIT_COLOR = Cesium.Color.fromCssColorString('#ffd24a');
const ORBIT_FADE = Cesium.Color.fromCssColorString('#ffd24a').withAlpha(0.35);
// 相位节点（升交点为 0）——时间轴上的刻度，点击即把空间站跳到该相位。
//   · 前 4 个是**几何节点**（每圈固定不变）：升交点/最北点/降交点/最南点
//   · 另 2 个是**光照节点**（进地影/出地影），随太阳方位缓慢漂移，运行时按当前时刻算（见 shadowNodes）
const PHASE_TICKS = [
  { u: 0, name: '升交点：由南向北穿越赤道（纬度 0°）' },
  { u: Math.PI / 2, name: '最北点：纬度 +41.5°，一圈里的极北' },
  { u: Math.PI, name: '降交点：由北向南穿越赤道（纬度 0°）' },
  { u: (3 * Math.PI) / 2, name: '最南点：纬度 −41.5°，一圈里的极南' },
];
// 星下点落在这个粗框内即算「中国上空」（中国大陆近似：73–135°E，18–54°N）
const CN_BOX = { w: 73, e: 135, s: 18, n: 54 };

let _viewer = null;
let _orbitEntity = null;
let _stationEntity = null;
let _t0 = null;               // 参考时间
let _phase0 = 0;              // 初始相位
let _prevMultiplier = 1;
let _postRender = null;
let _follow = false;          // 跟随空间站机位
let _followBtn = null;
let _pausedByUs = false;      // 面板暂停（canAnimate 由本模块关闭）
let _onSlower = null, _onFaster = null, _onStop = null, _onPause = null;
let _onTrackDown = null, _onTrackMove = null, _onTrackUp = null;
let _tickT = null;                // 上次重算地影节点的模拟时刻（太阳方位漂移后需刷新刻度）

function $(id) { return document.getElementById(id); }

// 简化 GMST（rad）：误差 <0.01°，科普展示足够
function gmstFromDate(date) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const T = (jd - 2451545.0) / 36525;
  let deg = 280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * T * T - (T * T * T) / 38710000;
  deg = ((deg % 360) + 360) % 360;
  return Cesium.Math.toRadians(deg);
}
// 惯性系轨道点（m）：u = 升交点角距
function orbitEci(u) {
  const cu = Math.cos(u), su = Math.sin(u);
  const cO = Math.cos(RAAN), sO = Math.sin(RAAN);
  const cI = Math.cos(INC), sI = Math.sin(INC);
  return [
    ORBIT_R * (cu * cO - su * cI * sO),
    ORBIT_R * (cu * sO + su * cI * cO),
    ORBIT_R * (su * sI),
  ];
}
function eciToFixed(eci, gmst) {
  const cg = Math.cos(gmst), sg = Math.sin(gmst);
  return new Cesium.Cartesian3(
    (eci[0] * cg - eci[1] * sg),
    (eci[0] * sg + eci[1] * cg),
    eci[2]
  );
}
// 轨道环（闭环）：i 从 0..SAMPLES，末点 = 首点（u 取模回绕）
function ringPositions(time) {
  const gmst = gmstFromDate(Cesium.JulianDate.toDate(time));
  const arr = new Array(RING_SAMPLES + 1);
  for (let i = 0; i <= RING_SAMPLES; i++) {
    const u = ((i % RING_SAMPLES) / RING_SAMPLES) * 2 * Math.PI;
    arr[i] = eciToFixed(orbitEci(u), gmst);
  }
  return arr;
}
function stationFraction(time) {
  const dt = Cesium.JulianDate.secondsDifference(time, _t0);
  let u = (_phase0 + MEAN_MOTION * dt) % (2 * Math.PI);
  if (u < 0) u += 2 * Math.PI;
  return u;
}
function stationPosition(time) {
  const gmst = gmstFromDate(Cesium.JulianDate.toDate(time));
  return eciToFixed(orbitEci(stationFraction(time)), gmst);
}

// ====== 地面时间 / 星下点 / 光照（2026-10-28 用户要求：行进时显示对应地面时间）======
// 太阳方向（惯性系单位向量）：低精度天文算法（误差 <0.5°，判断地影足够）
function sunEci(date) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const D2R = Math.PI / 180;
  const L = (280.460 + 0.9856474 * n) * D2R;            // 平黄经
  const g = (357.528 + 0.9856003 * n) * D2R;            // 平近点角
  const lam = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R; // 视黄经
  const eps = 23.439 * D2R;                             // 黄赤交角
  return [Math.cos(lam), Math.cos(eps) * Math.sin(lam), Math.sin(eps) * Math.sin(lam)];
}
// 太阳方向（地固系）：与轨道用同一套 GMST 变换，保证相对几何一致
function sunFixed(date) {
  return eciToFixed(sunEci(date), gmstFromDate(date));
}
// 圆柱地影模型：空间站落在地球背光侧的圆柱内即为地影（忽略半影/大气，科普足够）
function inShadow(time) {
  const p = stationPosition(time);
  const s = Cesium.Cartesian3.normalize(sunFixed(Cesium.JulianDate.toDate(time)), new Cesium.Cartesian3());
  const c = -Cesium.Cartesian3.dot(p, s);               // 沿背光方向的投影（>0 = 在夜半球一侧）
  if (c <= 0) return false;
  const perp2 = Cesium.Cartesian3.magnitudeSquared(p) - c * c;
  return perp2 < EARTH_R * EARTH_R;
}
const _cart = new Cesium.Cartographic();
function subpointOf(p) {
  const c = Cesium.Cartographic.fromCartesian(p, Cesium.Ellipsoid.WGS84, _cart);
  if (!c) return null;
  return { lat: c.latitude * 180 / Math.PI, lon: c.longitude * 180 / Math.PI };
}
function fmtLatLon(sp) {
  if (!sp) return '—';
  const a = Math.abs(sp.lat).toFixed(1) + '°' + (sp.lat >= 0 ? 'N' : 'S');
  const o = Math.abs(sp.lon).toFixed(1) + '°' + (sp.lon >= 0 ? 'E' : 'W');
  return `${a} ${o}`;
}
// 北京时间（UTC+8）——展示"轨道行进到此处时，地面上是几点"
function fmtBeijing(date) {
  const t = new Date(date.getTime() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
}
// 进/出地影的相位节点：扫描一圈，取状态翻转处（太阳方位每天只移 1°，会话内稳定）
function shadowNodes() {
  const out = [];
  if (!_t0) return out;
  const N = 360;
  let prev = null;
  for (let i = 0; i <= N; i++) {
    const u = (i / N) * 2 * Math.PI;
    const t = Cesium.JulianDate.addSeconds(_t0, (u - _phase0) / MEAN_MOTION, new Cesium.JulianDate());
    const s = inShadow(t);
    if (prev !== null && s !== prev) {
      out.push({ u, kind: 'shadow', name: s ? '进入地影：站上进入夜区（不可见）' : '离开地影：站上复见阳光' });
    }
    prev = s;
  }
  return out;
}

// ====== 球体在"右侧展示页"居中（2026-10-28 用户要求）======
// 背景：画布是 #cesiumContainer（flex:1，已在左栏右侧），但①底部巡游面板会盖住画面下沿、
// ②若左栏改为浮层压在画布上，还得让出左栏宽度。这里按"未被遮挡的矩形"求中心，
// 再把相机平移过去（平移量 = 距离 × tan(半张角) × 遮挡占比，纯几何，与机位无关）。
function fovTans(cam) {
  const def = { h: Math.tan(Math.PI / 6), v: Math.tan(Math.PI / 6) / (16 / 9) };
  try {
    const f = cam && cam.frustum;
    if (f && typeof f.fov === 'number' && isFinite(f.fov) && f.fov > 0) {
      let asp = f.aspectRatio;
      if (!(asp > 0) || !isFinite(asp)) asp = 16 / 9;
      // Cesium：aspect>=1 时 fov 是**水平**张角，否则是竖直张角
      return asp >= 1
        ? { h: Math.tan(f.fov / 2), v: Math.tan(f.fov / 2) / asp }
        : { v: Math.tan(f.fov / 2), h: Math.tan(f.fov / 2) * asp };
    }
  } catch { /* 忽略 */ }
  return def;
}
function occludedRect(canvas) {
  const r = canvas.getBoundingClientRect();
  const W = canvas.clientWidth || r.width || 1;
  const H = canvas.clientHeight || r.height || 1;
  // 左栏遮挡宽度（flex 布局下通常为 0；若左栏浮在画布上则为其压住的宽度）
  let leftOcc = 0;
  try {
    const panel = document.getElementById('panel');
    if (panel && !document.body.classList.contains('panel-collapsed')) {
      const pr = panel.getBoundingClientRect();
      if (pr.width > 0) leftOcc = Math.max(0, Math.min(pr.right - r.left, W * 0.5));
    }
  } catch { /* 忽略 */ }
  // 底部巡游面板遮挡高度
  let botOcc = 0;
  try {
    const tp = document.getElementById('tourPanel');
    if (tp && !tp.classList.contains('hidden')) {
      const tr = tp.getBoundingClientRect();
      if (tr.height > 0) botOcc = Math.max(0, Math.min(r.bottom - tr.top + 12, H * 0.45));
    }
  } catch { /* 忽略 */ }
  return { leftOcc, botOcc, W, H };
}
/** 把地球球心移到"未被遮挡区域"的中心（相机反向平移，保持视线方向不变） */
function centerGlobeInView(viewer, duration = 0.5) {
  const cam = viewer && viewer.camera;
  const canvas = viewer && viewer.scene && viewer.scene.canvas;
  if (!cam || !canvas) return;
  const { leftOcc, botOcc, W, H } = occludedRect(canvas);
  if (leftOcc <= 0 && botOcc <= 0) return;
  const dist = Cesium.Cartesian3.magnitude(cam.positionWC);   // 地心距（球心即 ECEF 原点）
  if (!(dist > 0)) return;
  const { h: tanH, v: tanV } = fovTans(cam);
  const dRight = dist * tanH * (leftOcc / W);   // 球体需右移 → 相机左移
  const dUp = dist * tanV * (botOcc / H);       // 球体需上移 → 相机下移
  const pos = Cesium.Cartesian3.clone(cam.positionWC, new Cesium.Cartesian3());
  const right = Cesium.Cartesian3.clone(cam.rightWC, new Cesium.Cartesian3());
  const up = Cesium.Cartesian3.clone(cam.upWC, new Cesium.Cartesian3());
  Cesium.Cartesian3.multiplyByScalar(right, -dRight, right);
  Cesium.Cartesian3.multiplyByScalar(up, -dUp, up);
  Cesium.Cartesian3.add(pos, right, pos);
  Cesium.Cartesian3.add(pos, up, pos);
  const dir = Cesium.Cartesian3.clone(cam.directionWC, new Cesium.Cartesian3());
  const upv = Cesium.Cartesian3.clone(cam.upWC, new Cesium.Cartesian3());
  cam.flyTo({ destination: pos, orientation: { direction: dir, up: upv }, duration });
}

function updatePanelClock(viewer) {
  const label = $('timeSpeedLabel');
  if (label) label.textContent = `${viewer.clock.multiplier}×`;
}
function showPanel(viewer) {
  const panel = $('tourPanel');
  if (!panel) return;
  panel.classList.remove('hidden');
  $('tourTitle').textContent = '天宫空间站轨道';
  $('rocketPhase').classList.add('hidden');
  $('flyControls').classList.add('hidden');
  $('rocketControls').classList.add('hidden');
  $('btnLaunch').classList.add('hidden');
  $('timelineNote')?.classList.add('hidden');
  $('actCard')?.classList.add('hidden');
  $('tourBar').style.width = '0%';
  $('tourProgressText').textContent = '0%';
  const pb = $('tourPause');
  pb.classList.remove('hidden');
  pb.textContent = viewer.clock.canAnimate ? '暂停' : '播放';
  updatePanelClock(viewer);
  buildPhaseTicks();
}
function hidePanel() {
  const panel = $('tourPanel');
  if (panel) panel.classList.add('hidden');
}

// 进度条上的节点：4 个几何相位 + 2 个光照（进/出地影）；点击跳转空间站相位
function buildPhaseTicks() {
  const wrap = $('tourTicks');
  if (!wrap) return;
  wrap.innerHTML = '';
  const nodes = PHASE_TICKS.concat(shadowNodes());
  for (const t of nodes) {
    const dot = document.createElement('span');
    dot.className = 'fly-tick' + (t.kind === 'shadow' ? ' night' : '');
    dot.style.left = ((t.u / (2 * Math.PI)) * 100).toFixed(2) + '%';
    dot.style.pointerEvents = 'auto';
    dot.style.cursor = 'pointer';
    dot.title = t.name + ' · 点击跳到此处';
    dot.addEventListener('pointerdown', (e) => e.stopPropagation());
    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      seekPhase(t.u);
    });
    wrap.appendChild(dot);
  }
}

// 把空间站相位设为 u（反算并重写时钟 currentTime；环与站同步，闭环不破）
function seekPhase(u) {
  if (!_viewer || !_t0) return;
  const clock = _viewer.clock;
  // 目标： stationFraction(currentTime) = u
  // 令 dt = (u - _phase0)/MEAN_MOTION，则 currentTime = _t0 + dt
  const dt = (u - _phase0) / MEAN_MOTION;
  const target = Cesium.JulianDate.addSeconds(_t0, dt, new Cesium.JulianDate());
  try {
    clock.currentTime = target;
  } catch { /* 忽略 */ }
  updatePhaseUI();
}

function updatePhaseUI() {
  if (!_viewer) return;
  const now = _viewer.clock.currentTime;
  const f = stationFraction(now) / (2 * Math.PI);
  const bar = $('tourBar');
  if (bar) bar.style.width = (f * 100).toFixed(1) + '%';

  // 地面时间 + 星下点 + 光照（行进中实时刷新）
  const sp = subpointOf(stationPosition(now));
  const night = inShadow(now);
  const overCN = !!sp && sp.lon >= CN_BOX.w && sp.lon <= CN_BOX.e && sp.lat >= CN_BOX.s && sp.lat <= CN_BOX.n;
  const txt = $('tourProgressText');
  if (txt) {
    txt.textContent = `${Math.round(f * 100)}% · 星下点 ${fmtLatLon(sp)}`;
    txt.title = `轨道高度 ${(ORBIT_ALT / 1000).toFixed(0)} km · 周期 ${(PERIOD_S / 60).toFixed(1)} min · 倾角 41.5°`;
  }
  const clk = $('tourClock');
  if (clk) {
    clk.textContent = `🕐 北京 ${fmtBeijing(Cesium.JulianDate.toDate(now))} · ${night ? '🌑 地影' : '☀ 日照'}${overCN ? ' · 🇨🇳 中国上空' : ''}`;
    clk.title = '空间站当前位置对应的地面时间（北京时间 UTC+8）与光照状态';
  }

  // 地影节点随太阳方位缓慢漂移：模拟时间推进超过 1 小时就重算一次刻度
  if (_tickT == null || Math.abs(Cesium.JulianDate.secondsDifference(now, _tickT)) > 3600) {
    _tickT = Cesium.JulianDate.clone(now, _tickT || new Cesium.JulianDate());
    buildPhaseTicks();
  }
}

// 跟随/取消跟随空间站机位
function setFollow(on) {
  _follow = on;
  if (_followBtn) _followBtn.textContent = on ? '跟随：开' : '跟随：关';
  if (!on && _viewer) {
    try { _viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY); } catch { /* 忽略 */ }
  }
}

/**
 * 加载天宫空间站轨道
 * @param {Cesium.Viewer} viewer
 * @returns {Promise<boolean>}
 */
export async function loadTiangong(viewer) {
  if (_orbitEntity) return true; // 已加载
  _viewer = viewer;
  _t0 = Cesium.JulianDate.now();
  _phase0 = Cesium.Math.toRadians(20);
  _orbitEntity = viewer.entities.add({
    id: 'tiangongOrbit',
    polyline: {
      positions: new Cesium.CallbackProperty(ringPositions, false),
      width: 2,
      material: ORBIT_COLOR,
      // 被地球遮挡的半圈用半透明补全 → 任意视角都呈现闭环
      depthFailMaterial: ORBIT_FADE,
      arcType: Cesium.ArcType.NONE,
    },
  });
  _stationEntity = viewer.entities.add({
    id: 'tiangongStation',
    position: new Cesium.CallbackProperty(stationPosition, false),
    point: {
      pixelSize: 9,
      color: Cesium.Color.fromCssColorString('#7fc4ff'),
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 2,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: {
      text: '天宫空间站',
      font: '13px "Microsoft YaHei", "PingFang SC", sans-serif',
      fillColor: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      pixelOffset: new Cesium.Cartesian2(0, -16),
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      showBackground: true,
      backgroundColor: new Cesium.Color(0.05, 0.08, 0.18, 0.7),
      backgroundPadding: new Cesium.Cartesian2(6, 4),
    },
  });
  // 时钟推进（60× 起步，站内每圈约 92 s 可见）
  _prevMultiplier = viewer.clock.multiplier;
  viewer.clock.multiplier = 60;
  viewer.clock.canAnimate = true;
  _pausedByUs = false;
  showPanel(viewer);

  // 跟随开关（插在停止按钮前，移除时删除）
  _followBtn = document.createElement('button');
  _followBtn.className = 'fly-action';
  _followBtn.id = 'tourFollowTiangong';
  _followBtn.textContent = '跟随：关';
  _followBtn.addEventListener('click', () => setFollow(!_follow));
  $('tourStop')?.before(_followBtn);
  setFollow(false);

  // 进度条 = 轨道相位；跟随时相机盯住空间站
  _postRender = () => {
    if (!_orbitEntity) return;
    updatePhaseUI();
    updatePanelClock(viewer);
    if (_follow && _stationEntity) {
      const pos = stationPosition(viewer.clock.currentTime);
      const up = Cesium.Cartesian3.normalize(pos, new Cesium.Cartesian3());
      const hpr = new Cesium.HeadingPitchRoll(0, Cesium.Math.toRadians(-32), 0);
      viewer.camera.lookAt(pos, new Cesium.HeadingPitchRange(0, hpr.pitch, ORBIT_ALT * 3.2));
      void up;
    }
  };
  viewer.scene.postRender.addEventListener(_postRender);

  // 暂停/继续：切换时钟 canAnimate
  _onPause = () => {
    if (isRouteTourActive()) return;
    viewer.clock.canAnimate = !viewer.clock.canAnimate;
    _pausedByUs = !viewer.clock.canAnimate;
    const pb = $('tourPause');
    if (pb) pb.textContent = viewer.clock.canAnimate ? '暂停' : '播放';
  };
  // 时间倍率（巡礼进行中则让位给巡礼）
  const step = (dir) => {
    if (isRouteTourActive()) return;
    const idx = SPEED_STEPS.indexOf(viewer.clock.multiplier);
    const cur = idx >= 0 ? idx : SPEED_STEPS.reduce(
      (best, v, i) => (Math.abs(v - viewer.clock.multiplier) < Math.abs(SPEED_STEPS[best] - viewer.clock.multiplier) ? i : best), 2);
    const next = Math.max(0, Math.min(SPEED_STEPS.length - 1, cur + dir));
    viewer.clock.multiplier = SPEED_STEPS[next];
    updatePanelClock(viewer);
  };
  _onSlower = () => step(-1);
  _onFaster = () => step(1);
  _onStop = () => { if (!isRouteTourActive()) removeTiangong(viewer); };
  $('tourPause')?.addEventListener('click', _onPause);
  $('timeSlower')?.addEventListener('click', _onSlower);
  $('timeFaster')?.addEventListener('click', _onFaster);
  $('tourStop')?.addEventListener('click', _onStop);

  // 进度条拖拽跳转相位（拖动期间暂停时钟，松手恢复原状态）
  const track = $('tourTrack');
  if (track) {
    track.style.position = 'relative';
    let wasAnimate = true;
    const seekFromEvent = (e) => {
      const rect = track.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      seekPhase(f * 2 * Math.PI);
    };
    _onTrackDown = (e) => {
      wasAnimate = viewer.clock.canAnimate;
      viewer.clock.canAnimate = false;
      seekFromEvent(e);
    };
    _onTrackMove = (e) => { if (e.buttons & 1) seekFromEvent(e); };
    _onTrackUp = () => {
      viewer.clock.canAnimate = wasAnimate;
      const pb = $('tourPause');
      if (pb) pb.textContent = viewer.clock.canAnimate ? '暂停' : '播放';
    };
    track.addEventListener('pointerdown', _onTrackDown);
    window.addEventListener('pointermove', _onTrackMove);
    window.addEventListener('pointerup', _onTrackUp);
  }

  // 飞到可见轨道的位置：视线**正对地心** → 球心落在画面正中
  // （旧写法是 heading0/pitch−75，视线偏离天底 15°，球体被推到画面上方且顶部出画；
  //   再由 centerGlobeInView 让出底部巡游面板：球体落到"未被遮挡区域"的中心）
  const dest = Cesium.Cartesian3.fromDegrees(VIEW_LON, VIEW_LAT, VIEW_RANGE);
  const dir = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.negate(dest, new Cesium.Cartesian3()), new Cesium.Cartesian3());
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(dest);
  const north = Cesium.Matrix4.getColumn(enu, 1, new Cesium.Cartesian3());
  const d = Cesium.Cartesian3.dot(north, dir);
  const up = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.subtract(north, Cesium.Cartesian3.multiplyByScalar(dir, d, new Cesium.Cartesian3()), new Cesium.Cartesian3()),
    new Cesium.Cartesian3());
  viewer.camera.flyTo({
    destination: dest,
    orientation: { direction: dir, up },
    duration: 1.5,
    complete: () => centerGlobeInView(viewer),
  });
  console.log('[tiangong] 轨道已加载（闭环示意 · 暂停/seek/跟随可用）');
  return true;
}

export function removeTiangong(viewer) {
  setFollow(false);
  if (_postRender) {
    try { viewer.scene.postRender.removeEventListener(_postRender); } catch { /* 忽略 */ }
    _postRender = null;
  }
  if (_onPause) $('tourPause')?.removeEventListener('click', _onPause);
  if (_onSlower) $('timeSlower')?.removeEventListener('click', _onSlower);
  if (_onFaster) $('timeFaster')?.removeEventListener('click', _onFaster);
  if (_onStop) $('tourStop')?.removeEventListener('click', _onStop);
  const track = $('tourTrack');
  if (track && _onTrackDown) track.removeEventListener('pointerdown', _onTrackDown);
  if (_onTrackMove) window.removeEventListener('pointermove', _onTrackMove);
  if (_onTrackUp) window.removeEventListener('pointerup', _onTrackUp);
  _onSlower = _onFaster = _onStop = _onPause = null;
  _onTrackDown = _onTrackMove = _onTrackUp = null;
  _followBtn?.remove();
  _followBtn = null;
  if (_orbitEntity) { viewer.entities.remove(_orbitEntity); _orbitEntity = null; }
  if (_stationEntity) { viewer.entities.remove(_stationEntity); _stationEntity = null; }
  try { viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY); } catch { /* 忽略 */ }

  if (!isRouteTourActive()) {
    viewer.clock.multiplier = _prevMultiplier || 1;
    if (_pausedByUs) viewer.clock.canAnimate = true; // 恢复时钟，避免遗留暂停
    _pausedByUs = false;
    $('tourPause')?.classList.add('hidden');
    $('tourTicks').innerHTML = '';
    // 地面时间芯片是面板共用元素：退出时必须清空，否则巡礼/探月会残留天宫的时间
    const clk = $('tourClock');
    if (clk) { clk.textContent = ''; clk.title = ''; }
    hidePanel();
  }
  _tickT = null;
  _viewer = null;
  console.log('[tiangong] 轨道已移除');
}

export function isTiangongLoaded() {
  return !!_orbitEntity;
}