// src/main.js — 应用入口
// 从 dist index--AIpTfEu.js 提取核心逻辑

import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import './style.css';

import { TerrariumTerrainProvider } from './terrarium-provider.js';
import { LAYERS, LAYER_CATEGORIES, resolveCategories } from './layers/index.js';
import { createLayerRenderer } from './layer-renderer.js';
import { loadTiangong, isTiangongLoaded } from './tiangong.js';
import {
  MOON_ELLIPSOID,
  createMoonViewer,
  destroyMoonViewer,
  toggleLunarGroup,
  getMoonViewer,
} from './lunar.js';

// ====== Cesium Ion Token ======
// 必须设置才能使用 Bing Maps Aerial 在线底图（默认 Viewer baseLayer）。
// 注册免费 token：https://cesium.com/ion/
// 本地开发：设环境变量 SPHERE_CESIUM_ION_TOKEN
// 生产部署：.env / CI 注入，勿提交到仓库！
Cesium.Ion.defaultAccessToken =
  import.meta.env.VITE_CESIUM_ION_TOKEN ||
  (typeof process !== 'undefined' ? process.env.SPHERE_CESIUM_ION_TOKEN : undefined) ||
  '';

// ====== 全局便捷 $ 函数 ======
function $(id) {
  if (id.startsWith('#')) id = id.slice(1);
  return document.getElementById(id);
}

// ====== 常量 ======
const POLE_CAP_EDGE_DEG = 5.04; // 极区补丁的纬度范围（度），从 dist Li=5.04
const IMG_W = 720; // bluemarble.jpg 原始像素宽
const IMG_H = 360; // bluemarble.jpg 原始像素高

// ====== DOM 引用 ======
const statusEl = $('status');
const coordbarEl = $('coordbar');
const exagValEl = $('exagVal');
const layerSearchEl = $('layerSearch');
const layersTreeEl = $('layersTree');

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
  navigationHelpButton: false,
  fullscreenButton: false,
  infoBox: false,
  selectionIndicator: false,
  shouldAnimate: true,
  contextOptions: { webgl: { alpha: false } },
});
viewer.allowDataSourcesToSuspendAnimation = false;

const globe = viewer.scene.globe;
globe.depthTestAgainstTerrain = true;
globe.terrainExaggeration = 1.2;
globe.tileCacheSize = 300;
viewer.scene.skyAtmosphere.show = true;
globe.baseColor = Cesium.Color.fromCssColorString('#26527c');

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

// 晨昏方向 tint color — CallbackProperty 根据太阳位置动态调整极点颜色
function makePolarColorCallback(isNorth) {
  const color = new Cesium.Color();
  const cartSunIcrf = new Cesium.Cartesian3();
  const mtxIcrfToFixed = new Cesium.Matrix3();
  const cartSunFixed = new Cesium.Cartesian3();

  return new Cesium.CallbackProperty((time) => {
    let brightness = 1.0;
    if (globe.enableLighting) {
      Cesium.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
        time, cartSunIcrf
      );
      Cesium.Transforms.computeIcrfToFixedMatrix(time, mtxIcrfToFixed);
      if (Cesium.defined(mtxIcrfToFixed)) {
        Cesium.Matrix3.multiplyByVector(mtxIcrfToFixed, cartSunIcrf, cartSunFixed);
        const zOverMag =
          cartSunFixed.z / Cesium.Cartesian3.magnitude(cartSunFixed);
        // 南半球 z 反号
        const dotSign = isNorth ? zOverMag : -zOverMag;
        const t = Math.min(1, Math.max(0, (dotSign + 0.1) / 0.25));
        // smoothstep
        const smooth = t * t * (3 - 2 * t);
        brightness = 0.06 + 0.94 * smooth;
      }
    }
    color.red = brightness;
    color.green = brightness;
    color.blue = brightness;
    color.alpha = 1.0;
    return color;
  }, false);
}

/**
 * 从 bluemarble.jpg 裁极区条带
 * - 北极条带：从图片顶端往下切 POLE_CAP_EDGE_DEG 度对应的像素行
 * - 南极条带：从图片底端往上切
 * - 接缝处用 softAlpha = 1 - r² × 0.06 柔化，避免白环
 */
