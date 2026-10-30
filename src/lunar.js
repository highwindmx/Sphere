// src/lunar.js — 月球 Viewer、月面高程与月面标注

import * as Cesium from 'cesium';
import CesiumNavigation from 'cesium-navigation-es6';

// 月球椭球（球形，半径 ~1737.4 km）
export const MOON_ELLIPSOID = new Cesium.Ellipsoid(1737400, 1737400, 1737400);
const MOON_R = 1737400;

// 月面着陆区坐标（selenographic 经纬度）
export const MOON_LANDING_SITES = {
  imbrium: { lon: -19.51, lat: 44.12, name: '雨海 · 嫦娥三号着陆区' },
  tranquillity: { lon: 23.47, lat: 0.67, name: '静海 · 阿波罗11着陆点' },
};

// 月面标注分组
export const MOON_GROUPS = [
  {
    id: 'maria',
    name: '月海',
    color: '#8b98b8',
    entities: [
      { name: '静海', text: '静海 · Sea of Tranquility', lon: 31.4, lat: 8.5, point: true, description: '阿波罗 11 号于静海西南缘着陆，人类首次登月之地。' },
      { name: '雨海', text: '雨海 · Mare Imbrium', lon: -16.0, lat: 32.8, point: true, description: '月球最大撞击盆地之一，嫦娥三号在雨海虹湾着陆。' },
      { name: '危海', text: '危海 · Mare Crisium', lon: 59.1, lat: 17.0, point: true, description: '月球正面东北的孤立圆形月海。' },
      { name: '风暴洋', text: '风暴洋 · Oceanus Procellarum', lon: -57.4, lat: 18.4, point: true, description: '月球正面西侧最大的月海区。' },
      { name: '澄海', text: '澄海 · Mare Serenitatis', lon: 17.5, lat: 28.0, point: true, description: '阿波罗 17 号着陆区所在的月海。' },
    ],
  },
  {
    id: 'landing',
    name: '人类着陆点',
    color: '#d4a04a',
    entities: [
      { name: '阿波罗 11 号着陆点', text: '阿波罗11 · 1969', lon: 23.47, lat: 0.67, point: true, marker: 'flag', description: '阿姆斯特朗「个人一小步、人类一大步」之地。' },
      { name: '嫦娥三号着陆区', text: '嫦娥三号 · 2013', lon: -19.51, lat: 44.12, point: true, marker: 'flag', description: '中国首次月面软着陆，玉兔号巡视器在此工作。' },
      { name: '嫦娥四号着陆区', text: '嫦娥四号 · 2019', lon: 176.9, lat: -45.5, point: true, marker: 'flag', description: '人类首次在月球背面软着陆（南极-艾特肯盆地）。' },
      { name: '嫦娥五号着陆区', text: '嫦娥五号 · 2020', lon: -51.9, lat: 43.06, point: true, marker: 'flag', description: '中国首次月球采样返回。' },
    ],
  },
  {
    id: 'craters',
    name: '著名环形山',
    color: '#c2cde6',
    entities: [
      { name: '第谷环形山', text: '第谷环形山', lon: -11.4, lat: -43.3, point: true, description: '月球南部年轻而明亮的撞击坑，辐射纹最醒目。' },
      { name: '哥白尼环形山', text: '哥白尼环形山', lon: -20.0, lat: 9.6, point: true, description: '雨海东南缘的典型复杂撞击坑。' },
      { name: '开普勒环形山', text: '开普勒环形山', lon: -38.0, lat: 8.1, point: true, description: '风暴洋东缘的明亮撞击坑。' },
    ],
  },
];

let _moonViewer = null;
let _moonNav = null;        // 月球 Viewer 的右上角导航控件（2026-10-17：探月第三/四幕要保留操作控件）
let _moonEntities = null;   // 标注实体
let _moonGroupMap = new Map();
let _heightBuf = null;      // 高程采样缓冲（Uint8 灰度）
let _heightRaw = null;      // 原始高度数据 {width,height,values:Float32Array}
let _terrainReady = false;

function $(id) {
  return document.getElementById(id);
}

