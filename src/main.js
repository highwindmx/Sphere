// src/main.js — 应用入口
// 从 dist index--AIpTfEu.js 提取核心逻辑

import * as Cesium from 'cesium';
// 调试导出：控制台可直接 new provider / 读枚举（CDP 自动化验证也依赖它）
window.Cesium = Cesium;
import CesiumNavigation from 'cesium-navigation-es6';

import { createLocalTerrainProvider } from './terrarium-provider.js';
import { LAYERS, LAYER_MAP, LAYER_CATEGORIES, resolveCategories } from './layers/index.js';
import { createLayerRenderer } from './layer-renderer.js';
import { createOffscreenIndicator } from './offscreen.js';
import { loadTiangong, isTiangongLoaded, removeTiangong } from './tiangong.js';
import { startRouteTour, stopRouteTour, isRouteTourFollowing, isRouteTourActive, seekRouteTourToStation } from './route-tour.js';
import { createSearchRegistry } from './search-registry.js';
import { initSearchBar } from './search-bar.js';
import { createShownLayers } from './shown-layers.js';
import {
  ImagerySourceManager,
  getSourceDef,
  getOnlineSourceId,
  setOnlineSourceId,
} from './imagery-sources.js';
import { resolvePolarProfile, getSeason, profileStatusText } from './polar-profiles.js';
import { initSourcePanel } from './source-settings.js';
import { createMoonMission } from './rocket.js';
import { createHistoryAtlas, mountHistoryPanel } from './history-atlas.js';
import { initOsmScene, attachGlobeOverlay, mountOsmNavBtn, setOsmNavBtnVisible } from './osm-map-scene.js';
import {
  createMoonViewer,
  destroyMoonViewer,
  toggleLunarGroup,
  getMoonViewer,
  getMoonGroups,
  sampleMoonHeight,
  setLunarHiRes,
  isLunarHiRes,
  isMoonTerrainReady,
  MOON_ELLIPSOID,
} from './lunar.js';
import {
  createMarsViewer,
  destroyMarsViewer,
  toggleMarsGroup,
  getMarsViewer,
  getMarsGroups,
  setMarsHillshade,
  isMarsHillshade,
  MARS_ELLIPSOID,
} from './mars.js';

// ====== Cesium Ion Token ======
// 必须设置才能使用 Bing Maps Aerial 在线底图（默认 Viewer baseLayer）。
// 注册免费 token：https://cesium.com/ion/
// 由 app.py 启动时从环境变量 SPHERE_CESIUM_ION_TOKEN 注入到 window.CESIUM_ION_TOKEN（勿提交仓库）
Cesium.Ion.defaultAccessToken =
  (typeof window !== 'undefined' && window.CESIUM_ION_TOKEN && !window.CESIUM_ION_TOKEN.startsWith('__'))
    ? window.CESIUM_ION_TOKEN
    : '';

// ====== 全局便捷 $ 函数 ======
function $(id) {
  if (id.startsWith('#')) id = id.slice(1);
  return document.getElementById(id);
}

// ====== 常量 ======
const POLE_CAP_EDGE_DEG = 5.04;
const SOFT_ALPHA_FACTOR = 0.45; // 接缝淡出系数：边缘 alpha → 0.55，大幅融入周围底图
const IMG_W = 4096; // bluemarble.jpg 实际像素宽（运行期 strip 也按 img.naturalWidth 读取，此处仅用于单色兜底画布）
const IMG_H = 2048; // bluemarble.jpg 实际像素高

// ====== 极冠纯红 debug 模式（2026-10-16 用户真机反馈极区仍为空洞，最小可见性测试）=====
// 用法：
//   - URL 参数：http://127.0.0.1:5008/?polar-debug=red     （极带纯红，中间仍透明）
//   - URL 参数：http://127.0.0.1:5008/?polar-debug=fullred （整张全球合成图全红，最强信号）
//   - 控制台：  __setPolarDebug('red'|'fullred'|'')         （即时切换，空=关闭回正常）
// 判定：极地见红 → 层/纹理/层序正常，问题在像素内容；不见红 → 层根本没渲染到极区。
const POLAR_DEBUG_KEY = 'sphere-polar-debug';
let _polarDebugInited = false;
function getPolarDebugMode() {
  let v = '';
  try {
    // URL 参数只做「本页首次读取」的一次性初始化；之后由 localStorage 接管，
    // 否则每次读取都把 URL 值写回，__setPolarDebug('') 将永远关不掉。
    if (!_polarDebugInited) {
      _polarDebugInited = true;
      const q = new URLSearchParams(location.search).get('polar-debug');
      if (q) localStorage.setItem(POLAR_DEBUG_KEY, q);
    }
    v = localStorage.getItem(POLAR_DEBUG_KEY) || '';
  } catch { /* 忽略 */ }
  return v === 'red' || v === 'fullred' ? v : '';
}

// 极地补丁调色 = 运行时实测采样 + 均值对齐：
// 1. 从当前实际生效的底图 provider 上取 85° 附近的真实瓦片像素，算出目标均值色
// 2. 把补丁原始像素按「(pixel - 补丁均值) × 对比度保持 + 目标均值」逐通道映射
// 首帧先用预设兜底（Bing 夏季冰色），采样成功后自动替换为实测值
const CONTRAST_KEEP = 1.0; // 对比度保持系数（纯均值对齐；>1 会放大源图逐行差异产生同心环）
// 接缝修正量的极心残留系数：修正量从接缝边缘 100% 向极心衰减，但**不衰减到 0**，
// 否则极心完全保留 bluemarble 原色（北带实测 7,22,47）——底图偏亮时看着仍像黑洞。
// 0.35 = 极心仍吃到三成底图色调修正，既保住实景纹理又不发黑。
const POLE_TONE_FLOOR = 0.35;
const STRIP_UPSCALE = 2;   // 条带平滑放大倍数：源条带行结构 → 双线性插值消除同心环
const COMPOSITE_SCALE = 2; // 全球合成图相对 bluemarble(4096×2048) 的放大倍数：
                           // 8192×4096 仍远低于 GPU 8192 通用纹理下限，极带纵向分辨率翻倍到 115 行

// 单色兜底目标色（bluemarble.jpg 缺失时使用；夏季北极深蓝海面 + 南极白冰）
const PRESET_TARGET = { north: [212, 220, 224], south: [224, 231, 236] };

// 极冠纹理的季节策略：在线底图（Esri World Imagery / Bing）为**夏季**卫星影像，
// 北极海冰范围小、多大面积深蓝海面 → 北极补丁直接用源图北带（Blue Marble 北带
// 即最小海冰范围的夏季状态），沿经线逐列对齐接缝色即可自然融合；
// 不做「南北翻转用南极白冰补北极」（那属于冬季策略，与夏季底图反而冲突）。
// 南极全年冰盖，无季节差异。

// 底图源模式：auto=本地瓦片优先+在线兜底 | online=仅在线（Esri World Imagery）
const BASE_MODE_KEY = 'sphere-base-mode';
function getBaseMode() {
  try {
    const m = localStorage.getItem(BASE_MODE_KEY);
    return (m === 'online' || m === 'auto') ? m : 'auto';
  } catch { return 'auto'; }
}

// ====== DOM 引用 ======
const statusEl = $('status');
const exagValEl = $('exagVal');
const layersTreeEl = $('layersTree');

// ====== 活动视图（地球/月球/火星）与统一坐标控件 ======
// 地球 viewer / globe 在下方初始化；本块只声明状态与函数，运行期才访问它们。
let isMoonMode = false;
let isMarsMode = false;
let moonCoordBound = false;
let marsCoordBound = false;
let hoveringGlobe = false;
// 左上统一坐标控件：实时经纬度写输入框 placeholder（不打扰用户已输入的值），海拔只读回显
const coordLonEl = $('gotoLon'), coordLatEl = $('gotoLat'), coordAltEl = $('coordAlt');
const _lastCursor = { lon: null, lat: null };   // 最近一次坐标（「留空 = 定位到光标处」用）

// 海拔回显（只读文本）：terrarium 含海底负深（0°,0° 实测 -4,941 m 即大西洋真实水深）。
// 负值**保留符号**（🌊 -4,118 m），只用图标区分水上/水下，不抹掉负号。
function showAlt(v) {
  if (!coordAltEl) return;
  // 火星无可用 3D 高程源（MOLA 瓦片近乎全空，见 mars.js），海拔读数恒为 —、无意义，整行隐藏；
  // 切回地球/月球时 refreshCoordUI→writeCoord→showAlt 会重新显示并填真实值。
  if (isMarsMode) { coordAltEl.style.display = 'none'; return; }
  coordAltEl.style.display = '';
  if (typeof v !== 'number' || !isFinite(v)) { coordAltEl.innerHTML = '⛰ <span class="na">—</span>'; return; }
  const r = Math.round(v).toLocaleString();   // toLocaleString 对负数自带符号：-4,118
  coordAltEl.innerHTML = v < -5
    ? `🌊 <span class="v">${r}</span> m`
    : `⛰ <span class="v">${r}</span> m`;
  coordAltEl.title = v < -5
    ? `水面下 ${Math.abs(Math.round(v)).toLocaleString()} m（地形源含海底地形，负值即水下深度）`
    : `地面海拔 ${r} m`;
}

// 把一对经纬度 + 海拔写进左上控件（placeholder 只在输入为空时可见）
function writeCoord(lon, lat, ground) {
  // OSM 场景（Cesium 容器已隐藏、渲染循环暂停）时，坐标由 osm-map-scene.js 调用本函数刷新，
  // 否则进 OSM 后经纬度就冻在切换瞬间不再变化。
  _lastCursor.lon = lon; _lastCursor.lat = lat;
  if (coordLonEl) coordLonEl.placeholder = `经度 ${lon.toFixed(2)}°`;
  if (coordLatEl) coordLatEl.placeholder = `纬度 ${lat.toFixed(2)}°`;
  showAlt(ground);
}
// 暴露给 osm-map-scene.js：OSM 场景（Cesium 容器隐藏、渲染循环暂停）下刷新经纬度回显
window.__writeCoord = writeCoord;
const _carto2 = new Cesium.Cartographic();   // 采样海拔用的临时 Cartographic

// 当前应读取的 Viewer：月球/火星模式返回各自 viewer，否则地球 viewer
function activeViewer() {
  if (isMoonMode) return getMoonViewer();
  if (isMarsMode) return getMarsViewer();
  return viewer;
}
// 供 osm-map-scene.js 浮动区使用（跨模块取当前 viewer）
window.activeViewer = activeViewer;

// ====== 瓦片加载状态灯（左上角 #tileDot，三层同心 SVG）======
// 中心色 = 状态（黄加载中 / 绿完成 / 绿+双层环已达最大精度 / 橙部分为空 / 红上游不可达）
// 中环   = 进度弧（globe.tileLoadProgressEvent，公开 API，替代原先读私有 _surface 队列）
// 外环   = 来源（实线=本地直出，虚线=回源在线；数据来自 /api/tile-health）
// ⚠ 不能只看 globe.tilesLoaded：上游不可达时 app.py 回 1×1 透明 PNG(200)，
//   Cesium 视为成功、队列照样清空 → 会把「画面是空的」报成「已全部加载」。
const tileDotEl = $('tileDot');
const _tdProg = tileDotEl ? tileDotEl.querySelector('.td-prog') : null;
const _TD_C = 2 * Math.PI * 6.2;          // 中环周长，用 dashoffset 画进度弧
const _TD_BOUND = new WeakSet();
let _tdState = null;      // 已应用的状态（变了才动 DOM）
let _tdSrc = null;
let _tdPending = 0;       // 待载瓦片数
let _tdHealth = null;     // /api/tile-health 最近一次结果
let _tdDoneStreak = 0;    // 防抖：回到「完成」需连续 2 次采样（600ms）

/** 待载数走公开事件；viewer 会随星球切换重建，故按 globe 实例去重绑定 */
function _tdBindProgress(v) {
  try {
    const g = v && v.scene && v.scene.globe;
    if (!g || _TD_BOUND.has(g)) return;
    _TD_BOUND.add(g);
    if (g.tileLoadProgressEvent) {
      g.tileLoadProgressEvent.addEventListener((n) => { _tdPending = Math.max(0, n | 0); });
    }
  } catch { /* 忽略 */ }
}

/** 数据源上限：影像与地形取最严格的那个。
 *  ⚠ 必须过滤 <=0：本地地形等自定义 provider 可能把 maximumLevel 暴露成 0，
 *    直接取 min 会被它拉到 0，导致「已达最大精度」永远误触发（探针实测）。 */
let _tdLevels = [];
function _tdMaxLevel(v) {
  try {
    const g = v.scene.globe;
    const ls = [];
    const ils = g.imageryLayers;
    for (let i = 0; i < ils.length; i++) {
      const p = ils.get(i) && ils.get(i).imageryProvider;
      if (p && typeof p.maximumLevel === 'number' && isFinite(p.maximumLevel) && p.maximumLevel > 0) ls.push(p.maximumLevel);
    }
    const tp = g.terrainProvider;
    if (tp && typeof tp.maximumLevel === 'number' && isFinite(tp.maximumLevel) && tp.maximumLevel > 0) ls.push(tp.maximumLevel);
    _tdLevels = ls;
    return ls.length ? Math.min.apply(null, ls) : null;
  } catch { return null; }
}

/** 相机高度 → 目标瓦片级别（近似）。只用于「是否已顶到数据源上限」的布尔判断，
 *  ±1 级误差不影响结论；取不到就返回 null，该态自动不显示。 */
function _tdLevelEstimate(v) {
  try {
    const cg = v.camera.positionCartographic;
    if (!cg || !isFinite(cg.height) || cg.height <= 0) return null;
    const fov = (v.camera.frustum && v.camera.frustum.fov) || 1.0;
    const pxH = (v.scene.canvas && v.scene.canvas.clientHeight) || 800;
    const mpp = (2 * cg.height * Math.tan(fov / 2)) / pxH;
    const circ = 2 * Math.PI * 6378137 * Math.cos(cg.latitude || 0);
    if (!(mpp > 0) || !(circ > 0)) return null;
    return Math.log2(circ / (256 * mpp * 2));
  } catch { return null; }
}

function _tdIsMaxLevel(v) {
  const mx = _tdMaxLevel(v);
  const L = _tdLevelEstimate(v);
  if (mx == null || L == null) return false;
  return L >= mx - 0.5;
}

const _TD_TEXT = {
  loading: '正在加载瓦片',
  done: '视野内瓦片已全部加载',
  max: '已达数据源最大精度（再放大不会更清晰）',
  degraded: '部分瓦片为空（上游失败，已回退透明图）',
  unreachable: '上游不可达（画面为空，不是加载慢）',
};

function refreshTileDot() {
  if (!tileDotEl) return;
  const v = activeViewer();
  const globe = v && v.scene && v.scene.globe;
  if (!globe) return;
  _tdBindProgress(v);
  let loading;
  try { loading = !globe.tilesLoaded; } catch { return; }

  // 防抖：进入 loading 立即生效；回到 done 需连续 2 次采样（600ms），
  // 否则快速飞行时 tilesLoaded 反复跳变会让灯高频黄绿闪。
  _tdDoneStreak = loading ? 0 : _tdDoneStreak + 1;
  const settled = loading || _tdDoneStreak >= 2;

  let state;
  if (loading) state = 'loading';
  else if (!settled) state = _tdState || 'loading';   // 未稳定 → 维持原态，不闪
  else {
    const hh = _tdHealth || {};
    if (hh.unreachable) state = 'unreachable';
    else if (hh.degraded) state = 'degraded';
    else if (_tdIsMaxLevel(v)) state = 'max';
    else state = 'done';
  }

  const h = _tdHealth || {};
  const src = h.total ? (h.remote > 0 ? 'remote' : 'local') : 'none';

  if (state !== _tdState) {
    _tdState = state;
    tileDotEl.classList.remove('is-loading', 'is-done', 'is-max', 'is-degraded', 'is-unreachable');
    tileDotEl.classList.add('is-' + state);
  }
  if (src !== _tdSrc) {
    _tdSrc = src;
    tileDotEl.classList.remove('src-local', 'src-remote', 'src-none');
    tileDotEl.classList.add('src-' + src);
  }

  // 进度弧：pending 越多弧越空（无总数也能表达「在推进 vs 卡住」）
  if (_tdProg) {
    const frac = loading ? 1 / (1 + _tdPending / 8) : 1;
    _tdProg.style.strokeDasharray = _TD_C.toFixed(2);
    _tdProg.style.strokeDashoffset = (_TD_C * (1 - frac)).toFixed(2);
  }

  const srcTxt = src === 'none' ? '' : (src === 'local' ? `本地 ${h.local} 片` : `在线 ${h.remote} 片（本地 ${h.local}）`);
  const pendTxt = loading && _tdPending > 0 ? `，待载 ${_tdPending} 块` : '';
  const fbTxt = h.fallback ? `，回退 ${h.fallback} 块` : '';
  tileDotEl.title = `${_TD_TEXT[state]}${srcTxt ? ' · ' + srcTxt : ''}${pendTxt}${fbTxt} · 点此重载瓦片`;
  tileDotEl.setAttribute('aria-label', tileDotEl.title);
}
setInterval(refreshTileDot, 300);

