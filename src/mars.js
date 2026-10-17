// src/mars.js — 火星 Viewer、火星影像与火面标注（2026-10-18 新增）

import * as Cesium from 'cesium';
import CesiumNavigation from 'cesium-navigation-es6';

// 火星椭球（IAS/IAU 2000 火星球体，平均半径 3396.19 km）
// ⚠ 与影像源坐标系严格一致：AGOL OnMars 服务用 GCS_Mars_2000_Sphere
//   （wkid 104971，SPHEROID Mars_2000_Sphere_IAU_IAG = 3396190.0, 0）。
export const MARS_ELLIPSOID = new Cesium.Ellipsoid(3396190, 3396190, 3396190);
const MARS_R = 3396190;

// 火面标注分组（东经 0–360°，行星中心纬度）
export const MARS_GROUPS = [
  {
    id: 'landforms',
    name: '巨型地貌',
    color: '#e8a07a',
    entities: [
      { name: '奥林匹斯山', text: '奥林匹斯山 · Olympus Mons', lon: 226.2, lat: 18.65, point: true, description: '太阳系最高火山，高约 21.9 km，基部直径近 600 km，位于塔尔西斯隆起西北。' },
      { name: '水手谷', text: '水手谷 · Valles Marineris', lon: 300.0, lat: -14.0, point: true, description: '沿赤道延伸约 4000 km 的巨大峡谷系，最深处约 7 km，因水手9号探测器得名。' },
      { name: '希腊平原', text: '希腊平原 · Hellas Planitia', lon: 70.5, lat: -42.7, point: true, description: '南半球最醒目的撞击盆地，直径约 2300 km、深逾 7 km，是火星低压系统之一。' },
      { name: '大瑟提斯', text: '大瑟提斯 · Syrtis Major', lon: 290.0, lat: 10.0, point: true, description: '火星最著名的暗反照率特征（古老玄武岩盾），19 世纪即被地面望远镜绘出。' },
      { name: '塔尔西斯', text: '塔尔西斯隆起 · Tharsis', lon: 260.0, lat: 0.0, point: true, description: '火星赤道附近的巨型火山高原，集中了奥林匹斯山等五座大火山。' },
    ],
  },
  {
    id: 'landing',
    name: '人类着陆点',
    color: '#d4a04a',
    entities: [
      { name: '海盗1号着陆点', text: '海盗1号 · 1976', lon: 337.7, lat: 22.4, point: true, marker: 'flag', description: '人类首个成功工作的火星着陆器（克里塞平原）。' },
      { name: '海盗2号着陆点', text: '海盗2号 · 1976', lon: 312.1, lat: 48.0, point: true, marker: 'flag', description: '第二个海盗号着陆器（乌托邦平原），首次确认火星土壤含水冰。' },
      { name: '探路者着陆点', text: '探路者 · 1997', lon: 326.8, lat: 19.1, point: true, marker: 'flag', description: '携带旅居者号火星车，降落于阿瑞斯谷。' },
      { name: '勇气号着陆点', text: '勇气号 · 2004', lon: 175.4, lat: -14.6, point: true, marker: 'flag', description: '火星探索漫游者之一，工作于古瑟夫撞击坑。' },
      { name: '机遇号着陆点', text: '机遇号 · 2004', lon: 354.5, lat: -2.0, point: true, marker: 'flag', description: '另一辆火星探索漫游者，在子午线平原工作近 15 年。' },
      { name: '好奇号着陆点', text: '好奇号 · 2012', lon: 137.4, lat: -5.1, point: true, marker: 'flag', description: '核动力火星科学实验室，工作于盖尔撞击坑。' },
      { name: '毅力号着陆点', text: '毅力号 · 2021', lon: 77.6, lat: 18.4, point: true, marker: 'flag', description: '携带机智号直升机，工作于耶泽罗撞击坑（古湖泊三角洲）。' },
      { name: '祝融号着陆点', text: '祝融号 · 2021', lon: 109.9, lat: 25.1, point: true, marker: 'flag', description: '天问一号任务火星车，降落于乌托邦平原南部。' },
    ],
  },
  {
    id: 'poles',
    name: '极冠',
    color: '#cfe4ff',
    entities: [
      { name: '北极极冠', text: '北极极冠 · Planum Boreum', lon: 0.0, lat: 85.0, point: true, description: '以水冰为主、季节性 CO₂ 霜覆盖的北极冰盖。' },
      { name: '南极极冠', text: '南极极冠 · Planum Australe', lon: 0.0, lat: -85.0, point: true, description: '常年存在的 CO₂/水冰混合冰盖。' },
    ],
  },
];

