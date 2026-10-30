// src/route-tour.js — 通用路线巡礼
// 沿折线行进：播放/暂停、⏪/⏩ 加减速、进度条拖拽跳转、站点节点点击跳转、相机跟随。
// 复用 index.html 预留的 #tourPanel 骨架（进度条 / ticks / 暂停 / 倍率 / 停止）。
// 未来卫星发射等线路类功能直接调 startRouteTour(viewer, { title, color, coords }) 接入。

import * as Cesium from 'cesium';

const SPEED_STEPS = [0.5, 1, 2, 4, 8]; // 倍率档位
const BASE_DURATION = 90;              // 1× 时全程行进秒数

let _st = null; // 当前巡礼状态
let _activeSeek = null; // 当前巡礼的 seek 闭包（供搜索跳节点）

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

/** 跳到指定 f（搜索跳节点内部用，落点由 tick 处理） */
export function seekRouteTour(f) {
  if (_st) _st.f = Math.max(0, Math.min(1, f));
}

/**
 * 按谓词找到站点并**瞬移**到该站落点暂停（如按「腊子口」「残阳如血」跳到对应节点）。
 *
 * ⭐ 2026-10-29 用户实测反馈：早先版本用 mult=8 快进，虽然 3 秒就到，但相机仍把起点→目标
 *   之间整条路径飞了一遍（"非要把之前的路径走了一遍，过于冗余"）。这里改为直接把 f 设到
 *   目标站，tick 下一帧即命中落点块：弹幕卡 + 相机对准该站，中间路线不播放。
 */
