// src/terrarium-provider.js — 本地 Terrarium 高程地形（地理方案外壳 + 墨卡托瓦片重采样）
//
// 背景（2026-10-16 极冠黑洞根因）：Cesium 的 GlobeSurfaceTileProvider.tilingScheme
//   只读 terrainProvider.tilingScheme。本 provider 原先直接声明 WebMercatorTilingScheme，
//   导致整个地球 quadtree 变成墨卡托切分——±85.05° 之外没有任何瓦片几何，极冠区域
//   永远是黑洞（任何影像层都摸不到没有几何的区域）。旧文件头「极区保持平坦椭球面」
//   即为该后果的写照；极冠补丁做了三代都没生效，全因几何不存在。
//
// 现状设计（双方案，对外/对内分离）：
//   · 对外：provider 声明 GeographicTilingScheme → globe 恢复全极区几何（±90°），
//     极冠合成影像层（全球矩形 SingleTile）终于有瓦片可画。
//   · 对内：磁盘瓦片 tiles/terrain/{z}/{x}/{y}.png 是原生 Web Mercator XYZ
//     （AWS elevation-tiles-prod / Terrarium 编码），callback 收到的是地理瓦片索引，
//     经「经度恒等、纬度投影换算」映射到墨卡托源瓦片，再双线性重采样输出：
//       - 经度：两方案瓦片经度边界完全一致（level≥1 时 x 恒等；level 0 地理 2×1
//         对墨卡托 1×1，由源瓦片范围计算自动收敛）。
//       - 纬度：v = 0.5 - ln(tan(π/4 + φ/2)) / (2π)（Web Mercator 归一化纵坐标，
//         0 在北）；源瓦片按 [floor(vN·2^L), ceil(vS·2^L)-1] 取块，逐像素重采样。
//       - 极区（|φ| > 85.0511°）：墨卡托无数据，纵坐标钳制到边缘行 → 平坦
//         （本来就是冰盖/洋面，无地形可言）。
//
// 主体仍是 Cesium.CustomHeightmapTerrainProvider（内置 provider 负责瓦片调度、标准几何误差、
// 父级回退/上采样），本文件只提供 callback 做三件事：
//   1. 区域可用性判断（z0-z5 全球；z6-z9 中国 bbox；z10-z12 仅山脉兴趣点矩形；其余返回 undefined → 渲染父级）
//   2. 原生 Image 拉取 PNG（callback 上下文拿不到 Request，用 Resource.fetchImage 会被调度器静默丢弃）
//   3. 解码 Mapbox Terrarium 编码：height(m) = R*256 + G + B/256 - 32768
//
// 瓦片位于 tiles/terrain/{z}/{x}/{y}.png，数据源 AWS elevation-tiles-prod（Terrarium）。
// 下载范围（与 tools/download_terrain_tiles.py 完全对齐）：
//   z0-z5 全球 + z6-z9 中国 bbox[60,0,150,60] + z10-z12 山脉折线中点 ±3° 矩形。

import * as Cesium from 'cesium';
import { LAYER as MOUNTAINS } from './layers/mountains.js';

const SIZE = 256;             // 瓦片 PNG 尺寸（宽=高）
const GLOBAL_MAX_LEVEL = 5;   // 全球覆盖上限
const CHINA_MAX_LEVEL = 12;   // 中国/兴趣点覆盖上限（z10-z12 为山脉高精度，须与下载器对齐）
const PLACE_DELTA = 3;        // 兴趣点矩形半宽（度），与 download_terrain_tiles.py / emit_places.mjs 一致

// 中国区域覆盖 bbox [minLon, minLat, maxLon, maxLat]（度，预转弧度）
const CHINA_RECT = {
  west: Cesium.Math.toRadians(60),
  south: Cesium.Math.toRadians(0),
  east: Cesium.Math.toRadians(150),
  north: Cesium.Math.toRadians(60),
};

// 兴趣点矩形（山脉折线中点 ±PLACE_DELTA°）：z10-z12 仅这些区域放行，
// 避免全中国 z10-z12 海量瓦片；与下载器使用同一份 mountains.js 单一数据源。
const PLACE_RECTS = MOUNTAINS.groups
  .flatMap((g) => g.entities)
  .filter((e) => e.type === 'polyline' && Array.isArray(e.coords) && e.coords.length > 1)
  .map((e) => {
    const m = e.coords[Math.floor(e.coords.length / 2)];
    return Cesium.Rectangle.fromDegrees(
      m[0] - PLACE_DELTA, m[1] - PLACE_DELTA, m[0] + PLACE_DELTA, m[1] + PLACE_DELTA
    );
  });

