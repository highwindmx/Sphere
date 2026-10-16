// src/route-tour.js — 通用路线巡礼
// 沿折线行进：播放/暂停、⏪/⏩ 加减速、进度条拖拽跳转、站点节点点击跳转、相机跟随。
// 复用 index.html 预留的 #tourPanel 骨架（进度条 / ticks / 暂停 / 倍率 / 停止）。
// 未来卫星发射等线路类功能直接调 startRouteTour(viewer, { title, color, coords }) 接入。

import * as Cesium from 'cesium';

const SPEED_STEPS = [0.5, 1, 2, 4, 8]; // 倍率档位
const BASE_DURATION = 90;              // 1× 时全程行进秒数

let _st = null; // 当前巡礼状态

function $(id) {
  return document.getElementById(id);
}

/** 是否正在巡礼（供指北针等模块做相机所有权判断） */
export function isRouteTourActive() {
  return !!_st;
}

/** 巡礼是否正在抢占相机（lookAt 跟随） */
export function isRouteTourFollowing() {
  return !!(_st && _st.follow);
}

// ====== 弧长表：累计里程 → 任意分数位置 ======
function buildArcTable(coords) {
  const pts = coords.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat));
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Cesium.Cartesian3.distance(pts[i - 1], pts[i]));
  }
  return { pts, cum, total: cum[cum.length - 1] || 1 };
}

function posAtFraction(table, f) {
  const { pts, cum, total } = table;
  const target = Math.max(0, Math.min(1, f)) * total;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < target) i++;
  const segLen = cum[i] - cum[i - 1] || 1e-9;
  const t = (target - cum[i - 1]) / segLen;
  return Cesium.Cartesian3.lerp(pts[i - 1], pts[i], t, new Cesium.Cartesian3());
}

function traveledPositions(table, f) {
  const { pts, cum, total } = table;
  const target = Math.min(1, Math.max(0, f)) * total;
  const arr = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (cum[i] <= target) arr.push(pts[i]);
    else break;
  }
  if (f > 0) arr.push(posAtFraction(table, f));
  if (arr.length < 2) arr.push(pts[0]);
  return arr;
}