// ====== 点击灯 = 强制重载瓦片 ======
// Cesium 没有「只重载视野内局部」的公开 API（失败瓦片会带指数退避重试，队列可能长期不清零）。
// 唯一可靠的重置手段是重建数据源：影像层 remove + addImageryProvider（丢弃已解码纹理与失败态），
// 地形则重建 provider 实例。本地已落盘的瓦片命中磁盘缓存会秒回，代价只是短暂重解码。
function forceReloadTiles() {
  const v = activeViewer();
  if (!v) return;
  const g = v.scene && v.scene.globe;
  if (!g) return;
  try {
    // 月球/火星各有自己的地形 provider，地球才用本地 terrarium 地形
    if (!isMoonMode && !isMarsMode && typeof createLocalTerrainProvider === 'function') {
      g.terrainProvider = createLocalTerrainProvider();
    }
  } catch { /* 星球模式无本地地形，忽略 */ }
  try {
    const ls = g.imageryLayers;
    const saved = [];
    for (let i = ls.length - 1; i >= 0; i--) {
      const L = ls.get(i);
      saved.unshift({ p: L.imageryProvider, alpha: L.alpha, show: L.show, brightness: L.brightness,
        contrast: L.contrast, hue: L.hue, saturation: L.saturation, gamma: L.gamma });
      ls.remove(L, false);
    }
    for (const s of saved) {
      const n = ls.addImageryProvider(s.p);
      if (!n) continue;
      n.alpha = s.alpha; n.show = s.show; n.brightness = s.brightness; n.contrast = s.contrast;
      n.hue = s.hue; n.saturation = s.saturation; n.gamma = s.gamma;
    }
  } catch { /* 图层重建失败不影响主流程 */ }
  try { v.scene.requestRender(); } catch { /* 忽略 */ }
  _tdDoneStreak = 0;   // 立即回到 loading，别让残留的稳定计数维持绿色假象
}
if (tileDotEl) {
  tileDotEl.addEventListener('click', forceReloadTiles);
  tileDotEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); forceReloadTiles(); }
  });
}
window.__forceReloadTiles = forceReloadTiles;

// 瓦片来源/回退统计：app.py 在 serve 直出 / 代理回源 / 透明回退三处埋点，5s 滑动窗
setInterval(async () => {
  try {
    const r = await fetch('/api/tile-health', { cache: 'no-store' });
    if (r.ok) _tdHealth = await r.json();
  } catch { /* 后端不可用则保留旧值，灯自动退化为纯 tilesLoaded 两态 */ }
}, 2000);

window.__tileDotDbg = (override) => {
  const v = activeViewer();
  const L = _tdLevelEstimate(v);
  const mx = _tdMaxLevel(v);
  if (override && typeof override.health === 'object') _tdHealth = override.health;   // 便于探针注入假数据验状态机
  return {
    state: _tdState, src: _tdSrc, pending: _tdPending, health: _tdHealth,
    maxLevel: mx, levels: _tdLevels.slice(), isMax: _tdIsMaxLevel(v),
    estLevel: L == null ? null : +L.toFixed(2),
  };
};

// 刷新「视点」坐标（相机正下方地面海拔）到左上控件；悬停光标时由光标读数接管。
// 地球用 globe.getHeight（含垂直夸张还原），月球用 sampleMoonHeight（Terrarium DEM），
// 火星暂无 3D 地形（MOLA 瓦片源缓存为空，见 mars.js），海拔显示 —。
function refreshCoordUI() {
  const v = activeViewer();
  if (!v) return;
  try {
    const pos = v.camera.positionCartographic;
    if (!pos) return;
    if (hoveringGlobe) return;   // 光标在球体上：由 updateCursorCoord 接管
    const lon = Cesium.Math.toDegrees(pos.longitude);
    const lat = Cesium.Math.toDegrees(pos.latitude);
    let ground = null;
    if (isMoonMode) {
      try { ground = sampleMoonHeight(lon, lat); } catch { /* 未就绪 */ }
    } else if (!isMarsMode) {
      try {
        _carto2.longitude = pos.longitude;
        _carto2.latitude = pos.latitude;
        _carto2.height = 0;
        const gh = globe.getHeight(_carto2);
        if (typeof gh === 'number' && isFinite(gh)) ground = gh / (globe.terrainExaggeration || 1);
      } catch { /* 瓦片未就绪 */ }
    }
    writeCoord(lon, lat, ground);
  } catch { /* 忽略 */ }
}

// 鼠标在球体上 → 显示光标处经纬度与海拔；移出球体 → 回到视点坐标。
function updateCursorCoord(clientX, clientY) {
  const v = activeViewer();
  if (!v) return;
  const canvas = v.scene.canvas;
  const rect = canvas.getBoundingClientRect();
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
    hoveringGlobe = false;
    refreshCoordUI();
    return;
  }
  hoveringGlobe = true;
  const cart = v.camera.pickEllipsoid(
    new Cesium.Cartesian2(clientX - rect.left, clientY - rect.top),
    v.scene.globe.ellipsoid
  );
  if (!cart) { hoveringGlobe = false; refreshCoordUI(); return; }
  const c = Cesium.Cartographic.fromCartesian(cart);
  const lon = Cesium.Math.toDegrees(c.longitude);
  const lat = Cesium.Math.toDegrees(c.latitude);
  let ground = null;
  if (isMoonMode) {
    try { ground = sampleMoonHeight(lon, lat); } catch { /* 未就绪 */ }
  } else if (!isMarsMode) {
    try {
      _carto2.longitude = c.longitude;
      _carto2.latitude = c.latitude;
      _carto2.height = 0;
      const gh = globe.getHeight(_carto2);
      if (typeof gh === 'number' && isFinite(gh)) ground = gh / (globe.terrainExaggeration || 1);
    } catch { /* 瓦片未就绪 */ }
  }
  writeCoord(lon, lat, ground);
}

document.addEventListener('mousemove', (e) => updateCursorCoord(e.clientX, e.clientY));

/** 顶部居中浮层提示（2026-10-24 用户：原右上角提示改为页面顶部、自动隐藏、不挤占空间）。
 *  absolute 定位本就不在文档流里（不挤占空间）；这里加**自动淡出**：
 *  显示 2.8 s 后开始淡出（0.4 s），期间有新消息则重置计时（连续操作不会闪断）。
 *  kind = '' / 'ok' / 'warn' / 'error' → 左侧色条。 */
let _statusTimer = 0;
function setStatus(msg, kind = '') {
  if (!statusEl) return;
  if (_statusTimer) { clearTimeout(_statusTimer); _statusTimer = 0; }
  statusEl.textContent = msg || '';
  statusEl.className = kind ? kind : '';
  if (msg) {
    statusEl.classList.add('show');
    _statusTimer = setTimeout(() => {
      statusEl.classList.remove('show');
      _statusTimer = setTimeout(() => { statusEl.textContent = ''; _statusTimer = 0; }, 450);
    }, 2800);
  } else {
    statusEl.classList.remove('show');
  }
}

// ====== 场景初始化 ======
// WebGL 预检：GPU 进程崩溃/驱动异常时，getContext 直接返回 null。
// 这里先探一次，给清晰指引而不是只抛 Cesium 栈跟踪（后者用户无法自行恢复）。
(function _probeWebGL() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) {
      const box = document.getElementById('cesiumContainer');
      if (box) box.innerHTML =
        '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
        'color:#e8b4b4;font:15px/1.7 system-ui;padding:28px;text-align:center">' +
        '⚠ 浏览器 WebGL 初始化失败。<br>请按顺序排查：①完全关闭并重启浏览器；' +
        '②打开 chrome://gpu 确认 WebGL 为 “Hardware accelerated”；③访问 get.webgl.org 自检；' +
        '④必要时更新显卡驱动或换浏览器。<br><br>' +
        '（此类报错多见于 GPU 进程崩溃之后，重启浏览器通常即可恢复，并非应用代码问题。）</div>';
      throw new Error('WebGL unavailable — viewer creation skipped');
    }
  } catch (e) {
    if (/WebGL unavailable/.test(e.message)) throw e;
    // 探测本身异常（极少见）→ 不拦截，仍交给 Cesium 正常处理
  }
})();

var viewer = null;   // var 不进 TDZ：WebGL 不可用时保持 null，早期回调的 !v 守卫可正常短路
try {
viewer = new Cesium.Viewer('cesiumContainer', {
  animation: false,
  timeline: false,
  geocoder: false,
  homeButton: false,
  sceneModePicker: false,
  baseLayerPicker: false,
  baseLayer: false,
  navigationHelpButton: false,
  fullscreenButton: false,
  infoBox: false,
  selectionIndicator: false,
  // 默认关闭时钟动画：仅天宫轨道加载时才开启（见下方 loadTiangong 处理）。
  // 配合 requestRenderMode，空闲时不再 60fps 空转重绘，CPU/GPU 占用大幅下降。
  shouldAnimate: false,
  requestRenderMode: true,
  // 高分屏（devicePixelRatio>1）下按设备像素比渲染：Cesium 默认 useBrowserRecommendedResolution=
  // true 会忽略 DPR、按 CSS 像素出图，文字标注/图标会被放大成"粗糙马赛克"。
  useBrowserRecommendedResolution: (window.devicePixelRatio || 1) <= 1,
  contextOptions: { webgl: { alpha: false } },
});
} catch (e) {
  const box = document.getElementById('cesiumContainer');
  if (box) box.innerHTML =
    '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
    'color:#e8b4b4;font:15px/1.7 system-ui;padding:28px;text-align:center">' +
    '⚠ 浏览器 WebGL 初始化失败（Cesium 创建 Viewer 抛错）。<br>请：①完全关闭并重启浏览器；' +
    '②打开 chrome://gpu 确认 WebGL 状态；③访问 get.webgl.org 自检；④更新显卡驱动或换浏览器。<br><br>' +
    '（多为 GPU 进程崩溃后现象，重启浏览器即可恢复。）</div>';
  console.error('[WebGL] Cesium Viewer 创建失败：', e);
  throw e;
}
window.viewer = viewer;

// WebGL 上下文丢失（GPU 进程崩溃 / 驱动重置）时给出明确提示，而非静默黑屏
try {
  const _cv = viewer.scene.canvas;
  _cv.addEventListener('webglcontextlost', (ev) => {
    ev.preventDefault();
    if (typeof setStatus === 'function') setStatus('⚠ WebGL 上下文丢失（GPU 进程可能崩溃），请重启浏览器恢复。', 'err');
  });
  _cv.addEventListener('webglcontextrestored', () => {
    if (typeof setStatus === 'function') setStatus('WebGL 上下文已恢复。', 'ok');
  });
} catch (e) {}
viewer.allowDataSourcesToSuspendAnimation = false;

// 导航控件（指南针/缩放/重置视图/比例尺），仅地球 Viewer；重置视图对齐「回到中国」
const earthNav = new CesiumNavigation(viewer, {
  enableCompass: true,
  enableZoomControls: true,
  enableDistanceLegend: true,
  defaultResetView: Cesium.Cartographic.fromDegrees(105, 33, 16000000),
  orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
  duration: 1.5,
});
// 地表OSM 贴邻钮：挂到导航控件列正下方（独立 DOM，视觉同款）
mountOsmNavBtn(viewer);

// ====== 右侧控件同轴对齐（2026-10-30 用户：fixed 后上下两段仍有微小错位）======
// 根因：缩放列在导航容器内 right:32、宽 32 → 中心=视口−60px；.scene-nav-col 自身 right:12、宽 30
// → 中心=视口−27px，偏右 33px。不手算 right 值（插件内部尺寸一变就再错），改为运行时
// 读 .navigation-controls 真实几何，把「场景钮列 / OSM 钮」的中心轴钉到缩放列中心上。
(function setupRightDockAlign() {
  const HALF = { nav: 15, osm: 15 };   // 各钮宽 30（含边框）的一半
  function align() {
    const zoom = document.querySelector(
      '.cesium-widget-cesiumNavigationContainer .navigation-controls');
    if (!zoom) return false;
    const r = zoom.getBoundingClientRect();
    if (!r.width) return false;
    const axis = r.left + r.width / 2;
    const nav = document.getElementById('sceneNavCol');
    if (nav) nav.style.right = Math.round(window.innerWidth - axis - HALF.nav) + 'px';
    const osm = document.querySelector('.osm-nav-btn');
    if (osm) osm.style.right = Math.round(window.innerWidth - axis - HALF.osm) + 'px';
    return true;
  }
  // 插件容器是异步 appendChild 的 → 轮询到挂载为止；此后 resize 重算
  let tries = 0;
  (function retry() {
    if (align() || ++tries > 40) return;
    setTimeout(retry, 250);
  })();
  window.addEventListener('resize', () => { align(); });
})();

// ====== 右侧控件自动隐藏（2026-10-30 用户要求）======
// 默认隐藏（透明 + 不拦截鼠标，避免挡住球体拖拽）；hover 视口右缘区域或操作球体（拖拽/旋转/相机变化）
// 时被唤起，离开后自动收起。Cesium 原生导航与 .scene-nav-col 都锚定视口右缘，永远同列。
(function setupRightDockAutoHide() {
  const body = document.body;
  const ZONE = 120;          // 视口右缘 120px 内视为「靠近右侧控件」
  let hideTimer = null;
  const show = () => { body.classList.add('right-active'); if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } };
  const hideSoon = (ms) => { if (hideTimer) clearTimeout(hideTimer); hideTimer = setTimeout(() => body.classList.remove('right-active'), ms); };
  document.addEventListener('mousemove', (e) => {
    if (e.clientX > window.innerWidth - ZONE) show();
    else hideSoon(500);              // 离开右缘 500ms 后收起
  }, { passive: true });
  // 操作球体（地球）：按下或相机变化 → 显形并保持 2500ms，方便顺手用缩放/指北针
  const poke = () => { show(); hideSoon(2500); };
  try {
    viewer.scene.canvas.addEventListener('pointerdown', poke);
    viewer.scene.camera.changed.addEventListener(poke);
  } catch { /* 忽略 */ }
})();

const globe = viewer.scene.globe;
globe.depthTestAgainstTerrain = true;
globe.terrainExaggeration = 1.2;
globe.tileCacheSize = 300;
if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = true;
globe.baseColor = Cesium.Color.fromCssColorString('#26527c');
// 降低地形网格几何精度 → 加载更少瓦片、首屏更快（科普场景够用，略粗）
globe.maximumScreenSpaceError = 4;

// 本地 Terrarium 高程地形（离线瓦片 tiles/terrain/…；缺失瓦片由内置 provider 自动回退父级）
// 下载范围（与 tools/build/download_terrain_tiles.py 对齐）：z0-z5 全球 + z6-z9 中国 bbox + z10-z12 山脉兴趣点。
// callback 内置区域判断：z0-z5 全球、z6-z9 中国、z10-z12 仅山脉矩形，其余回落父级。
// ⚠ 极冠黑洞根因（2026-10-16）：globe 的瓦片几何 tilingScheme 只读 terrainProvider.tilingScheme，
// 本 provider 曾直接声明 WebMercatorTilingScheme → 地球 quadtree 在 ±85.05° 外没有任何几何，
// 极冠区域永远是黑洞。现改为「对外 GeographicTilingScheme + 内部墨卡托瓦片重采样」，
// 详见 terrarium-provider.js 文件头。
// 运行 python tools/build/download_terrain_tiles.py 后才有明显地形。
try {
  globe.terrainProvider = createLocalTerrainProvider();
} catch { /* 保持默认椭球（Geographic，极区几何仍在） */ }

// 初始视角
viewer.camera.setView({
  destination: Cesium.Cartesian3.fromDegrees(105, 33, 16000000),
  orientation: {
    heading: 0,
    pitch: Cesium.Math.toRadians(-90),
    roll: 0,
  },
});

// ====== 图层渲染器 ======
const renderer = createLayerRenderer(viewer, globe);
// 调试/冒烟导出（tools/smoke/layers-smoke.mjs 依赖）
window.renderer = renderer;

// ====== 屏幕边缘指示器：球背面/屏外标注的折线引出（2026-10-17）======
// 与渲染器的背面剔除配套：背面标记在球体上隐藏，改在画布边缘标出名称与方向。
const EDGE_IND_KEY = 'sphere-edge-indicator';
const OCCLUDE_BACK_KEY = 'sphere-occlude-back';
let edgeIndicator = null;
function initOffscreenIndicator() {
  const container = $('cesiumContainer');
  if (!container) return;
  edgeIndicator = createOffscreenIndicator(viewer, container);
  if (edgeIndicator) {
    renderer.attachOffscreen(edgeIndicator);
    window.__edge = edgeIndicator;   // 调试/冒烟导出
  }
}
function initBackfaceToggles() {
  const cbBack = $('cbOccludeBack');
  const cbEdge = $('cbEdgeIndicator');
  let occ = true, edge = true;
  try {
    occ = localStorage.getItem(OCCLUDE_BACK_KEY) !== '0';
    edge = localStorage.getItem(EDGE_IND_KEY) !== '0';
  } catch { /* 忽略 */ }
  if (cbBack) {
    cbBack.checked = occ;
    cbBack.addEventListener('change', () => {
      try { localStorage.setItem(OCCLUDE_BACK_KEY, cbBack.checked ? '1' : '0'); } catch { /* 忽略 */ }
      renderer.setOccludeBack(cbBack.checked);
      setStatus(cbBack.checked ? '球背面标记已隐藏（不再有背面虚影）' : '球背面标记恢复半透明虚影显示', 'ok');
    });
  }
  if (cbEdge) {
    cbEdge.checked = edge;
    cbEdge.addEventListener('change', () => {
      try { localStorage.setItem(EDGE_IND_KEY, cbEdge.checked ? '1' : '0'); } catch { /* 忽略 */ }
      if (edgeIndicator) edgeIndicator.setEnabled(cbEdge.checked);
      setStatus(cbEdge.checked ? '屏幕边缘指示已开启' : '屏幕边缘指示已关闭', 'ok');
    });
  }
  renderer.setOccludeBack(occ);
  if (edgeIndicator) edgeIndicator.setEnabled(edge);
}

// ====== 加载所有图层 ======
for (const layer of LAYERS) {
  renderer.addLayer(layer);
}

// ====== 极地补丁工具函数（从 dist 完整提取）======