function makePolarStrip(img, isNorth) {
  const n = img.naturalWidth;
  const fullH = img.naturalHeight;
  const stripH = Math.max(
    2,
    Math.round((POLE_CAP_EDGE_DEG / 180) * fullH)
  );

  // 裁原始像素（不增白）
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = n;
  srcCanvas.height = stripH;
  const sctx = srcCanvas.getContext('2d');
  // 北极：从 0 行开始切；南极：从 fullH - stripH 行开始切
  sctx.drawImage(
    img,
    0, isNorth ? 0 : fullH - stripH, n, stripH,
    0, 0, n, stripH
  );
  const imgData = sctx.getImageData(0, 0, n, stripH);
  const src = imgData.data;

  // 逐行计算 softAlpha
  const outCanvas = document.createElement('canvas');
  outCanvas.width = n;
  outCanvas.height = stripH;
  const octx = outCanvas.getContext('2d');
  const outData = octx.createImageData(n, stripH);
  const dst = outData.data;

  for (let y = 0; y < stripH; y++) {
    // 该行距离极点中心的「归一化纬度」（0=极点中心, 1=边缘）
    const latOffset = (isNorth ? y + 0.5 : stripH - y - 0.5) / fullH * 180;
    const r = Math.min(1, latOffset / POLE_CAP_EDGE_DEG);
    const softAlpha = 1 - r * r * 0.06; // 柔化因子

    for (let x = 0; x < n; x++) {
      const idx = (y * n + x) * 4;
      dst[idx] = src[idx];       // R
      dst[idx + 1] = src[idx + 1]; // G
      dst[idx + 2] = src[idx + 2]; // B
      dst[idx + 3] = Math.round(255 * softAlpha);
    }
  }
  octx.putImageData(outData, 0, 0);
  return outCanvas;
}

/**
 * 兜底 canvas：Bing 离线时显示的北极/南极冰盖（纯手绘渐变）
 */
function makeFallbackPolarStrip(isNorth) {
  const c = document.createElement('canvas');
  c.width = IMG_W;
  c.height = Math.max(
    2,
    Math.round((POLE_CAP_EDGE_DEG / 180) * IMG_H)
  );
  const ctx = c.getContext('2d');
  // 整幅先透明
  ctx.fillStyle = '#00000000';
  ctx.fillRect(0, 0, c.width, c.height);
  return c;
}

// 南极冰盖实体（需要动态更新 height 以匹配 terrainExaggeration）
let southCapEntity = null;

/**
 * 添加一个极区 Rectangle 实体
 */