export function seekRouteTourToStation(pred) {
  if (!_st || !_activeSeek) return false;
  const tgt = _st.stationList.find(pred);
  if (!tgt) return false;
  _st.f = tgt.f;          // 瞬移：已走轨迹/里程读数由 f 即时算出，无需重放
  _st.playing = false;
  _st.suppress = false;
  _st.jumpToStationF = tgt.f;
  _st.jumpTarget = tgt;
  $('tourPause').textContent = '播放';
  return true;
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

// 站点（按 lon/lat 给定）投影到折线，返回其弧长 fraction（0~1）
function fractionAtLonLat(table, lon, lat) {
  const target = Cesium.Cartesian3.fromDegrees(lon, lat);
  const { pts, cum, total } = table;
  let best = 0, bestD = Infinity;
  const ab = new Cesium.Cartesian3();
  const ap = new Cesium.Cartesian3();
  const proj = new Cesium.Cartesian3();
  for (let i = 1; i < pts.length; i++) {
    Cesium.Cartesian3.subtract(pts[i], pts[i - 1], ab);
    const len2 = Cesium.Cartesian3.dot(ab, ab) || 1e-9;
    Cesium.Cartesian3.subtract(target, pts[i - 1], ap);
    let t = Cesium.Cartesian3.dot(ap, ab) / len2;
    t = Math.max(0, Math.min(1, t));
    Cesium.Cartesian3.multiplyByScalar(ab, t, proj);
    Cesium.Cartesian3.add(pts[i - 1], proj, proj);
    const d = Cesium.Cartesian3.distance(proj, target);
    if (d < bestD) {
      bestD = d;
      best = cum[i - 1] + t * (cum[i] - cum[i - 1]);
    }
  }
  return total ? best / total : 0;
}

// ====== 时间轴时钟 ======
// 站点数据带 `at: 'YYYY-MM'`（事件发生年月）。巡游时按弧长 f 在相邻两站之间线性插值，
// 使时间轴上的年月随行进连续流动，而不是「到站才跳一下」。
// 取值口径是事件发生年月（非诗词创作年月），保证沿程单调不减、时间不倒流。
function monthNum(at) {
  const [y, m] = String(at).split('-').map(Number);
  return y * 12 + (m - 1);
}
function formatMonth(n) {
  // ⚠ 必须先四舍五入到整月再分解年月。若先取余再四舍五入，
  // 小数进位会让 m 逼近 12、+1 后溢出成「13 月」（如 1934年13月）。
  const t = Math.round(n);
  const y = Math.floor(t / 12);
  const m = (t % 12) + 1;
  return `${y}年${m}月`;
}
function monthAtFraction(timeList, f) {
  if (!timeList.length) return '';
  if (f <= timeList[0].f) return formatMonth(timeList[0].m);
  const last = timeList[timeList.length - 1];
  if (f >= last.f) return formatMonth(last.m);
  for (let i = 1; i < timeList.length; i++) {
    if (f <= timeList[i].f) {
      const a = timeList[i - 1];
      const b = timeList[i];
      const t = (f - a.f) / ((b.f - a.f) || 1e-9);
      return formatMonth(a.m + (b.m - a.m) * t);
    }
  }
  return formatMonth(last.m);
}

// ====== 幕卡停靠位置（左 / 中 / 右） ======
// 巡游时相机跟随、行进主体在屏幕中央，故默认靠左停泊让出中央；用户可点卡片右上「⇄」切换。
const DOCK_KEYS = ['pos-left', 'pos-center', 'pos-right'];
const DOCK_LABEL = { 'pos-left': '靠左', 'pos-center': '居中', 'pos-right': '靠右' };
function applyPoemDock(pos) {
  const card = $('poemCard');
  if (!card) return;
  card.classList.remove('pos-left', 'pos-center', 'pos-right');
  card.classList.add(pos);
  const btn = $('poemDock');
  if (btn) btn.title = `幕卡位置：${DOCK_LABEL[pos]}（点击切换 左 / 中 / 右）`;
}

// ====== 启动巡礼 ======
export function startRouteTour(viewer, { title, color, coords, stations }) {
  stopRouteTour(); // 先清理旧巡礼
  if (!Array.isArray(coords) || coords.length < 2) {
    console.warn('[route-tour] 航点不足，无法巡礼');
    return;
  }

  const table = buildArcTable(coords);
  const stationList = (stations || [])
    .map((s) => ({
      ...s,
      f: (typeof s.f === 'number' && isFinite(s.f))
        ? Math.max(0, Math.min(1, s.f))
        : fractionAtLonLat(table, s.lon, s.lat),
      isPoem: !!s.body,
      shown: false,
    }))
    .sort((a, b) => a.f - b.f);
  // 时间轴刻度表：沿程各站的年月（按 f 排序，供插值得到「当前所处年月」）
  const timeList = stationList
    .filter((s) => s.at)
    .map((s) => ({ f: s.f, m: monthNum(s.at) }))
    .sort((a, b) => a.f - b.f);
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
  $('timelineNote')?.classList.add('hidden');
  $('actCard')?.classList.add('hidden');
  const pauseBtn = $('tourPause');
  pauseBtn.classList.remove('hidden');
  pauseBtn.textContent = '暂停';

  // 幕卡停靠位置：恢复上次选择，「⇄」在 左 / 中 / 右 之间循环（用 onclick 覆盖赋值，避免重复绑定）
  let dockPos = 'pos-left';
  try {
    const saved = localStorage.getItem('poemDock');
    if (DOCK_KEYS.includes(saved)) dockPos = saved;
  } catch (_) {
    /* 隐私模式下 localStorage 不可用，忽略即可 */
  }
  applyPoemDock(dockPos);
  const dockBtn = $('poemDock');
  if (dockBtn) {
    dockBtn.onclick = (e) => {
      e.stopPropagation();
      const card = $('poemCard');
      const cur = DOCK_KEYS.find((k) => card.classList.contains(k)) || 'pos-left';
      const next = DOCK_KEYS[(DOCK_KEYS.indexOf(cur) + 1) % DOCK_KEYS.length];
      try {
        localStorage.setItem('poemDock', next);
      } catch (_) {
        /* 同上 */
      }
      applyPoemDock(next);
    };
  }

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

  // 轨道刻度：只画有内容的站点（诗词/背景语）。
  // 早期曾按折线中间顶点画「航点」圆点，但那只是几何插值点、无内容且与站点标记混淆，已移除。
  const track = $('tourTrack');
  const ticks = $('tourTicks');
  ticks.innerHTML = '';

  // 站点标记：诗词站 📜 菱形（金），背景语站 ● 圆点（青）
  for (const st of stationList) {
    const pct = (st.f * 100).toFixed(2);
    const dot = document.createElement('span');
    if (st.isPoem) {
      dot.className = 'tour-tick tour-tick-poem';
      dot.style.cssText =
        'position:absolute;top:1px;width:11px;height:11px;border-radius:2px;' +
        'background:#ffe08a;border:1px solid rgba(0,0,0,.75);' +
        'transform:translateX(-50%) rotate(45deg);cursor:pointer;z-index:3;';
      dot.title = `诗词 · ${st.title}（${st.name}）`;
    } else {
      dot.className = 'tour-tick tour-tick-note';
      dot.style.cssText =
        'position:absolute;top:-5px;width:9px;height:9px;border-radius:50%;' +
        'background:#5fd0d6;border:1px solid rgba(0,0,0,.6);' +
        'transform:translateX(-50%);cursor:pointer;z-index:3;';
      dot.title = `背景 · ${st.title || st.name}`;
    }
    dot.style.left = pct + '%';
    dot.addEventListener('click', (e) => { e.stopPropagation(); seek(st.f); });
    ticks.appendChild(dot);
  }

  // ---- 状态 ----
  _st = {
    viewer,
    table,
    stationList,
    timeList,
    f: 0,
    focusStation: null, // 弹卡期间对准的站点（有 lon/lat 时相机看向它，保证幕卡与地图标注对应）
    playing: true,
    suppress: false, // 拖拽进度条期间抑制站点卡触发
    mult: 1,
    follow: true,
    jumpToStationF: null,   // 搜索跳节点：到达该 f 即落点暂停
    jumpTarget: null,       // 落点站点引用
    raf: 0,
    last: performance.now(),
    traveledEnt,
    markerEnt,
    followBtn,
    heading: viewer.camera.heading,
    range: Math.min(2.5e6, Math.max(2e5, table.total * 0.08)),
    // 事件绑定（停止时移除）
    onPause: () => {
      if (_st.f >= 1) {
        // 播完后再按 = 重播：f 归零的同时复位全部站点，
        // 否则第二遍会因 shown 全为 true 而从头到尾不弹一张卡
        _st.f = 0;
        for (const st of _st.stationList) st.shown = false;
      }
      _st.playing = !_st.playing;
      pauseBtn.textContent = _st.playing ? '暂停' : '播放';
      if (!_st.playing) {
        _st.focusStation = null; // 手动暂停：收卡并让相机回到主线跟随
        hideStationCard();
      }
    },
    onStop: () => {
      stopRouteTour();
      // 通知「显示图层」列表把对应行置灰（用户点了底部「停止」也要同步，别让列表骗人）
      window.dispatchEvent(new CustomEvent('route-tour-stopped'));
    },
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
    _st.suppress = true; // 拖拽期间不弹卡，否则每划过一站就闪一张
    seekFromEvent(e);
  };
  _st.onTrackMove = (e) => {
    if (_st && e.buttons & 1) seekFromEvent(e);
  };
  _st.onTrackUp = () => {
    if (!_st) return;
    _st.suppress = false; // 松手恢复触发：若正好停在站点上，下一帧会弹该站
    if (_st._wasPlaying && _st.f < 1) _st.playing = true;
    pauseBtn.textContent = _st.playing ? '暂停' : '播放';
  };
  track.addEventListener('pointerdown', _st.onTrackDown);
  window.addEventListener('pointermove', _st.onTrackMove);
  window.addEventListener('pointerup', _st.onTrackUp);

  function seek(f) {
    if (!_st) return;
    _st.f = Math.max(0, Math.min(1, f));
    // 跳转 = 「重置未来」：目标位置及其之后的站点全部恢复未触发状态。
    // 否则倒回后再正向经过会全程静默不弹卡（shown 只置位不复位的旧 bug）。
    // 恰好落在某站上时该站也会复位，因此点轨道刻度能重新看到该站卡片。
    for (const st of _st.stationList) {
      if (st.shown && st.f >= _st.f - 1e-9) st.shown = false;
    }
    // 旧卡片随跳转失效，否则卡片停在原地、相机还盯着上一站
    _st.focusStation = null;
    hideStationCard();
  }
  _activeSeek = seek; // 暴露给搜索跳节点

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
    // 搜索跳节点：f 已被 seekRouteTourToStation 直接设到目标站，这里只做落点收尾（不重放中间路径）
    if (_st.jumpToStationF != null && _st.f >= _st.jumpToStationF - 1e-9) {
      _st.f = _st.jumpToStationF;
      _st.playing = false;
      _st.suppress = false;
      pauseBtn.textContent = '播放';
      const tgt = _st.jumpTarget;
      _st.jumpToStationF = null;
      _st.jumpTarget = null;
      if (tgt) {
        // 目标站及其之前的站全部标记为已显示：避免下面「跨站触发」循环在同一帧再弹一次卡
        for (const s of _st.stationList) s.shown = s.f <= tgt.f + 1e-9;
        _st.focusStation = tgt;
        showStationCard(tgt);
      }
    }
    // 倒回复位：f 被改小（拖拽 / 重播）后，前方的站点恢复「未触发」。
    // 正常播放时 f 单调增，此循环不会命中；它是 seek 之外的第二道保险。
    for (const st of _st.stationList) {
      if (st.shown && _st.f < st.f - 1e-9) st.shown = false;
    }
    // 站点触发：跨过未显示站点 → 吸附到该站并暂停弹卡（一帧一张，逐个展示）
    // 拖拽进度条期间 suppress，避免快速划过时一路闪卡
    for (const st of _st.stationList) {
      if (!_st.suppress && !st.shown && _st.f >= st.f) {
        st.shown = true;
        _st.f = st.f;
        if (_st.playing) {
          _st.playing = false;
          pauseBtn.textContent = '播放';
        }
        _st.focusStation = st; // 弹卡期间相机对准站点真实位置
        showStationCard(st);
        break;
      }
    }
    // 进度 UI
    $('tourBar').style.width = (_st.f * 100).toFixed(2) + '%';
    $('tourProgressText').textContent =
      `${Math.round(_st.f * 100)}% · ${((_st.f * _st.table.total) / 1000).toFixed(0)} km`;
    $('tourClock').textContent = monthAtFraction(_st.timeList, _st.f);
    // 相机跟随：弹卡时对准站点真实坐标，而非主线插值点。
    // 四渡赤水等站点用显式 f 保证时间顺序，其真实渡口与主线插值点可差 100~200km，
    // 不对准就会出现「幕卡写三渡、画面里三渡点早被甩在身后」的错位。
    if (_st.follow) {
      const fs = _st.focusStation;
      const target =
        fs && isFinite(fs.lon) && isFinite(fs.lat)
          ? Cesium.Cartesian3.fromDegrees(fs.lon, fs.lat)
          : posAtFraction(_st.table, _st.f);
      viewer.camera.lookAt(
        target,
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

// ====== 站点卡（幕卡形态，复用 actCard 视觉语言；诗词站与背景语站通用） ======
function showStationCard(st) {
  const card = $('poemCard');
  if (!card) return;
  card.classList.toggle('is-note', !st.body);
  card.querySelector('.poem-place').textContent = st.name || '';
  card.querySelector('.poem-badge').textContent = st.body ? '诗词' : '背景';
  const titleEl = card.querySelector('.poem-title');
  titleEl.textContent = st.title || '';
  const authorEl = card.querySelector('.poem-author');
  authorEl.textContent = (st.author ? `${st.author} · ` : '') + (st.date || '');
  card.querySelector('.poem-body').textContent = st.body || st.note || '';
  // 诗词有注、背景语无独立注：注作为副标题显示；背景语本身已当正文，不再重复
  card.querySelector('.poem-note').textContent = (st.body && st.note) ? st.note : '';
  card.classList.add('show');
  const btn = $('poemContinue');
  if (btn) btn.onclick = () => {
    hideStationCard();
    if (_st) {
      _st.focusStation = null; // 收卡后相机回到主线跟随
      _st.playing = true;
      $('tourPause').textContent = '暂停';
    }
  };
}

function hideStationCard() {
  $('poemCard')?.classList.remove('show');
  const btn = $('poemContinue');
  if (btn) btn.onclick = null;
}

// ====== 停止巡礼并清理 ======
export function stopRouteTour() {
  if (!_st) return;
  const st = _st;
  _st = null;
  _activeSeek = null;

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
  $('tourClock').textContent = ''; // 探月模式共用面板，不留上次的年份
  hideStationCard();
  $('tourPanel').classList.add('hidden');
}