let _marsViewer = null;
let _marsNav = null;          // 火星 Viewer 的导航控件
let _marsEntities = null;
let _marsGroupMap = new Map();
let _hillLayer = null;        // 地形晕渲层（HRSC-MOLA）
let _hillOn = localStorage.getItem('sphere.marsHillshade') === '1';

// ====== 火星影像瓦片（2026-10-18 选型） ======
// 图源选型结论：用户指定「选推荐的第一个图源」。月球侧同构的成功路径是
// 「Esri Astrogeology AGOL 瓦片服务 + 本地代理缓存」，火星沿用同一架构：
// ① 底图 Mars MDIM 2.1 彩色全球镶嵌（Viking Orbiter VIS，232 m/像素，公共域）
//     https://astro.arcgis.com/arcgis/rest/services/OnMars/MDIM/MapServer/tile/{z}/{y}/{x}
// ② 晕渲 Mars HRSC-MOLA Colorized Shaded Relief（同矩阵同缓存深度）——切层显示
// 矩阵：GCS_Mars_2000_Sphere（wkid 104971），L0 = 2 列 × 1 行（LOD 0.3515625°/px
//   × 512px = 180°/tile）→ 与 Cesium GeographicTilingScheme 默认
//   numberOfLevelZeroTilesX=2 逐级吻合；实测 z0–z7 全缓存（z8+ 返回 400）。
// ⚠ 火星 **没有** 3D 高程地形：MOLA 高程瓦片服务（AGOL Mars_MOLA_elevation）
//   实测缓存近乎全空（z0 仅 3 块、z1 全 404），无法驱动 CustomHeightmapTerrainProvider；
//   trek.nasa.gov 在本机 egress 不可达。故用晕渲图层做视觉地形补偿，
//   待有可用高程源（如 GIBS Mars / 自建 DEM 瓦片）再接真地形。
// 通道：前端 /tiles/mars/{z}/{x}/{y}.jpg、/tiles/marshill/{z}/{x}/{y}.jpg，
//   app.py 未命中代理上游并回写 public/tiles/{mars,marshill}/。
// 失败语义：1×1 透明 PNG（200）——火星无本地底图，透明时露出 globe.baseColor。
const MARS_TILE_URL = '/tiles/mars/{z}/{x}/{y}.jpg';
const MARS_HILL_URL = '/tiles/marshill/{z}/{x}/{y}.jpg';
const MARS_TILE_MAX_LEVEL = 7;

function $(id) {
  return document.getElementById(id);
}

/** 火面标注实体（与月球同构：点 + 标签，CLAMP_TO_GROUND + 禁深度测试） */
function buildMarsEntities(viewer) {
  _marsEntities = [];
  _marsGroupMap = new Map();
  for (const g of MARS_GROUPS) {
    const color = Cesium.Color.fromCssColorString(g.color);
    const ents = [];
    for (const e of g.entities) {
      const pos = Cesium.Cartesian3.fromDegrees(e.lon, e.lat, 0, MARS_ELLIPSOID);
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
          backgroundColor: new Cesium.Color(0.12, 0.05, 0.03, 0.65),
          backgroundPadding: new Cesium.Cartesian2(6, 4),
        },
      });
      ent._groupId = g.id;
      ent.show = false;
      ents.push(ent);
    }
    _marsGroupMap.set(g.id, ents);
    _marsEntities.push(...ents);
  }
}

/** 地形晕渲层（HRSC-MOLA 彩色晕渲）：切层显示，不抢底图位 */
function applyHillshadeLayer(viewer, on) {
  if (!viewer || viewer.isDestroyed()) return;
  if (_hillLayer) {
    try { viewer.imageryLayers.remove(_hillLayer); } catch { /* 忽略 */ }
    _hillLayer = null;
  }
  if (!on) return;
  const p = new Cesium.UrlTemplateImageryProvider({
    url: MARS_HILL_URL,
    tilingScheme: new Cesium.GeographicTilingScheme({ ellipsoid: MARS_ELLIPSOID }),
    tileWidth: 256,
    tileHeight: 256,
    maximumLevel: MARS_TILE_MAX_LEVEL,
    credit: 'NASA/USGS Mars HRSC-MOLA Colorized Shaded Relief · Esri Astrogeology',
  });
  // ⚠ Cesium 1.146 坑（2026-10-18 实测）：ImageryLayerCollection.add() **不返回 layer**
  //   （只有 addImageryProvider 返回新建的 layer）——必须显式构造 layer、add、自己持有引用，
  //   否则 remove() 时拿到 undefined 永远删不掉（晕渲开关曾因此关不掉）。
  // ⚠ Cesium 1.146 坑：addImageryProvider(provider, {}) 的第二参会被当 index
  //   （ToInteger({})===0）→ 新层插到 0 抢底图位。必须 ImageryLayer + 单参 add()。
  const layer = new Cesium.ImageryLayer(p, {});
  viewer.imageryLayers.add(layer);
  _hillLayer = layer;
}