// 对外：globe 瓦片几何用全极区地理切分（极冠补丁的前提，见文件头根因）
const geoScheme = new Cesium.GeographicTilingScheme();

// 对内：Web Mercator 归一化纵坐标换算常量（弧度）
const MERC_MAX_LAT = 1.4844222297453322; // 85.0511287798066°，= WebMercatorTilingScheme 纬度上限
const TWO_PI = 2 * Math.PI;
const MAX_SRC_TILES = 48;  // 单地理瓦片最多拼接多少张墨卡托源瓦片（极区高纬度时纵坐标被拉伸，数量会放大）
const SRC_CACHE_MAX = 2000;   // 墨卡托源瓦片解码缓存上限
const RESULT_CACHE_MAX = 500; // 地理瓦片重采样结果缓存上限

// 地理瓦片可用性判断（rect 由 geoScheme.tileXYToRectangle 给出，弧度）
function tileAvailable(x, y, level) {
  if (level <= GLOBAL_MAX_LEVEL) return true;            // z0-z5 全球
  if (level > CHINA_MAX_LEVEL) return false;             // z>12 不请求
  const r = geoScheme.tileXYToRectangle(x, y, level);
  if (level <= 9) {
    // z6-z9 中国 bbox 内放行（下载器也只下这个范围）
    return r.east > CHINA_RECT.west && r.west < CHINA_RECT.east
        && r.north > CHINA_RECT.south && r.south < CHINA_RECT.north;
  }
  // z10-z12 仅兴趣点矩形内放行（下载器只下这些 bbox），其余回落到 z9 中国地形
  for (const pr of PLACE_RECTS) {
    if (r.east > pr.west && r.west < pr.east && r.north > pr.south && r.south < pr.north) {
      return true;
    }
  }
  return false;
}

// Terrarium PNG → Float32 高度数组；残缺瓦片（>10% 像素为 -32768 深坑值，即解码失败征兆）
// 返回 undefined → 由调用方降级为平坦海平面，避免地表出现深坑。
function decodeTerrarium(img) {
  const w = img.naturalWidth ?? img.width;
  const h = img.naturalHeight ?? img.height;
  if (w !== SIZE || h !== SIZE) return undefined;
  const px = Cesium.getImagePixels(img, w, h);
  const heights = new Float32Array(w * h);
  let bad = 0;
  for (let i = 0; i < heights.length; i++) {
    const j = i * 4;
    let v = px[j] * 256 + px[j + 1] + px[j + 2] / 256 - 32768;
    if (v <= -32767) { bad++; v = 0; }
    heights[i] = Math.min(Math.max(v, -11000), 9000);
  }
  return bad > heights.length * 0.1 ? undefined : heights;
}

// 原生 Image 加载（不用 Resource.fetchImage：其内部 RequestScheduler 过载时会返回 undefined，
// 而 callback 里拿不到 Request 上下文，会静默丢瓦片）
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () =>
      img.decode().then(() => resolve(img)).catch(() => reject(new Error('decode failed: ' + src)));
    img.onerror = () => reject(new Error('load failed: ' + src));
    img.src = src;
  });
}

function flatHeights() {
  return new Float32Array(SIZE * SIZE); // 海平面 0m
}

// 墨卡托源瓦片缓存（失败也缓存平坦值，避免重复请求）；设上限防止长会话内存无界增长
const srcCache = new Map();

async function loadMercatorTile(x, y, level) {
  const key = `${level}/${x}/${y}`;
  if (srcCache.has(key)) return srcCache.get(key);
  let result;
  try {
    const img = await loadImage(`tiles/terrain/${level}/${x}/${y}.png`);
    result = decodeTerrarium(img) ?? flatHeights();
  } catch {
    result = flatHeights();
  }
  if (srcCache.size >= SRC_CACHE_MAX) srcCache.clear();
  srcCache.set(key, result);
  return result;
}

// 纬度（弧度）→ Web Mercator 归一化纵坐标 v ∈ [0,1]（0 在北）；极区外钳制到边缘行
function latToMercatorV(lat) {
  const phi = Math.max(-MERC_MAX_LAT, Math.min(MERC_MAX_LAT, lat));
  return 0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / TWO_PI;
}