// 加载高程底图（lunar_dem.png，等距圆柱投影，Terrarium 编码高度）
function loadHeightData(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      img.decode().then(() => {
        try {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0);
          const d = ctx.getImageData(0, 0, c.width, c.height).data;
          const n = c.width * c.height;
          const values = new Float32Array(n);
          // ⚠ 2026-10-18 修真 bug：lunar_dem.png 是 **Terrarium 编码**
          //   （convert_lunar_dem.py：height = R*256 + G + B/256 - 32768），不是灰度图！
          //   旧代码按 (R/255)*20000-9100 解码 → 高程幅度被压扁约一半且整体偏移
          //   （实测雨海 -1966m 被读成 +312m）。LOLA 全球范围 -9178~+10786 m。
          for (let i = 0; i < n; i++) {
            values[i] = (d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256) - 32768;
          }
          _heightRaw = { width: c.width, height: c.height, values };
          _heightBuf = d;
        } catch { /* 采样失败则保持平坦 */ }
        resolve();
      }).catch(() => resolve());
    };
    img.onerror = () => resolve();
    img.src = src;
  });
}

// 按经纬度采样高程（米）
function sampleHeight(lon, lat) {
  if (!_heightRaw) return 0;
  const { width, height, values } = _heightRaw;
  // 等距圆柱：lon -180..180 → x 0..w-1；lat 90..-90 → y 0..h-1
  let x = Math.round(((lon + 180) / 360) * (width - 1));
  let y = Math.round(((90 - lat) / 180) * (height - 1));
  x = Math.max(0, Math.min(width - 1, x));
  y = Math.max(0, Math.min(height - 1, y));
  return values[y * width + x];
}

// 月球瓦片方案（heightmapCallback 每瓦片调用，scheme 提到模块级复用，避免逐瓦片 new）
const _moonTiling = new Cesium.GeographicTilingScheme({ ellipsoid: MOON_ELLIPSOID });

// 为 CustomHeightmapTerrainProvider 提供的瓦片高度回调
function heightmapCallback(x, y, level) {
  const W = 32, H = 32;
  const out = new Float32Array(W * H);
  if (!_heightRaw) return out;
  const rect = _moonTiling.tileXYToRectangle(x, y, level);
  const lonW = Cesium.Math.toDegrees(rect.west);
  const lonE = Cesium.Math.toDegrees(rect.east);
  const latN = Cesium.Math.toDegrees(rect.north);
  const latS = Cesium.Math.toDegrees(rect.south);
  for (let j = 0; j < H; j++) {
    const lat = latN - (latN - latS) * (j / (H - 1));
    for (let i = 0; i < W; i++) {
      const lon = lonW + (lonE - lonW) * (i / (W - 1));
      out[j * W + i] = sampleHeight(lon, lat);
    }
  }
  return out;
}

// ====== 月面高清瓦片层（2026-10-17 接入，2026-10-18 换源） ======
// 本地资产只有 lunar_wac.jpg（8192×4096 ≈ 1.33 km/像素）与 lunar_dem.png（4096×2048 ≈ 2.7 km/像素），
// 近距离（探月第三/四幕几十米机位）看不出月面细节——必须补在线瓦片源。
// 2026-10-18 换源记录：原 NASA Moon Trek WMTS（trek.nasa.gov）在本机沙箱 egress
//   不可达（CONNECT 502，curl 与 urllib 双实测，public/tiles/lunar 长期空目录即为证据），
//   改用 Esri Astrogeology AGOL 上的**同一份 LRO WAC 100m 全球镶嵌**（NASA/USGS 公共域）：
//     https://astro.arcgis.com/arcgis/rest/services/OnMoon/LRO_WAC/MapServer/tile/{z}/{y}/{x}
//   - GCS_Moon_2000（wkid 104903），L0 = 2 列 × 1 行 → 与 GeographicTilingScheme 默认逐级吻合；
//   - 实测 z0–z7 全缓存（L7 ≈ 523 m/像素，较本地图提升 ~2.5× 且瓦片化渐进加载）；
//   - z8+ 上游返回 400，故 maximumLevel 取 7。
// 通道：前端请求本地端点 /tiles/lunar/{z}/{x}/{y}.jpg，app.py 未命中时代理上游并回写
//   public/tiles/lunar/…（与 esri/eox/gibs 同一套「本地优先 + 在线缓存」机制）。
// 降级：先探测 0/0/0，失败即不挂层（离线或被墙时静默保持本地底图，不产生瓦片报错刷屏）。
const LUNAR_TILE_URL = '/tiles/lunar/{z}/{x}/{y}.jpg';
const LUNAR_TILE_MAX_LEVEL = 7;
let _lunarHiRes = localStorage.getItem('sphere.lunarHiRes') !== '0';
let _lunarHiResLayer = null;
let _lunarHiResState = 'idle';   // idle | on | off | failed

