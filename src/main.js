// src/main.js — 应用入口
// 从 dist index--AIpTfEu.js 提取核心逻辑

import * as Cesium from 'cesium';
// 调试导出：控制台可直接 new provider / 读枚举（CDP 自动化验证也依赖它）
window.Cesium = Cesium;
import CesiumNavigation from 'cesium-navigation-es6';

import { createLocalTerrainProvider } from './terrarium-provider.js';
import { LAYERS, LAYER_MAP, LAYER_CATEGORIES, resolveCategories } from './layers/index.js';
import { createLayerRenderer } from './layer-renderer.js';
import { loadTiangong, isTiangongLoaded, removeTiangong } from './tiangong.js';
import { startRouteTour, isRouteTourFollowing, isRouteTourActive } from './route-tour.js';
import {
  ImagerySourceManager,
  getSourceDef,
  getOnlineSourceId,
  setOnlineSourceId,
} from './imagery-sources.js';
import { resolvePolarProfile, getSeason, profileStatusText } from './polar-profiles.js';
import { initSourcePanel } from './source-settings.js';
import { createMoonMission } from './rocket.js';
import {
  createMoonViewer,
  destroyMoonViewer,
  toggleLunarGroup,
  getMoonViewer,
  getMoonGroups,
  sampleMoonHeight,
  setLunarHiRes,
  isLunarHiRes,
  MOON_ELLIPSOID,
} from './lunar.js';

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
const layerSearchEl = $('layerSearch');
const layersTreeEl = $('layersTree');

// ====== 活动视图（地球/月球）与统一坐标控件 ======
// 地球 viewer / globe 在下方初始化；本块只声明状态与函数，运行期才访问它们。
let isMoonMode = false;
let moonCoordBound = false;
let hoveringGlobe = false;
// 左上统一坐标控件：实时经纬度写输入框 placeholder（不打扰用户已输入的值），海拔只读回显
const coordLonEl = $('gotoLon'), coordLatEl = $('gotoLat'), coordAltEl = $('coordAlt');
const _lastCursor = { lon: null, lat: null };   // 最近一次坐标（「留空 = 定位到光标处」用）

// 海拔回显（只读文本）：terrarium 含海底负深（0°,0° 实测 -4,941 m 即大西洋真实水深）。
// 负值**保留符号**（🌊 -4,118 m），只用图标区分水上/水下，不抹掉负号。
function showAlt(v) {
  if (!coordAltEl) return;
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
  _lastCursor.lon = lon; _lastCursor.lat = lat;
  if (coordLonEl) coordLonEl.placeholder = `经度 ${lon.toFixed(2)}°`;
  if (coordLatEl) coordLatEl.placeholder = `纬度 ${lat.toFixed(2)}°`;
  showAlt(ground);
}
const _carto2 = new Cesium.Cartographic();   // 采样海拔用的临时 Cartographic

// 当前应读取的 Viewer：月球模式返回月球 viewer，否则地球 viewer
function activeViewer() {
  return isMoonMode ? getMoonViewer() : viewer;
}