// 地理瓦片结果缓存（同一地理瓦片 → 同一组源瓦片，结果确定）
const resultCache = new Map();

/**
 * 把地理瓦片 (x, y, level) 重采样为 SIZE×SIZE 高度数组：
 * 抓取覆盖该地理矩形的全部墨卡托源瓦片 → 拼成连续「源像素条带」→ 逐像素双线性采样。
 * 注意：内置 provider 对 callback 返回的 promise 一律 new HeightmapTerrainData({ buffer }),
 * resolve undefined 会构造出 buffer 为 undefined 的坏数据；「无数据走父级」只能通过
 * callback 同步返回 undefined 表达。因此任何失败路径一律 resolve 平坦海平面。
 */
async function loadHeightsGeographic(x, y, level) {
  const key = `${level}/${x}/${y}`;
  if (resultCache.has(key)) return resultCache.get(key);

  const rect = geoScheme.tileXYToRectangle(x, y, level);
  const n = 1 << level;
  const u0 = (rect.west + Math.PI) / TWO_PI;
  const u1 = (rect.east + Math.PI) / TWO_PI;
  const vN = latToMercatorV(rect.north); // 北边 → v 较小
  const vS = latToMercatorV(rect.south);
  const x0 = Math.max(0, Math.min(n - 1, Math.floor(u0 * n)));
  const x1 = Math.max(0, Math.min(n - 1, Math.ceil(u1 * n) - 1));
  const y0 = Math.max(0, Math.min(n - 1, Math.floor(vN * n)));
  const y1 = Math.max(0, Math.min(n - 1, Math.ceil(vS * n) - 1));

  const out = new Float32Array(SIZE * SIZE);

  if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_SRC_TILES) {
    // 极端情况（高等级极区瓦片，墨卡托纵坐标被极度拉伸）：退化为「中心最近源瓦片」
    // 整块返回，避免组合爆炸；极区反正被极冠影像层覆盖，地形平坦可接受。
    const sx = Math.max(0, Math.min(n - 1, Math.floor(((u0 + u1) / 2) * n)));
    const sy = Math.max(0, Math.min(n - 1, Math.floor(((vN + vS) / 2) * n)));
    out.set(await loadMercatorTile(sx, sy, level));
  } else {
    // 抓取源瓦片块并拼成连续条带（块内索引 = 全局墨卡托像素坐标 - 块原点）
    const cols = x1 - x0 + 1;
    const rows = y1 - y0 + 1;
    const SW = cols * SIZE;
    const SH = rows * SIZE;
    const strip = new Float32Array(SW * SH);
    const jobs = [];
    for (let sy = y0; sy <= y1; sy++) {
      for (let sx = x0; sx <= x1; sx++) {
        jobs.push(loadMercatorTile(sx, sy, level).then((h) => {
          const ox = (sx - x0) * SIZE;
          const oy = (sy - y0) * SIZE;
          for (let r = 0; r < SIZE; r++) {
            strip.set(h.subarray(r * SIZE, (r + 1) * SIZE), (oy + r) * SW + ox);
          }
        }));
      }
    }
    await Promise.all(jobs);

    // 预计算每行/每列对应的源条带像素坐标（对数/正切每行只算一次）
    const dLat = (rect.north - rect.south) / SIZE;
    const dLon = (rect.east - rect.west) / SIZE;
    const gyArr = new Float64Array(SIZE);
    for (let j = 0; j < SIZE; j++) {
      gyArr[j] = latToMercatorV(rect.north - (j + 0.5) * dLat) * n * SIZE - y0 * SIZE;
    }
    const gxArr = new Float64Array(SIZE);
    for (let i = 0; i < SIZE; i++) {
      gxArr[i] = ((rect.west + (i + 0.5) * dLon + Math.PI) / TWO_PI) * n * SIZE - x0 * SIZE;
    }

    const maxX = SW - 1;
    const maxY = SH - 1;
    for (let j = 0; j < SIZE; j++) {
      let gy = gyArr[j] - 0.5;
      if (gy < 0) gy = 0; else if (gy > maxY) gy = maxY;
      const iy = gy | 0;
      const iy1 = iy + 1 < SH ? iy + 1 : iy;
      const fy = gy - iy;
      const r0 = iy * SW;
      const r1 = iy1 * SW;
      const orow = j * SIZE;
      for (let i = 0; i < SIZE; i++) {
        let gx = gxArr[i] - 0.5;
        if (gx < 0) gx = 0; else if (gx > maxX) gx = maxX;
        const ix = gx | 0;
        const ix1 = ix + 1 < SW ? ix + 1 : ix;
        const fx = gx - ix;
        const a = strip[r0 + ix];
        const b = strip[r0 + ix1];
        const c = strip[r1 + ix];
        const d = strip[r1 + ix1];
        const top = a + (b - a) * fx;
        const bot = c + (d - c) * fx;
        out[orow + i] = top + (bot - top) * fy;
      }
    }
  }

  if (resultCache.size >= RESULT_CACHE_MAX) resultCache.clear();
  resultCache.set(key, out);
  return out;
}