function addHighResLunarLayer(viewer, onStatus) {
  if (!_lunarHiRes || !viewer || viewer.isDestroyed()) return;
  if (_lunarHiResLayer) return;
  fetch(LUNAR_TILE_URL.replace('{z}', '0').replace('{x}', '0').replace('{y}', '0'))
    .then((r) => {
      if (!r.ok) throw new Error('probe http ' + r.status);
      return r.arrayBuffer();
    })
    .then((buf) => {
      if (!_lunarHiRes || !viewer || viewer.isDestroyed() || buf.byteLength < 512) return;
      const p = new Cesium.UrlTemplateImageryProvider({
        url: LUNAR_TILE_URL,
        tilingScheme: new Cesium.GeographicTilingScheme({ ellipsoid: MOON_ELLIPSOID }),
        tileWidth: 256,
        tileHeight: 256,
        maximumLevel: LUNAR_TILE_MAX_LEVEL,
        credit: 'NASA/USGS LRO WAC 全球镶嵌（100m）· Esri Astrogeology',
      });
      // ⚠ Cesium 1.146 坑：addImageryProvider(provider, {}) 的第二参会被当 index（ToInteger({})===0）
      //   → 新层插到 0 抢掉底图位。必须 ImageryLayer + 单参 add()。
      // ⚠ 同版本 add() **不返回 layer**（仅 addImageryProvider 返回）——显式构造、自己持引用，
      //   否则 setLunarHiRes(false) 时 remove(undefined) 永远关不掉（2026-10-18 实测）。
      // 高清层同样套提亮参数（否则在线瓦片加载后月面又变回暗的）。
      const layer = brightLayer(p);
      viewer.imageryLayers.add(layer);
      _lunarHiResLayer = layer;
      _lunarHiResState = 'on';
      if (onStatus) onStatus('月面高清瓦片已加载（LRO WAC ≈100 m/像素，已缓存到本地）', 'ok');
    })
    .catch(() => {
      _lunarHiResState = 'failed';
      if (onStatus) onStatus('月面高清瓦片不可用（离线/上游不可达），使用本地月面贴图', 'warn');
    });
}

function removeHighResLunarLayer(viewer) {
  if (_lunarHiResLayer && viewer && !viewer.isDestroyed()) {
    try { viewer.imageryLayers.remove(_lunarHiResLayer); } catch { /* 忽略 */ }
  }
  _lunarHiResLayer = null;
  _lunarHiResState = 'off';
}

/** UI 开关：月面高清瓦片（在线） */
export function setLunarHiRes(on, onStatus = null) {
  _lunarHiRes = !!on;
  localStorage.setItem('sphere.lunarHiRes', on ? '1' : '0');
  const v = getMoonViewer();
  if (on) addHighResLunarLayer(v, onStatus);
  else {
    removeHighResLunarLayer(v);
    if (onStatus) onStatus('已关闭月面高清瓦片（使用本地月面贴图）', '');
  }
  return _lunarHiRes;
}

export function isLunarHiRes() { return _lunarHiRes; }
export function lunarHiResState() { return _lunarHiResState; }