// 刷新「视点」坐标（相机正下方地面海拔）到左上控件；悬停光标时由光标读数接管。
// 地球用 globe.getHeight（含垂直夸张还原），月球用 sampleMoonHeight。
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
    } else {
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
  } else {
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

function setStatus(msg, kind = '') {
  statusEl.textContent = msg || '';
  statusEl.className = kind ? kind : '';
}

// ====== 场景初始化 ======
const viewer = new Cesium.Viewer('cesiumContainer', {
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
window.viewer = viewer;
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

const globe = viewer.scene.globe;
globe.depthTestAgainstTerrain = true;
globe.terrainExaggeration = 1.2;
globe.tileCacheSize = 300;
if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = true;
globe.baseColor = Cesium.Color.fromCssColorString('#26527c');
// 降低地形网格几何精度 → 加载更少瓦片、首屏更快（科普场景够用，略粗）
globe.maximumScreenSpaceError = 4;

// 本地 Terrarium 高程地形（离线瓦片 tiles/terrain/…；缺失瓦片由内置 provider 自动回退父级）
// 下载范围（与 tools/download_terrain_tiles.py 对齐）：z0-z5 全球 + z6-z9 中国 bbox + z10-z12 山脉兴趣点。
// callback 内置区域判断：z0-z5 全球、z6-z9 中国、z10-z12 仅山脉矩形，其余回落父级。
// ⚠ 极冠黑洞根因（2026-10-16）：globe 的瓦片几何 tilingScheme 只读 terrainProvider.tilingScheme，
// 本 provider 曾直接声明 WebMercatorTilingScheme → 地球 quadtree 在 ±85.05° 外没有任何几何，
// 极冠区域永远是黑洞。现改为「对外 GeographicTilingScheme + 内部墨卡托瓦片重采样」，
// 详见 terrarium-provider.js 文件头。
// 运行 python tools/download_terrain_tiles.py 后才有明显地形。
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

// 地形夸张滑块
$('exag').addEventListener('input', (e) => {
  const v = parseFloat(e.target.value);
  globe.terrainExaggeration = v;
  exagValEl.textContent = `${v.toFixed(1)}×`;
  // 极冠为底层影像层（非实体），自动跟随地形夸张，无需任何同步处理。
});

// 晨夜光影（极冠为底层影像层，自动跟随全局光照，无需任何额外处理）
$('lighting').addEventListener('click', () => {
  const on = !$('lighting').classList.contains('active');
  $('lighting').classList.toggle('active', on);
  globe.enableLighting = on;
  viewer.scene.requestRender();
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
  // 月球模式用月球椭球定位，否则用 WGS84
  const ellipsoid = isMoonMode ? MOON_ELLIPSOID : Cesium.Ellipsoid.WGS84;
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
$('btnGoto')?.addEventListener('click', flyToLonLat);
$('gotoLat')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') flyToLonLat(); });
$('gotoLon')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') flyToLonLat(); });

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

// 回到中国（若处于月球模式，先切回地球）
$('btnHome').addEventListener('click', () => {
  if (isMoonMode) enterEarthMode();
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

// ====== 地球 / 月球 模式切换 ======
function buildMoonGroupUI() {
  const wrap = $('moonGroups');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (const g of getMoonGroups()) {
    const label = document.createElement('label');
    label.className = 'check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.addEventListener('change', () => toggleLunarGroup(g.id, cb.checked));
    label.appendChild(cb);
    const span = document.createElement('span');
    span.textContent = g.name;
    label.appendChild(span);
    wrap.appendChild(label);
  }
}

function enterMoonMode() {
  $('btnMoonMode').classList.add('active');
  $('btnEarthMode').classList.remove('active');
  $('cesiumContainer').classList.add('hidden');
  $('moonContainer').classList.remove('hidden');
  $('moonSection').classList.remove('hidden');
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

function enterEarthMode() {
  $('btnMoonMode').classList.remove('active');
  $('btnEarthMode').classList.add('active');
  $('cesiumContainer').classList.remove('hidden');
  $('moonContainer').classList.add('hidden');
  $('moonSection').classList.add('hidden');
  destroyMoonViewer();
  isMoonMode = false;
  refreshCoordUI();
}

$('btnMoonMode').addEventListener('click', () => {
  if ($('btnMoonMode').classList.contains('active')) enterEarthMode();
  else enterMoonMode();
});
$('btnEarthMode').addEventListener('click', () => {
  if ($('btnMoonMode').classList.contains('active')) enterEarthMode();
});

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

function enterRocketMode() {
  // 与天宫轨道互斥：进入任务时移除天宫并同步取消其顶层勾选
  if (isTiangongLoaded()) {
    removeTiangong(viewer);
    const tgCb = document.getElementById('layer-tiangong');
    if (tgCb) tgCb.checked = false;
    const tgBtn = document.getElementById('btnTiangong');
    if (tgBtn) tgBtn.textContent = '📡 天宫轨道';
  }
  // 勾选同步：任务面板打开 ⇔ 探月任务顶层勾选
  const mmCb = document.getElementById('layer-moonmission');
  if (mmCb) mmCb.checked = true;
  getMission();
  // 预加载地球侧 3D 模型（GLB 异步）：用户选场地/看点的时候就在加载，点火时已就绪
  moonMission.preload?.();
  $('tourPanel')?.classList.remove('hidden');
  $('tourTitle').textContent = '探月任务 · 三幕剧';
  $('flyControls')?.classList.add('hidden');
  $('rocketControls')?.classList.remove('hidden');
  $('rocketPhase')?.classList.add('hidden');
  $('tourPause')?.classList.add('hidden');
  $('compressNote')?.classList.add('hidden');
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
{
  const cb = $('moonHiRes');
  if (cb) {
    cb.checked = isLunarHiRes();
    cb.addEventListener('change', () => {
      setLunarHiRes(cb.checked, (msg, kind) => setStatus(msg, kind));
    });
  }
}

// 月球一键归位：停止跟随，飞回默认正面俯瞰视角（对应地球「回到中国」）
$('btnMoonHome')?.addEventListener('click', () => {
  const mv = getMoonViewer();
  if (!mv) return;
  if (moonMission && moonMission.isActive()) {
    setStatus('探月任务进行中，请先「停止」任务再归位', 'warn');
    return;
  }
  try { mv.camera.lookAtTransform(Cesium.Matrix4.IDENTITY); } catch { /* 忽略 */ }
  const r = MOON_ELLIPSOID.radii.x;
  mv.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(0, 10, r * 3.2, MOON_ELLIPSOID),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
    duration: 1.5,
  });
  setStatus('已回到月球正面俯瞰视角', 'ok');
});

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

// ====== 图层悬停只显示当前（hover 预览，替代原「只显示当前」按钮） ======
// 默认关闭：必须由用户在「标注图层」面板显式勾选「悬停预览图层」才生效，
// 开关状态持久化到 localStorage。
let layerHoverActive = false;
let layerHoverTimer = 0;
const HOVER_PREVIEW_KEY = 'sphere-layer-hover-preview';
function getHoverPreviewEnabled() {
  try { return localStorage.getItem(HOVER_PREVIEW_KEY) === '1'; } catch { return false; }
}
function initHoverPreviewToggle() {
  const cb = $('layerHoverPreview');
  if (!cb) return;
  cb.checked = getHoverPreviewEnabled();
  cb.addEventListener('change', () => {
    try { localStorage.setItem(HOVER_PREVIEW_KEY, cb.checked ? '1' : '0'); } catch { /* 忽略 */ }
    if (!cb.checked) cancelLayerHover(true); // 关掉时立刻恢复，避免卡在"只显示一层"
    setStatus(cb.checked ? '悬停预览已开启：鼠标停在图层行 0.35 秒即临时只显示该图层' : '悬停预览已关闭', 'ok');
  });
}

// 按 groupStateMap 恢复全部图层可见性与复选框
function restoreLayerVisibility() {
  for (const [layerId, gmap] of groupStateMap) {
    for (const [gid, on] of gmap) {
      renderer.setGroupVisible(layerId, gid, on);
      const c = document.getElementById(`layer-${layerId}-g-${gid}`);
      if (c) c.checked = on;
    }
    const layer = LAYERS.find((l) => l.id === layerId);
    if (layer) updateTopCbState(layer);
  }
}

// 进入预览：全部隐藏，仅显示悬停图层
function enterLayerHover(layer) {
  if (layerHoverActive) return;
  layerHoverActive = true;
  for (const [layerId, gmap] of groupStateMap) {
    for (const [gid] of gmap) {
      renderer.setGroupVisible(layerId, gid, false);
      const c = document.getElementById(`layer-${layerId}-g-${gid}`);
      if (c) c.checked = false;
    }
  }
  const gmap = groupStateMap.get(layer.id);
  if (gmap) {
    for (const [gid] of gmap) {
      renderer.setGroupVisible(layer.id, gid, true);
      const c = document.getElementById(`layer-${layer.id}-g-${gid}`);
      if (c) c.checked = true;
    }
  }
  setStatus(`仅显示「${layer.name}」，移开鼠标恢复`, 'ok');
}

function cancelLayerHover(restore) {
  clearTimeout(layerHoverTimer);
  if (!layerHoverActive) return;
  layerHoverActive = false;
  if (restore) {
    restoreLayerVisibility();
    setStatus('');
  }
}

function buildLayerTree() {
  layersTreeEl.innerHTML = '';
  const categories = resolveCategories();

  for (const cat of categories) {
    // 航天探索作为「工具」单独渲染为按钮（见 buildToolsPanel），不进勾选树
    if (cat.id === 'space') { buildToolsPanel(cat); continue; }

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
        cancelLayerHover(true); // 悬停预览期间手动操作则先恢复全量状态
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
            const b = document.getElementById('btnTiangong');
            if (b) b.textContent = '📡 移除轨道';
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
        const b = document.getElementById('btnTiangong');
        if (b) b.textContent = '📡 天宫轨道';
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
        btn.textContent = isTiangongLoaded() ? '📡 移除轨道' : '📡 天宫轨道';
        btn.addEventListener('click', () => {
          const cbx = document.getElementById(`layer-${layer.id}`);
          if (cbx) {
            cbx.checked = !isTiangongLoaded();
            cbx.dispatchEvent(new Event('change'));
          }
        });
        head.appendChild(btn);
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

      // 悬停预览：停留 0.35s 临时只显示当前图层，移开恢复。
      // 默认关闭（面板上的「悬停预览图层」勾选框控制，记在 localStorage），
      // 因为它会临时改动勾选框状态，静默开启时容易被误认为"我的勾选被改了"。
      if (layer.id !== 'tiangong') {
        layerEl.addEventListener('mouseenter', () => {
          if (!getHoverPreviewEnabled()) return;
          clearTimeout(layerHoverTimer);
          layerHoverTimer = setTimeout(() => enterLayerHover(layer), 350);
        });
        layerEl.addEventListener('mouseleave', () => {
          if (!getHoverPreviewEnabled()) return;
          cancelLayerHover(true);
        });
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
            cancelLayerHover(true); // 悬停预览期间手动操作则先恢复全量状态
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

// ====== 航天探索工具面板（独立按钮，不进勾选树）======
function buildToolsPanel(cat) {
  const host = document.getElementById('toolButtons');
  if (!host) return;
  host.innerHTML = '';
  for (const layer of cat.layers) {
    if (layer.id === 'tiangong') {
      const btn = document.createElement('button');
      btn.className = 'scene-btn';
      btn.id = 'btnTiangong';
      btn.textContent = isTiangongLoaded() ? '📡 移除轨道' : '📡 天宫轨道';
      btn.addEventListener('click', () => {
        if (isTiangongLoaded()) {
          removeTiangong(viewer);
          viewer.clock.shouldAnimate = false;
          btn.textContent = '📡 天宫轨道';
          setStatus('天宫空间站已移除', 'ok');
        } else {
          loadTiangong(viewer).then((ok) => {
            if (!ok) { setStatus('天宫轨道加载失败', 'warn'); return; }
            viewer.clock.shouldAnimate = true;
            btn.textContent = '📡 移除轨道';
            setStatus('天宫空间站轨道已加载（闭环 · 实时位置）', 'ok');
          });
        }
      });
      host.appendChild(btn);
    } else if (layer.id === 'moonmission') {
      const btn = document.createElement('button');
      btn.className = 'scene-btn';
      btn.textContent = '🚀 探月任务';
      btn.addEventListener('click', () => enterRocketMode());
      host.appendChild(btn);
    }
  }
}

// ====== 场景预设：一键讲清一个故事，避免面对几十个勾选框 ======
const SCENARIOS = [
  { id: 'silkroad',  name: '🐫 丝绸之路',   layerIds: ['silkroad', 'cities'] },
  { id: 'zhenghe',   name: '⛵ 郑和下西洋', layerIds: ['zhenghe'] },
  { id: 'longmarch', name: '🚩 长征',       layerIds: ['longmarch', 'cities'] },
  { id: 'shanhai',   name: '⛰️ 山川形胜',   layerIds: ['shanhai', 'wall', 'peaks'] },
  { id: 'dynasties', name: '🏯 中国朝代',   layerIds: ['dynasties', 'cities'] },
  { id: 'worldgeo',  name: '🌍 世界地理',   layerIds: ['worldcapitals', 'worldrivers', 'plates'] },
  { id: 'worldhist', name: '🏛️ 世界史',     layerIds: ['civilizations', 'wonders', 'heritage'] },
  { id: 'moon',      name: '🌕 探月',       layerIds: [], tools: ['moonmission'] },
];

// 把渲染器实体显隐状态同步回侧栏勾选框（场景预设 / 全清后调用）
function syncLayerCheckboxes() {
  for (const layer of LAYERS) {
    if (layer.id === 'tiangong' || layer.id === 'moonmission') continue;
    const topCb = document.getElementById('layer-' + layer.id);
    if (!topCb) continue;
    const st = groupStateMap.get(layer.id);
    if (!st) continue;
    for (const [gid, on] of st) {
      const sub = document.getElementById('layer-' + layer.id + '-g-' + gid);
      if (sub) sub.checked = on;
    }
    updateTopCbState(layer);
  }
}

function applyScenario(sc) {
  for (const layer of LAYERS) {
    if (layer.id === 'tiangong' || layer.id === 'moonmission') continue;
    const on = sc.layerIds.includes(layer.id);
    const st = groupStateMap.get(layer.id);
    if (st) for (const gid of st.keys()) st.set(gid, on);
    renderer.setLayerVisible(layer.id, on);
  }
  if (sc.tools && sc.tools.includes('moonmission')) {
    if (!(moonMission && moonMission.isActive())) enterRocketMode();
  }
  syncLayerCheckboxes();
  setStatus('已载入场景：' + sc.name, 'ok');
}

function clearAllScenes() {
  for (const layer of LAYERS) {
    if (layer.id === 'tiangong' || layer.id === 'moonmission') continue;
    const st = groupStateMap.get(layer.id);
    if (st) for (const gid of st.keys()) st.set(gid, false);
    renderer.setLayerVisible(layer.id, false);
  }
  syncLayerCheckboxes();
  setStatus('已清空所有图层', 'ok');
}

function buildSceneButtons() {
  const host = document.getElementById('sceneButtons');
  if (!host) return;
  host.innerHTML = '';
  for (const sc of SCENARIOS) {
    const b = document.createElement('button');
    b.className = 'scene-btn';
    b.textContent = sc.name;
    b.title = '一键载入：' + (sc.layerIds.join('、') || '（探月任务）');
    b.addEventListener('click', () => applyScenario(sc));
    host.appendChild(b);
  }
  const clr = document.createElement('button');
  clr.className = 'scene-btn clear';
  clr.textContent = '🧹 清空';
  clr.addEventListener('click', clearAllScenes);
  host.appendChild(clr);
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

buildLayerTree();
initHoverPreviewToggle();
initBuildTag();
buildSceneButtons();

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

// ====== 图层搜索 ======
layerSearchEl.addEventListener('input', () => {
  const q = layerSearchEl.value.trim().toLowerCase();
  const items = layersTreeEl.querySelectorAll('.layer-item');
  items.forEach((el) => {
    const search = el.dataset.search || '';
    if (!q || search.includes(q)) {
      el.classList.remove('hidden-by-search');
      el.closest('.layer-category')?.classList.remove('hidden-by-search');
    } else {
      el.classList.add('hidden-by-search');
      // 如果分类下所有图层都隐藏，则整个分类也隐藏
      const catBody = el.closest('.layer-category-body');
      if (catBody) {
        const any = catBody.querySelector(
          '.layer-item:not(.hidden-by-search)'
        );
        if (!any) {
          catBody.parentElement.classList.add('hidden-by-search');
        }
      }
    }
  });
});

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