export function createLocalTerrainProvider() {
  return new Cesium.CustomHeightmapTerrainProvider({
    width: SIZE,
    height: SIZE,
    tilingScheme: geoScheme, // 对外地理方案：globe 全极区几何（见文件头根因）
    callback: (x, y, level) =>
      tileAvailable(x, y, level) ? loadHeightsGeographic(x, y, level) : undefined,
  });
}

/**
 * 采样地表高程（米，相对 WGS84 椭球）：与 globe 完全同源的瓦片数据。
 * 从最高可用层级逐级往下找第一个 tileAvailable 的地理瓦片（发射台类非山脉点 → z9 中国地形），
 * 双线性插值出该点高程。
 *
 * ⚠ 为什么不用 Cesium.sampleTerrainMostDetailed（2026-10-17 实测踩坑）：
 *   该 API 内部读 terrainProvider.availability.computeMaximumLevelAtPosition，
 *   而 CustomHeightmapTerrainProvider 不设 availability → 直接抛
 *   "Cannot read properties of undefined (reading 'computeMaximumLevelAtPosition')"。
 *   previewLaunchSite 的 try/catch 会把它吞掉按 0 高程取景 → 酒泉（海拔 ~1 km）
 *   相机在地下 ~850 m，月面/地表预览全黑。本函数与渲染共用 loadHeightsGeographic，
 *   数据必然一致。
 */
export async function sampleTerrainHeight(lon, lat) {
  for (let level = CHINA_MAX_LEVEL; level >= 0; level--) {
    // ⚠ 坑（2026-10-17 实测）：GeographicTilingScheme 默认 numberOfLevelZeroTilesX=2
    //   （z9 时 x 方向 1024 块、每块 360/2^(L+1)°），不能按 1<<level 算 x，否则采样点
    //   落到西半球去（曾采到 -4942 m 的大西洋海底）。用 scheme 自己的计数函数。
    const xTiles = geoScheme.getNumberOfXTilesAtLevel(level);
    const yTiles = geoScheme.getNumberOfYTilesAtLevel(level);
    // 地理方案等距经纬切分：y=0 在北极，行向南增（与 tileXYToRectangle 一致）
    const x = Math.min(xTiles - 1, Math.max(0, Math.floor((lon + 180) / 360 * xTiles)));
    const y = Math.min(yTiles - 1, Math.max(0, Math.floor((90 - lat) / 180 * yTiles)));
    if (!tileAvailable(x, y, level)) continue;
    const heights = await loadHeightsGeographic(x, y, level);
    if (!heights) return 0;
    const rect = geoScheme.tileXYToRectangle(x, y, level);
    const west = Cesium.Math.toDegrees(rect.west), east = Cesium.Math.toDegrees(rect.east);
    const north = Cesium.Math.toDegrees(rect.north), south = Cesium.Math.toDegrees(rect.south);
    const u = Math.min(0.9999, Math.max(0, (lon - west) / (east - west)));
    const v = Math.min(0.9999, Math.max(0, (north - lat) / (north - south)));
    const fx = u * (SIZE - 1), fy = v * (SIZE - 1);
    const ix = fx | 0, iy = fy | 0;
    const ix1 = Math.min(SIZE - 1, ix + 1), iy1 = Math.min(SIZE - 1, iy + 1);
    const tx = fx - ix, ty = fy - iy;
    const a = heights[iy * SIZE + ix], b = heights[iy * SIZE + ix1];
    const c = heights[iy1 * SIZE + ix], d = heights[iy1 * SIZE + ix1];
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  }
  return 0;
}