/** UI 开关：火星地形晕渲（在线瓦片，经本地代理缓存） */
export function setMarsHillshade(on, onStatus = null) {
  _hillOn = !!on;
  localStorage.setItem('sphere.marsHillshade', on ? '1' : '0');
  applyHillshadeLayer(_marsViewer, _hillOn);
  if (onStatus) {
    onStatus(_hillOn ? '已开启火星地形晕渲（HRSC-MOLA）' : '已关闭火星地形晕渲', '');
  }
  return _hillOn;
}

export function isMarsHillshade() { return _hillOn; }

/**
 * 创建火星 Viewer（影像底图 + 可选晕渲 + 火面标注）
 */
export function createMarsViewer(containerId = 'marsContainer', onStatus = null) {
  if (_marsViewer) return _marsViewer;

  const globe = new Cesium.Globe(MARS_ELLIPSOID);
  // 上游不可达时的兜底色：暗锈红（AGOL 瓦片失败时露出此色而非黑）
  globe.baseColor = Cesium.Color.fromCssColorString('#4a2418');
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
    ellipsoid: MARS_ELLIPSOID,
    contextOptions: { webgl: { alpha: false } },
  });
  viewer.allowDataSourcesToSuspendAnimation = false;
  // 火星无 3D 地形 provider：不做深度测试（避免平地场景下标注被误遮挡）
  viewer.scene.globe.depthTestAgainstTerrain = false;
  if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = false;
  if ('showGroundAtmosphere' in viewer.scene.globe) {
    viewer.scene.globe.showGroundAtmosphere = false;
  }

  // 初始视角：水手谷—塔尔西斯一带俯瞰（火星最壮观的地貌集中区）
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(300, -10, MARS_R * 3.0, MARS_ELLIPSOID),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
  });

  _marsViewer = viewer;

  // 导航控件（与月球/地球同款）
  try {
    _marsNav = new CesiumNavigation(viewer, {
      enableCompass: true,
      enableZoomControls: true,
      enableDistanceLegend: true,
      defaultResetView: Cesium.Cartographic.fromDegrees(300, -10, MARS_R * 3.0),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
    });
  } catch (e) {
    console.warn('[mars] 火星导航控件创建失败（不影响主流程）：', e);
  }

  // 影像底图（MDIM 2.1 彩色全球镶嵌，在线瓦片）
  // ⚠ Cesium.Viewer 会自带一个默认底图层（Ion world imagery，无 token 时加载失败），
  //   先清掉再加——与月球 createMoonViewer 的 removeAll 同构（2026-10-18）。
  viewer.imageryLayers.removeAll();
  const p = new Cesium.UrlTemplateImageryProvider({
    url: MARS_TILE_URL,
    tilingScheme: new Cesium.GeographicTilingScheme({ ellipsoid: MARS_ELLIPSOID }),
    tileWidth: 256,
    tileHeight: 256,
    maximumLevel: MARS_TILE_MAX_LEVEL,
    credit: 'NASA/USGS Mars MDIM 2.1 Colorized Mosaic（Viking Orbiter 232m）· Esri Astrogeology',
  });
  viewer.imageryLayers.add(new Cesium.ImageryLayer(p, {}));
  if (onStatus) onStatus('火星影像已加载（Viking MDIM 2.1 · 232 m/像素）', 'ok');
  // 晕渲层（默认关；用户勾选后叠加在最上）
  if (_hillOn) applyHillshadeLayer(viewer, true);

  buildMarsEntities(viewer);
  return viewer;
}

export function getMarsViewer() {
  return _marsViewer;
}

export function destroyMarsViewer() {
  if (_marsViewer) {
    _hillLayer = null;
    if (_marsNav) { try { _marsNav.destroy(); } catch { /* 忽略 */ } _marsNav = null; }
    try { _marsViewer.destroy(); } catch { /* 忽略 */ }
    _marsViewer = null;
  }
  _marsEntities = null;
  _marsGroupMap = new Map();
}

/**
 * 显隐火星标注分组
 */
export function toggleMarsGroup(groupId, visible) {
  const ents = _marsGroupMap.get(groupId);
  if (!ents) return;
  for (const e of ents) e.show = visible;
}

export function getMarsGroups() {
  return MARS_GROUPS;
}

export default {
  createMarsViewer,
  destroyMarsViewer,
  setMarsHillshade,
  isMarsHillshade,
  toggleMarsGroup,
  getMarsViewer,
  getMarsGroups,
  MARS_ELLIPSOID,
};