function addPolarCap(isNorth, image) {
  const rectangle = isNorth
    ? Cesium.Rectangle.fromDegrees(
        -180, 90 - POLE_CAP_EDGE_DEG, 180, 90
      )
    : Cesium.Rectangle.fromDegrees(
        -180, -90, 180, -90 + POLE_CAP_EDGE_DEG
      );

  const height = isNorth ? 20 : 2450 * globe.terrainExaggeration;

  const ent = viewer.entities.add({
    id: isNorth ? 'polarCapNorth' : 'polarCapSouth',
    rectangle: {
      coordinates: rectangle,
      height: height,
      material: new Cesium.ImageMaterialProperty({
        image: image,
        color: makePolarColorCallback(isNorth),
      }),
    },
  });

  if (!isNorth) southCapEntity = ent;
  return ent;
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

// ====== bluemarble.jpg 加载 & 极地补丁 ======
fetch('bluemarble.jpg', { method: 'HEAD' })
  .then(async (r) => {
    if (!r.ok) throw new Error('no bluemarble');
    const bmProvider = await Cesium.SingleTileImageryProvider.fromUrl(
      'bluemarble.jpg'
    );
    const bmLayer = viewer.imageryLayers.addImageryProvider(bmProvider);
    viewer.imageryLayers.lowerToBottom(bmLayer);

    const img = await loadImage('bluemarble.jpg');
    addPolarCap(true, makePolarStrip(img, true));
    addPolarCap(false, makePolarStrip(img, false));

    setStatus('已加载 bluemarble.jpg + 极地补丁', 'ok');
  })
  .catch(() => {
    // Fallback：没有 bluemarble.jpg 时画兜底极区
    setStatus('无本地 bluemarble.jpg，使用 Bing 底图 + 兜底极区', 'warn');
    addPolarCap(true, makeFallbackPolarStrip(true));
    addPolarCap(false, makeFallbackPolarStrip(false));
  });

// ====== 本地卫星影像检测 ======
(async function setupLocalSatellite() {
  try {
    const r = await fetch('tiles/satellite/0/0/0.jpg', { method: 'HEAD' });
    if (!r.ok) return;
    setStatus('检测到本地卫星瓦片，切换底图层…', '');
    const layers = viewer.imageryLayers;
    for (let i = layers.length - 1; i >= 0; i--) {
      const p = layers.get(i).imageryProvider;
      if (
        p instanceof Cesium.BingMapsImageryProvider ||
        p instanceof Cesium.IonImageryProvider
      ) {
        layers.removeAt(i);
      }
    }
    // Esri 在线底图 + 本地高清瓦片
    viewer.imageryLayers.addImageryProvider(
      new Cesium.UrlTemplateImageryProvider({
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        maximumLevel: 19,
      })
    );
    viewer.imageryLayers.addImageryProvider(
      new Cesium.UrlTemplateImageryProvider({
        url: 'tiles/satellite/{z}/{x}/{y}.jpg',
        maximumLevel: 14,
      })
    );
    setStatus('本地卫星瓦片已激活', 'ok');
  } catch {
    // 忽略
  }
})();

// ====== 左侧面板交互 ======

// 地形夸张滑块
$('exag').addEventListener('input', (e) => {
  const v = parseFloat(e.target.value);
  globe.terrainExaggeration = v;
  exagValEl.textContent = `${v.toFixed(1)}×`;
  if (southCapEntity) {
    southCapEntity.rectangle.height = 2450 * v;
  }
});

// 晨夜光影
$('lighting').addEventListener('click', () => {
  const on = !$('lighting').classList.contains('active');
  $('lighting').classList.toggle('active', on);
  globe.enableLighting = on;
  // 强制触发 CallbackProperty 更新
  viewer.scene.requestRender();
});

// 回到中国
$('btnHome').addEventListener('click', () => {
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

// ====== 月球模式按钮 ======
$('btnMoonMode').addEventListener('click', () => {
  const moonBtn = $('btnMoonMode');
  const earthBtn = $('btnEarthMode');
  const moonContainer = $('moonContainer');
  const cesiumContainer = $('cesiumContainer');
  const moonSection = $('moonSection');

  const toMoon = !moonBtn.classList.contains('active');
  moonBtn.classList.toggle('active', toMoon);
  earthBtn.classList.toggle('active', !toMoon);

  if (toMoon) {
    cesiumContainer.classList.add('hidden');
    moonContainer.classList.remove('hidden');
    moonSection.classList.remove('hidden');
    const moonViewer = createMoonViewer('moonContainer', (msg, kind) =>
      setStatus(msg, kind)
    );
  } else {
    cesiumContainer.classList.remove('hidden');
    moonContainer.classList.add('hidden');
    moonSection.classList.add('hidden');
    destroyMoonViewer();
  }
});

$('btnEarthMode').addEventListener('click', () => {
  if ($('btnMoonMode').classList.contains('active')) {
    $('btnMoonMode').click(); // 触发回地球
  }
});

// ====== 图层树构建 ======
const groupStateMap = new Map(); // layerId → Map<groupId, boolean>  分组 checkbox 状态

function buildLayerTree() {
  layersTreeEl.innerHTML = '';
  const categories = resolveCategories();

  for (const cat of categories) {
    const catEl = document.createElement('details');
    catEl.className = 'layer-category';
    catEl.open = true;

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
        const checked = topCb.checked;
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
        btn.textContent = '📡 天宫轨道';
        btn.addEventListener('click', () => {
          if (isTiangongLoaded()) {
            setStatus('天宫轨道已加载', 'ok');
          } else {
            loadTiangong(viewer).then((ok) => {
              if (ok) setStatus('天宫轨道已加载', 'ok');
              else setStatus('天宫轨道加载失败（stub）', 'warn');
            });
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
          setStatus('探月任务 — stub（待实现三幕剧）', 'warn');
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

buildLayerTree();

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
let lastPickTime = 0;
viewer.camera.changed.addEventListener(() => {
  const now = Date.now();
  if (now - lastPickTime < 200) return;
  lastPickTime = now;

  const mousePos = viewer.scene.pickPositionSupported
    ? viewer.scene.globe.pick(
        viewer.camera.getPickRay(viewer.scene.canvas.clientWidth / 2, viewer.scene.canvas.clientHeight / 2),
        viewer.scene
      )
    : null;

  // 简单用 camera 位置估算（更准确的做法是监听 mouse move）
  const pos = viewer.camera.positionCartographic;
  const lon = Cesium.Math.toDegrees(pos.longitude);
  const lat = Cesium.Math.toDegrees(pos.latitude);
  const alt = pos.height;

  coordbarEl.textContent =
    `经度 ${lon.toFixed(2)}°  纬度 ${lat.toFixed(2)}°  海拔 ${(alt / 1000).toFixed(1)} km`;
});

// ====== 初始状态 ======
setStatus('地球场景就绪。勾选左侧图层开始探索。', 'ok');