// 月面提亮（2026-10-17 用户反馈「月面近黑，月兔车动起来看不清」）：
// 本地 lunar_wac.jpg 是 WAC 反照率镶嵌——实测全局均值 64/255、着陆区仅 37/255，
// 叠加太阳光照后渲染像素 ~29，近距看等于近黑。
// ImageryLayer 调整参数（vendored sampleAndBlend 中的应用顺序：gamma → brightness → contrast）：
//   out = clamp(src^(1/gamma) × brightness)   ← 2026-10-17 读 shader 实测标定的公式
//   gamma=1.45    → 指数 0.69，暗部大幅提亮且高光不 clipping；
//   brightness=1.35 → 线性再乘一档。两者合用：着陆区 37 → ~91、全局均值 64 → ~133。
// ⚠ 两个坑（都读 vendored shader 证实，改值前必读）：
//   ① czm_gammaCorrect 在非 HDR 下是**恒等函数**（#ifdef HDR 才生效）——所以默认
//      (gamma=1) 路径对纹理值什么也不做，别按「sRGB 解码」的直觉推；
//   ② gamma<1 是**变暗**（指数 >1），要提亮必须 gamma>1。第一版按直觉写了 0.7，白改。
const LUNAR_LAYER_OPTS = { gamma: 1.45, brightness: 1.35 };

/** 给月球 viewer 的影像层统一套提亮参数（底图 / 高清瓦片层共用） */
function brightLayer(provider) {
  return new Cesium.ImageryLayer(provider, LUNAR_LAYER_OPTS);
}

/**
 * 创建月球 Viewer（影像 + 高程 + 月面标注）
 */
export function createMoonViewer(containerId = 'moonContainer', onStatus = null) {
  if (_moonViewer) return _moonViewer;

  const globe = new Cesium.Globe(MOON_ELLIPSOID);
  globe.baseColor = Cesium.Color.fromCssColorString('#1b1b22');
  const viewer = new Cesium.Viewer(containerId, {
    animation: false,
    timeline: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    baseLayerPicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    shouldAnimate: true,
    globe,
    ellipsoid: MOON_ELLIPSOID,
    contextOptions: { webgl: { alpha: false } },
  });
  viewer.allowDataSourcesToSuspendAnimation = false;
  viewer.scene.globe.depthTestAgainstTerrain = true;
  // 2026-10-22 瓦片加速（DS 建议）：焦点加载（优先中心瓦片）+ 动态 SSE（远处降分辨率），
  // 动力下降近距离段更快变清晰，且不影响中心画质
  viewer.scene.globe.foveatedScreenSpaceError = true;
  viewer.scene.globe.dynamicScreenSpaceError = true;
  // 非地球椭球下 Cesium 可能不创建 skyAtmosphere，需判空
  if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = false;
  if ('showGroundAtmosphere' in viewer.scene.globe) {
    viewer.scene.globe.showGroundAtmosphere = false;
  }

  // 初始视角：正面俯瞰
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(0, 10, MOON_R * 3.2, MOON_ELLIPSOID),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
  });

  _moonViewer = viewer;

  // 导航控件（指南针 / 缩放 / 重置 / 比例尺）：与地球同款，右上角位置由
  // .cesium-widget-cesiumNavigationContainer 的 CSS 决定（style.css）。
  // 2026-10-17：探月第三/四幕在月球容器内，没有它「右上角操作控件」就整体消失。
  try {
    _moonNav = new CesiumNavigation(viewer, {
      enableCompass: true,
      enableZoomControls: true,
      enableDistanceLegend: true,
      defaultResetView: Cesium.Cartographic.fromDegrees(0, 10, MOON_R * 3.2),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
    });
  } catch (e) {
    console.warn('[lunar] 月球导航控件创建失败（不影响主流程）：', e);
  }

  // 影像底图（2026-10-17：套 LUNAR_LAYER_OPTS 提亮，见文件头注释）
  Cesium.SingleTileImageryProvider.fromUrl('lunar/lunar_wac.jpg')
    .then((p) => {
      if (!_moonViewer) return;
      _moonViewer.imageryLayers.removeAll();
      // ⚠ Cesium 1.146 坑：addImageryProvider(provider, {}) 的第二参会被当 index
      //   （ToInteger({})===0）→ 新层插到 0 抢底图位。必须 ImageryLayer + 单参 add()。
      _moonViewer.imageryLayers.add(brightLayer(p));
      if (onStatus) onStatus('月球影像已加载', 'ok');
      // 高清瓦片层（见下）：底图就绪后再叠加，缺失/离线时自动保持本地底图
      addHighResLunarLayer(_moonViewer, onStatus);
    })
    .catch(() => { if (onStatus) onStatus('月球影像加载失败（缺 lunar/lunar_wac.jpg）', 'warn'); });

  // 高程地形（LOLA 灰度高程图 → CustomHeightmapTerrainProvider）
  loadHeightData('lunar/lunar_dem.png').then(() => {
    if (!_moonViewer) return;
    if (!_heightRaw) return;
    try {
      const provider = new Cesium.CustomHeightmapTerrainProvider({
        callback: heightmapCallback,
        width: 32,
        height: 32,
        tilingScheme: new Cesium.GeographicTilingScheme({ ellipsoid: MOON_ELLIPSOID }),
        ellipsoid: MOON_ELLIPSOID,
      });
      _moonViewer.terrainProvider = provider;
      _terrainReady = true;
      if (onStatus) onStatus('月球高程已加载', 'ok');
    } catch { /* 保持平坦月球 */ }
  });

  buildMoonEntities(viewer);
  return viewer;
}