// ====== 极地补丁工具函数（从 dist 完整提取）======
//
// 【架构 2026-10-15 二次重构】极冠 = 一张「全球等经纬合成图」SingleTileImageryProvider。
//
// 演进与踩坑（三次方案都实测过，别再回退）：
//  ① Entity rectangle + classificationType → 属性改动不重建 / 亮度回调 6% 极夜黑洞；
//  ② 极区「带状」SingleTileImageryProvider + lowerToBottom → 层存在、纹理像素正确，
//     但实机与 headless 双双不出图（黑洞依旧）；
//  ③ 现方案（= Cesium 官方社区口径 + 兜底双保险）：
//     A. 极冠合成层 = rectangle 覆盖全球的等经纬单张图（与 Cesium 官方样例
//        Natural Earth II 完全同构，是唯一被大量验证过的 SingleTile 用法）：
//        上/下两条极带为实景冰盖/大洋，中间 ±84.96° 区间 **全透明** → 低纬完全
//        透出卫星底图，不影响任何既有画面。
//     B. 卫星底图（Web Mercator）**必须保持第 0 层**：Cesium 只对 base layer 做
//        「极区边缘像素拉伸覆盖极点」（见 ImageryLayer._createTileImagerySkeletons：
//        `if (!isBaseLayer()) return false`）。② 方案用 lowerToBottom 抢走第 0 层，
//        等于把这条原生兜底也一起关掉了。现在合成层排在第 1 层，底图保持第 0 层，
//        即便合成层哪天不渲染，极区也由原生拉伸填满，永远不会再出现黑洞。

/**
 * 从 patch/bluemarble.jpg 裁极区条带（仅裁切+烘焙 softAlpha，不着色）
 * - 北极条带：从图片顶端往下切 POLE_CAP_EDGE_DEG 度对应的像素行
 * - 南极条带：从图片底端往上切
 * - 接缝处用 softAlpha = 1 - r² × SOFT_ALPHA_FACTOR(0.45) 柔化，避免白环
 * 着色（shiftToMean 到动态接缝色）由 renderPolarStrip 完成。
 */
// 极区补丁状态：保存原始像素与均值，供运行时校准后重映射
// canvas = 每条极带的纹理画布；合成层 = 由两条带拼出的全球等经纬影像层
const polarState = {
  ready: false,
  north: { raw: null, rawMean: null, canvas: null, target: PRESET_TARGET.north.slice(), seamColors: null },
  south: { raw: null, rawMean: null, canvas: null, target: PRESET_TARGET.south.slice(), seamColors: null },
};
let polarCompositeLayer = null; // 全球合成影像层（SingletonTile，index 1）

function computeMean(data) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
  if (!n) n = 1;
  return [r / n, g / n, b / n];
}

// 均值对齐映射：(pixel - rawMean) × CONTRAST_KEEP + targetMean，保留纹理只对齐色调
function shiftToMean(src, rawMean, targetMean) {
  const out = new ImageData(src.width, src.height);
  const s = src.data, d = out.data;
  for (let i = 0; i < s.length; i += 4) {
    d[i]     = Math.max(0, Math.min(255, (s[i]     - rawMean[0]) * CONTRAST_KEEP + targetMean[0]));
    d[i + 1] = Math.max(0, Math.min(255, (s[i + 1] - rawMean[1]) * CONTRAST_KEEP + targetMean[1]));
    d[i + 2] = Math.max(0, Math.min(255, (s[i + 2] - rawMean[2]) * CONTRAST_KEEP + targetMean[2]));
    d[i + 3] = s[i + 3];
  }
  return out;
}

// 下一个 2 的幂（WebGL 纹理尺寸对齐用）
function nextPow2(v) {
  let p = 1;
  while (p < v) p *= 2;
  return p;
}

// ImageData → 纹理 canvas：先放小图，再高质量双线性放大，
// 把逐像素行结构插值成连续渐变（否则每个源像素行在极冠上显示为一圈同心环）。
// 放大倍数动态钳制：GPU 单纹理上限 16384px，超限会抛 DeveloperError。
// ⚠️ 高度必须 pad 到 2 的幂（POT）：源条带 114 行是 NPOT，WebGL1 下 NPOT 纹理
//   无法生成 mipmap → 纹理不完整 → 采样返回纯白（headless 实测两极整盘 255 白，
//   而 canvas 本身像素完全正确）。pad 区保持透明，不参与渲染。
function imageDataToCanvas(imgData) {
  const small = document.createElement('canvas');
  small.width = imgData.width;
  small.height = imgData.height;
  small.getContext('2d').putImageData(imgData, 0, 0);

  // 放大倍数钳制到本机 GPU 纹理上限（硬编码 16384 会在 8192 上限的机器上触发
  // DeveloperError → Rendering stopped；bluemarble 为 4096 宽，8192 上限机器只能 2×、16384 上限 4×）
  const maxTex = Cesium.ContextLimits.maximumTextureSize || 8192;
  const scale = Math.max(
    1,
    Math.min(STRIP_UPSCALE, Math.floor(maxTex / small.width))
  );
  const contentW = small.width * scale;
  const contentH = Math.max(1, small.height * scale);
  const c = document.createElement('canvas');
  c.width = contentW;
  c.height = nextPow2(contentH); // POT pad（见上方警告）
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // 双重平滑：先降采样到 1/8（抹平逐行/逐列结构），再放大回目标尺寸
  const tiny = document.createElement('canvas');
  tiny.width = Math.max(2, Math.round(small.width / 8));
  tiny.height = Math.max(2, Math.round(small.height / 8));
  const tctx = tiny.getContext('2d');
  tctx.imageSmoothingEnabled = true;
  tctx.drawImage(small, 0, 0, tiny.width, tiny.height);
  // 只画内容区（contentH 行），POT pad 区（c.height - contentH）保持透明
  ctx.drawImage(tiny, 0, 0, contentW, contentH);
  // 记录内容高度：合成全球图时只贴内容区，避免把透明 pad 当成极区像素贴进去
  // （实测坑：南带 pad 正好落在极点侧 → 南极整条 alpha=0，补丁看不见）
  c.__contentH = contentH;
  return c;
}

// 裁切原始条带（存入 polarState[key].raw，供运行时按动态接缝色反复重着色）
function cutPolarStrip(img, isNorth) {
  const n = img.naturalWidth;
  const fullH = img.naturalHeight;
  const stripH = Math.max(2, Math.round((POLE_CAP_EDGE_DEG / 180) * fullH));

  // 裁原始像素（alpha 预烘焙 softAlpha 接缝柔化）
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = n;
  srcCanvas.height = stripH;
  const sctx = srcCanvas.getContext('2d');
  sctx.drawImage(img, 0, isNorth ? 0 : fullH - stripH, n, stripH, 0, 0, n, stripH);
  const raw = sctx.getImageData(0, 0, n, stripH);

  for (let y = 0; y < stripH; y++) {
    const latOffset = (isNorth ? y + 0.5 : stripH - y - 0.5) / fullH * 180;
    const r = Math.min(1, latOffset / POLE_CAP_EDGE_DEG);
    const softAlpha = 1 - r * r * SOFT_ALPHA_FACTOR;
    for (let x = 0; x < n; x++) {
      raw.data[(y * n + x) * 4 + 3] = Math.round(255 * softAlpha);
    }
  }
  return raw;
}

// 沿经线采样点 → 每列底图接缝色（环形角距反比加权插值，天然处理 ±180° 环绕）
function interpSeamColors(samples, w) {
  const out = new Float64Array(w * 3);
  for (let x = 0; x < w; x++) {
    const lon = ((x + 0.5) / w) * 360 - 180;
    const dists = samples.map((p) => {
      let dd = Math.abs(p.lon - lon) % 360;
      if (dd > 180) dd = 360 - dd;
      return { p, dd };
    }).sort((a, b) => a.dd - b.dd).slice(0, 3);
    let wsum = 0, r = 0, g = 0, b = 0;
    for (const { p, dd } of dists) {
      const wt = 1 / (dd * dd + 1);
      wsum += wt; r += p.rgb[0] * wt; g += p.rgb[1] * wt; b += p.rgb[2] * wt;
    }
    out[x * 3] = r / wsum; out[x * 3 + 1] = g / wsum; out[x * 3 + 2] = b / wsum;
  }
  return out;
}

/**
 * 【纯红 debug 条带】不依赖 bluemarble：整条带填不透明纯红 (255,0,0,255)。
 * 尺寸与兜底条带一致（imageDataToCanvas 会双线性平滑 + POT pad + 记 __contentH）。
 */
function makeDebugPolarStrip() {
  const w = IMG_W;
  const stripH = Math.max(2, Math.round((POLE_CAP_EDGE_DEG / 180) * IMG_H));
  const img = new ImageData(w, stripH);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) { d[i] = 255; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = 255; }
  return imageDataToCanvas(img);
}

// 按沿经线采样结果重着色并输出纹理 canvas：
// 每列按「底图接缝色 − 补丁该列边缘色」做色调修正，修正量从接缝边缘（100%）
// 向极心（0%）衰减——边缘逐列对齐底图色泽，极心保留冰盖真实纹理。
// 无采样结果时退回单目标均值对齐（shiftToMean + PRESET_TARGET 兜底）。
function renderPolarStrip(key) {
  const st = polarState[key];
  if (getPolarDebugMode()) return makeDebugPolarStrip(); // 纯红 debug：不看源图
  if (!st || !st.raw) return null;
  const raw = st.raw;
  const w = raw.width, h = raw.height;
  const s = raw.data;

  if (st.seamColors && st.seamColors.length >= 2) {
    const out = new ImageData(w, h);
    const d = out.data;
    // 每列补丁边缘色：取接缝侧 25% 行（北=底部，南=顶部）的列均值
    const edgeRows = Math.max(1, Math.round(h * 0.25));
    const y0 = key === 'north' ? h - edgeRows : 0;
    const colEdge = new Float64Array(w * 3);
    const colCnt = new Uint32Array(w);
    for (let y = y0; y < y0 + edgeRows; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        colEdge[x * 3] += s[i]; colEdge[x * 3 + 1] += s[i + 1]; colEdge[x * 3 + 2] += s[i + 2];
        colCnt[x]++;
      }
    }
    for (let x = 0; x < w; x++) {
      if (colCnt[x]) {
        colEdge[x * 3] /= colCnt[x]; colEdge[x * 3 + 1] /= colCnt[x]; colEdge[x * 3 + 2] /= colCnt[x];
      }
    }
    const base = interpSeamColors(st.seamColors, w);
    const denom = Math.max(1, h - 1);
    for (let y = 0; y < h; y++) {
      const edgeT = key === 'north' ? (h - 1 - y) / denom : y / denom;
      const k = POLE_TONE_FLOOR + (1 - POLE_TONE_FLOOR) * (1 - edgeT); // 边缘 1 → 极心 POLE_TONE_FLOOR
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const dx = (base[x * 3] - colEdge[x * 3]) * k;
        const dy = (base[x * 3 + 1] - colEdge[x * 3 + 1]) * k;
        const dz = (base[x * 3 + 2] - colEdge[x * 3 + 2]) * k;
        d[i]     = Math.max(0, Math.min(255, s[i]     + dx));
        d[i + 1] = Math.max(0, Math.min(255, s[i + 1] + dy));
        d[i + 2] = Math.max(0, Math.min(255, s[i + 2] + dz));
        d[i + 3] = s[i + 3];
      }
    }
    return imageDataToCanvas(out);
  }
  return imageDataToCanvas(shiftToMean(raw, st.rawMean, st.target));
}

/**
 * 兜底 canvas：Web Mercator 瓦片底图在 ±85.05° 之外无瓦片 → 极区空洞，
 * 这里手绘一层冰盖补上。画上冷白蓝基色（与 PRESET_TARGET 一致），再按与
 * bluemarble 版相同的 softAlpha 接缝淡出（极心不透明 → 85° 接缝 0.55，融入底图）。
 *
 * ⚠️ 历史坑：此前版本只 fill 了全透明画布（#00000000），虽然兜底条带已作为
 * 影像层添加，但图像 alpha 全 0 → 补丁「启用了却看不见」。现已修正为带 alpha 的冰色条带。
 */
function makeFallbackPolarStrip(isNorth) {
  if (getPolarDebugMode()) return makeDebugPolarStrip(); // 纯红 debug：兜底路径同样生效
  const w = IMG_W;
  const stripH = Math.max(
    2,
    Math.round((POLE_CAP_EDGE_DEG / 180) * IMG_H)
  );
  const c = document.createElement('canvas');
  c.width = w;
  c.height = stripH;
  const ctx = c.getContext('2d');
  const base = isNorth ? PRESET_TARGET.north : PRESET_TARGET.south;
  ctx.fillStyle = `rgb(${base[0] | 0}, ${base[1] | 0}, ${base[2] | 0})`;
  ctx.fillRect(0, 0, w, stripH);
  const img = ctx.getImageData(0, 0, w, stripH);
  for (let y = 0; y < stripH; y++) {
    const latOffset = (isNorth ? y + 0.5 : stripH - y - 0.5) / IMG_H * 180;
    const r = Math.min(1, latOffset / POLE_CAP_EDGE_DEG);
    const alpha = Math.round(255 * (1 - r * r * SOFT_ALPHA_FACTOR));
    for (let x = 0; x < w; x++) {
      img.data[(y * w + x) * 4 + 3] = alpha;
    }
  }
  // 统一走 imageDataToCanvas：双线性平滑 + POT 高度 pad（NPOT 会白屏，见其注释）
  return imageDataToCanvas(img);
}

/**
 * 合成「全球等经纬极冠图」：
 * 整张 4096×2048 等经纬画布，只有上/下两条极带（各 POLE_CAP_EDGE_DEG 度）有像素，
 * 中间 ±84.96° 区间保持全透明 → 低纬完整透出卫星底图，极区补上实景冰盖/大洋。
 * 用全球矩形（而非极区子矩形）是刻意的：Cesium 官方样例（Natural Earth II）就是
 * 这种用法，而「子矩形 + 自定义 1×1 根瓦片方案」实测不出图（见文件头架构注释）。
 */
function buildPolarCompositeCanvas() {
  // 合成图放大倍数按本机 GPU 纹理上限降档（默认 2× = 8192×4096；上限 4096 的老 GPU 退 1×）
  const maxTex = Cesium.ContextLimits.maximumTextureSize || 8192;
  const scale = Math.max(1, Math.min(COMPOSITE_SCALE, Math.floor(maxTex / IMG_W)));
  const w = IMG_W * scale;
  const h = IMG_H * scale; // 等经纬，POT
  const bandPx = Math.max(1, Math.round((POLE_CAP_EDGE_DEG / 180) * h));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  // fullred：整张全球合成图全红（最强可见性信号——红遮住整个地球说明层 100% 在工作）
  if (getPolarDebugMode() === 'fullred') {
    c.getContext('2d').fillStyle = 'rgb(255, 0, 0)';
    c.getContext('2d').fillRect(0, 0, w, h);
    return c;
  }
  const ctx = c.getContext('2d');
  // 等经纬：y=0 → +90°，y=h → -90°。两条带的行序已与纬度对齐
  // （北带第 0 行 = 极点、末行 = 接缝；南带第 0 行 = 接缝、末行 = 极点），无需翻转。
  // 只取内容高度（__contentH）贴，跳过 POT 透明 pad。
  const paste = (canvas, dy) => {
    if (!canvas) return;
    const ch = canvas.__contentH || canvas.height;
    ctx.drawImage(canvas, 0, 0, canvas.width, ch, 0, dy, w, bandPx);
  };
  paste(polarState.north.canvas, 0);
  paste(polarState.south.canvas, h - bandPx);
  return c;
}

/**
 * 刷新极冠合成影像层（remove 旧层 + add 新层，Cesium 会走 provider 重载路径）
 */
function updatePolarCompositeLayer() {
  const canvas = buildPolarCompositeCanvas();
  window.__polarComposite = canvas;
  if (polarCompositeLayer) {
    try { viewer.imageryLayers.remove(polarCompositeLayer); } catch { /* 已移除则忽略 */ }
    polarCompositeLayer = null;
  }
  const provider = new Cesium.SingleTileImageryProvider({
    url: canvas.toDataURL('image/png'),
    rectangle: Cesium.Rectangle.MAX_VALUE,
    tileWidth: canvas.width,
    tileHeight: canvas.height,
  });
  polarCompositeLayer = viewer.imageryLayers.addImageryProvider(provider);
  syncImageryLayerOrder();
  window.__polarCompositeLayer = polarCompositeLayer; // 调试探针：检查 _image/_texture
  console.log('[polar] 极冠合成影像层已更新：全球矩形 | 瓦片',
    canvas.width + '×' + canvas.height,
    '| 层序 =', viewer.imageryLayers.length > 0 ? indexOfLayer(polarCompositeLayer) : -1);
  return polarCompositeLayer;
}

// 取某层在当前集合里的下标（ImageryLayerCollection 没有 indexOf，也不支持迭代）
function indexOfLayer(layer) {
  const layers = viewer.imageryLayers;
  const n = layers ? layers.length : 0;
  for (let i = 0; i < n; i++) if (layers.get(i) === layer) return i;
  return -1;
}

// 卫星底图层（UrlTemplate/Esri 瓦片层）本身的 layer 对象
function findSatelliteBaseLayer() {
  const layers = viewer.imageryLayers;
  const n = layers ? layers.length : 0;
  for (let i = 0; i < n; i++) {
    const layer = layers.get(i);
    const p = layer && layer.imageryProvider;
    if (!p || !p.tilingScheme || !p.requestImage) continue;
    if (p instanceof Cesium.SingleTileImageryProvider) continue;
    return layer;
  }
  return null;
}

/**
 * 锁定图层顺序：卫星底图 index 0（Cesium 只对 base layer 做极区边缘拉伸），
 * 极冠合成层 index 1（压在底图之上、其它图层之下）。
 * 每次底图或极冠层重建后都要调用一次。
 */
