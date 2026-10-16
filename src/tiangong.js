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

const SPEED_STEPS = [1, 10, 60, 300, 1200];
const ORBIT_COLOR = Cesium.Color.fromCssColorString('#ffd24a');
const ORBIT_FADE = Cesium.Color.fromCssColorString('#ffd24a').withAlpha(0.35);
// 相位节点（升交点为 0）
const PHASE_TICKS = [
  { u: 0, name: '升交点' },
  { u: Math.PI / 2, name: '最北点' },
  { u: Math.PI, name: '降交点' },
  { u: (3 * Math.PI) / 2, name: '最南点' },
];

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
  $('compressNote')?.classList.add('hidden');
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

// 进度条上的 4 个相位节点（点击跳转空间站相位）
function buildPhaseTicks() {
  const wrap = $('tourTicks');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (const t of PHASE_TICKS) {
    const dot = document.createElement('span');
    dot.className = 'fly-tick';
    dot.style.left = ((t.u / (2 * Math.PI)) * 100).toFixed(2) + '%';
    dot.style.pointerEvents = 'auto';
    dot.style.cursor = 'pointer';
    dot.title = t.name;
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
  const f = stationFraction(_viewer.clock.currentTime) / (2 * Math.PI);
  const bar = $('tourBar');
  if (bar) bar.style.width = (f * 100).toFixed(1) + '%';
  const txt = $('tourProgressText');
  if (txt) txt.textContent = `${Math.round(f * 100)}% · ${(ORBIT_ALT / 1000).toFixed(0)} km 轨道`;
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

  // 飞到可见轨道的位置
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(110, 30, 24000000),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-75), roll: 0 },
    duration: 1.5,
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
    hidePanel();
  }
  _viewer = null;
  console.log('[tiangong] 轨道已移除');
}

export function isTiangongLoaded() {
  return !!_orbitEntity;
}