// ====== 启动巡礼 ======
export function startRouteTour(viewer, { title, color, coords }) {
  stopRouteTour(); // 先清理旧巡礼
  if (!Array.isArray(coords) || coords.length < 2) {
    console.warn('[route-tour] 航点不足，无法巡礼');
    return;
  }

  const table = buildArcTable(coords);
  const baseColor = Cesium.Color.fromCssColorString(color ?? '#ffd24a');
  const travelColor = Cesium.Color.fromCssColorString('#ffd24a');

  // ---- 实体：已走高亮线 + 行进标记 ----
  const traveledEnt = viewer.entities.add({
    polyline: {
      positions: new Cesium.CallbackProperty(() => traveledPositions(table, _st?.f ?? 0), false),
      width: 5,
      material: travelColor,
      clampToGround: true,
    },
  });
  const markerEnt = viewer.entities.add({
    position: new Cesium.CallbackProperty(() => posAtFraction(table, _st?.f ?? 0), false),
    point: {
      pixelSize: 14,
      color: travelColor,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 2,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: {
      text: title,
      font: '13px "Microsoft YaHei", "PingFang SC", sans-serif',
      fillColor: Cesium.Color.WHITE,
      showBackground: true,
      backgroundColor: new Cesium.Color(0.05, 0.08, 0.18, 0.75),
      backgroundPadding: new Cesium.Cartesian2(7, 4),
      pixelOffset: new Cesium.Cartesian2(0, -24),
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });

  // ---- 面板接管 ----
  const panel = $('tourPanel');
  panel.classList.remove('hidden');
  $('tourTitle').textContent = `路线巡礼 · ${title}`;
  $('flyControls').classList.add('hidden');
  $('rocketControls').classList.add('hidden');
  $('rocketPhase').classList.add('hidden');
  $('btnLaunch').classList.add('hidden');
  $('compressNote')?.classList.add('hidden');
  $('actCard')?.classList.add('hidden');
  const pauseBtn = $('tourPause');
  pauseBtn.classList.remove('hidden');
  pauseBtn.textContent = '暂停';

  // 跟随开关（巡礼专属，停止时移除）
  const followBtn = document.createElement('button');
  followBtn.className = 'fly-action';
  followBtn.id = 'tourFollow';
  followBtn.textContent = '跟随：开';
  followBtn.addEventListener('click', () => {
    _st.follow = !_st.follow;
    followBtn.textContent = _st.follow ? '跟随：开' : '跟随：关';
    if (!_st.follow) viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  });
  $('tourStop').before(followBtn);

  // 站点节点（航点百分比）
  const track = $('tourTrack');
  const ticks = $('tourTicks');
  ticks.innerHTML = '';
  for (let i = 1; i < table.cum.length - 1; i++) {
    const pct = (table.cum[i] / table.total) * 100;
    const dot = document.createElement('span');
    dot.className = 'tour-tick';
    dot.style.cssText =
      'position:absolute;top:-4px;width:9px;height:9px;border-radius:50%;' +
      'background:#ffd24a;border:1px solid rgba(0,0,0,.7);' +
      'transform:translateX(-50%);cursor:pointer;z-index:2;';
    dot.style.left = pct + '%';
    dot.title = `航点 ${i}`;
    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      seek(pct / 100);
    });
    ticks.appendChild(dot);
  }

  // ---- 状态 ----
  _st = {
    viewer,
    table,
    f: 0,
    playing: true,
    mult: 1,
    follow: true,
    raf: 0,
    last: performance.now(),
    traveledEnt,
    markerEnt,
    followBtn,
    heading: viewer.camera.heading,
    range: Math.min(2.5e6, Math.max(2e5, table.total * 0.08)),
    // 事件绑定（停止时移除）
    onPause: () => {
      if (_st.f >= 1) _st.f = 0; // 播完后再按 = 重播
      _st.playing = !_st.playing;
      pauseBtn.textContent = _st.playing ? '暂停' : '播放';
    },
    onStop: () => stopRouteTour(),
    onSlower: () => {
      const idx = Math.max(0, SPEED_STEPS.indexOf(_st.mult) - 1);
      _st.mult = SPEED_STEPS[idx];
      $('timeSpeedLabel').textContent = `${_st.mult}×`;
    },
    onFaster: () => {
      const idx = Math.min(SPEED_STEPS.length - 1, SPEED_STEPS.indexOf(_st.mult) + 1);
      _st.mult = SPEED_STEPS[idx];
      $('timeSpeedLabel').textContent = `${_st.mult}×`;
    },
    onTrackDown: null,
    onTrackMove: null,
    onTrackUp: null,
  };
  $('timeSpeedLabel').textContent = `${_st.mult}×`;
  pauseBtn.addEventListener('click', _st.onPause);
  $('tourStop').addEventListener('click', _st.onStop);
  $('timeSlower').addEventListener('click', _st.onSlower);
  $('timeFaster').addEventListener('click', _st.onFaster);

  // 进度条拖拽 seek（拖动期间暂停，松手恢复）
  track.style.position = 'relative';
  const seekFromEvent = (e) => {
    const rect = track.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seek(f);
  };
  _st.onTrackDown = (e) => {
    if (!_st) return;
    _st._wasPlaying = _st.playing;
    _st.playing = false;
    seekFromEvent(e);
  };
  _st.onTrackMove = (e) => {
    if (_st && e.buttons & 1) seekFromEvent(e);
  };
  _st.onTrackUp = () => {
    if (!_st) return;
    if (_st._wasPlaying && _st.f < 1) _st.playing = true;
    pauseBtn.textContent = _st.playing ? '暂停' : '播放';
  };
  track.addEventListener('pointerdown', _st.onTrackDown);
  window.addEventListener('pointermove', _st.onTrackMove);
  window.addEventListener('pointerup', _st.onTrackUp);

  function seek(f) {
    if (!_st) return;
    _st.f = Math.max(0, Math.min(1, f));
  }

  // ---- 主循环 ----
  function tick(now) {
    if (!_st) return;
    const dt = (now - _st.last) / 1000;
    _st.last = now;
    if (_st.playing) {
      _st.f += (dt / BASE_DURATION) * _st.mult;
      if (_st.f >= 1) {
        _st.f = 1;
        _st.playing = false;
        pauseBtn.textContent = '重播';
      }
    }
    // 进度 UI
    $('tourBar').style.width = (_st.f * 100).toFixed(2) + '%';
    $('tourProgressText').textContent =
      `${Math.round(_st.f * 100)}% · ${((_st.f * _st.table.total) / 1000).toFixed(0)} km`;
    // 相机跟随
    if (_st.follow) {
      viewer.camera.lookAt(
        posAtFraction(_st.table, _st.f),
        new Cesium.HeadingPitchRange(_st.heading, Cesium.Math.toRadians(-45), _st.range)
      );
    }
    // requestRenderMode 下必须主动请求渲染，否则静态相机帧里移动标记不重绘（画面冻住）
    viewer.scene.requestRender();
    _st.raf = requestAnimationFrame(tick);
  }
  _st.raf = requestAnimationFrame(tick);

  console.log(`[route-tour] 启动：${title}，全程 ${(table.total / 1000).toFixed(0)} km`);
}

// ====== 停止巡礼并清理 ======
export function stopRouteTour() {
  if (!_st) return;
  const st = _st;
  _st = null;

  cancelAnimationFrame(st.raf);
  st.viewer.entities.remove(st.traveledEnt);
  st.viewer.entities.remove(st.markerEnt);
  st.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);

  $('tourPause').removeEventListener('click', st.onPause);
  $('tourStop').removeEventListener('click', st.onStop);
  $('timeSlower').removeEventListener('click', st.onSlower);
  $('timeFaster').removeEventListener('click', st.onFaster);
  const track = $('tourTrack');
  track.removeEventListener('pointerdown', st.onTrackDown);
  window.removeEventListener('pointermove', st.onTrackMove);
  window.removeEventListener('pointerup', st.onTrackUp);
  $('tourFollow')?.remove();
  $('tourTicks').innerHTML = '';
  $('tourPanel').classList.add('hidden');
}