/**
 * 锁定图层顺序（2026-10-16 第三次修正，完整根因见 terrarium-provider.js 文件头）：
 *  卫星底图 = index 0（base layer），极冠合成层 = index 1（盖在底图之上）。
 *
 * 演进史（三次翻车才到位）：
 *   ① 卫星 index 0 / 合成 index 1：globe 瓦片几何是 WebMercator（terrain provider 带出来的），
 *      ±85.05° 外没有瓦片 → 极冠永远黑洞（fullred 实测「中低纬全红、极地仍黑洞」）。
 *   ② 一度把合成层压到 index 0 抢 base 位，以为「base layer 边缘像素拉伸」能救极区：
 *      那是 Geographic globe + Mercator 影像才有的机制；本项目 globe 本身就是 Mercator，
 *      不存在「超出影像矩形的瓦片」，拉伸分支根本不触发——极地照样黑洞。
 *   ③ 现行：terrain provider 改为对外 GeographicTilingScheme → globe 恢复 ±90° 全极区几何；
 *      合成层（全球矩形）与所有瓦片相交直接上屏。层序回到「合成层在卫星层之上」——
 *      因为 WebMercator 卫星影像重投影到地理瓦片时会钳制到 85.05° 边缘行，
 *      极区瓦片也会拿到卫星 skeleton（实测 ±90° 瓦片上 24+ 个），合成层必须盖在它上面，
 *      否则极带被卫星的边缘拉伸内容压住（北极实测 [38,107,122] 蓝灰 = 被盖住的合成层）。
 *
 * 每次底图或极冠层重建后都要调用一次。
 */
function syncImageryLayerOrder() {
  const layers = viewer.imageryLayers;
  if (!layers) return;
  let guard = 0;
  const base = findSatelliteBaseLayer();
  if (base) {
    // 卫星底图保持 index 0（base layer）
    while (indexOfLayer(base) > 0 && guard++ < 20) layers.lower(base);
  }
  if (polarCompositeLayer) {
    // 极冠合成层抬到底图之上（index 1；无底图时 index 0）
    guard = 0;
    const target = base ? 1 : 0;
    while (indexOfLayer(polarCompositeLayer) > target && guard++ < 20) {
      layers.lower(polarCompositeLayer);
    }
  }
}

/**
 * 图片加载工具（带 decode）
 */
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      img.decode().then(() => resolve(img)).catch(() => resolve(img));
    };
    img.onerror = reject;
    img.src = src;
  });
}

// 极地补丁：按当前底图源的 profile（每源一份补丁图，见 polar-profiles.js），
// 沿经线与当前底图接缝带逐列对齐，作为影像层盖在 Mercator 钳制内容之上。
// 切源联动：手动/故障/探活恢复 → applyPolarProfile → 防抖 → 换图（如需）+ 重采样接缝色。
// 季节策略：在线底图为夏季影像 → 北极直接用源图北带（夏季极区状态），不翻转。
// 采样失败回退 PRESET_TARGET 单色对齐；图片缺失时退回单色兜底条带。
//
// ====== 极冠补丁 profile 状态（2026-10-16 per-source 架构）=====
let polarProfile = resolvePolarProfile({ baseMode: getBaseMode(), sourceId: getOnlineSourceId() });
let polarLocalActive = false; // 本地瓦片层在画面中（auto 模式）→ profile 走 local（=Esri 派生）
let activePatchSrc = null;    // 当前已加载的补丁图路径（null=未加载）

/** 按 profile 加载补丁图并重裁南北带（图未变则什么都不做）。返回是否有变化。 */
async function loadPolarPatchImage(profile) {
  if (profile.poleStrategy === 'native') return false; // 原生极区源：不补丁
  const src = profile.patchImage || 'patch/bluemarble.jpg';
  if (src === activePatchSrc) return false;
  const img = await loadImage(src);
  polarState.north.raw = cutPolarStrip(img, true);
  polarState.south.raw = cutPolarStrip(img, false);
  for (const key of ['north', 'south']) {
    const st = polarState[key];
    st.rawMean = computeMean(st.raw.data);
    st.target = PRESET_TARGET[key].slice();
    st.seamColors = null; // 换图了，旧接缝采样作废（recalibrate 会重采）
  }
  activePatchSrc = src;
  console.log('[polar] 补丁图已切换：', src,
    '| 北带均值', polarState.north.rawMean.map(Math.round),
    '| 南带均值', polarState.south.rawMean.map(Math.round));
  return true;
}

/** 更新左侧「极冠补丁」状态行 */
function updatePolarProfileStatus() {
  const el = $('polarProfileInfo');
  if (el) el.textContent = profileStatusText(polarProfile, getSeason());
}

let _polarRecalTimer = 0;
/** 防抖重校准：等新源首屏瓦片就绪（约 1.5s）再采样接缝色，避免采到旧源的色 */
function schedulePolarRecalibrate() {
  clearTimeout(_polarRecalTimer);
  _polarRecalTimer = setTimeout(async () => {
    try {
      await loadPolarPatchImage(polarProfile);
      await recalibratePolarCaps();
    } catch (e) {
      console.warn('[polar] 补丁重校准失败：', e);
    }
  }, 1500);
}

/** 切换生效 profile（切源时调用）：立即更新状态行，防抖后重校准 */
function applyPolarProfile(sourceId) {
  polarProfile = resolvePolarProfile({ baseMode: getBaseMode(), sourceId, localActive: polarLocalActive });
  updatePolarProfileStatus();
  schedulePolarRecalibrate();
}

(async function setupPolarCap() {
  try {
    if (polarProfile.poleStrategy === 'native') {
      // 原生极区源（如 GIBS EPSG:4326）：源自身覆盖 ±90°，补丁直接关闭
      updatePolarProfileStatus();
      setStatus(`底图源自带 ±90° 极区数据（${polarProfile.label}），极冠补丁已关闭`, 'ok');
      return;
    }
    await loadPolarPatchImage(polarProfile);
    for (const key of ['north', 'south']) {
      const st = polarState[key];
      const isNorth = key === 'north';
      st.seamColors = await sampleBaseSeamColors(isNorth);
      st.canvas = renderPolarStrip(key);
    }
    // 调试导出：纹理 canvas 供控制台/自动化直接检查像素
    // （例：__polarCanvases.north.getContext('2d').getImageData(...).data）
    window.__polarCanvases = { north: polarState.north.canvas, south: polarState.south.canvas };
    updatePolarCompositeLayer();
    polarState.ready = true;
    setStatus(`已加载 ${activePatchSrc} · 极地实景补丁（全球合成影像层，沿经线与底图逐列对齐）`, 'ok');
  } catch {
    polarState.north.canvas = makeFallbackPolarStrip(true);
    polarState.south.canvas = makeFallbackPolarStrip(false);
    window.__polarCanvases = { north: polarState.north.canvas, south: polarState.south.canvas };
    updatePolarCompositeLayer();
    setStatus('无补丁图，使用单色兜底极区', 'warn');
  }
  updatePolarProfileStatus();
  recalibratePolarCaps();
})();

// ====== 本地卫星影像检测 & 底图源切换 ======
let onlineEsriProvider = null;   // 当前在线底图 provider（兼容旧调试引用）
let bingBaseProvider = null;     // 当前在线底图 provider（兼容旧调试引用）
let imagerySourceMgr = null;     // 在线源管理器（esri/aws-s2 互切 + 天地图中国覆盖层 + 故障切换）

// 当前生效的「卫星瓦片底图」provider（跳过极冠 SingleTile 底层影像层）。
// 层序（2026-10-16 反转）：极冠合成层 index 0 抢 base 位（只有 base layer 的极区
// 像素拉伸能覆盖 Mercator 极区空洞），卫星底图 index 1 盖在其透明中带之上。
// 接缝采样/底图判定必须显式跳过 SingleTile，否则会采到极冠图自己。
function findSatelliteBaseProvider() {
  const layers = viewer.imageryLayers;
  const n = layers ? layers.length : 0;
  for (let i = 0; i < n; i++) {
    const layer = layers.get(i);
    const p = layer && layer.imageryProvider;
    if (!p || !p.tilingScheme || !p.requestImage) continue;
    if (p instanceof Cesium.SingleTileImageryProvider) continue; // 极冠层自身
    return p;
  }
  return null;
}

// 飞抵极点俯瞰极冠补丁（调试/验证用）：__flyToPole(true) 北极 / (false) 南极
// 第二参数为相机高度（米），默认 220 万（近看）；传 12000000 级可复现「宽视角」
window.__flyToPole = (isNorth, height = 2200000) => {
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(0, isNorth ? 89.5 : -89.5, height),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
    duration: 1.5,
  });
};

// 极冠纯红 debug 开关：__setPolarDebug('red'|'fullred'|'')，空/undefined = 关闭
window.__setPolarDebug = (mode) => {
  const v = mode === 'red' || mode === 'fullred' ? mode : '';
  try { v ? localStorage.setItem(POLAR_DEBUG_KEY, v) : localStorage.removeItem(POLAR_DEBUG_KEY); } catch { /* 忽略 */ }
  recalibratePolarCaps(); // 重画条带 + 重建合成层
  return getPolarDebugMode();
};

// 极冠状态速查：浏览器控制台输入 __polarDebug() 一键诊断
window.__polarDebug = () => {
  const layers = viewer.imageryLayers;
  const base = findSatelliteBaseProvider();
  const ts = base && base.tilingScheme;
  const poleLayers = [];
  const n = layers ? layers.length : 0;
  for (let i = 0; i < n; i++) {
    const p = layers.get(i).imageryProvider;
    if (p instanceof Cesium.SingleTileImageryProvider) {
      poleLayers.push({ index: i, show: layers.get(i).show });
    }
  }
  const baseLayer = findSatelliteBaseLayer();
  return {
    // 当前页面加载的 main.js 版本（index.html 里 ?v= 的值，app.py 按 src/ mtime 注入）：
    // 与页面网络面板里 main.js 的 URL 对不上 → 浏览器还在跑旧缓存，硬重载即可
    build: new URL(import.meta.url).searchParams.get('v'),
    compositeLayer: !!polarCompositeLayer,
    compositeIndex: polarCompositeLayer ? indexOfLayer(polarCompositeLayer) : -1,
    // 层序（2026-10-16 第三次修正后）：卫星底图 = index 0 的 base layer，
    // 极冠合成层 = index 1 盖在其上（极区几何已由 Geographic globe 恢复，
    // 合成层全球矩形与所有瓦片相交；且必须盖住卫星层的 Mercator 边缘拉伸内容）
    compositeIsBaseLayer: polarCompositeLayer ? polarCompositeLayer.isBaseLayer() : null,
    // 卫星底图在合成层之上（index 1）
    baseIndex: baseLayer ? indexOfLayer(baseLayer) : -1,
    baseIsBaseLayer: baseLayer ? baseLayer.isBaseLayer() : null,
    poleLayers,
    imageryCount: n,
    baseScheme: ts ? ts.constructor.name : null,
    baseRectNorth: ts && ts.rectangle ? ts.rectangle.north : null,
    // globe 自身瓦片几何方案（2026-10-16 极冠黑洞根因）：必须是 Geographic（矩形到 ±90°）。
    // 若为 WebMercator（矩形北界 1.4844），±85.05° 外没有瓦片几何，极冠补丁永远摸不到极区。
    globeScheme: (() => {
      try {
        const gts = viewer.scene.globe._surface._tileProvider.tilingScheme;
        return {
          ctor: gts ? gts.constructor.name : null,
          rectNorth: gts && gts.rectangle ? +gts.rectangle.north.toFixed(4) : null,
        };
      } catch { return null; }
    })(),
    lighting: globe.enableLighting,
    polarDebug: getPolarDebugMode() || null,
    // 极冠补丁 profile（2026-10-16 per-source 架构）：切源时 id/patchImage 应跟着变
    polarProfile: {
      id: polarProfile.id,
      label: polarProfile.label,
      patchImage: polarProfile.patchImage,
      activePatchSrc, // 实际已加载的图（切源防抖期内可能还是旧图）
      poleStrategy: polarProfile.poleStrategy,
      season: getSeason(),
      localActive: polarLocalActive,
    },
    // native 策略下合成层应 show=false（GIBS 等源自带极区数据）
    polarCompositeShow: polarCompositeLayer ? polarCompositeLayer.show : null,
    seamNorth: polarState.north.seamColors,
    seamSouth: polarState.south.seamColors,
  };
};

/**
 * 沿经线采样底图接缝带颜色：返回 [{lon, rgb}, ...] 或 null。
 * 在极冠边缘之外、Mercator 覆盖之内（北 83°，南 -83°）沿 8 条经线取点，
 * 从最底层 imagery（= 底图）请求对应瓦片，读取「样本点精确像素」邻块均值。
 *
 * 与旧版两点差异：
 *   1. 沿经线多点（旧版 2 纬度 × 5 经度取全局均值）→ 供 renderPolarStrip 逐列对齐；
 *   2. 精确像素（旧版取瓦片中心 16×16——z4 瓦片跨 ~20° 纬度，中心可能落在
 *      低 10° 的开放大洋上，采到的不是接缝带颜色）。
 *
 * 防御（历史坑：Flask 代理上游失败时返回 1×1 透明 PNG，若当成底图色采样，
 * getImageData 越界区为透明黑 → 目标色 [0,0,0] → 冰盖全映射成黑盘）：
 *   丢弃 width<64 的占位图；跳过 alpha<200 的透明像素；有效点 <2 返回 null。
 */
async function sampleBaseSeamColors(isNorth) {
  const provider = findSatelliteBaseProvider(); // 跳过极冠 SingleTile 层
  if (!provider) return null;
  const scheme = provider.tilingScheme;
  const level = 4; // 单瓦片约 22° 宽，足够覆盖接缝带
  const lats = isNorth ? [83] : [-83]; // 接缝外侧（补丁边缘 85.05° 之外）
  const lons = [-165, -120, -75, -30, 15, 60, 105, 150];

  // 并发采样：串行时每个失败瓦片都要等满超时，重校准会被拖慢
  const jobs = [];
  for (const lat of lats) {
    for (const lon of lons) {
      jobs.push((async () => {
        try {
          const carto = Cesium.Cartographic.fromDegrees(lon, lat);
          const xy = scheme.positionToTileXY(carto, level);
          if (!xy) return null;
          const im = await provider.requestImage(xy.x, xy.y, level);
          if (!im || !im.width || im.width < 64) return null; // 占位图/无效图
          // 精确像素：样本点在瓦片内的相对位置（经 tilingScheme 矩形换算，scheme 无关）
          const rect = scheme.tileXYToRectangle(xy.x, xy.y, level);
          if (!rect) return null;
          const fx = (carto.longitude - rect.west) / (rect.east - rect.west);
          const fy = (rect.north - carto.latitude) / (rect.north - rect.south);
          const c = document.createElement('canvas');
          c.width = im.width;
          c.height = im.height;
          const ctx = c.getContext('2d');
          ctx.drawImage(im, 0, 0);
          const bs = 8;
          const px = Math.max(0, Math.min(c.width - bs, Math.round(fx * c.width) - (bs >> 1)));
          const py = Math.max(0, Math.min(c.height - bs, Math.round(fy * c.height) - (bs >> 1)));
          const d = ctx.getImageData(px, py, bs, bs).data;
          let r = 0, g = 0, b = 0, n = 0;
          for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] < 200) continue; // 跳过透明像素
            r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
          }
          if (!n) return null;
          const mean = [r / n, g / n, b / n];
          // 防御：真实地表在 ±83° 不可能是近黑（北冰洋深青 sum≈140-260、
          // 南极冰盖 sum≈730）。近黑样本只会来自未就绪瓦片/占位图，
          // 一旦流入逐列对齐（delta = 接缝色 − 补丁边缘色）会把白冰整条拉黑。
          if (mean[0] + mean[1] + mean[2] < 100) return null;
          return { lon, rgb: mean };
        } catch { return null; }
      })());
    }
  }
  const results = (await Promise.all(jobs)).filter(Boolean);
  return results.length >= 2 ? results : null; // 有效采样点不足 → 失败
}

/**
 * 底图装配完成后重校准极冠接缝色：
 * 重新采样卫星瓦片底图接缝带 → 更新 seamColors → 重渲染 canvas → 换影像层。
 * 覆盖「setupPolarCap 先于底图就绪跑完」的时序差（首跑只能用 PRESET_TARGET 兜底）。
 * 影像层更换 = remove 旧 layer + add 新 layer（SingleTile provider 一次性建命令，
 * 但 provider 本身替换后 Cesium 会走 layer 的 imageryProvider 重载路径，稳定生效）。
 * 底图模式切换走 location.reload() 整页重载，无需在此监听。
 */
async function recalibratePolarCaps() {
  // 原生极区源（GIBS EPSG:4326 等）：源自身有 ±90° 真数据 → 补丁隐藏。
  // 层已存在则 show=false（保留 canvas，切回 patch 源即刻恢复）；不存在则不建。
  if (polarProfile.poleStrategy === 'native') {
    if (polarCompositeLayer) polarCompositeLayer.show = false;
    updatePolarProfileStatus();
    return;
  }
  if (polarCompositeLayer) polarCompositeLayer.show = true;
  let changed = false;
  for (const key of ['north', 'south']) {
    const st = polarState[key];
    if (!st || !st.raw) continue;
    const isNorth = key === 'north';
    try {
      const colors = await sampleBaseSeamColors(isNorth);
      if (colors) st.seamColors = colors;
    } catch { /* 保留现采样 */ }
    const canvas = renderPolarStrip(key);
    if (!canvas) continue;
    st.canvas = canvas;
    changed = true;
  }
  if (!changed) { updatePolarProfileStatus(); return; }
  window.__polarCanvases = { north: polarState.north.canvas, south: polarState.south.canvas };
  updatePolarCompositeLayer();
  updatePolarProfileStatus();
}

/**
 * 挂「当前选定在线源」底图层（esri / aws-s2；tianditu 只作中国覆盖层，不当全球底图——
 * 其全球瓦片在中国之外无数据，直接当底图会出现空白世界）。
 * 失败自动回退 esri。返回新建的 ImageryLayer（或 null）。
 */
function applyOnlineBase(layerOptions = {}) {
  if (!imagerySourceMgr) return null;
  let layer = imagerySourceMgr.applyOnlineLayer(imagerySourceMgr.currentId, layerOptions);
  if (!layer) layer = imagerySourceMgr.applyOnlineLayer('esri', layerOptions);
  if (layer) {
    onlineEsriProvider = layer.imageryProvider;
    bingBaseProvider = layer.imageryProvider;
  }
  return layer;
}