function buildMoonEntities(viewer) {
  _moonEntities = [];
  _moonGroupMap = new Map();
  for (const g of MOON_GROUPS) {
    const color = Cesium.Color.fromCssColorString(g.color);
    const ents = [];
    for (const e of g.entities) {
      const pos = Cesium.Cartesian3.fromDegrees(e.lon, e.lat, 0, MOON_ELLIPSOID);
      const ent = viewer.entities.add({
        name: e.name,
        description: e.description,
        position: pos,
        point: e.point
          ? {
              pixelSize: 10,
              color,
              outlineColor: Cesium.Color.fromCssColorString('#1a1a1a'),
              outlineWidth: 2,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            }
          : undefined,
        label: {
          text: e.text ?? e.name,
          font: '13px "Microsoft YaHei", "PingFang SC", sans-serif',
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(0, -16),
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          showBackground: true,
          backgroundColor: new Cesium.Color(0.05, 0.08, 0.18, 0.65),
          backgroundPadding: new Cesium.Cartesian2(6, 4),
        },
      });
      ent._groupId = g.id;
      ent.show = false;
      ents.push(ent);
    }
    _moonGroupMap.set(g.id, ents);
    _moonEntities.push(...ents);
  }
}

export function getMoonViewer() {
  return _moonViewer;
}

export function isMoonTerrainReady() {
  return _terrainReady;
}

// 月面地形高（米，相对月球参考椭球，未做垂直夸张）：供着陆接地等使用
// 与 CustomHeightmapTerrainProvider 同源（lunar_dem.png 采样），DEM 未加载时返回 0
export function sampleMoonHeight(lon, lat) {
  return sampleHeight(lon, lat);
}

export function destroyMoonViewer() {
  if (_moonViewer) {
    _lunarHiResLayer = null;
    _lunarHiResState = 'idle';
    if (_moonNav) { try { _moonNav.destroy(); } catch { /* 忽略 */ } _moonNav = null; }
    try { _moonViewer.destroy(); } catch { /* 忽略 */ }
    _moonViewer = null;
  }
  _moonEntities = null;
  _moonGroupMap = new Map();
  // 重置高程状态，保证下次进入月球模式重新加载 DEM
  _terrainReady = false;
  _heightBuf = null;
  _heightRaw = null;
}

/**
 * 显隐月球标注分组
 */
export function toggleLunarGroup(groupId, visible) {
  const ents = _moonGroupMap.get(groupId);
  if (!ents) return;
  for (const e of ents) e.show = visible;
}

export function getMoonGroups() {
  return MOON_GROUPS;
}

export default {
  createMoonViewer,
  destroyMoonViewer,
  setLunarHiRes,
  isLunarHiRes,
  lunarHiResState,
  toggleLunarGroup,
  getMoonViewer,
  getMoonGroups,
  sampleMoonHeight,
  MOON_ELLIPSOID,
  MOON_LANDING_SITES,
};
