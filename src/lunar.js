// src/lunar.js — 月球 Viewer、月面高程与月面标注

import * as Cesium from 'cesium';

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
let _moonEntities = null;   // 标注实体
let _moonGroupMap = new Map();
let _heightBuf = null;      // 高程采样缓冲（Uint8 灰度）
let _heightRaw = null;      // 原始高度数据 {width,height,values:Float32Array}
let _terrainReady = false;

function $(id) {
  return document.getElementById(id);
}

// 加载高程底图（lunar_dem.png，等距圆柱投影，灰度编码高度）
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
          // LOLA 高程范围约 -9.1 km ~ +10.9 km，按灰度线性映射（0→-9100m，255→10900m）
          for (let i = 0; i < n; i++) {
            values[i] = (d[i * 4] / 255) * 20000 - 9100;
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

// 为 CustomHeightmapTerrainProvider 提供的瓦片高度回调
function heightmapCallback(x, y, level) {
  const W = 32, H = 32;
  const out = new Float32Array(W * H);
  if (!_heightRaw) return out;
  const tiling = new Cesium.GeographicTilingScheme({ ellipsoid: MOON_ELLIPSOID });
  const rect = tiling.tileXYToRectangle(x, y, level);
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

  // 影像底图
  Cesium.SingleTileImageryProvider.fromUrl('lunar/lunar_wac.jpg')
    .then((p) => {
      if (!_moonViewer) return;
      _moonViewer.imageryLayers.removeAll();
      _moonViewer.imageryLayers.addImageryProvider(p);
      if (onStatus) onStatus('月球影像已加载', 'ok');
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
  toggleLunarGroup,
  getMoonViewer,
  getMoonGroups,
  sampleMoonHeight,
  MOON_ELLIPSOID,
  MOON_LANDING_SITES,
};