(async function setupLocalSatellite() {
  const layers = viewer.imageryLayers;
  const mode = getBaseMode();

  // 在线源管理器：接管在线底图挂载/切换、天地图中国覆盖层、故障自动切换。
  // 必须在任何 await 之前创建，保证紧随其后的 UI 绑定代码能立即拿到实例。
  imagerySourceMgr = new ImagerySourceManager(viewer, {
    syncOrder: syncImageryLayerOrder, // 铁律：每次增删影像层后保底图 index 0
    setStatus,
    // 在线源变更（手动切源/故障切换/探活切回）→ 极冠补丁 profile 联动：
    // 切源会把本地瓦片层请出画面（见 applyOnlineLayer），profile 不再走 local
    onSourceChanged: (id) => {
      polarLocalActive = false;
      applyPolarProfile(id);
    },
  });
  window.__imagerySourceMgr = imagerySourceMgr; // 调试探针

  // 图源设置抽屉（右侧浮层）：优先级排序 / 本地优先 / 缓存统计 / 分段下载。
  // 侧栏的底图/在线源/天地图控件由它 DOM 迁移接管（监听器不丢失）。
  initSourcePanel({ manager: imagerySourceMgr, setStatus });

  // 仅在线模式：直接挂当前选定的在线源
  if (mode === 'online') {
    applyOnlineBase();
    // 初始 profile 按实际生效源解析（选中的源创建失败会回落 esri）
    applyPolarProfile(imagerySourceMgr.currentId);
    imagerySourceMgr.applyOverlayLayer(); // 覆盖层开关开着才挂
    imagerySourceMgr.startProbing();      // 故障切备用后每 60s 探活切回
    syncImageryLayerOrder();
    setStatus(`底图：仅在线（${getSourceDef(imagerySourceMgr.currentId).name}）`, 'ok');
    recalibratePolarCaps();
    return;
  }

  // auto 模式：检测本地卫星瓦片
  try {
    const r = await fetch('tiles/esri/0/0/0.jpg', { method: 'HEAD' });
    if (!r.ok) {
      // 无本地瓦片：回退到在线源
      applyOnlineBase();
      applyPolarProfile(imagerySourceMgr.currentId);
      imagerySourceMgr.applyOverlayLayer();
      imagerySourceMgr.startProbing();
      syncImageryLayerOrder();
      setStatus(`无本地卫星瓦片，使用在线底图（${getSourceDef(imagerySourceMgr.currentId).name}）`, 'ok');
      recalibratePolarCaps();
      return;
    }
    setStatus('检测到本地卫星瓦片，切换底图层…', '');
    // auto：只挂 ONE 个本地瓦片 imagery 层（不限定范围，向全球请求）。
    // 「本地优先、在线兜底」发生在 Flask 瓦片级（见 app.py proxy_esri_tile）：
    // 已下载的瓦片由 Flask 直出；未下载的由 Flask 代理 Esri 在线瓦片顶上，上游失败
    // 返回 1×1 透明 PNG（HTTP 200，无控制台报错）。因此并不是「两层叠加」，
    // 而是单层 + 逐瓦片回退；日后下载更多区域自动本地化、无需改代码。
    layers.addImageryProvider(
      new Cesium.UrlTemplateImageryProvider({
        url: 'tiles/esri/{z}/{x}/{y}.jpg',
        maximumLevel: 14,
        enablePickFeatures: false,
      })
    );
    polarLocalActive = true; // 本地瓦片在画面中 → 极冠 profile 走 local（=Esri 派生）
    applyPolarProfile('local');
    imagerySourceMgr.applyOverlayLayer(); // 本地底图之上仍可叠中国高清覆盖层
    syncImageryLayerOrder();
    setStatus('本地卫星瓦片已激活（本地优先，Esri 在线兜底）', 'ok');
  } catch {
    applyOnlineBase();
    applyPolarProfile(imagerySourceMgr.currentId);
    imagerySourceMgr.startProbing();
    syncImageryLayerOrder();
    setStatus('底图：在线（异常回退）', 'warn');
  }
  recalibratePolarCaps();
})();

// 在线源切换/天地图覆盖层/底图模式控件已移除（2026-10-17）：统一走「图源设置」抽屉的
// 优先级链 + 本地优先 + 启用开关；getBaseMode/天地图 key 仍从 localStorage / .env 读取。

// ====== 左侧面板交互 ======

// 地形夸张（2026-10-29 用户第 2 点：滑块改成按钮控件）
// 真值仍是隐藏的 #exag range：按钮只负责「点一下换一个档位」并派发 input，
// 上面这套 input 逻辑（globe.terrainExaggeration + 极冠/瓦片自动跟随）一行都不用改。
$('exag').addEventListener('input', (e) => {
  const v = parseFloat(e.target.value);
  globe.terrainExaggeration = v;
  exagValEl.textContent = `${v.toFixed(1)}×`;
  // 极冠为底层影像层（非实体），自动跟随地形夸张，无需任何同步处理。
});

// 行星模式下的场景控件收放（2026-10-29）：地形夸张改成按钮后与晨夜/海底同列，
// 原来那行是「仅地球模式显示」，若整行隐藏会把晨夜与地形夸张一起带走。改为只收地球专属的两项。
// （侧栏 OSM 钮 2026-10-29 第五轮已删除，不再有 #osmRow；OSM 入口只剩右侧导航列那一颗。）
function setSceneControlsMode(isEarth) {
  $('btnOceanBase')?.classList.toggle('hidden', !isEarth);
  $('btnGeocode')?.classList.toggle('hidden', !isEarth);
  // 2026-10-30：月球/火星模式不需要「回到中国」按钮（地球模式才保留，作为切回地球入口）
  $('btnHome')?.classList.toggle('hidden', !isEarth);
  setOsmNavBtnVisible(isEarth);   // 右侧 🗺 是唯一 OSM 入口，月/火模式必须收起
}

const EXAG_STEPS = [1.0, 1.2, 1.5, 2.0, 3.0];
function syncExagBtn() {
  const btn = $('exagBtn');
  if (!btn) return;
  const v = parseFloat($('exag').value);
  btn.classList.toggle('active', v > 1.0001);
  btn.title = `地形夸张 ${v.toFixed(1)}× —— 点击切换到下一档（1.0 / 1.2 / 1.5 / 2 / 3×，超过 3× 会明显失真）`;
}
$('exagBtn')?.addEventListener('click', () => {
  const cur = parseFloat($('exag').value);
  // 找下一个更大的档位，到头回到 1.0（= 关闭夸张）
  const next = EXAG_STEPS.find((v) => v > cur + 1e-6) ?? EXAG_STEPS[0];
  $('exag').value = String(next);
  $('exag').dispatchEvent(new Event('input', { bubbles: true }));
  syncExagBtn();
  setStatus(next > 1.0001 ? `地形夸张 ${next.toFixed(1)}×` : '地形夸张关闭（1.0× 真实比例）', 'ok');
});
syncExagBtn();

// 晨夜光影（极冠为底层影像层，自动跟随全局光照，无需任何额外处理）
$('lighting').addEventListener('click', () => {
  const on = !$('lighting').classList.contains('active');
  $('lighting').classList.toggle('active', on);
  globe.enableLighting = on;
  viewer.scene.requestRender();
});

// ====== 海底地形底图（Esri World Ocean Base，GEBCO/NOAA NGDC 测深编译）======
// 走 app.py 的 tiles/ocean 代理（本地优先 + 成功回写，与 esri/eox 同一套），
// 前端模板用 Cesium 约定的 z/x/y，代理内部换成上游的 z/y/x。
// ⚠ 该服务是 Web Mercator（3857），必须用 WebMercatorTilingScheme，不能按 Geographic 拼。
// ⚠ Cesium 1.146 的 addImageryProvider(provider, opts) 会把 opts 当 index（ToInteger({})===0），
//    必须 new Cesium.ImageryLayer(provider, opts) + 单参 add()（2026-10-16 踩过的坑）。
let oceanLayer = null;
function setOceanBasemap(on) {
  const btn = $('btnOceanBase');
  if (!viewer || !viewer.imageryLayers) return;
  if (!on) {
    if (oceanLayer) {
      try { viewer.imageryLayers.remove(oceanLayer); } catch { /* 忽略 */ }
      oceanLayer = null;
    }
    if (btn) btn.classList.remove('active');
    setStatus('已回到卫星底图', 'ok');
    return;
  }
  if (oceanLayer) return;
  try {
    const provider = new Cesium.UrlTemplateImageryProvider({
      url: 'tiles/ocean/{z}/{x}/{y}',
      tilingScheme: new Cesium.WebMercatorTilingScheme(),
      maximumLevel: 13,
      credit: 'Esri, Garmin, GEBCO, NOAA NGDC and other contributors',
    });
    oceanLayer = new Cesium.ImageryLayer(provider, {});
    viewer.imageryLayers.add(oceanLayer);
    if (btn) btn.classList.add('active');
    setStatus('海底地形底图已开启（GEBCO / NOAA NGDC 测深；再点一次回到卫星底图）', 'ok');
  } catch (e) {
    setStatus(`海底地形底图加载失败：${e && e.message ? e.message : e}`, 'warn');
  }
}
$('btnOceanBase')?.addEventListener('click', () => {
  setOceanBasemap(!oceanLayer);
});

// （已删除：OSM 栅格街道底图按钮全家 —— 2026-10-25 用户拍板删按钮+JS。
//   osmLayer/probeOsmUpstream/setOsmBasemap 仅服务 btnOsm；功能由「地表OSM」MapLibre
//   场景完全取代，图源设置抽屉里的 osm 源定义保留不动。）



// ====== 点击地球反查地名（Nominatim 逆向地理编码；境外/参考，限频 1 次/秒） ======
let geocodeMode = false;
let _geoPopup = null;
let _lastGeoReq = 0;
function ensureGeoPopup() {
  if (_geoPopup) return _geoPopup;
  const el = document.createElement('div');
  el.id = 'geoPopup';
  el.className = 'geo-popup hidden';
  el.innerHTML = '<button class="geo-close" title="关闭">✕</button><div class="geo-name"></div><div class="geo-meta"></div>';
  document.body.appendChild(el);
  el.querySelector('.geo-close').addEventListener('click', (e) => { e.stopPropagation(); el.classList.add('hidden'); });
  _geoPopup = el;
  return el;
}
function showGeoPopup(screenPos, name, meta) {
  const el = ensureGeoPopup();
  const rect = viewer.scene.canvas.getBoundingClientRect();
  let left = rect.left + screenPos.x + 14;
  let top = rect.top + screenPos.y + 14;
  // 防止超出右/下边界（画布宽高）
  const maxX = rect.left + rect.width - el.offsetWidth - 8;
  const maxY = rect.top + rect.height - el.offsetHeight - 8;
  if (left > maxX) left = rect.left + screenPos.x - el.offsetWidth - 14;
  if (top > maxY) top = rect.top + screenPos.y - el.offsetHeight - 14;
  el.style.left = Math.max(rect.left + 4, left) + 'px';
  el.style.top = Math.max(rect.top + 4, top) + 'px';
  el.querySelector('.geo-name').textContent = name;
  el.querySelector('.geo-meta').textContent = meta ? `📍 ${meta.lat.toFixed(4)}, ${meta.lon.toFixed(4)}` : '';
  el.classList.remove('hidden');
}
async function reverseGeocode(lat, lon, screenPos) {
  const now = Date.now();
  if (now - _lastGeoReq < 1100) {
    showGeoPopup(screenPos, '请求过快（Nominatim 限 1 次/秒），稍后再点', null);
    return;
  }
  _lastGeoReq = now;
  showGeoPopup(screenPos, '查询中…', null);
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}&zoom=10&accept-language=zh-CN&email=sphere-demo@example.com`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Sphere/1.0 (https://github.com/highwindmx/sphere; demo)' } });
    if (!r.ok) { showGeoPopup(screenPos, `查询失败（HTTP ${r.status}）`, null); return; }
    const j = await r.json();
    const name = (j && (j.display_name || j.name)) || '未知地点';
    showGeoPopup(screenPos, name, { lat, lon });
  } catch (e) {
    showGeoPopup(screenPos, '查询失败（网络 / CORS 拦截）', null);
  }
}
const geocodeHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
geocodeHandler.setInputAction((movement) => {
  if (!geocodeMode) return;
  const cart = viewer.camera.pickEllipsoid(movement.position, viewer.scene.globe.ellipsoid);
  if (!cart) { showGeoPopup(movement.position, '此处不是地球表面（请点向地球陆地/海洋）', null); return; }
  const c = Cesium.Cartographic.fromCartesian(cart);
  const lat = Cesium.Math.toDegrees(c.latitude);
  const lon = Cesium.Math.toDegrees(c.longitude);
  reverseGeocode(lat, lon, movement.position);
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);
$('btnGeocode')?.addEventListener('click', () => {
  geocodeMode = !geocodeMode;
  const btn = $('btnGeocode');
  btn && btn.classList.toggle('active', geocodeMode);
  setStatus(geocodeMode ? '地名查询已开启：点地球任意位置反查地名（再点关闭）' : '地名查询已关闭', 'ok');
});

// ====== 侧栏折叠 ======
$('panelToggle')?.addEventListener('click', () => {
  const collapsed = document.body.classList.toggle('panel-collapsed');
  $('panelToggle').textContent = collapsed ? '▶' : '◀';
});

// ====== 坐标定位 ======
// 输入留空的那一维回落用 _lastCursor（最近光标/视点坐标）→「留空 = 定位到光标处」
// 定位成功后：清空两个输入框（让 placeholder 重新显示实时光标经纬度，不被旧值挡住），
// 并把该点记入浏览历史（可折叠列表，倒序，点击可回飞）。
function flyToLonLat() {
  const lonRaw = $('gotoLon')?.value ?? '';
  const latRaw = $('gotoLat')?.value ?? '';
  const lon = lonRaw !== '' ? Number(lonRaw) : _lastCursor.lon;
  const lat = latRaw !== '' ? Number(latRaw) : _lastCursor.lat;
  if (!isFinite(lon) || !isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) {
    setStatus('请输入有效经纬度（经度 -180~180，纬度 -90~90）', 'warn');
    return;
  }
  // 月球/火星模式用各自椭球定位，否则用 WGS84
  const ellipsoid = isMoonMode ? MOON_ELLIPSOID : isMarsMode ? MARS_ELLIPSOID : Cesium.Ellipsoid.WGS84;
  activeViewer().camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, 200000, ellipsoid),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-55), roll: 0 },
    duration: 1.8,
  });
  const atCursor = lonRaw === '' && latRaw === '';
  setStatus(`已飞到 ${lon.toFixed(2)}°, ${lat.toFixed(2)}°${atCursor ? '（光标处）' : ''}`, 'ok');
  if (coordLonEl) coordLonEl.value = '';
  if (coordLatEl) coordLatEl.value = '';
  navHistoryPush(lon, lat);
}

// 天宫轨道：加载 / 移除（检索栏「航天」快捷行用，可反复开关——原分区按钮的唯一替代）
function toggleTiangong() {
  if (isTiangongLoaded()) {
    removeTiangong(viewer);
    viewer.clock.shouldAnimate = false;
    syncTiangongButtons();
    setStatus('天宫空间站已移除', 'ok');
    return;
  }
  loadTiangong(viewer).then((ok) => {
    if (!ok) { setStatus('天宫轨道加载失败', 'warn'); return; }
    viewer.clock.shouldAnimate = true;
    syncTiangongButtons();
    setStatus('天宫空间站轨道已加载（闭环 · 实时位置）', 'ok');
  });
}

// 程序化启用图层。航天两个特殊层（天宫/探月）原本挂在已删除的「航天探索」分区按钮上，
// 没有 #layer-* checkbox，这里直接走它们的特例逻辑；其余图层复用到手点一致的 checkbox 分支。
function enableLayerById(id) {
  if (id === 'tiangong') {
    if (isTiangongLoaded()) {
      setStatus('天宫空间站轨道已在显示中', 'ok');
      syncTiangongButtons();
      return true;
    }
    toggleTiangong();
    return true;
  }
  if (id === 'moonmission') {
    enterRocketMode();
    return true;
  }
  const cb = document.getElementById(`layer-${id}`);
  if (!cb) return false;
  if (!cb.checked) {
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
  }
  return true;
}

// ⭐⭐ OSM 全屏场景（#osmMap z-index 5）整屏盖住球体容器：在它里面点检索结果，
// 相机飞了、球体也切了，用户看到的仍是 MapLibre 那张图 —— 表现就是「点了没反应」
// （2026-10-29 用户实测：进 OSM 后搜「火星」点条目毫无变化）。
// 故任何检索落地 / 切星球动作前，必须先退出 OSM 回到球体。isActive 为假时什么也不做（幂等）。
function exitOsmIfActive() {
  const s = window.__osmScene;
  if (s && typeof s.isActive === 'function' && s.isActive()) {
    try { s.hide(); } catch (e) { /* 忽略：退回球体失败也不该阻断后续动作 */ }
    return true;
  }
  return false;
}

// 检索栏的地名 / 巡礼 / 历史 / 图层 都是地球数据（坐标系 WGS84、历史疆域只属于地球），
// 月球/火星模式下直接飞会飞到错的椭球上。
// 2026-10-29 第四轮：从「只提示不动作」改为**自动切回地球**——检索结果已经统一成「点了就跳到该去的地方」，
// 月面/火星会切球体，地球条目再只弹提示就成了单向门（用户得自己找回 🌍 按钮）。
function requireEarth(what) {
  exitOsmIfActive();          // OSM 场景里先退出来，否则飞了也看不见
  if (!isMoonMode && !isMarsMode) return true;
  if (planetBusy()) {   // 探月任务第三/四幕就在月球容器里演出，切走会销毁场景
    setStatus('探月任务进行中，请先停止任务再切回地球', 'warn');
    return false;
  }
  setStatus(`${what}在地球上，已切回 🌍 地球`, 'ok');
  enterEarthMode();
  return true;
}

// ====== 检索结果 → 「显示图层」列表 ======
// 2026-10-29 用户设计：检索结果点一下 = 往「显示图层」里加一行；**默认互斥**（新项顶掉旧项），
// 每行可手动点亮叠加、可 ✕ 移除。侧栏不再有「标注图层」勾选树与「历史时空」面板。
let shownList = null;

// 按经纬度飞行定位
function flyToCoords(lon, lat, name) {
  if (!requireEarth('地名定位')) return;
  const ellipsoid = isMoonMode ? MOON_ELLIPSOID : isMarsMode ? MARS_ELLIPSOID : Cesium.Ellipsoid.WGS84;
  const H = 600000;                                  // 相机离目标的高度（米）：城市级取 600km
  const pitch = Cesium.Math.toRadians(-40);           // 朝北俯视 40°，比 -45 更平、倾角更舒服
  // ⭐ 让目标居中而非贴在画面底边：相机落在目标正南 H/tan(|pitch|)（水平视距）处、朝北俯视，
  //   视线落点≈目标（旧版 (lon,lat,2000km)+pitch-45 把目标甩到画面底边，视线落点北偏 ~18° 纬度，
  //   看着像"飞错地方 + 大倾角"）。球面曲率约带来 1° 残差，城市级可忽略。
  const mPerDeg = ellipsoid.maximumRadius * Math.PI / 180;
  const offsetDeg = (H / Math.tan(Math.abs(pitch))) / mPerDeg;
  const dest = Cesium.Cartesian3.fromDegrees(lon, lat - offsetDeg, H, ellipsoid);
  activeViewer().camera.flyTo({
    destination: dest,
    orientation: { heading: 0, pitch, roll: 0 },
    duration: 1.8,
  });
  setStatus(`已飞到 ${name ? name + '（' : ''}${lon.toFixed(2)}°, ${lat.toFixed(2)}°${name ? '）' : ''}`, 'ok');
  navHistoryPush(lon, lat);
}

/**
 * 该经纬度当前是否落在球背面（2026-10-29）。
 * 判据与 layer-renderer 的 EllipsoidalOccluder 同源：scaled space（各分量 /椭球半径）下
 * dot(P, C) ≥ 1 才可见；< 1 即被地平线挡住。月/火模式与 OSM 场景内一律返回 false（那两套
 * 视角/坐标系不同，标"背面"没有意义）。
 */
function isBacksideLonLat(lon, lat) {
  if (!isFinite(lon) || !isFinite(lat)) return false;
  if (isMoonMode || isMarsMode) return false;
  try {
    const ell = Cesium.Ellipsoid.WGS84;
    const p = Cesium.Cartesian3.fromDegrees(lon, lat, 0, ell);
    const c = Cesium.Cartesian3.multiplyComponents(viewer.camera.positionWC, ell.oneOverRadii, new Cesium.Cartesian3());
    const q = Cesium.Cartesian3.multiplyComponents(p, ell.oneOverRadii, new Cesium.Cartesian3());
    return Cesium.Cartesian3.dot(q, c) < 1;
  } catch {
    return false;
  }
}

/**
 * 底部「统一巡游面板」(#tourPanel) 是单例，路线巡礼 / 天宫 / 历史时间轴 / 探月 都想写它。
 * 谁要接管就先喊一声，把别人的播放循环停掉——否则会出现「长征还在、时间轴没切到天宫」的串台
 * （用户 2026-10-29 实测反馈的 3 号问题，根因就是 route-tour 的 rAF 没停、还在覆盖同一批 DOM）。
 */
function releasePanels(keep) {
  // ⭐ 2026-10-30：探月任务第三/四幕就在**月球容器**里演出，用的是同一块 #tourPanel。
  //   而 enterMoonMode() 内部必然调 releasePanels(null)（本意是清掉地球侧的巡礼/历史/天宫），
  //   历史巡礼的收尾 __historyStopTour → hideEraPanel() 会顺手把整块面板 hidden 掉、
  //   并清空 #tourTicks → 结果「第三幕一开始时间轴不见了」。
  //   任务播放期间面板归探月，历史只能停表、不能收面板。
  const missionOwnsPanel = !!moonMission && moonMission.isActive();
  if (keep !== 'tour' && isRouteTourActive()) {
    stopRouteTour();
    markOffPrefix('tour:');
  }
  if (keep !== 'history') {
    window.__historyStopTour?.(missionOwnsPanel ? { keepPanel: true } : undefined);
    markOffPrefix('history:');
  }
  if (keep !== 'tiangong' && isTiangongLoaded()) {
    removeTiangong(viewer);
    viewer.clock.shouldAnimate = false;
    syncTiangongButtons();
    markOffPrefix('layer:tiangong');
  }
  // 兜底（2026-10-30）：上面三条收尾路径（stopRouteTour / hideEraPanel / removeTiangong）里
  //   任何一条把共用的 #tourPanel 藏了，只要探月任务还在播就得立刻取回来——第三/四幕没有时间轴
  //   等于没法看进度。（幕节点 ticks 的补画在 rocket.js ensureTourPanelOwned 里做。）
  if (missionOwnsPanel) $('tourPanel')?.classList.remove('hidden');
}

/** 把「显示图层」里以某前缀开头的行统一置灰（外部停了播放，列表不能还亮着） */
function markOffPrefix(prefix) {
  if (!shownList) return;
  for (const k of [...shownList.items.keys()]) {
    if (k.startsWith(prefix)) shownList.markOff(k);
  }
}

// 关闭图层（与 enableLayerById 对称）
function disableLayerById(id) {
  if (id === 'tiangong') {
    if (isTiangongLoaded()) {
      removeTiangong(viewer);
      viewer.clock.shouldAnimate = false;
      syncTiangongButtons();
    }
    return true;
  }
  if (id === 'moonmission') {
    try { exitRocketMode(); } catch { /* 没在任务里就忽略 */ }
    return true;
  }
  const cb = document.getElementById(`layer-${id}`);
  if (!cb) return false;
  if (cb.checked) { cb.checked = false; cb.dispatchEvent(new Event('change')); }
  return true;
}

// 检索栏"图层"结果 → 显示图层列表项
function applyLayerEntry(entry) {
  const id = entry.id;
  const isSpace = (id === 'tiangong' || id === 'moonmission');
  shownList?.add({
    key: `layer:${id}`,
    label: entry.name,
    icon: entry.icon || (isSpace ? '🛰️' : '👁'),
    kind: isSpace ? 'tiangong' : 'layer',
    setOn: () => {
      if (isSpace) releasePanels(id === 'tiangong' ? 'tiangong' : 'mission');
      enableLayerById(id);
    },
    setOff: () => disableLayerById(id),
  });
}

// 检索栏"地点"结果 → 只做定位（不参与互斥：它不产生图层，只是"最近去过哪"）
function applyPlaceEntry(entry) {
  shownList?.add({
    key: `place:${entry.name}`,
    label: entry.name,
    icon: '📍',
    kind: 'place',
    mutex: false,
    setOn: () => flyToCoords(entry.lon, entry.lat, entry.name),
    setOff: () => {},
  });
}

// 检索栏"巡礼"结果 → 启层 + 起路线巡礼 +（若指定节点）瞬移落点（不重放中间路径）
function applyTourEntry(entry) {
  const stationName = entry.station ? (entry.station.name || entry.station.title) : '';
  shownList?.add({
    key: `tour:${entry.layerId}`,
    label: stationName ? `${entry.layerName} · ${stationName}` : entry.layerName,
    icon: '🎬',
    kind: 'tour',
    setOn: () => {
      if (!requireEarth('路线巡礼')) return;
      releasePanels('tour');
      enableLayerById(entry.layerId);
      startRouteTour(viewer, {
        title: entry.ent.name || entry.layerName,
        color: entry.ent.color,
        coords: entry.ent.coords,
        stations: entry.ent.stations,
      });
      if (entry.station) {
        seekRouteTourToStation((s) => s === entry.station
          || (entry.station.name && s.name === entry.station.name)
          || (entry.station.body && s.body === entry.station.body));
      }
    },
    setOff: () => {
      if (isRouteTourActive()) stopRouteTour();
      disableLayerById(entry.layerId);
    },
  });
}

// 检索栏"历史"结果 → 起历史时间轴（底部巡礼面板接管）
function applyHistoryEntry(entry) {
  const isMs = entry.histKind === 'milestone';
  shownList?.add({
    key: `history:${isMs ? entry.dynastyKey : entry.key}${isMs ? ':' + entry.year : ''}`,
    label: isMs ? `${entry.dynastyTitle} · ${entry.year < 0 ? '前' + -entry.year : entry.year} 年` : entry.title,
    icon: '📜',
    kind: 'history',
    setOn: () => { launchHistory(entry); },
    setOff: () => {
      window.__historyStopTour?.();
      const a = historyAtlas || window.historyAtlas;
      if (a && a.isEnabled()) a.setEnabled(false);
    },
  });
}

// ====== 检索栏「月面 / 火星」结果（2026-10-29 用户要求：两个行星的标注也做进搜索）======
// 两个球体各有独立 Cesium.Viewer 与独立标注组（MOON_GROUPS / MARS_GROUPS），不在 LAYERS 里，
// 所以点击流程是「切球体 → 勾上所属分组 → 相机飞到该点」，而不是地球那套 checkbox 派发。
const BODY_CFG = {
  moon: {
    label: '月球',
    ellipsoid: () => MOON_ELLIPSOID,
    viewer: () => getMoonViewer(),
    isOn: () => isMoonMode,
    enter: () => enterMoonMode(),
    toggle: (gid, on) => toggleLunarGroup(gid, on),
  },
  mars: {
    label: '火星',
    ellipsoid: () => MARS_ELLIPSOID,
    viewer: () => getMarsViewer(),
    isOn: () => isMarsMode,
    enter: () => enterMarsMode(),
    toggle: (gid, on) => toggleMarsGroup(gid, on),
  },
};

function bodyCfg(body) {
  return body === 'mars' ? BODY_CFG.mars : BODY_CFG.moon;
}

/** 同步侧栏里那个分组复选框（月球模式下月面标注面板才可见，未建时静默跳过） */
function setBodyGroupChecked(body, groupId, checked) {
  const sel = body === 'mars' ? '#marsGroups' : '#moonGroups';
  const cb = document.querySelector(`${sel} input[data-group="${CSS.escape(groupId)}"]`);
  if (cb) cb.checked = checked;
}

/** 跳到某个行星标注：必要时先切球体 */
function flyToBodyPoint(entry) {
  const cfg = bodyCfg(entry.body);
  exitOsmIfActive();                         // ⭐ OSM 场景整屏盖住球体，不退出来切了也看不见
  releasePanels(null);                       // 底部面板上的地球巡礼/历史/天宫在这里没有意义，先让位
  if (!cfg.isOn()) cfg.enter();
  cfg.toggle(entry.groupId, true);           // 标注组默认不勾选，不勾就飞过去只看得到一片地表
  setBodyGroupChecked(entry.body, entry.groupId, true);
  const v = cfg.viewer();
  if (!v) { setStatus(`${cfg.label}视图尚未就绪，请稍后重试`, 'warn'); return; }
  // 高度取该球体半径的 0.25（月球≈434 km、火星≈849 km），正俯视：
  //   ⚠ 不要用 -60° 斜视 —— 倾斜后视线中心会偏到标注点以北几百公里，标注点直接跑出画面
  //   （2026-10-29 实测：-60° 时静海落在屏幕外，以为"没跳过去"）。
  const R = cfg.ellipsoid().maximumRadius;
  v.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(entry.lon, entry.lat, R * 0.25, cfg.ellipsoid()),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
    duration: 1.6,
  });
  setStatus(`已跳到 ${cfg.label} · ${entry.groupName} · ${entry.name}（${entry.lon.toFixed(1)}°, ${entry.lat.toFixed(1)}°）`, 'ok');
}

function applyBodyEntry(entry) {
  const cfg = bodyCfg(entry.body);
  shownList?.add({
    key: entry.id,
    label: `${entry.name} · ${entry.groupName}`,
    icon: entry.body === 'mars' ? '🔴' : '🌙',
    kind: 'body',
    setOn: () => flyToBodyPoint(entry),
    setOff: () => {
      cfg.toggle(entry.groupId, false);
      setBodyGroupChecked(entry.body, entry.groupId, false);
    },
  });
}

// 历史巡礼启动（含首次加载 2.7MB 中国史包）
async function launchHistory(entry) {
  if (!requireEarth('历史时空')) return;
  const atlas = historyAtlas || window.historyAtlas;
  if (!atlas) { setStatus('历史时空尚未就绪，请稍后重试', 'warn'); return; }
  releasePanels('history');
  try {
    if (!atlas.isEnabled()) await atlas.setEnabled(true);
    if (typeof window.__historyStartEraTour !== 'function') {
      setStatus('历史巡礼未就绪（面板挂载未完成）', 'warn');
      return;
    }
    if (entry.histKind === 'milestone') await window.__historyStartEraTour(entry.dynastyKey, entry.year);
    else await window.__historyStartEraTour(entry.key);
  } catch (e) {
    console.error('[search] 历史巡礼启动失败', e);
    setStatus('历史巡礼启动失败（见控制台）', 'warn');
  }
}

$('btnGoto')?.addEventListener('click', flyToLonLat);
$('gotoLat')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') flyToLonLat(); });
$('gotoLon')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') flyToLonLat(); });

// ====== 局部放大（地物密集区一键拉近：四渡赤水等）======
let _localFocus = null;
const LOCAL_FOCUS_CHIP_ID = 'localFocusChip';

function enterLocalFocus(v, focus) {
  if (!v || !focus) return;
  if (isRouteTourActive()) stopRouteTour(); // 巡礼相机跟随会与新视角打架，先停
  exitLocalFocus(v, false);                 // 清掉上一次的框/按钮（不还原相机）
  const lon = focus.lon, lat = focus.lat;
  const height = focus.height ?? 140000;
  const heading = Cesium.Math.toRadians(focus.heading ?? 0);
  const pitch = Cesium.Math.toRadians(focus.pitch ?? -90);

  // 记录当前视角，供「返回」还原
  _localFocus = {
    viewer: v,
    saved: {
      destination: Cesium.Cartesian3.clone(v.camera.positionWC),
      heading: v.camera.heading,
      pitch: v.camera.pitch,
      roll: v.camera.roll,
    },
    ringEnt: null,
  };

  // 视野框：以 focus 为圆心的实线圆（闭合环不用 PolylineDash，垂直/闭合段会丢线）
  if (focus.ringRadius) {
    const r = focus.ringRadius;
    const dLat = r / 111320;
    const dLon = r / (111320 * Math.cos(Cesium.Math.toRadians(lat)));
    const arr = [];
    for (let i = 0; i <= 128; i++) {
      const a = (i / 128) * Math.PI * 2;
      arr.push(lon + dLon * Math.cos(a), lat + dLat * Math.sin(a));
    }
    _localFocus.ringEnt = v.entities.add({
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray(arr),
        width: 2,
        material: Cesium.Color.fromCssColorString('#ffd24a').withAlpha(0.85),
        arcType: Cesium.ArcType.GEODESIC,
      },
    });
  }

  v.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
    orientation: { heading, pitch, roll: 0 },
    duration: 1.6,
  });

  let chip = document.getElementById(LOCAL_FOCUS_CHIP_ID);
  if (!chip) {
    chip = document.createElement('button');
    chip.id = LOCAL_FOCUS_CHIP_ID;
    chip.className = 'local-focus-chip';
    document.body.appendChild(chip);
  }
  chip.textContent = `↩ 返回全景（${focus.title || '局部放大'}）`;
  chip.onclick = () => exitLocalFocus(v, true);
}

function exitLocalFocus(v, restoreCamera) {
  if (!_localFocus) return;
  const st = _localFocus;
  _localFocus = null;
  if (st.ringEnt && st.viewer) st.viewer.entities.remove(st.ringEnt);
  document.getElementById(LOCAL_FOCUS_CHIP_ID)?.remove();
  if (restoreCamera && st.saved && st.viewer) {
    st.viewer.camera.flyTo({
      destination: st.saved.destination,
      orientation: { heading: st.saved.heading, pitch: st.saved.pitch, roll: st.saved.roll },
      duration: 1.2,
    });
  }
}

// ====== 浏览历史（坐标控件内可折叠列表：倒序 · 点击回飞 · 可清空 · localStorage 持久化）=====
const NAV_HIST_KEY = 'sphere-nav-history';
const NAV_HIST_MAX = 20;

function navHistoryLoad() {
  try { return JSON.parse(localStorage.getItem(NAV_HIST_KEY)) || []; } catch { return []; }
}
function navHistorySave(list) {
  try { localStorage.setItem(NAV_HIST_KEY, JSON.stringify(list)); } catch { /* 隐私模式等 */ }
}
/** 记录一次定位：按 0.01° 去重（同点重复只更新时间并置顶），最新在前，最多 NAV_HIST_MAX 条 */
function navHistoryPush(lon, lat) {
  const k = `${lon.toFixed(2)},${lat.toFixed(2)}`;
  let list = navHistoryLoad().filter((h) => `${h.lon.toFixed(2)},${h.lat.toFixed(2)}` !== k);
  list.unshift({ lon, lat, t: Date.now() });
  if (list.length > NAV_HIST_MAX) list = list.slice(0, NAV_HIST_MAX);
  navHistorySave(list);
  navHistoryRender();
}
function navHistoryClear() {
  navHistorySave([]);
  navHistoryRender();
  setStatus('浏览历史已清空', 'ok');
}
function navHistoryRender() {
  const box = $('navHistList');
  if (!box) return;
  const list = navHistoryLoad();
  const clearBtn = $('navHistClear');
  if (clearBtn) clearBtn.hidden = list.length === 0;
  if (!list.length) {
    box.innerHTML = '<div class="nav-hist-empty">暂无记录 · 定位后自动记入（最多 20 条）</div>';
    return;
  }
  box.innerHTML = '';
  for (const h of list) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'nav-hist-item';
    const d = new Date(h.t);
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    item.innerHTML = `<span class="nh-coord">${h.lon.toFixed(2)}°, ${h.lat.toFixed(2)}°</span><span class="nh-time">${hhmm}</span>`;
    item.title = `飞往 ${h.lon.toFixed(2)}°, ${h.lat.toFixed(2)}°`;
    item.addEventListener('click', () => {
      if (coordLonEl) coordLonEl.value = h.lon.toFixed(4);
      if (coordLatEl) coordLatEl.value = h.lat.toFixed(4);
      flyToLonLat();
    });
    box.appendChild(item);
  }
}
// 折叠开合（按钮文案 ▾/▴ 同步）
$('navHistToggle')?.addEventListener('click', () => {
  const body = $('navHistBody');
  const btn = $('navHistToggle');
  if (!body || !btn) return;
  const open = body.hidden;
  body.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  btn.textContent = open ? '🕘 记录 ▴' : '🕘 记录 ▾';
});
$('navHistClear')?.addEventListener('click', navHistoryClear);
navHistoryRender();

// 回到中国（若处于月球/火星模式，先切回地球）
$('btnHome').addEventListener('click', () => {
  if (isMoonMode || isMarsMode) enterEarthMode();
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(105, 33, 16000000),
    orientation: {
      heading: 0,
      pitch: Cesium.Math.toRadians(-90),
      roll: 0,
    },
    duration: 1.5,
  });
});

// ====== 地球 / 月球 / 火星 模式切换 ======
function buildMoonGroupUI() {
  const wrap = $('moonGroups');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (const g of getMoonGroups()) {
    const label = document.createElement('label');
    label.className = 'check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    // dataset 供检索栏跳转时反查/同步（月面标注没有 #layer-* 那套 id 体系）
    cb.dataset.body = 'moon';
    cb.dataset.group = g.id;
    cb.addEventListener('change', () => toggleLunarGroup(g.id, cb.checked));
    label.appendChild(cb);
    const span = document.createElement('span');
    span.textContent = g.name;
    label.appendChild(span);
    wrap.appendChild(label);
  }
}

function buildMarsGroupUI() {
  const wrap = $('marsGroups');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (const g of getMarsGroups()) {
    const label = document.createElement('label');
    label.className = 'check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.body = 'mars';
    cb.dataset.group = g.id;
    cb.addEventListener('change', () => toggleMarsGroup(g.id, cb.checked));
    label.appendChild(cb);
    const span = document.createElement('span');
    span.textContent = g.name;
    label.appendChild(span);
    wrap.appendChild(label);
  }
}

// 右侧导航列里「按球体出现」的钮（2026-10-30 用户：从侧栏「月面标注 / 火星标注」移出；同轮 🏠 星球归位已删）：
//   月球 = 🛰 高清瓦片；火星 = 🌋 地形晕渲；地球 = 都隐藏（地球归位在坐标栏 🏠）。
// 地球专属的 🌊 海底 / 🗺 OSM / 📍 查地名 由 setSceneControlsMode() 管，两处互不重叠。
function setNavColBodyMode(mode) {
  const show = (id, on) => { const el = $(id); if (el) el.classList.toggle('hidden', !on); };
  show('btnMoonHiRes', mode === 'moon');
  show('btnMarsHillshade', mode === 'mars');
}

function enterMoonMode() {
  exitOsmIfActive();          // ⭐ 从 OSM 场景点 🌙：必须先退 OSM，否则 #osmMap 仍盖在最上层
  $('btnMoonMode').classList.add('active');
  $('btnEarthMode').classList.remove('active');
  $('btnMarsMode').classList.remove('active');
  $('cesiumContainer').classList.add('hidden');
  $('marsContainer').classList.add('hidden');
  $('moonContainer').classList.remove('hidden');
  setNavColBodyMode('moon');                 // 🏠 归位 + 🛰 高清瓦片（火星晕渲收起）
  setHistorySectionVisible(false);          // 历史政区只属于地球
  setSceneControlsMode(false);   // 海底 / OSM / 点图查地名 仅地球（晨夜 / 地形夸张保留）
  releasePanels(null);           // 地球的巡礼 / 历史 / 天宫 在月球上没有意义，先停掉（面板不能继续播）
  attachGlobeOverlay();   // 浮动区（回顶视/提示卡）挪到月球容器
  createMoonViewer('moonContainer', (msg, kind) => setStatus(msg, kind));
  buildMoonGroupUI();
  // 坐标栏切换为月球：标记模式 + 绑定月球相机刷新（仅绑一次）
  isMoonMode = true;
  if (!moonCoordBound) {
    const mv = getMoonViewer();
    if (mv) {
      mv.camera.changed.addEventListener(() => refreshCoordUI());
      moonCoordBound = true;
    }
  }
  refreshCoordUI();
  return getMoonViewer();
}

function enterMarsMode() {
  exitOsmIfActive();          // ⭐ 同上：OSM 场景下切火星必须先退 OSM
  $('btnMarsMode').classList.add('active');
  $('btnEarthMode').classList.remove('active');
  $('btnMoonMode').classList.remove('active');
  $('cesiumContainer').classList.add('hidden');
  $('moonContainer').classList.add('hidden');
  $('marsContainer').classList.remove('hidden');
  setNavColBodyMode('mars');                 // 🏠 归位 + 🌋 地形晕渲（月面瓦片收起）
  setHistorySectionVisible(false);          // 历史政区只属于地球
  setSceneControlsMode(false);   // 海底 / OSM / 点图查地名 仅地球（晨夜 / 地形夸张保留）
  releasePanels(null);           // 同月球：地球的巡礼 / 历史 / 天宫 先停
  attachGlobeOverlay();   // 浮动区（回顶视/提示卡）挪到火星容器
  createMarsViewer('marsContainer', (msg, kind) => setStatus(msg, kind));
  buildMarsGroupUI();
  isMarsMode = true;
  if (!marsCoordBound) {
    const mv = getMarsViewer();
    if (mv) {
      mv.camera.changed.addEventListener(() => refreshCoordUI());
      marsCoordBound = true;
    }
  }
  refreshCoordUI();
  return getMarsViewer();
}

function enterEarthMode() {
  exitOsmIfActive();          // ⭐ 同上（OSM 里点 🌍 / 检索地球条目）
  $('btnMoonMode').classList.remove('active');
  $('btnMarsMode').classList.remove('active');
  $('btnEarthMode').classList.add('active');
  $('cesiumContainer').classList.remove('hidden');
  $('moonContainer').classList.add('hidden');
  $('marsContainer').classList.add('hidden');
  setNavColBodyMode('earth');                // 🏠 / 🛰 / 🌋 全部收起（地球归位在坐标栏）
  setHistorySectionVisible(true);              // 回到地球：历史时空可用
  setSceneControlsMode(true);   // 回到地球：海底 / OSM / 点图查地名 恢复
  attachGlobeOverlay();   // 浮动区（回顶视/提示卡）挪回地球容器
  destroyMoonViewer();
  destroyMarsViewer();
  // 两个行星的 Viewer 已销毁、分组勾选状态也不再保留 → 列表里对应的行星标注行同步置灰
  markOffPrefix('moon:');
  markOffPrefix('mars:');
  isMoonMode = false;
  isMarsMode = false;
  refreshCoordUI();
}

// 探月任务进行中禁止切星球：第三/四幕就在月球容器里演出，切走会销毁其场景
function planetBusy() {
  if (moonMission && moonMission.isActive()) {
    setStatus('探月任务进行中，请先「停止」任务再切换星球', 'warn');
    return true;
  }
  return false;
}

$('btnMoonMode').addEventListener('click', () => {
  if ($('btnMoonMode').classList.contains('active')) enterEarthMode();
  else if (!planetBusy()) enterMoonMode();
});
$('btnMarsMode').addEventListener('click', () => {
  if ($('btnMarsMode').classList.contains('active')) enterEarthMode();
  else if (!planetBusy()) enterMarsMode();
});
$('btnEarthMode').addEventListener('click', () => {
  if ($('btnMoonMode').classList.contains('active') || $('btnMarsMode').classList.contains('active')) {
    if (!planetBusy()) enterEarthMode();
  }
});

// 火星地形晕渲开关（见 mars.js：火星无可用 3D 高程源，用晕渲图层做视觉地形）
// 2026-10-30：侧栏「火星标注」整块移除 → 改成右侧导航列的 🌋 按钮，按当前状态点亮/熄灭
{
  const btn = $('btnMarsHillshade');
  if (btn) {
    const sync = () => btn.classList.toggle('active', !!isMarsHillshade());
    btn.addEventListener('click', () => {
      setMarsHillshade(!isMarsHillshade(), (msg, kind) => setStatus(msg, kind));
      sync();
    });
    sync();
  }
}

// 冒烟/调试钩子：星球 viewer 句柄 + 月面高程采样（tools/smoke/planet-smoke.mjs 用）
window.__getMarsViewer = getMarsViewer;
window.__getMoonViewer = getMoonViewer;
window.__sampleMoonHeight = sampleMoonHeight;
window.__isMoonTerrainReady = isMoonTerrainReady;

// ====== 探月任务控制器（三幕剧）======
let moonMission = null;
function getMission() {
  if (!moonMission) {
    moonMission = createMoonMission({
      earthViewer: viewer,
      env: {
        showMoon: enterMoonMode,
        showEarth: enterEarthMode,
        getMoonViewer,
        onStatus: (msg, kind) => setStatus(msg, kind),
      },
    });
    // 调试/冒烟钩子：window.__moonMission.debugState() 看各 glTF 槽位状态
    window.__moonMission = moonMission;
    // 冒烟钩子：月球 viewer 句柄（任务第三/四幕对月球容器截图用）
    window.__getMoonViewer = getMoonViewer;
  }
  return moonMission;
}

function updateSiteButtons() {
  const m = getMission();
  const pairs = [
    ['siteJiuquan', m.getLaunchSite() === 'jiuquan'],
    ['siteWenchang', m.getLaunchSite() === 'wenchang'],
    ['siteImbrium', m.getLandingSite() === 'imbrium'],
    ['siteTranquillity', m.getLandingSite() === 'tranquillity'],
  ];
  for (const [id, on] of pairs) $(id)?.classList.toggle('active', on);
}

// ====== 天宫轨道按钮同步 ======
// 文案恒定「📡 天宫轨道」，用 .active 金边表示"已加载"（与晨夜/海底/地名等开关一致），
// 不再变成「移除轨道」——那样会把"这是什么"的信息丢掉，只留下一个动作词。
// ⚠ 图层树与「航天探索」面板各有一个按钮（此前两者都写 id=btnTiangong，重复 id 导致
//    getElementById 只能更新第一个），统一用 data-tiangong 标记后批量同步。
function syncTiangongButtons() {
  const on = isTiangongLoaded();
  document.querySelectorAll('[data-tiangong]').forEach((b) => {
    b.textContent = '📡 天宫轨道';
    b.classList.toggle('active', on);
    b.title = on
      ? '天宫空间站轨道已加载：再点一次即移除（也可取消上方勾选）'
      : '加载天宫空间站轨道：400 km 圆轨道示意 · 显示地面时间 / 星下点 / 光照';
  });
}

function enterRocketMode() {
  // 与天宫轨道互斥：进入任务时移除天宫并同步取消其顶层勾选
  if (isTiangongLoaded()) {
    removeTiangong(viewer);
    const tgCb = document.getElementById('layer-tiangong');
    if (tgCb) tgCb.checked = false;
  }
  syncTiangongButtons();
  // 探月任务在地球 Viewer 上演出：若停在月球/火星模式先切回（否则预览火箭画在隐藏容器里）
  if (isMoonMode || isMarsMode) enterEarthMode();
  // 勾选同步：任务面板打开 ⇔ 探月任务顶层勾选
  const mmCb = document.getElementById('layer-moonmission');
  if (mmCb) mmCb.checked = true;
  getMission();
  // 预加载地球侧 3D 模型（GLB 异步）：用户选场地/看点的时候就在加载，点火时已就绪
  moonMission.preload?.();
  // 发射前预览（2026-10-17 用户反馈）：进面板即把火箭竖在当前发射台、镜头转过去
  moonMission.previewLaunchSite?.();
  $('tourPanel')?.classList.remove('hidden');
  $('tourTitle').textContent = '探月任务 · 三幕剧';
  $('flyControls')?.classList.add('hidden');
  $('rocketControls')?.classList.remove('hidden');
  $('rocketPhase')?.classList.add('hidden');
  $('tourPause')?.classList.add('hidden');
  $('timelineNote')?.classList.add('hidden');
  $('actCard')?.classList.add('hidden');
  $('tourBar').style.width = '0%';
  $('tourProgressText').textContent = '0%';
  $('tourTicks').innerHTML = '';
  $('timeSpeedLabel').textContent = '1×';
  const lb = $('btnLaunch');
  lb.classList.remove('hidden');
  lb.disabled = false;
  updateSiteButtons();
  setStatus('选择发射场与落点后点「🚀 点火」开始三幕剧', '');
}

function exitRocketMode() {
  $('tourPanel')?.classList.add('hidden');
  $('btnLaunch')?.classList.add('hidden');
  $('rocketControls')?.classList.add('hidden');
  const mmCb = document.getElementById('layer-moonmission');
  if (mmCb) mmCb.checked = false;
}

// 月面高清瓦片开关（见 lunar.js：本地贴图只有 ≈660 m/像素，高清需在线源）
// 2026-10-30：同上，侧栏复选框 → 右侧导航列 🛰 按钮（默认开启，按钮点亮）
{
  const btn = $('btnMoonHiRes');
  if (btn) {
    const sync = () => btn.classList.toggle('active', !!isLunarHiRes());
    btn.addEventListener('click', () => {
      setLunarHiRes(!isLunarHiRes(), (msg, kind) => setStatus(msg, kind));
      sync();
    });
    sync();
  }
}

$('siteJiuquan')?.addEventListener('click', () => { getMission().setLaunchSite('jiuquan'); updateSiteButtons(); });
$('siteWenchang')?.addEventListener('click', () => { getMission().setLaunchSite('wenchang'); updateSiteButtons(); });
$('siteImbrium')?.addEventListener('click', () => { getMission().setLandingSite('imbrium'); updateSiteButtons(); });
$('siteTranquillity')?.addEventListener('click', () => { getMission().setLandingSite('tranquillity'); updateSiteButtons(); });
$('btnLaunch')?.addEventListener('click', () => {
  const m = getMission();
  m.start({ launchSite: m.getLaunchSite(), landingSite: m.getLandingSite() });
});
// 停止：仅在探月面板空闲（未在动画）且无巡礼时收起面板
$('tourStop')?.addEventListener('click', () => {
  if (isRouteTourActive()) return;
  if (moonMission && moonMission.isActive()) return;
  if (!$('rocketControls')?.classList.contains('hidden')) exitRocketMode();
});

// ====== 导航控件锁定：巡礼/探月播放期间禁用 cesium-navigation（置灰 + 控件失效） ======
function cameraLocked() {
  if (isRouteTourFollowing()) return true;
  // 探月任务（2026-10-17 用户反馈）：仅第二幕地月顶视构图锁定导航控件，
  // 第一幕（地球发射段）与第三/四幕（月球）保留右上角指南针/缩放/重置可用。
  if (moonMission && moonMission.isActive()) {
    return typeof moonMission.navLocked === 'function' ? moonMission.navLocked() : false;
  }
  return false;
}

let _navLocked = null;
// 改用 postRender 监听替代 perpetual requestAnimationFrame：仅在发生实际渲染时检查，
// 避免空闲时仍每帧自旋（与 requestRenderMode 空闲省电目标一致）。
viewer.scene.postRender.addEventListener(() => {
  const locked = cameraLocked();
  if (locked !== _navLocked) {
    _navLocked = locked;
    earthNav.setNavigationLocked(locked);
    // 地球 + 月球两个容器都要置灰（月球 viewer 也有自己的导航控件）
    for (const c of document.querySelectorAll('.cesium-widget-cesiumNavigationContainer')) {
      c.classList.toggle('nav-locked', locked);
    }
    if (locked) setStatus('相机正被巡礼/任务跟随占用，导航控件暂不可用', 'warn');
  }
});

// ====== 图层树构建 ======
const groupStateMap = new Map(); // layerId → Map<groupId, boolean>  分组 checkbox 状态

// ====== 巡礼线路选择菜单（一个子组含多条折线时弹出） ======
let _tourMenuEl = null;

function closeTourMenu() {
  if (_tourMenuEl && _tourMenuEl.parentNode) {
    _tourMenuEl.parentNode.removeChild(_tourMenuEl);
  }
  _tourMenuEl = null;
}

function openTourMenu(anchor, items, onPick) {
  closeTourMenu();
  const menu = document.createElement('div');
  menu.className = 'tour-menu';
  for (const it of items) {
    const b = document.createElement('button');
    b.className = 'tour-menu-item';
    b.textContent = it.name;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTourMenu();
      onPick(it);
    });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  let left = r.right - mw;
  if (left < 8) left = 8;
  menu.style.left = `${left}px`;
  const h = menu.offsetHeight;
  let top = r.bottom + 4;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
  menu.style.top = `${top}px`;
  _tourMenuEl = menu;
}

document.addEventListener('pointerdown', (e) => {
  if (_tourMenuEl && !e.target.closest('.tour-menu')) closeTourMenu();
}, true);

function buildLayerTree() {
  layersTreeEl.innerHTML = '';
  const categories = resolveCategories();

  for (const cat of categories) {
    // 航天类（天宫 / 探月）不进勾选树：入口已移到检索栏的「航天」快捷行（2026-10-29 删除航天探索分区）
    if (cat.id === 'space') continue;

    const catEl = document.createElement('details');
    catEl.className = 'layer-category';
    // 默认折叠，记住用户上次展开状态（localStorage），缓解长列表臃肿
    let openState = false;
    try { openState = localStorage.getItem('catOpen_' + cat.id) === '1'; } catch { /* 忽略 */ }
    catEl.open = openState;
    catEl.addEventListener('toggle', () => {
      try { localStorage.setItem('catOpen_' + cat.id, catEl.open ? '1' : '0'); } catch { /* 忽略 */ }
    });

    const summary = document.createElement('summary');
    const catCount = cat.layers.length;
    summary.innerHTML = `<span>${cat.name}</span><span class="cat-count">${catCount}</span>`;
    catEl.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'layer-category-body';

    for (const layer of cat.layers) {
      const layerEl = document.createElement('div');
      layerEl.className = 'layer-item';
      layerEl.dataset.layerId = layer.id;
      // 供统一检索栏过滤图层树（旧 #layerSearch 从未给 dataset.search 赋值，等于失效；这里补上）
      layerEl.dataset.search = (
        layer.name + ' ' + layer.id + ' ' + (layer.description || '')
        + (layer.id === 'tiangong' ? ' 天宫 轨道 空间站' : '')
        + (layer.id === 'moonmission' ? ' 探月 月球 火箭' : '')
      ).toLowerCase();

      // 分组状态初始化
      const layerGroupState = new Map();
      for (const g of layer.groups) {
        layerGroupState.set(g.id, false);
      }
      groupStateMap.set(layer.id, layerGroupState);

      // 图层标题行
      const head = document.createElement('div');
      head.className = 'layer-item-head';

      const topCb = document.createElement('input');
      topCb.type = 'checkbox';
      topCb.id = `layer-${layer.id}`;
      topCb.addEventListener('change', () => {
        const checked = topCb.checked;
        // 天宫空间站为动态图层（groups 为空，实体由 tiangong.js 运行时创建）
        if (layer.id === 'tiangong') {
          if (checked) {
            if (isTiangongLoaded()) return;
            loadTiangong(viewer).then((ok) => {
              if (!ok) {
                topCb.checked = false;
                setStatus('天宫轨道加载失败', 'warn');
          } else {
            syncTiangongButtons();
            setStatus('天宫空间站轨道已加载（闭环 · 实时位置）', 'ok');
            // 开启时钟动画以驱动轨道运行（空闲时关闭以省电，见下方移除分支）
            viewer.clock.shouldAnimate = true;
          }
        });
      } else {
        if (!isTiangongLoaded()) return;
        removeTiangong(viewer);
        // 关闭时钟动画，恢复空闲省电（当前仅天宫依赖时钟动画）
        viewer.clock.shouldAnimate = false;
        syncTiangongButtons();
        setStatus('天宫空间站已移除', 'ok');
      }
          return;
        }
        // 探月任务：顶层勾选 = 任务模式开关（发射场标注由 pads 子组单独控制）
        if (layer.id === 'moonmission') {
          if (checked) {
            enterRocketMode();
          } else {
            if (moonMission && moonMission.isActive()) moonMission.stop();
            exitRocketMode();
          }
          return;
        }
        for (const g of layer.groups) {
          const subCb = document.getElementById(`layer-${layer.id}-g-${g.id}`);
          if (subCb) subCb.checked = checked;
          layerGroupState.set(g.id, checked);
          renderer.setGroupVisible(layer.id, g.id, checked);
        }
        updateTopCbState(layer);
      });
      head.appendChild(topCb);

      const icon = document.createElement('span');
      icon.className = 'layer-icon';
      icon.textContent = layer.icon ?? '◆';
      head.appendChild(icon);

      const nameEl = document.createElement('span');
      nameEl.className = 'layer-name';
      nameEl.textContent = layer.name;
      nameEl.title = layer.description ?? '';
      head.appendChild(nameEl);

      // 特殊按钮
      if (layer.id === 'tiangong') {
        const btn = document.createElement('button');
        btn.className = 'layer-space-btn';
        btn.id = 'btnTiangong';
        btn.dataset.tiangong = '1';
        btn.textContent = '📡 天宫轨道';
        btn.addEventListener('click', () => {
          const cbx = document.getElementById(`layer-${layer.id}`);
          if (cbx) {
            cbx.checked = !isTiangongLoaded();
            cbx.dispatchEvent(new Event('change'));
          }
        });
        head.appendChild(btn);
        syncTiangongButtons();
      }
      if (layer.id === 'moonmission') {
        const btn = document.createElement('button');
        btn.className = 'layer-space-btn';
        btn.id = 'btnMoonMission';
        btn.textContent = '🚀 探月任务';
        btn.addEventListener('click', () => {
          enterRocketMode();
        });
        head.appendChild(btn);
      }

      layerEl.appendChild(head);

      // 子分组
      if (layer.groups.length) {
        const subgroups = document.createElement('div');
        subgroups.className = 'layer-subgroups';
        for (const g of layer.groups) {
          const row = document.createElement('div');
          row.className = 'layer-subgroup';

          const swatch = document.createElement('span');
          swatch.className = 'swatch';
          swatch.style.background = g.color ?? layer.defaultColor;
          row.appendChild(swatch);

          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.id = `layer-${layer.id}-g-${g.id}`;
          cb.dataset.groupId = g.id;
          cb.addEventListener('change', () => {
            const checked = cb.checked;
            layerGroupState.set(g.id, checked);
            renderer.setGroupVisible(layer.id, g.id, checked);
            updateTopCbState(layer);
          });
          row.appendChild(cb);

          const gName = document.createElement('span');
          gName.textContent = g.name;
          row.appendChild(gName);

          // 路线巡礼按钮：组内含折线即显示（单折线直接巡，多条则弹出选择菜单）
          const polys = g.entities.filter(
            (e) => e.type === 'polyline' && Array.isArray(e.coords) && e.coords.length >= 2
          );
          if (polys.length) {
            const tourBtn = document.createElement('button');
            tourBtn.className = 'layer-space-btn tour-btn';
            tourBtn.textContent = '▶';
            tourBtn.title =
              polys.length === 1
                ? `路线巡礼：${polys[0].name || g.name}`
                : `路线巡礼（${polys.length} 条线路，点击选择）`;
            tourBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              // 勾选该组确保路线可见
              if (!cb.checked) {
                cb.checked = true;
                layerGroupState.set(g.id, true);
                renderer.setGroupVisible(layer.id, g.id, true);
                updateTopCbState(layer);
              }
              const start = (ent) =>
                startRouteTour(viewer, {
                  title: ent.name || g.name,
                  color: g.color ?? layer.defaultColor,
                  coords: ent.coords,
                  stations: ent.stations ?? null,
                });
              if (polys.length === 1) {
                start(polys[0]);
              } else {
                openTourMenu(tourBtn, polys.map((p) => ({ name: p.name || g.name, ent: p })), (it) =>
                  start(it.ent)
                );
              }
            });
            row.appendChild(tourBtn);
          }

          // 局部放大：组内声明 focus 时显示（四渡赤水等地物密集区）
          if (g.focus) {
            const focusBtn = document.createElement('button');
            focusBtn.className = 'layer-space-btn layer-focus-btn';
            focusBtn.textContent = '🔍';
            focusBtn.title = `局部放大：${g.focus.title || g.name}`;
            focusBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              if (!cb.checked) {
                cb.checked = true;
                layerGroupState.set(g.id, true);
                renderer.setGroupVisible(layer.id, g.id, true);
                updateTopCbState(layer);
              }
              enterLocalFocus(viewer, g.focus);
            });
            row.appendChild(focusBtn);
          }

          subgroups.appendChild(row);
        }
        layerEl.appendChild(subgroups);
      }

      body.appendChild(layerEl);
    }

    catEl.appendChild(body);
    layersTreeEl.appendChild(catEl);
  }
}

function updateTopCbState(layer) {
  const cb = document.getElementById(`layer-${layer.id}`);
  if (!cb) return;
  const states = Array.from(groupStateMap.get(layer.id).values());
  const allOn = states.every(Boolean);
  const someOn = states.some(Boolean);
  cb.checked = allOn;
  cb.indeterminate = someOn && !allOn;
}

// ====== 代码版本号（显式化，终结「改了没生效」类扯皮） ======
// app.py 把 src/** 最大 mtime 作为 __BUILD__ 注入 <script src="...?v=__BUILD__">。
// 这里从 import.meta.url 回读该值显示在右上角；反馈问题时报这个编号，与我在服务端
// 核对的当前 build 一比即可立刻判定是不是旧缓存，不用反复猜有没有硬刷新。
const BUILD_ID = (() => {
  try { return new URL(import.meta.url).searchParams.get('v') || '?'; } catch { return '?'; }
})();

function collectDiagnostics() {
  const diag = {
    build: BUILD_ID,
    mainUrl: import.meta.url,
    href: location.href,
    ua: navigator.userAgent,
    dpr: window.devicePixelRatio || 1,
    webgl2: (() => { try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; } })(),
    at: new Date().toISOString(),
  };
  try { if (window.__polarDebug) diag.polar = window.__polarDebug(); } catch { /* 忽略 */ }
  try {
    const mgr = window.__imagerySourceMgr;
    if (mgr) diag.imagery = { current: mgr.currentId, online: !!mgr.onlineLayer, overlay: !!mgr.overlayLayer };
  } catch { /* 忽略 */ }
  return diag;
}
window.__sphereBuild = collectDiagnostics;

function initBuildTag() {
  const tag = $('buildTag');
  if (tag) {
    tag.textContent = `build ${BUILD_ID}`;
    tag.title = `main.js?v=${BUILD_ID} · 与我报的服务端当前版本号不一致 = 你的浏览器还是旧缓存，请 Ctrl+F5`;
  }
  const btn = $('btnCopyDiag');
  if (btn) {
    btn.addEventListener('click', async () => {
      const text = JSON.stringify(collectDiagnostics(), null, 2);
      try {
        await navigator.clipboard.writeText(text);
        setStatus('诊断信息已复制到剪贴板，直接粘贴发我', 'ok');
      } catch {
        window.prompt('剪贴板不可用，请手动复制以下诊断信息发我：', text); // 旧浏览器/非安全上下文退化
      }
    });
  }
}

// ====== 历史时空：世界历史国界 + 中国历代疆域 ======
// 数据资产在 public/data/history/（由 tools/history/ 下两个脚本从上游仓库构建）。
// 面板默认关闭，首次勾选「启用历史时空」才加载 2.7 MB 的中国史包 + 按年分片的世界国界。
let historyAtlas = null;

function initHistoryAtlas() {
  const root = $('historyPanel');
  if (!root) return;
  try {
    historyAtlas = createHistoryAtlas(viewer, {
      onStatus: () => {},
      onPick: () => {},
    });
    mountHistoryPanel(historyAtlas, root).catch((e) => {
      console.error('[history-atlas] 面板挂载失败', e);
      root.innerHTML = '<p class="hint">历史时空初始化失败（见控制台）。</p>';
    });
  } catch (e) {
    console.error('[history-atlas] 初始化失败', e);
  }
}

/** 切到月球/火星时收起历史时空（政区数据只属于地球） */
function setHistorySectionVisible(on) {
  const sec = $('historySection');
  if (!sec) return;
  sec.classList.toggle('hidden', !on);
  if (!on && historyAtlas && historyAtlas.isEnabled()) {
    window.__historyStopTour?.();
    historyAtlas.setEnabled(false);
    const cb = $('histEnable');
    if (cb) cb.checked = false;
  }
}

buildLayerTree();
initOffscreenIndicator();
initBackfaceToggles();
initOsmScene();
initBuildTag();
initHistoryAtlas();

// ====== 统一检索栏（取代「标注图层」勾选树 / 「历史时空」面板 / 「航天探索」分区）======
// ⚠ 必须包 try/catch：索引构建期间任何一处抛错都发生在模块顶层，会连带整个 app 起不来
//   （2026-10-29 曾因 kw.push 写错导致 viewer 建好但侧栏全空、检索栏不挂载）。
try {
  const searchRegistry = createSearchRegistry();
  shownList = createShownLayers({ host: $('shownLayers') });
  window.__shownList = shownList; // 调试/外部停止时同步列表状态用
  initSearchBar({
    registry: searchRegistry,
    ctx: {
      // ⭐ 每个回调先 exitOsmIfActive()：OSM 全屏场景盖住球体，不退出来点了就像"没反应"
      // （2026-10-29 用户实测：进 OSM 搜火星条目 → 毫无变化）。requireEarth / flyToBodyPoint
      // 里也各写了一次（它们还有别的调用入口，如 🎯 定位、🏠 回国、🌙🌍 按钮）。
      onLayer: (entry) => { exitOsmIfActive(); applyLayerEntry(entry); },
      onPlace: (entry) => { exitOsmIfActive(); applyPlaceEntry(entry); },
      onTour: (entry) => { exitOsmIfActive(); applyTourEntry(entry); },
      onHistory: (entry) => { exitOsmIfActive(); applyHistoryEntry(entry); },
      onBody: (entry) => { exitOsmIfActive(); applyBodyEntry(entry); },
      // 2026-10-29：地点结果若当前在球背面，下拉里标「🌗 背面」——背面标注在球体上是隐藏的，
      // 不给提示的话用户点了会以为"没跳过去"。判据与渲染器的 EllipsoidalOccluder 同源（scaled space
      // 下 dot(p,c) ≥ 1 可见），这里只需 lon/lat 就能算，不必等非得有实体。
      isBackside: (entry) => isBacksideLonLat(entry.lon, entry.lat),
    },
  });
} catch (e) {
  console.error('[search] 统一检索栏初始化失败', e);
  const bar = $('searchBar');
  if (bar) bar.innerHTML = '<p class="hint">检索栏初始化失败（见控制台）</p>';
}

// 用户在底部面板点「停止」时，把「显示图层」里对应的行同步置灰（列表不能骗人）
window.addEventListener('route-tour-stopped', () => markOffPrefix('tour:'));
window.addEventListener('history-tour-stopped', () => markOffPrefix('history:'));

// ====== 左栏优化：区块可折叠（A）+ 说明「?」气泡（C）======
function initPanelSections() {
  const KEY = 'sphere-collapsed-sections';
  let raw = null;
  try { raw = localStorage.getItem(KEY); } catch { /* 忽略 */ }
  const collapsed = new Set(raw ? JSON.parse(raw) : []);
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify([...collapsed])); } catch { /* 忽略 */ } };
  // 首访默认收起「历史时空」，减少拥挤（用户之后展开会记住）
  const hist = document.getElementById('historySection');
  if (raw === null && hist) hist.classList.add('collapsed');
  document.querySelectorAll('section.panel-section > h2').forEach((h2) => {
    const sec = h2.parentElement;
    if (collapsed.has(sec.id)) sec.classList.add('collapsed');
    h2.addEventListener('click', () => {
      const on = sec.classList.toggle('collapsed');
      if (sec.id) { if (on) collapsed.add(sec.id); else collapsed.delete(sec.id); save(); }
    });
  });
}

function initHints() {
  document.querySelectorAll('.hint-q').forEach((btn) => {
    const id = btn.getAttribute('aria-controls');
    const pop = id && document.getElementById(id);
    if (!pop) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = pop.hasAttribute('hidden');
      if (open) { pop.removeAttribute('hidden'); btn.setAttribute('aria-expanded', 'true'); }
      else { pop.setAttribute('hidden', ''); btn.setAttribute('aria-expanded', 'false'); }
    });
  });
  document.addEventListener('click', (e) => {
    document.querySelectorAll('.hint-pop:not([hidden])').forEach((pop) => {
      const btn = pop.parentElement.querySelector('.hint-q');
      if (btn && !btn.contains(e.target) && !pop.contains(e.target)) {
        pop.setAttribute('hidden', '');
        if (btn) btn.setAttribute('aria-expanded', 'false');
      }
    });
  });
}

initPanelSections();
initHints();

// ====== 图层全选/全清 ======
$('layerSelectAll').addEventListener('click', () => {
  for (const [layerId, groupMap] of groupStateMap) {
    for (const [groupId] of groupMap) {
      groupMap.set(groupId, true);
      renderer.setGroupVisible(layerId, groupId, true);
      const cb = document.getElementById(`layer-${layerId}-g-${groupId}`);
      if (cb) cb.checked = true;
    }
    const topCb = document.getElementById(`layer-${layerId}`);
    if (topCb) topCb.checked = true;
  }
});

$('layerClearAll').addEventListener('click', () => {
  for (const [layerId, groupMap] of groupStateMap) {
    for (const [groupId] of groupMap) {
      groupMap.set(groupId, false);
      renderer.setGroupVisible(layerId, groupId, false);
      const cb = document.getElementById(`layer-${layerId}-g-${groupId}`);
      if (cb) cb.checked = false;
    }
    const topCb = document.getElementById(`layer-${layerId}`);
    if (topCb) topCb.checked = false;
  }
});

// ====== 图层搜索（已移交统一检索栏 search-bar.js 处理；此处仅保留图层树过滤兼容）======
// 注：旧 #layerSearch 输入框已删除，统一检索栏会同时驱动图层树过滤（见 search-bar.js filterTree）。

// ====== 屏幕点击 → 图层 entity ======
const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
handler.setInputAction((movement) => {
  renderer.handleScreenClick(movement.position);
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

// ====== 坐标栏 ======
// 注意：不要在 camera.changed 里调 globe.pick() —— 初始渲染前 canvas 尺寸可能为 0，
// getPickRay(0, height/2) → getPickRayPerspective → add() 报 undefined 类型 → 整个 render 停摆
let lastPickTime = 0;
const _carto = new Cesium.Cartographic();
// 视点坐标随相机变化刷新（地球/月球通用，见 refreshCoordUI）
viewer.camera.changed.addEventListener(() => {
  const now = Date.now();
  if (now - lastPickTime < 200) return;
  lastPickTime = now;
  refreshCoordUI();
});

// ====== 初始状态 ======
refreshCoordUI();
setStatus('地球场景就绪。勾选左侧图层开始探索。', 'ok');
