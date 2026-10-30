// src/osm-map-scene.js — 独立 OSM 矢量场景（MapLibre GL JS）
import { glyphRangePbf } from './osm-glyphs.js';
//
// 为什么存在：Cesium 的 MVTDataProvider（1.142 才加入）把 MVT 转 3D Tiles 后动态生成的
// 着色器在用户 GPU 上编译崩溃（空 Compile log = 驱动 TDR）。MapLibre 是 MVT 的成熟渲染器，
// 着色器保守稳定，绕开该崩溃。本模块与 Cesium 球体「全屏场景切换 + 相机握手」打通。
//
// 两种数据来源（场景内可切换）：
//  - 在线（默认）：OpenFreeMap 全球 OSM（含楼高、街道名、免费无密钥），需联网。
//  - 离线：本地 PMTiles 单文件（public/data/osm/pmtiles/<城市>.pmtiles，tools/osm-pmtiles-pipeline/pbf-to-pmtiles.py
//          生成，实测 433 城；勿写死数字，一律取 manifest 长度），经自定义协议 pmt:// 由 PMTilesReader 读取；含 height/levels 真楼高，
//          不依赖外网。城市清单见同目录 manifest.json（bbox 命中即用）。
//
// 球体右上角浮动区（globe-overlay，位于 cesium-navigation 控件下方，避免遮挡）：
//  - ⬇ 回顶视钮：相机倾斜时（pitch > -83.7°）浮现，点击原地压平 pitch=-90°（保持中心/高程）；
//  - 🗺 离线提示卡：相机高度 < 10km 且当前中心命中离线城市 bbox 时浮现，点击「查看街道级」
//    触发丝滑切换（Cesium 先拉远到交接高度 9km 保 z15 瓦片不空 → 交叉淡切）。

// 在线：OpenFreeMap 全球样式（OpenMapTiles schema，含 render_height + glyphs）
const OSM_STYLE_ONLINE = 'https://tiles.openfreemap.org/styles/liberty';

// 离线：PMTiles 单文件 + 城市 manifest
const PMTILES_BASE = window.location.origin + '/pmtiles/';
const MANIFEST_URL = window.location.origin + '/data/osm/pmtiles/manifest.json';
const HANDOFF_HEIGHT = 9000;    // 丝滑切换的交接高度(m)：对应 zoom≈15.1，恰为离线数据最高级
const HINT_HEIGHT = 10000;      // 提示卡浮现阈值(m)：低于此高度卫星图开始不够用
const RETURN_HEIGHT = 5000;     // 返回球体的固定相机高度(m)：按 zoom 换算会甩到几十公里外
// 进入 OSM 的默认俯仰角(°)：0 = 正俯视，此时 3D 建筑侧面为 0 像素、看不出楼高
const DEFAULT_PITCH = 35;

// ⭐⭐ 离线数据的「完整级」：实测（tools/osm-pmtiles-pipeline/inspect-pmtiles.mjs + 逐层普查）
//   本地 pmtiles 的分层策略是——**支路(residential/service/tertiary)与 area 面要素
//   （建筑/绿地/水域）只存在于 z15**，z14 及更低只有主干道、且完全没有 area 层：
//     z11: 5387 条路(全主干)   z12: 1366   z13: 404   z14: 121(仅主次干)   z15: 86(含支路) + area
//   → 所以在 z13/14 看城市必然「道路稀疏断续 + 建筑绿地全无」。源 pbf 已删、无法重抽，
//     前端只能保证**进入即落在 z15**（数据完整处），并在更低层级给出提示。
const DETAIL_ZOOM = 15;
// 无 height / building:levels 数据时的假定楼高(m)。实测唐镇 building 属性只有
// building/osm_id/name/layer（height、building:levels 均为 0 条）；中国大陆 OSM 建筑
// 高度标签覆盖率极低，10.5m 在 z15(~4.7 m/px) 只有 2px、俯视根本看不见。
// ⚠ 这是**假定值不是真实高度**，故用浅色 + 提示区分（真实高度走深色）。
const DEFAULT_BUILDING_M = 18;
let _prevCenter = null;         // 进入 OSM 前的相机中心 [lng,lat]（返回时回到该坐标，只改高度）

let _map = null;
let _inited = false;
let _active = false;
let _btn = null;
let _prevPlanet = 'cesiumContainer';
let _mode = 'online';          // 'online' | 'offline'
let _appliedMode = null;       // 当前已加载到地图的 style 模式（避免重复 setStyle）
let _appliedCity = null;       // ⭐ 当前 style 对应的离线城市：换城市必须重设 style
let _appliedKey = null;        // ⭐ '<mode>:<cityFile>' —— 模式或城市任一变化都要重新 setStyle
let _modeCtl = null;           // 场景内来源切换控件
let _modeBtns = {};
let _tiltBtn = null;
let _diagBadge = null;         // 接缝诊断的屏上统计条（见 refreshSeamDiag）
let _city = null;              // 离线模式命中的城市条目（manifest）
let _manifest = null;          // 离线城市清单（懒加载一次）
const _readers = new Map();    // file -> Promise<PMTilesReader|null>（懒加载 + 缓存）

// Cesium 相机高度(m) → MapLibre zoom（经验映射：z = 19 - log2(h/500)，clamp 2..19）
function cesiumHeightToZoom(h) {
  const z = 19 - Math.log2(Math.max(1, h) / 500);
  return Math.max(2, Math.min(19, z));
}
// 反向：zoom → 相机高度(m)
function zoomToCesiumHeight(z) {
  return Math.max(800, 500 * Math.pow(2, 19 - z));
}

function cesiumView() {
  const v = window.viewer;
  if (!v || !v.camera) return { center: [116.4, 39.9], zoom: 4 };
  try {
    const c = v.camera.positionCartographic; // 弧度 + height(m)
    const center = [(c.longitude * 180 / Math.PI), (c.latitude * 180 / Math.PI)];
    return { center, zoom: cesiumHeightToZoom(c.height) };
  } catch (e) {
    return { center: [116.4, 39.9], zoom: 4 };
  }
}

function planetContainers() {
  return ['cesiumContainer', 'moonContainer', 'marsContainer'];
}
function activePlanet() {
  for (const id of planetContainers()) {
    const el = document.getElementById(id);
    if (el && !el.classList.contains('hidden')) return id;
  }
  return 'cesiumContainer';
}

// ---------- 离线城市 manifest（实测 433 城；代码里一律取 _manifest.length，勿写死） ----------
async function loadManifest() {
  if (_manifest) return _manifest;
  try {
    const r = await fetch(MANIFEST_URL);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    // 只保留成功条目，按 bbox 面积升序（小城优先于大区矩形，命中更准）
    _manifest = Object.entries(d)
      .filter(([, v]) => v.ok && v.bbox)
      .map(([name, v]) => ({ name, file: v.file.replace(/^.*\//, ''), bbox: v.bbox,
        center: v.center, minz: v.minz, maxz: v.maxz,
        // ⭐ v3：该城瓦片是否已按「类别 × zoom」铺满 z11–z14（见 overviewMinZ）
        overview: v.overview === true }))
      .sort((a, b) => area(a.bbox) - area(b.bbox));
  } catch (e) {
    console.warn('[osm-scene] manifest 加载失败:', e);
    _manifest = [];
  }
  return _manifest;
}
function area(bb) { return Math.max(0, bb[2] - bb[0]) * Math.max(0, bb[3] - bb[1]); }
function inBbox(lng, lat, bb) {
  return lng >= bb[0] && lng <= bb[2] && lat >= bb[1] && lat <= bb[3];
}
// 命中当前中心的离线城市（面积最小者优先）；无 manifest 返回 null
function hitCity(lng, lat) {
  if (!_manifest) return null;
  for (const c of _manifest) {
    if (inBbox(lng, lat, c.bbox)) return c;
  }
  return null;
}

// ---------- PMTiles 自定义协议（MapLibre addProtocol 桥接零依赖读取器） ----------
// ⚠ MapLibre GL JS 4.x 起 addProtocol 是 Promise-based（v3 的 (params, callback) 签名已移除）：
//   handler = async (params, abortController) => { data } | null；null = 无此瓦片（不报错）。
let _protoRegistered = false;
function registerPmtProtocol() {
  if (_protoRegistered || typeof maplibregl === 'undefined' || !maplibregl.addProtocol) return;
  // tiles 模板：pmt://<encodeURIComponent(file)>/{z}/{x}/{y}
  maplibregl.addProtocol('pmt', async (params) => {
    const m = params.url.match(/^pmt:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)/);
    if (!m) return null;
    const file = decodeURIComponent(m[1]);
    const z = +m[2], x = +m[3], y = +m[4];
    const r = await getReader(file);
    if (!r) return null;
    try {
      const data = await r.getTile(z, x, y);
      if (!data || !data.length) return null;   // 无此瓦片 → MapLibre 视为空，不报错
      // ⭐ 必须返回**独立副本**：getTile 给的可能是 25MB 共享缓冲上的视图（subarray）。
      //   若它随结构化克隆/transfer 被共享或分离，同批其它瓦片会连带失效 ——
      //   实测 8 块瓦片只有 1 块 loaded、7 块静默 errored，正是这个症状。
      return { data: new Uint8Array(data) };
    } catch (e) {
      console.warn('[osm-scene] pmtiles 瓦片读取失败:', z, x, y, e);
      return null;
    }
  });
  _protoRegistered = true;
}

// ---------- 在线 OSM 矢量瓦片代理协议（osmvt:// → /osm-vt/ 本地缓存） ----------
// 把 OpenFreeMap 的 https://*.openfreemap.org/... 改写成 osmvt://...，请求经 app.py
// /osm-vt/ 路由回源并落盘 public/osm-vt/，实现与 tiles/ 体系一致的本地缓存。
// ---------- 字形（glyphs）：非 CJK 本地生成 + CJK 兜底 ----------
// ⭐ 关键坑（2026-10-28 实测）：glyphs 服务器不可达时，MapLibre 的 protocol 若返回 null，
//   会当成 tile 加载错误 —— 结果不是「少几个字」，而是**整块瓦片的文字一起丢掉**，
//   离线城市于是一条街道名都不出（本地 pmtiles 里 name 明明有 1000+ 条，已用
//   tools/osm-pmtiles-pipeline/inspect-pmtiles.mjs 验证）。
// ⭐⭐ 更深的坑（2026-10-29 米兰）：只回「空字形 PBF」也不够 —— 空字形只救得了中日韩
//   （MapLibre 有 localIdeographFontFamily 回退，会用本机字体现生成 SDF），**拉丁字母不在
//   该回退范围内** → 米兰/罗马/巴黎整城无字（实测 pmt-road-label 可见要素 = 0）。
//   正解：拉丁等非 CJK 区间由 src/osm-glyphs.js 用 Canvas + SDF 距离变换**本地生成**字形，
//   CJK 区间仍回空字形、交给 localIdeographFontFamily。两者互补，才算真正离线可用。
function varintBytes(n) {
  const out = [];
  do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n);
  return out;
}
// Glyphs{ stacks: Fontstack{ name: string, glyphs: [] } } —— 只写 name，glyphs 省略即为空
function emptyGlyphPbf(stack) {
  const nm = Array.from(new TextEncoder().encode(stack));
  const inner = [0x0a, ...varintBytes(nm.length), ...nm];
  return new Uint8Array([0x0a, ...varintBytes(inner.length), ...inner]);
}

let _osmvtRegistered = false;
function registerOsmVtProtocol() {
  if (_osmvtRegistered || typeof maplibregl === 'undefined' || !maplibregl.addProtocol) return;
  maplibregl.addProtocol('osmvt', async (params) => {
    const rest = params.url.slice('osmvt://'.length);
    // 字形请求：<host>/<fontstack>/<range>.pbf。
    // ⭐ 离线场景不该为「字体」去联网：上游 fonts.openfreemap.org 常年不可达，
    //   而浏览器单域名并发连接只有 6 条，几个挂起 20s 的字形请求足以把后续请求全堵住。
    //   这里对字形一律**本地即时返回空字形**（不 fetch），中文靠 localIdeographFontFamily
    //   本机字体渲染，零网络、零等待。
    const gm = rest.match(/^[^/]+\/(.+)\/(\d+)-(\d+)\.pbf$/);
    if (gm) {
      const stack = decodeURIComponent(gm[1]);
      const start = +gm[2], end = +gm[3];
      try {
        // ⭐⭐ 拉丁字母走**本机生成**的 SDF 字形（src/osm-glyphs.js）：
        //   空字形兜底只能救中日韩（有 localIdeographFontFamily 回退），拉丁字母取不到字形
        //   会让整条标签被丢弃 —— 米兰/罗马这类城市因此一条街道名都不出（实测 label 要素 = 0）。
        const pbf = glyphRangePbf(stack, start, end);
        if (pbf) return { data: pbf };
      } catch (e) { console.warn('[osm-scene] 本地字形生成失败:', e); }
      // CJK 区间（以及生成失败）→ 空字形，交给 MapLibre 的 localIdeographFontFamily 用本机字体渲染
      try { return { data: emptyGlyphPbf(stack) }; } catch (e) { return null; }
    }
    // 非字形（在线瓦片/样式）：走代理，但**必须快速失败**，不能长挂
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      let r;
      try { r = await fetch('/osm-vt/' + rest, { signal: ctrl.signal }); }
      finally { clearTimeout(timer); }
      if (r.ok) return { data: new Uint8Array(await r.arrayBuffer()) };
    } catch (e) { /* 落空 → 返回 null */ }
    return null;
  });
  _osmvtRegistered = true;
}

// 递归改写 style JSON 中的 openfreemap.org 绝对 URL → 本地代理路径 /osm-vt/<host>/<path>
// ⭐ 为什么用普通路径而不是自定义协议（2026-10-29 实测）：
//   osmvt:// 协议对**矢量瓦片**没问题（返回 ArrayBuffer），但 sprite 是图片，
//   MapLibre 的图片管线要 ImageBitmap，经自定义协议返回的字节解码不出图 →
//   满屏 'Image "bus" could not be loaded'，POI 图标全丢。
//   普通路径留在同源 fetch 链上，图片按原逻辑解码，且同样享受落盘缓存。
//   唯一例外是字形（glyphs）：它必须留在 osmvt:// 上，才能被我们的协议截住、
//   用本机字体本地生成（上游 fonts.openfreemap.org 常年不可达）。
const OSM_VT_PREFIX = '/osm-vt/';
// ⚠️ 必须拼成**绝对 URL**：MapLibre 内部用 `new Request(url)` 发瓦片请求，
//   相对路径会直接抛 "Failed to parse URL"（实测 6 个瓦片全 errored）。
function osmVtAbs(p) {
  return location.origin + OSM_VT_PREFIX + p;
}
function rewriteOsmUrls(o) {
  if (typeof o === 'string') {
    return o.replace(/^https:\/\/([\w.-]+\.)*openfreemap\.org\//,
      (m) => osmVtAbs(m.slice('https://'.length)));
  }
  if (Array.isArray(o)) return o.map(rewriteOsmUrls);
  if (o && typeof o === 'object') {
    for (const k in o) o[k] = rewriteOsmUrls(o[k]);
    return o;
  }
  return o;
}

let _onlineStyle = null;
// 在线 style：fetch OpenFreeMap 后改写 URL 走本地代理（内存缓存，避免重复拉取）
async function resolveStyle(mode) {
  if (mode === 'offline') return _city ? offlineStyleFor(_city) : null;
  if (_onlineStyle) return _onlineStyle;
  try {
    // 优先走本地代理（可落盘缓存、且不依赖浏览器直连上游），失败再直连
    let r = null;
    for (const u of ['/osm-vt/tiles.openfreemap.org/styles/liberty', OSM_STYLE_ONLINE]) {
      try {
        const rr = await fetch(u);
        if (rr.ok) { r = rr; break; }
      } catch (e) { /* 试下一个 */ }
    }
    if (!r) throw new Error('style 不可达');
    const s = await r.json();
    // ⭐⭐ 必须把 TileJSON 展开（2026-10-29 实测，长期「在线始终加载不出来」的最后一环）：
    //   样式里的 source 写的是 `url: 'https://tiles.openfreemap.org/planet'`，MapLibre 会在
    //   运行时自己去拉这份 TileJSON，而 TileJSON 里的 tiles[] 是**上游绝对 https 地址** ——
    //   它们不经过 rewriteOsmUrls（那只改写 style 对象本身），于是所有瓦片请求都绕过本地代理
    //   直连 openfreemap。浏览器实测的后果：flask 只收到 /planet 与 sprite 两次请求，
    //   一个 .pbf 都没有；直连一旦不可用，12 个瓦片全部 errored、整屏空白。
    //   做法：这里同步把 TileJSON 拉下来（经 /osm-vt 代理）、把 tiles 数组塞进 source、
    //   删掉 url —— 之后所有瓦片都走 osmvt:// → 本地代理 + 落盘缓存。
    for (const src of Object.values(s.sources || {})) {
      if (!src || typeof src.url !== 'string') continue;
      const abs = src.url;
      try {
        const tjUrl = '/osm-vt/' + abs.replace(/^https:\/\//, '');
        const tj = await (await fetch(tjUrl)).json();
        if (Array.isArray(tj.tiles) && tj.tiles.length) {
          src.tiles = tj.tiles.slice();
          if (tj.minzoom != null) src.minzoom = tj.minzoom;
          if (tj.maxzoom != null) src.maxzoom = tj.maxzoom;
          if (tj.bounds) src.bounds = tj.bounds;
          delete src.url;
        }
      } catch (e) {
        console.warn('[osm-scene] TileJSON 展开失败（保持 url 直连）:', abs, e);
      }
    }
    rewriteOsmUrls(s);
    // 字形是唯一必须留在自定义协议上的资源：协议里会**本地生成** SDF 字形，
    // 不去上游下载（fonts.openfreemap.org 实测不可达，一旦 502 整块文字都会丢）。
    s.glyphs = 'osmvt://fonts.openfreemap.org/{fontstack}/{range}.pbf';
    _onlineStyle = s;
  } catch (e) {
    console.warn('[osm-scene] 在线 style 加载/改写失败，回退远程 URL:', e);
    return OSM_STYLE_ONLINE;
  }
  return _onlineStyle;
}

// ⭐⭐ 只取文件名：manifest 的 file 字段写作 'pmtiles/亚洲_中国_上海.pmtiles'（带目录前缀），
//   而 PMTILES_BASE 已经是 '/pmtiles/' —— 直接拼接会得到 '/pmtiles/pmtiles/xxx.pmtiles'
//   → **404** → PMTilesReader.open 抛错 → 所有瓦片加载失败 → MapLibre 退回显示父级瓦片
//   （父级只有主干道、没有建筑），画面上就是「部分区块空白 + 道路接缝对不上 + 没有楼」。
//   实测：curl /pmtiles/<file> = 200，/pmtiles/pmtiles/<file> = 404。
function pmtilesUrl(file) {
  return PMTILES_BASE + encodeURIComponent(String(file || '').replace(/^.*\//, ''));
}

async function getReader(file) {
  if (_readers.has(file)) return _readers.get(file);
  if (typeof PMTilesReader === 'undefined') {
    console.warn('[osm-scene] PMTilesReader 未加载（vendor/pmtiles-reader.js）');
    return null;
  }
  const url = pmtilesUrl(file);
  const p = PMTilesReader.open(url);
  _readers.set(file, p);               // 存 Promise 防并发重复 fetch
  try {
    const r = await p;
    if (!r) { _readers.delete(file); return null; }
    return r;
  } catch (e) {
    console.error('[osm-scene] pmtiles 打开失败:', url, e);
    _readers.delete(file);
    return null;
  }
}

// 探测：在线样式（OpenFreeMap）是否可达。与 resolveStyle 同序：先本地代理，再直连。
async function probeOnline() {
  for (const u of ['/osm-vt/tiles.openfreemap.org/styles/liberty', OSM_STYLE_ONLINE]) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      const r = await fetch(u, { method: 'GET', signal: ctrl.signal });
      clearTimeout(t);
      if (r.ok) return true;
    } catch (e) { /* 试下一个 */ }
  }
  return false;
}

// 返回 { mode, city, banner }
async function autoDetect(lng, lat) {
  await loadManifest();
  const city = hitCity(lng, lat);
  if (city) return { mode: 'offline', city, banner: null };
  const onlineOk = await probeOnline();
  if (onlineOk) return { mode: 'online', city: null, banner: null };
  // 都失败：离线兜底（manifest 第一城）+ 横幅提示
  const fallback = _manifest && _manifest.length ? _manifest[0] : null;
  return {
    mode: 'offline', city: fallback,
    banner: '⚠ 在线地图服务不可达，且当前区域无本地离线数据；已加载离线兜底' +
      (fallback ? `（${fallback.name}）` : '') + '，请联网后重试。',
  };
}

// 顶部横幅（非阻塞）
function osmBanner(msg) {
  let b = document.getElementById('osmBanner');
  if (!b) {
    b = document.createElement('div');
    b.id = 'osmBanner';
    b.style.cssText = 'position:absolute;top:0;left:0;right:0;z-index:30;background:#c0392b;color:#fff;' +
      'font:13px sans-serif;padding:8px 12px;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.3)';
    const osm = document.getElementById('osmMap');
    if (osm) osm.appendChild(b);
  }
  b.textContent = msg;
  b.style.display = msg ? 'block' : 'none';
}
function clearOsmBanner() { osmBanner(null); }

// 当前中心是否在任一离线城市覆盖内（manifest 驱动）
function offlineCovers(lng, lat) {
  return !!hitCity(lng, lat);
}

// ---------- 离线 style（PMTiles 单源；MVT schema：transportation 线 / area 面） ----------
// 数据完整级：本地 pmtiles 只在这一级同时具备支路 + 建筑 + 绿地。
// 实测（米兰逐个 z 计数）：z15 单瓦片 transportation 1908 / area 502，
// 而 z11–z14 只有主干道（z14 单瓦片仅 90 条、零 area 面）—— 低层级是另一套抽稀数据。
// 所以「完整级」= min(DETAIL_ZOOM, 城市最高级)，任何一步取层级都必须用它而不是 city.minz。
function detailZ(city) {
  const hi = (city && city.maxz) || DETAIL_ZOOM;
  return Math.min(DETAIL_ZOOM, hi);
}

// ⭐ v3 概览层（2026-10-29）：重跑过管线的城市，z11–z14 里也有水体/绿地/分级路网
//   （manifest 条目带 overview:true，由 tools/osm-pmtiles-pipeline/pbf-to-pmtiles.py 写入）。
//   只有这类城市才允许把缩放下限放到 city.minz —— 老文件（overview 缺失）z11–z14
//   是「只有几根主干道、零面积面」的空图，缩过去就是白屏，必须继续钉在 detailZ。
function overviewMinZ(city) {
  if (city && city.overview) return Math.max(2, city.minz || DETAIL_ZOOM);
  return detailZ(city);
}

// ⭐⭐ 水体/绿地的**完整**判据（2026-10-29 第六轮根因）。
//   原来 pmt-water 用 `['has','water']`，只命中带 `water=lake/river/pond` 子标签的面；
//   而 OSM 里大量水面**只有 `natural=water`**、没有 `water=*` 子标签（实测上海 z11 单瓦片
//   199 个水体里 62 个 = 31%，z13 21 个里 10 个 = 48%）。这些面全被漏画。
//   同一条江的不同河段 way 标注不一致（有的带 water=river、有的不带），于是渲染结果就是
//   「江/河一段画出来、一段留白」—— 用户一直描述的「纵向三段不连续」的真身。
//   更糟的是 pmt-green 的 `['has','natural']` 又把它们当绿地涂绿 → 漏掉的那段变成绿色。
//   判据必须与管线 pbf-to-pmtiles.py::is_water()/is_green() **逐项一致**，否则永远对不齐。
const F_WATER = ['any',
  ['has', 'water'],
  ['match', ['get', 'natural'], ['water', 'wetland', 'bay', 'strait'], true, false],
  ['match', ['get', 'landuse'], ['reservoir', 'basin', 'salt_pond'], true, false],
  ['match', ['get', 'waterway'], ['riverbank', 'dock', 'canal'], true, false],
];
const F_GREEN = ['any',
  ['match', ['get', 'landuse'], ['forest', 'grass', 'meadow', 'farmland', 'orchard',
    'vineyard', 'village_green', 'recreation_ground', 'cemetery'], true, false],
  ['match', ['get', 'natural'], ['wood', 'scrub', 'heath', 'grassland', 'tree_row'], true, false],
  ['match', ['get', 'leisure'], ['park', 'garden', 'golf_course', 'nature_reserve', 'pitch'], true, false],
];

function offlineStyleFor(city) {
  const id = 'pmt';
  const layers = [
    // ⭐ 底色用「陆地色」而不是原来的浅蓝灰 #eef3f5。
    //   原因：OSM 的 landcover 数据本身不连续 —— 相邻两块水/绿地面之间常有几米到几十米的空隙
    //   （尤其黄浦江这类被分成多段 osm way 的大水体），空隙里露出的是背景色。
    //   旧背景色是偏蓝的浅灰，和水的 #aadaff 太接近，露出来就像「河面被切成两段还错位了」。
    //   换成暖调陆地色后，任何空隙都读作「未测绘的陆地」，不再像渲染断裂。
    { id: 'bg', type: 'background', paint: { 'background-color': '#f2efe9' } },
    // ⭐ 绘制顺序：绿地在下、水域在上。两者都改成了不透明（见下方说明），
    //   若水域先画会被绿地(命中 natural=water)整个盖住 —— 顺序必须反过来。
    // 绿地 / 用地 / 公园（landuse/leisure/natural）—— 先画，垫在最下层
    // ⭐ 判据用 F_GREEN 白名单，**不能**再写 `['has','natural']`：那样会把 `natural=water`
    //   的江面一并涂成绿色（漏画的水面就变成绿地，是「河流断裂」的另一半成因）。
    // ⭐⭐ 陆地铺底（2026-10-29）：把 area 层**所有**面先铺成陆地色，再让水/绿覆盖。
    //   根因：我们原来只画 water 和 green 两类面，其余面（`landuse=port/industrial`、
    //   `man_made=pier`、`natural=beach`、`amenity=...` 等）**一律不画 → 露出背景色**。
    //   在陆地上看不出（背景本来就是陆地色），但在**江面中间**就表现为「江被挖掉一块」，
    //   实测离线江内背景色像素 6380，而在线 OpenFreeMap 是 **0**（它有完整 landcover 铺底）。
    //   这一层不改任何已有颜色，只保证「有面的地方永远不会露底色」。
    { id: 'pmt-land', type: 'fill', source: id, 'source-layer': 'area',
      paint: { 'fill-color': '#ece7dd', 'fill-opacity': 1 } },
    // ⭐⭐ 水域垫底（2026-10-29）：在所有面之下再铺一层水体。
    //   作用不是可见效果，而是**兜底** —— 任何上层（绿地、3D 挤出、抗锯齿边）在江面上
    //   造成的漏色都会露出这一层的蓝，而不是背景陆地色。
    { id: 'pmt-water-under', type: 'fill', source: id, 'source-layer': 'area',
      filter: F_WATER,
      paint: { 'fill-color': '#aadaff', 'fill-opacity': 1 } },
    { id: 'pmt-green', type: 'fill', source: id, 'source-layer': 'area',
      filter: F_GREEN,
      paint: { 'fill-color': '#cfe8c2', 'fill-opacity': 1 } },
    // 水域（area 层）—— 后画压住绿地
    { id: 'pmt-water', type: 'fill', source: id, 'source-layer': 'area',
      filter: F_WATER,
      paint: { 'fill-color': '#aadaff', 'fill-opacity': 1 } },
    // ⭐⭐ 水域描边（同色 line）。不是装饰，是**补缝 + 软化岸线台阶**。
    //   证据链（2026-10-29 用 tools/osm-pmtiles-pipeline/render-tile-block.py 把瓦片
    //   数据直接栅格化后做连通域分析，块内 384px/瓦片 = 3.2m/px）：
    //     · 膨胀 0px：水体 117 个连通块（最大仅 41k px）
    //     · 膨胀 1px：合并成 1 个 468k px 的大水体
    //   → 大江在源数据里被拆成多段闭合 way，段与段之间留 1–2px（≈3–6m）的缝；
    //     旧 3px 描边只向两侧各扩 1.5px，正好卡在临界值，pitch 视角/不同缩放下会漏出
    //     一条浅色细缝（用户早期描述「江面被水平切一刀」）。
    //   现在：宽度 5px + round join/cap —— 缝被吃掉，且岸线的 90° 直角转折被圆角软化，
    //   不再像「瓷砖拼缝」。代价是水面外扩约 2.5px（z15 ≈ 6m），肉眼无感。
    { id: 'pmt-water-edge', type: 'line', source: id, 'source-layer': 'area',
      filter: F_WATER,
      // ⚠ line-join / line-cap 是 **layout** 属性，写进 paint 会被样式校验拒绝
      //   → 整个 style 加载失败 → 场景直接掉回「在线/空白」（本次实测踩过）。
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': '#aadaff',
        'line-width': ['interpolate', ['linear'], ['zoom'], 13, 3.5, 15, 5, 17, 7],
        'line-opacity': 1,
      } },
    // ⭐⭐ 不要加「建筑底面」fill 层！曾经有一层 `pmt-building`（type: fill，淡米色）垫在
    //   3D 挤出层下面。pitch>0 时它画的是**地面轮廓**，而 fill-extrusion 的立体块往上挤出，
    //   两者在屏幕上错开 —— 从高处看就是每栋楼都拖着一个浅色"影子"，用户直接描述为
    //   「建筑错位/重影」。3D 层 base=0 本身已覆盖地面，这一层纯属有害无益，已删除。
    //   真 3D 建筑
    { id: 'pmt-3d', type: 'fill-extrusion', source: id, 'source-layer': 'area',
      minzoom: 12, filter: ['has', 'building'],
      paint: {
        // ⭐ 有真实高度用深色，缺数据走假定高度的用浅色 —— 一眼能分辨哪些是实测值。
        //   实测：唐镇 z15 building 属性只有 building/osm_id/name/layer，
        //   height 与 building:levels 均为 0 条；另有个别 height='0'（字符串）。
        'fill-extrusion-color': [
          'case',
          ['>', ['to-number', ['coalesce', ['get', 'height'], 0]], 1], '#c98f52',
          ['>', ['to-number', ['coalesce', ['get', 'building:levels'], 0]], 0], '#cf9a63',
          '#d9b38c',
        ],
        'fill-extrusion-opacity': 1,
        'fill-extrusion-base': 0,
        'fill-extrusion-vertical-gradient': true,
        // ⭐⭐ 不能写 ['coalesce', ['to-number', ['get','height']], ...] 了事：
        //   height 若是字符串 '0'（实测确有），to-number → 0，coalesce 认为 0 是有效值
        //   → 楼高 = 0 → **完全看不见，连默认高度都不生效**。必须用 case 先判 >1 再取。
        'fill-extrusion-height': [
          'case',
          ['>', ['to-number', ['coalesce', ['get', 'height'], 0]], 1],
          ['to-number', ['get', 'height']],
          // ⭐ 层高系数：building:levels × 3.5m。欧洲（尤其意大利老城区）层高普遍 3.3–3.6m，
          //   原 3.2 偏矮 —— 少一层就少 30cm，五层楼整整矮 1.5m，在 z15 上就是「看不出高低」。
          ['>', ['to-number', ['coalesce', ['get', 'building:levels'], 0]], 0],
          ['*', ['to-number', ['get', 'building:levels']], 3.5],
          DEFAULT_BUILDING_M,
        ],
      } },
    // 道路描边（casing）：先铺一层浅灰底，再压白线 —— 让稀疏路网在浅底上有骨架感，
    // 缓解「支路只在 z15」造成的断续观感
    { id: 'pmt-road-casing', type: 'line', source: id, 'source-layer': 'transportation',
      filter: ['has', 'highway'],
      paint: {
        'line-color': '#d9d3c6',
        // ⭐ v3：低层级也要有骨架 —— z11 只有 motorway/trunk，原来 1.2/0.7px 的白线
        //   铺在 #f2efe9 陆地色上几乎不可见，缩小后整屏读作「没有路」。
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 2.6, 13, 3.4, 14, 4.6, 15, 6.5],
        'line-opacity': 1,
      } },
    // 道路（transportation 层 highway 标记）
    // ⭐ v3：按等级上色（高速/主干=橙黄、次干=米黄、其余=白），否则缩小后一片白噪点。
    { id: 'pmt-road', type: 'line', source: id, 'source-layer': 'transportation',
      filter: ['has', 'highway'],
      paint: {
        'line-color': ['match', ['get', 'highway'],
          ['motorway', 'trunk', 'motorway_link', 'trunk_link'], '#f0a94e',
          ['primary', 'primary_link'], '#f7cb7a',
          ['secondary', 'secondary_link', 'tertiary', 'tertiary_link'], '#fbe7bd',
          '#ffffff'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1.6, 13, 2.2, 14, 3.0, 15, 4.8],
        'line-opacity': 1,
      } },
    // 水系线（waterway）
    // ⭐⭐ 颜色必须用**和江面填色一模一样**的 #aadaff（2026-10-29 用户截图复盘）：
    //   原来用深一点的 #7ec8ff，而大江的 `waterway=river` 中心线就压在自带的面填色上，
    //   于是江面上出现一条条斜穿的深蓝细线 —— 用户直接描述为「江段被切成几段/错位」。
    //   实测证据：江面区域取色统计里 #7ec8ff 出现 155+ 像素（tools/shots/ui/diag-*.png）。
    //   同色后：江面上完全隐形；陆地小溪仍是浅蓝细线（与水面同色系，观感一致）。
    { id: 'pmt-waterway', type: 'line', source: id, 'source-layer': 'transportation',
      filter: ['has', 'waterway'],
      // ⭐ v3：river/canal 中心线现在也进 z11/z12（低层级水面的连续骨架）。
      //   线宽必须随 zoom 收细，否则 z11 视野下 2px 相对太粗，像一层蓝网。
      paint: {
        'line-color': '#aadaff',
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1.2, 13, 1.6, 15, 2.2, 17, 3],
        'line-opacity': 1,
      } },
    // 街道名称（离线数据含 name/name:en；字体走 osmvt 代理缓存的 OpenFreeMap glyphs）
    // ⭐ text-field 必须 **中文优先**：name:en 是拉丁字符，会逼 MapLibre 去 glyphs 服务器
    //   取字形；该服务器不可达时（本地实测 public/osm-vt 零缓存）整块文字被丢弃。
    //   中文名则完全走 localIdeographFontFamily 的本机字体，零网络请求。
    { id: 'pmt-road-label', type: 'symbol', source: id, 'source-layer': 'transportation',
      minzoom: 12,
      filter: ['all', ['has', 'highway'], ['has', 'name']],
      layout: {
        'symbol-placement': 'line',
        'text-field': ['coalesce', ['get', 'name'], ['get', 'name:zh'], ['get', 'name:en']],
        'text-font': ['Noto Sans Regular'],
        'text-size': 12,
        'text-max-angle': 30,
        'text-padding': 2,
      },
      paint: {
        'text-color': '#33414f',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.4,
      } },
    // 区域名（公园 / 绿地 / 水体等 area 面要素的名称），同上中文优先
    { id: 'pmt-area-label', type: 'symbol', source: id, 'source-layer': 'area',
      minzoom: 14,
      filter: ['all', ['has', 'name'],
        ['any', ['has', 'leisure'], ['has', 'natural'], ['has', 'landuse'], ['has', 'water']]],
      layout: {
        'text-field': ['coalesce', ['get', 'name'], ['get', 'name:zh'], ['get', 'name:en']],
        'text-font': ['Noto Sans Regular'],
        'text-size': 11,
        'text-max-width': 7,
        'text-padding': 2,
      },
      paint: {
        'text-color': '#4a6a52',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.2,
      } },
  ];
  return {
    version: 8,
    glyphs: 'osmvt://fonts.openfreemap.org/{fontstack}/{range}.pbf',
    sources: {
      [id]: {
        type: 'vector',
        tiles: [`pmt://${encodeURIComponent(city.file)}/{z}/{x}/{y}`],
        // promoteId：把 `osm_id` 提升为**要素 id**（CrossTileSymbolIndex、feature-state、
        //   queryRenderedFeatures 都以 feature.id 作键）。我们生成的 MVT 要素 id 全为 0
        //   （实测 transportation 707/707、area 566/566），加这行后渲染要素 119/119 都有 id。
        //   ⚠️ 实测结论：它**不减少**同名标注重复 —— 开关前后都是「119 放置 / 111 唯一名 / 6 个重名」，
        //   那些重名是真实存在的同名道路分段（如 Piazza del Duomo 被瓦片切成 3 段，各自 osm_id 不同）。
        //   保留价值在于要素级操作（选中/高亮/feature-state）。
        promoteId: 'osm_id',
        // ⭐⭐ minzoom 也钉在「数据完整级」，不能写 city.minz：
        //   离线 pmtiles 的 z11–z14 是**另一套抽稀数据**（只有主干道，几何还额外简化，
        //   与 z15 的同一条路能差几十米）。而 MapLibre 在 pitch>0 时会按屏幕空间误差
        //   对**远处**自动改用低层级瓦片 —— 于是画面上出现一条水平接缝：远处是 z14 的
        //   稀疏主干道、近处是 z15 的细密路网，看着就是「道路整块错位」（用户实测截图）。
        //   钉死上下限后，远近都用同一份 z15 数据，几何与细节永远一致，接缝消失。
        //   代价：不再自动降级 —— 但「缩小」仍然可用（见下一段）。
        // ⭐ 2026-10-29 用户定案：缩小**不切在线**，用本地数据自己渲染。
        //   v3 管线重跑过的城市（overview:true）在 z11–z14 也铺了水体/绿地/分级路网，
        //   所以这类城市可以把 source.minzoom 放到 city.minz，真正任缩到 11 级；
        //   老文件仍钉在 detailZ（低层级无内容，缩过去就是白屏）。
        minzoom: overviewMinZ(city), maxzoom: detailZ(city),
      },
    },
    layers,
  };
}

// 离线把场景缩放下限对齐「本地数据能支撑的最低级」；在线恢复自由缩放。
// 联动点：首次创建、applyMode（数据来源切换/换城市）、autoDetectAndShow 复用分支。
function syncZoomLimits() {
  if (!_map) return;
  const lo = (_mode === 'offline' && _city) ? zoomFloorFor(_city) : 2;
  try {
    _map.setMinZoom(lo);
    _map.setMaxZoom(19);
    // 只在「比下限还小」时抬回下限（切城市时可能发生）；否则不动用户视角
    if (_mode === 'offline' && _map.getZoom() < lo - 0.01) _map.jumpTo({ zoom: lo });
  } catch (e) { /* 样式切换中可能暂不可用，非致命 */ }
}

// ---------- 离线「缩小」策略（2026-10-29 用户定案：不再自动切在线） ----------
// 历史结论（仍然有效）：**MapLibre 4.7 不会 overzoom-out** —— source.minzoom=15 时把
//   map.zoom 降到 13，它一块瓦片都不请求（sourceCaches.pmt._tiles 空、整屏背景色）。
//   即「拿 z15 瓦片铺 z13 视野」渲染层做不到，只能靠**数据侧补出低层级瓦片**。
// v3 管线（2026-10-29）就是干这个的：z11–z14 现在也有水/绿/分级路网。
// 所以：overview 城市 → 下限放到 city.minz；其余城市 → 仍钉 detailZ + 一次性提示。
const ZOOM_OUT_SPAN = 0;   // 已由 v3 数据侧解决，留作兼容旧调用

function zoomFloorFor(city) {
  return Math.max(2, overviewMinZ(city) - ZOOM_OUT_SPAN);
}

// 触底提示：只在真的「再往外滚也缩不动」时说一次，不改变模式。
let _floorHintAt = 0;
function wireZoomFloorHint() {
  const el = osmMapEl();
  if (!el) return;
  const maybeHint = () => {
    if (_mode !== 'offline' || !_city || !_map) return;
    const lo = zoomFloorFor(_city);
    if (_map.getZoom() > lo + 0.05) return;
    if (Date.now() - _floorHintAt < 8000) return;
    _floorHintAt = Date.now();
    osmBanner(`ⓘ 这座城市的离线瓦片只做到 ${lo} 级（它的 z11–z14 只有主干道、没有水面绿地）。`
      + '要更大范围请手动点左上角「数据来源 → 在线」，或用 v3 管线重跑该城（z11–z14 就会补齐）。');
    setTimeout(() => { if (_active && _mode === 'offline') clearOsmBanner(); }, 4200);
  };
  el.addEventListener('wheel', (e) => { if (e.deltaY > 0) setTimeout(maybeHint, 300); }, { passive: true });
  el.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('.maplibregl-ctrl-zoom-out');
    if (btn) setTimeout(maybeHint, 300);
  }, true);
}


function addSceneLayers(map, mode) {
  if (mode === 'offline') return;   // 离线图层已在 style 内定义（含 3D 楼）
  // 在线：OpenMapTiles building 层带 render_height；没有就按层数估算
  try {
    const src = map.getSource('openmaptiles');
    if (!src) {
      // style 刚切，source 可能尚未就绪：最多重试若干次（每次 800ms）
      if ((map.__osmRetry = (map.__osmRetry | 0) + 1) > 30) return;
      setTimeout(() => addSceneLayers(map, mode), 800);
      return;
    }
    if (map.getLayer('osm-3d-buildings')) return;
    if (!(map.getStyle().layers || []).some(l => l['source-layer'] === 'building')) return;
    map.addLayer({
      id: 'osm-3d-buildings',
      source: 'openmaptiles',
      'source-layer': 'building',
      type: 'fill-extrusion',
      minzoom: 14,
      paint: {
        'fill-extrusion-color': '#d9b38c',
        'fill-extrusion-height': [
          'coalesce', ['get', 'render_height'],
          ['*', ['coalesce', ['get', 'building:levels'], 1], 3.5],
        ],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
        'fill-extrusion-opacity': 1,
      },
    });
  } catch (e) {
    console.warn('[osm-scene] 3D 建筑图层添加失败（非致命）:', e);
  }
}

// OSM 场景：坐标控件跟随鼠标/视野。Cesium 容器已隐藏且渲染循环暂停，
// 球体那套「相机/鼠标驱动」的坐标刷新因此不再触发 —— 进 OSM 后经纬度会冻在切换瞬间。
let _coordTick = 0;
function wireCoordFollow(map) {
  const push = (lng, lat) => {
    const now = Date.now();
    if (now - _coordTick < 120) return;   // 节流：placeholder/DOM 写入不必逐帧
    _coordTick = now;
    if (window.__writeCoord) window.__writeCoord(lng, lat);
  };
  map.on('mousemove', (e) => push(e.lngLat.lng, e.lngLat.lat));
  map.on('moveend', () => { const c = map.getCenter(); push(c.lng, c.lat); });
  const c0 = map.getCenter();
  push(c0.lng, c0.lat);
}

function wirePicking(map) {
  map.on('click', (e) => {
    const fs = map.queryRenderedFeatures(e.point);
    const info = document.getElementById('status');
    if (!fs.length) {
      if (info) info.textContent = 'OSM：该点无要素';
      return;
    }
    const f = fs[0];
    const p = f.properties || {};
    const keys = Object.keys(p).filter(k => p[k] !== null && p[k] !== '');
    const s = `OSM ${f.sourceLayer || f.layer.source} · ${f.layer.id}: ` +
      keys.slice(0, 10).map(k => `${k}=${p[k]}`).join('  ');
    if (info) info.textContent = s;
  });
}

// ---------- 场景内「数据来源」切换控件 ----------
function buildModeControl() {
  const el = document.createElement('div');
  el.className = 'osm-mode-ctl';
  el.innerHTML = '<div class="osm-mode-title">数据来源</div>';
  const row = document.createElement('div');
  row.className = 'osm-mode-row';
  for (const m of ['online', 'offline']) {
    const b = document.createElement('button');
    b.textContent = m === 'online' ? '在线' : '离线(本地)';
    b.className = 'osm-mode-btn';
    b.onclick = () => applyMode(m, true);   // 显式点击一律强制重设（城市可能已变）
    _modeBtns[m] = b;
    row.appendChild(b);
  }
  el.appendChild(row);
  // ⭐ 立体视角：fill-extrusion 在 pitch=0（正俯视）时**只能看到屋顶**，侧面高度为 0 像素，
  //   「楼高」在视觉上完全不存在 —— 这是用户说「连默认高度都没有」的最后一环。
  const tilt = document.createElement('button');
  tilt.className = 'osm-mode-btn';
  tilt.textContent = '立体视角';
  tilt.title = '倾斜相机看 3D 建筑（俯视时只能看到屋顶）；再点一次回到正俯视';
  _tiltBtn = tilt;
  el.appendChild(tilt);
  // 按钮态与真实 pitch 同步：默认进入就是 35°，按钮应显示为「已开」，否则用户点了反而压平
  const syncTilt = () => { if (_map) tilt.classList.toggle('active', _map.getPitch() > 1); };
  tilt.onclick = () => {
    if (!_map) return;
    const on = _map.getPitch() > 1;
    _map.easeTo({ pitch: on ? 0 : 55, bearing: on ? _map.getBearing() : -20, duration: 600 });
    syncTilt();
  };
  if (_map) { syncTilt(); _map.on('pitchend', syncTilt); }

  // ⭐ 接缝诊断：一键叠加 MapLibre 的瓦片边界线并在屏幕上给出统计。
  //   任何「地图被水平切开/上下两块详细度不同」的怀疑，看这个就能定性：
  //   接缝压在彩色边界线上 = 瓦片问题；不压线 = 数据/样式问题。
  //   （以前要用户开 F12 敲命令，实际没人愿意敲。）
  const diag = document.createElement('button');
  diag.className = 'osm-mode-btn osm-diag-btn';
  diag.textContent = '接缝诊断';
  diag.title = '叠加瓦片边界线，并在右下角显示瓦片统计；再点一次关闭';
  diag.onclick = () => toggleSeamDiag(diag);
  el.appendChild(diag);
  const badge = document.createElement('div');
  badge.className = 'osm-diag-badge hidden';
  el.appendChild(badge);
  _diagBadge = badge;
  return el;
}

let _diagOn = false;
function toggleSeamDiag(btn) {
  if (!_map) return;
  _diagOn = !_diagOn;
  try { _map.showTileBoundaries = _diagOn; _map.triggerRepaint(); } catch (e) {}
  if (btn) btn.classList.toggle('active', _diagOn);
  if (_diagBadge) _diagBadge.classList.toggle('hidden', !_diagOn);
  if (_diagOn) refreshSeamDiag();
  else if (_diagBadge) _diagBadge.textContent = '';
}

function refreshSeamDiag() {
  if (!_diagOn || !_map || !_diagBadge) return;
  try {
    const caches = (_map.getStyle() && _map.style && _map.style.sourceCaches) || {};
    const name = Object.keys(caches).find((k) => k === 'pmt' || k === 'openmaptiles') || Object.keys(caches)[0];
    const tiles = Object.values((caches[name] && caches[name]._tiles) || {});
    const byZ = {}; const st = {};
    for (const t of tiles) {
      const c = t.tileID && t.tileID.canonical; if (!c) continue;
      byZ[c.z] = (byZ[c.z] || 0) + 1;
      const s = String(t.state); st[s] = (st[s] || 0) + 1;
    }
    const zs = Object.keys(byZ).sort().map((z) => 'z' + z + '×' + byZ[z]).join(' ');
    const ss = Object.keys(st).map((s) => s + ':' + st[s]).join(' ');
    _diagBadge.textContent = `${_mode} · zoom ${_map.getZoom().toFixed(1)} · 瓦片 ${tiles.length} 块 (${zs}) · ${ss}`;
  } catch (e) { _diagBadge.textContent = '统计失败: ' + e.message; }
}

// ⭐ 换城市必须重设 style：style 里 tiles 模板写死了城市 pmtiles 文件名，
//   只比较 mode 的话「离线 A 城 → 离线 B 城」会被判成无需切换，
//   于是地图仍去读 A 城的瓦片 → B 城位置一片空白 + 误报「无本地离线数据」。
function styleKey(mode) {
  return mode + ':' + (mode === 'offline' && _city ? _city.file : '');
}

// ⭐⭐ 判据必须是「地图里真实的样式」，不能只看自己记的 _appliedKey：
//   任何一次 setStyle 被打断（_applying 卡住、样式构建抛错、scene 被隐藏又显示）
//   _appliedKey 已经更新但样式并没换成 —— 之后再进来就永远被判成「已应用」，
//   于是「换到米兰还显示上海」（用户实测）。这里直接问地图。
function actualStyleKey() {
  if (!_map) return null;
  try {
    const st = _map.getStyle() || {};
    const src = st.sources && st.sources.pmt;
    if (src) {
      const t = String((src.tiles || [''])[0] || '');
      const m = t.match(/pmt:\/\/([^/]+)/);
      return 'offline:' + (m ? decodeURIComponent(m[1]) : '');
    }
    if (st.sources && st.sources.openmaptiles) return 'online:';
    return null;
  } catch (e) { return null; }
}

let _applying = false;         // setStyle 重入保护（moveend 自动换城市时会连发）
async function applyMode(mode, force) {
  if (!_map || _applying) return;
  const key = styleKey(mode);
  if (!force && key === _appliedKey) return;
  const prevMode = _mode;
  _applying = true;
  _mode = mode;
  updateModeButtons();                 // 立即高亮，不依赖异步 style 加载
  try {
    const style = await resolveStyle(mode);
    if (!style) {
      // 无可用样式（如切「离线」但当前区域没命中城市）：提示并保持现状，
      // 且**不要**改写 _appliedKey —— 否则下次切换会被判成「已应用」而彻底卡死。
      // ⭐ 还必须把 _mode 回滚：否则按钮停在「在线」高亮、画面却仍是离线内容，
      //   用户会以为「在线加载不出来」或「在线和离线内容不一样」。（实测踩过）
      _mode = prevMode;
      updateModeButtons();
      osmBanner('ⓘ 当前区域没有可用的离线数据（本地 ' + (_manifest ? _manifest.length : 0) +
        ' 城），已保持原来源；请在「数据来源」切「在线」。');
      _applying = false;
      return;
    }
    _appliedMode = mode;
    _appliedCity = _city;
    _appliedKey = key;
    // setStyle 会保留相机（center/zoom/bearing/pitch），无需手动保存
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; resolve(); };
      const timer = setTimeout(finish, 8000);      // 兜底：样式若加载失败也不能永久锁死
      _map.once('styledata', () => {
        clearTimeout(timer);
        try { addSceneLayers(_map, mode); } catch (e) {}
        try { updateStatusHint(); syncZoomLimits(); } catch (e) {}
        finish();
      });
      _map.setStyle(style, { diff: false });
    });
  } catch (e) {
    console.warn('[osm-scene] 切换数据来源失败:', e);
    _mode = prevMode;                  // 同上：失败必须回滚高亮，别留假状态
    updateModeButtons();
  } finally {
    _applying = false;
  }
}

function updateModeButtons() {
  for (const m of ['online', 'offline']) {
    if (_modeBtns[m]) _modeBtns[m].classList.toggle('active', m === _mode);
  }
}

function updateStatusHint() {
  const info = document.getElementById('status');
  if (!info) return;
  if (_mode === 'offline') {
    info.textContent = 'OSM(离线·PMTiles ' + (_city ? _city.name : '') +
      ')：本地数据统一 ' + DETAIL_ZOOM + ' 级（远近同一套几何，不会混层）· 缩放下限 ' +
      (_city ? zoomFloorFor(_city) : DETAIL_ZOOM) + ' 级（本地数据到此为止，要更大范围请手动切「在线」）· ' +
      '「立体视角」看 3D 楼高 · 右键拖动=旋转 · 点击查属性';
  } else {
    info.textContent = 'OSM(在线)：右键拖动=旋转 · Ctrl+左键拖动=倾斜 · 点击要素查属性';
  }
}

// ---------- 交叉淡切：Cesium 球体 ⇄ MapLibre 场景 ----------
function fadeOsmIn() {
  const osm = document.getElementById('osmMap');
  if (!osm) return;
  osm.style.transition = 'opacity .4s ease';
  osm.style.opacity = '0';
  requestAnimationFrame(() => { osm.style.opacity = '1'; });
}
function fadeCesium(dim) {
  const c = document.getElementById('cesiumContainer');
  if (!c) return;
  c.style.transition = 'opacity .4s ease';
  c.style.opacity = dim ? '0.15' : '1';
}

function showOsmScene(view) {
  if (_active) return;
  if (typeof maplibregl === 'undefined') {
    const info = document.getElementById('status');
    if (info) info.textContent = 'MapLibre 未加载（离线？需联网获取 maplibre-gl）';
    return;
  }
  const osm = document.getElementById('osmMap');
  if (!osm) return;
  view = view || cesiumView();
  _prevCenter = view.center.slice();   // 记录进入前中心，返回时回到该坐标（只改高度）

  _prevPlanet = activePlanet();
  for (const id of planetContainers()) {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  }
  osm.classList.remove('hidden');
  osm.style.background = '#eef3f5';
  fadeOsmIn();          // 淡入地图（Cesium 最后一帧在底层衬托）
  fadeCesium(true);     // 球体容器同步压暗

  // 暂停 Cesium 地球渲染循环，省 GPU（OSM 场景时球体不可见）
  if (window.viewer) {
    try { window.viewer.useDefaultRenderLoop = false; } catch (e) {}
  }

  // 异步自动探测：离线（manifest 命中）优先 → 否则在线 → 都失败给提示
  autoDetectAndShow(view);

  _active = true;
  // 侧栏 _btn 已随 2026-10-29 第五轮删除，这里只维护右侧那颗（切「🌐 返回球体」激活态，不再隐藏）
  if (_navBtn) {
    _navBtn.classList.add('active');
    _navBtn.title = '返回三维球体（地表 OSM 场景已开启）';
    const ic = _navBtn.querySelector('.osm-nav-icon');
    if (ic) ic.textContent = '🌐';
  }
}

// ⭐ OSM 起步 zoom 必须**双向钳制**到离线城市的 [minz, maxz]：
//   原代码只做了 Math.min(view.zoom, maxz) 单向钳制 —— 从远处（相机高 → zoom 小）进入时
//   会去请求 z5/z6 这种 pmtiles 里根本不存在的层级，结果**整屏空白**（用户实测：切到上海
//   进 OSM 什么都没有）。所以下限也要钳到城市 minz。
function osmZoomFor(view) {
  const z = view.zoom;
  if (_mode === 'offline' && _city) {
    const hi = _city.maxz ?? 19;
    // ⭐ 下限就是「数据完整级」detailZ（钉死，和 source.minzoom 保持一致）：
    //   minz 只是有瓦片的最低层级，那里只有主干道、没有建筑 —— 落进去就是用户看到的
    //   「道路断续 + 大片空白」。直接落在 z15（或该城最高级）才是完整数据。
    const lo = detailZ(_city);
    return Math.max(lo, Math.min(z, hi));
  }
  return Math.max(2, Math.min(z, 19));
}

async function autoDetectAndShow(view) {
  const det = await autoDetect(view.center[0], view.center[1]);
  _mode = det.mode;
  _city = det.city;
  if (det.banner) {
    osmBanner(det.banner);
  } else if (det.mode === 'offline' && !det.city) {
    clearOsmBanner();
  } else if (det.mode === 'offline' && det.city) {
    const _lo = zoomFloorFor(det.city);
    osmBanner(det.city.overview
      ? `ⓘ 离线矢量：${det.city.name}（本地数据 ${_lo}–${detailZ(det.city)} 级，z11 起有水面/绿地/主干道）· 点「立体视角」看 3D 楼高 · 可缩到 ${_lo} 级，再大范围请点「数据来源 → 在线」。`
      : `ⓘ 离线矢量：${det.city.name}（本地数据统一 ${detailZ(det.city)} 级，远近同一套几何）· 点「立体视角」看 3D 楼高 · 缩放下限 ${_lo} 级（本地数据到此为止；要更大范围请手动点「数据来源 → 在线」）。`);
    // 3s 后自动收起，不长期挡画面
    setTimeout(() => { if (_active && _mode === 'offline') clearOsmBanner(); }, 3000);
  } else {
    clearOsmBanner();
  }

  if (!_inited) {
    const initStyle = await resolveStyle(_mode) || OSM_STYLE_ONLINE;
    _map = new maplibregl.Map({
      container: osmMapEl(),
      style: initStyle,
      center: view.center,
      zoom: osmZoomFor(view),          // 双向钳制到城市 [minz, maxz]，否则远处进入会空白
      // ⭐ 默认给 35° 俯仰：fill-extrusion 在 pitch=0（正俯视）时侧面高度为 0 像素，
      //   楼看着就是平面色块 —— 用户因此认定「根本没有楼高」。给个初始倾角楼才立起来。
      //   只在**首次创建**时生效，之后再进入走 flyTo、不覆盖用户手动调过的视角。
      pitch: DEFAULT_PITCH,
      // 中日韩字符用本机系统字体生成字形，不去 glyphs 服务器下载 CJK range。
      // 关键：OpenFreeMap 的字体栈刻意不含 CJK（体积大），且 fonts.openfreemap.org
      // 常不可达 —— 不显式开这个，中文街道名就永远渲染不出来。
      localIdeographFontFamily: 'sans-serif',
    });
    _appliedMode = _mode;
    _appliedCity = _city;
    _appliedKey = styleKey(_mode);
    _map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }));
    _map.addControl(new maplibregl.ScaleControl({ maxWidth: 120 }));
    _map.on('load', () => {
      addSceneLayers(_map, _mode);
      wirePicking(_map);
      wireCoordFollow(_map);   // 经纬度跟随 OSM 地图（否则进 OSM 后坐标冻住不动）
      syncZoomLimits();        // 离线时缩放下限 = 数据完整级（见 detailZ）
    });
    _map.on('error', onMapError);
    // ⭐ sprite 兜底：OpenFreeMap 的 ofm sprite 只有 264 个图标，而 liberty 样式引用了
    //   office/atm/yoga/gate… 这些**它自己没有的**图标（实测 sprite json 里确实不存在）。
    //   缺图标时 MapLibre 会把整条 symbol 丢掉（POI 连文字都看不见）→ 补一张 1×1 透明图，
    //   保住文字与点位，只少了那个小图标。
    _map.on('styleimagemissing', (e) => {
      try {
        if (e && e.id && !_map.hasImage(e.id)) {
          _map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
        }
      } catch (er) { /* 非致命 */ }
    });
    _map.on('moveend', onMapMoveEnd);
    // 来源切换控件（一次性挂载到地图容器，setStyle 不移除 DOM）
    _modeCtl = buildModeControl();
    osmMapEl().appendChild(_modeCtl);
    // ⚠ 2026-10-29：原先这里挂 wireZoomFloorFallback()（触底自动切在线），
    //   已按用户要求移除 —— 缩小不再自动切在线，改为只提示（见 wireZoomFloorHint）。
    wireZoomFloorHint();
    updateModeButtons();
    _inited = true;
  } else {
    _map.resize();
    // ⭐ 判据用 actualStyleKey()（地图里的真实样式），不是 styleKey(_mode)（自己记的账）：
    //   记账与实际脱节时（样式构建抛错 / setStyle 被打断），旧逻辑会认定「已应用」→
    //   换城市后地图仍读上一座城市的 pmtiles，用户看到的就是「进米兰还是上海」。
    const want = styleKey(_mode);
    const have = actualStyleKey();
    if (have !== want) {
      _applying = false;                 // 入口处清掉可能残留的重入锁
      await applyMode(_mode, true);
    }
    // ⭐ 相机必须显式带到本次进入的位置：setStyle 会**保留旧相机**，而 MapLibre 的相机停在上
    //   一座城市（或上次浏览点），新样式会去请求那一片的瓦片 → 空白 / 看似「没换过来」。
    //   用 jumpTo 而非 flyTo：进入瞬间就该到位，不能让用户看到上一座城市的残留帧。
    try {
      _map.jumpTo({ center: view.center, zoom: osmZoomFor(view), bearing: 0, pitch: DEFAULT_PITCH });
    } catch (e) {}
    syncZoomLimits();
    try { updateStatusHint(); } catch (e) {}
  }
  updateStatusHint();
}

function osmMapEl() { return document.getElementById('osmMap'); }

// 在线资源（瓦片/glyphs/样式）拉取失败时的非阻塞提示
let _errCount = 0;
function onMapError(e) {
  const msg = (e && e.error && (e.error.message || String(e.error))) || '';
  // 仅对「在线」模式下明显的网络/资源失败提示，避免离线本身无数据时的噪音
  if (_mode === 'online' && /fetch|network|Failed to|load|tile|glyph/i.test(msg)) {
    _errCount++;
    if (_errCount <= 3) {
      osmBanner('⚠ 在线地图资源加载失败（' + msg.slice(0, 80) + '）。可切「离线(本地)」或检查网络。');
    }
  }
}

// 持续提示：当前视图与离线覆盖的关系
function onMapMoveEnd() {
  if (!_map) return;
  if (_diagOn) refreshSeamDiag();
  const c = _map.getCenter();
  const count = _manifest ? _manifest.length : 0;   // 实为 433 城，别再写死「123 城」
  if (_mode === 'offline') {
    const city = hitCity(c.lng, c.lat);
    // 判据同样用地图里的真实样式（actualStyleKey），不用 _appliedCity 记账：
    //   记账在 setStyle 失败时已经改掉，会导致「该换城市了却永不重试」→ 空白。
    const usingFile = String(actualStyleKey() || '').replace(/^offline:/, '');
    if (city && city.file && usingFile !== city.file) {
      // 平移/跳转到另一个离线城市：style 仍指向上一个城市的 pmtiles，不换就是空白
      _city = city;
      applyMode('offline', true);
      return;
    }
    if (!city) {
      // 方向也要说对：来源控件在地图左上角（面板右侧），不是右上角（右上角是缩放控件）
      osmBanner(`ⓘ 当前区域无本地离线数据（本地 ${count} 城）；可在地图左上角「数据来源」切「在线」。`);
    } else {
      clearOsmBanner();
    }
  } else if (_mode === 'online') {
    if (offlineCovers(c.lng, c.lat)) {
      osmBanner(`ⓘ 此区域有本地离线覆盖，可在地图左上角「数据来源」切「离线(本地)」。`);
    } else {
      clearOsmBanner();
    }
  }
}

function hideOsmScene() {
  if (!_active) return;
  _applying = false;        // 隐藏期间任何未完成的 setStyle 记账都不可信，重进时重新判定
  const osm = document.getElementById('osmMap');
  if (osm) {
    osm.style.transition = 'opacity .3s ease';
    osm.style.opacity = '0';
    setTimeout(() => { if (!_active) osm.classList.add('hidden'); }, 320);
  }

  // 把相机拉回「进入 OSM 前的坐标」+ 固定 RETURN_HEIGHT 高度。
  // 不按 zoom→height 换算：该换算在 zoom<15 时会给出 64km+ 的视角（用户反馈"切太远"）；
  // 也不跟随 OSM 当前中心，避免平移浏览后坐标漂移（用户反馈"坐标也改变了"）。
  const v0 = window.viewer;
  if (v0 && v0.camera) {
    const c = _map ? _map.getCenter() : null;
    const center = _prevCenter || (c ? [c.lng, c.lat] : [116.4, 39.9]);
    try {
      v0.camera.flyTo({
        destination: window.Cesium.Cartesian3.fromDegrees(center[0], center[1], RETURN_HEIGHT),
        duration: 1.2,
      });
    } catch (e) {}
  }

  // 恢复上一个星球容器 + Cesium 渲染循环 + 球体不透明度
  const restore = document.getElementById(_prevPlanet) || document.getElementById('cesiumContainer');
  if (restore) restore.classList.remove('hidden');
  fadeCesium(false);
  if (window.viewer) {
    try { window.viewer.useDefaultRenderLoop = true; } catch (e) {}
  }

  _active = false;
  if (_navBtn) {                                  // 恢复「🗺 进入地表 OSM」
    _navBtn.classList.remove('active');
    _navBtn.title = '地表 OSM 矢量场景：街道级 · 真 3D 建筑 · 离线优先';
    const ic = _navBtn.querySelector('.osm-nav-icon');
    if (ic) ic.textContent = '🗺';
  }
}

// ---------- 丝滑切换入口：提示卡 / 侧栏按钮共用 ----------
// opts.handoff = true 时，若当前相机高度对应的 zoom 超过离线数据最高级，
//   先把 Cesium 拉远到交接高度（HANDOFF_HEIGHT）再切，避免 MapLibre 起步 zoom 无瓦片。
async function switchToOsmScene(opts = {}) {
  const view = cesiumView();
  const token = ++_switchToken;
  if (opts.handoff) {
    // ⭐ 交接是**双向**的：
    //   ① zoom 过大（贴地）→ 拉远到 HANDOFF_HEIGHT，超过离线 maxz 也无瓦片；
    //   ② zoom 过小（高空，如「切到上海」时相机还在几百公里外）→ 拉近到城市 minz，
    //      否则 MapLibre 会去请求 pmtiles 里不存在的低层级 → 整屏空白。
    let targetH = null;
    if (view.zoom > 15) {
      targetH = HANDOFF_HEIGHT;
    } else {
      await loadManifest();
      const c = hitCity(view.center[0], view.center[1]);
      const minz = c ? (c.minz ?? 11) : 11;
      if (view.zoom < minz) targetH = zoomToCesiumHeight(minz);
    }
    if (targetH != null) {
      const v = window.viewer;
      if (v && v.camera) {
        await new Promise((res) => {
          let settled = false;
          const finish = () => { if (!settled) { settled = true; res(); } };
          try {
            v.camera.flyTo({
              destination: window.Cesium.Cartesian3.fromDegrees(view.center[0], view.center[1], targetH),
              orientation: { heading: v.camera.heading, pitch: v.camera.pitch, roll: 0 },
              duration: 1.4,
              complete: finish,
            });
          } catch (e) { finish(); }
          setTimeout(finish, 3000);   // 兜底超时（相机被占用等）
        });
        if (token !== _switchToken) return;   // 期间用户又触发了别的切换
        view.zoom = cesiumHeightToZoom(targetH);
      }
    }
  }
  showOsmScene(view);
}
let _switchToken = 0;

export function toggleOsmScene() {
  _active ? hideOsmScene() : showOsmScene();
}

// ---------- 球体右上角浮动区（离线提示卡） ----------
// 2026-10-25 用户拍板：删「⬇ 回顶视」浮动钮——cesium-navigation 的「双击指南针」
// 本就是原地回顶视（handleDoubleClick → flyToBoundingSphere 保持距离 pitch 归 -90°），
// 浮动钮功能重复；仅保留不可发现性互补……不，用户明确选「删浮动钮减冗余，靠双击」。
let _overlay = null;

function buildOverlay() {
  const el = document.createElement('div');
  el.id = 'globeOverlay';
  el.className = 'globe-overlay';
  return el;
}

// 把浮动区挂到当前星球容器（切星球时调用）
export function attachGlobeOverlay() {
  if (!_overlay) _overlay = buildOverlay();
  const host = document.getElementById(activePlanet());
  if (host && _overlay.parentNode !== host) host.appendChild(_overlay);
}

// ---------- 导航控件列贴邻按钮（2026-10-25 用户：图层切换按「贴住」方案） ----------
// 不 append 进 cesium-navigation 插件容器（插件重建 DOM 会冲掉自定义子元素），
// 而是独立 div 与缩放列同列：实测缩放列屏幕 right:48 top:168（30×88，底 256），
// 比例尺激活占 top 270-300 → 钮 top:304 right:48（见 index.html .osm-nav-btn），
// 视觉全套复刻（rgba(47,53,60,.8) 底 / 1px 边框 / 30px 控件 / hover 蓝 #68ADFE）。
// ⭐ 2026-10-29 第五轮：侧栏 #btnOsmScene 已删除，这一颗成为**唯一**进出 OSM 场景的入口，
//    故宿主从 viewer.container 改为 #app —— 否则进入 OSM 时星球容器整体 .hidden，
//    这颗钮跟着消失，用户就再也点不到「返回球体」了；同时点击改为 toggle。
let _navBtn = null;
export function mountOsmNavBtn(viewer) {
  if (_navBtn || !viewer || !viewer.container) return;
  const btn = document.createElement('div');
  btn.className = 'osm-nav-btn';
  // 定位写 inline style（双保险）：即使浏览器缓存了旧版 index.html 的内联 CSS，
  // inline 优先级最高，仍钉死在缩放列正下方（right:48 与缩放列同列 x，top:304 在比例尺下方）。
  // z-index 12 > #osmMap(5)：OSM 场景内这颗钮要浮在地图之上充当返回入口。
  btn.style.position = 'absolute';
  btn.style.top = '304px';
  btn.style.right = '48px';
  btn.style.zIndex = '12';
  btn.title = '地表 OSM 矢量场景：街道级 · 真 3D 建筑 · 离线优先';
  btn.innerHTML = '<span class="osm-nav-icon">🗺</span>';
  btn.onclick = () => { if (_active) hideOsmScene(); else switchToOsmScene({ handoff: true }); };
  const host = document.getElementById('app') || viewer.container;
  host.appendChild(btn);
  _navBtn = btn;
}
export function unmountOsmNavBtn() {
  if (_navBtn && _navBtn.parentNode) _navBtn.parentNode.removeChild(_navBtn);
  _navBtn = null;
}
// 行星模式收放（2026-10-29 第五轮）：这颗钮挂 #app 后不再随星球容器隐藏，
// 必须显式收——月球/火星没有 OSM 覆盖。OSM 场景激活时保持可见（它是唯一返回入口）。
export function setOsmNavBtnVisible(show) {
  if (!_navBtn || _active) return;
  _navBtn.classList.toggle('hidden', !show);
}

// ---------- OSM 按钮「本地可用」高亮/脉冲 ----------
// 当前地球视角：命中离线城市 bbox 且放大到街道级高度（与提示卡同一阈值 HINT_HEIGHT）
// 时，认为「有对应的本地 pmtiles」，按钮高亮+脉冲，点击即切离线街道级。
function osmAvailableNow() {
  if (_active) return { available: false };                          // OSM 场景已开 → 复位
  if (activePlanet() !== 'cesiumContainer') return { available: false }; // 月/火无地球坐标
  const v = window.viewer;
  if (!v || !v.camera) return { available: false };
  let h, lng, lat;
  try {
    const c = v.camera.positionCartographic;
    h = c.height; lng = c.longitude * 180 / Math.PI; lat = c.latitude * 180 / Math.PI;
  } catch (e) { return { available: false }; }
  // ⭐ 不再要求「已放大到街道级」才高亮：起步 zoom 已双向钳制到城市 [minz,maxz]，
  //   从几百公里外进入也能正常显示。原来 h>=HINT_HEIGHT(10km) 就不亮，
  //   用户在高空掠过覆盖城市时完全收不到「这里有本地数据」的提示。
  const city = hitCity(lng, lat);
  if (!city) return { available: false };
  return { available: true, city, streetLevel: h < HINT_HEIGHT };
}
function updateOsmButtonState() {
  const a = osmAvailableNow();
  const cls = 'osm-available';
  if (_navBtn) _navBtn.classList.toggle(cls, a.available);
  const tip = a.available
    ? `本地离线覆盖：${a.city.name}（${a.city.maxz} 级 · 真 3D 建筑）· 点击切街道级` +
      (a.streetLevel ? '' : '（当前视角较远，进入后自动定位到该城可显示的层级）')
    : '地表 OSM：离线优先（本地 ' + (_manifest ? _manifest.length : 0) + ' 城）；飞到覆盖城市上方可一键切本地街道级';
  if (_navBtn) _navBtn.title = tip;
  updateCoverageBox(a);
}

// ---------- 可加载范围的绿色框线（2026-10-30 用户要求） ----------
// 只闪按钮还不够直观：命中离线城市时，把该城的 bbox 用亮绿框线画在地球上，
// 让用户一眼看到「这一块有本地街道级数据，点 🗺 能进去」。
// 实现要点：
//   · 用 polyline + clampToGround（不是 polygon 面）：地形夸张开启时面会沉到地形下看不见，
//     线贴地则始终可见；闭合环 5 点（首点重复）。
//   · 记住创建时的 viewer（_coverBoxViewer）：切到月/火后 window.viewer 会指向别的球体，
//     用错 viewer 去 remove 会把框线永久留在地球上。
//   · 城市未变（name+bbox 同）时不重建，400ms 轮询零开销。
let _coverBox = null;
let _coverBoxViewer = null;

function removeCoverageBox() {
  if (_coverBox && _coverBoxViewer) {
    try {
      if (!_coverBoxViewer.isDestroyed || !_coverBoxViewer.isDestroyed()) {
        _coverBoxViewer.entities.remove(_coverBox);
      }
    } catch (e) { /* viewer 已销毁，忽略 */ }
  }
  _coverBox = null;
  _coverBoxViewer = null;
}

function updateCoverageBox(a) {
  const v = typeof window !== 'undefined' ? window.viewer : null;
  const C = typeof window !== 'undefined' ? window.Cesium : null;
  const on = !!(a && a.available && a.city && a.city.bbox && a.city.bbox.length === 4)
    && !_active && activePlanet() === 'cesiumContainer';
  if (!on || !v || !v.entities || !C) { removeCoverageBox(); return; }

  const bb = a.city.bbox;
  const key = a.city.name + '|' + bb.join(',');
  if (_coverBox && _coverBoxViewer === v && _coverBox.__coverKey === key) return;

  removeCoverageBox();
  const [w, s, e, n] = bb;
  try {
    _coverBox = v.entities.add({
      name: 'osm-coverage-box',
      polyline: {
        positions: C.Cartesian3.fromDegreesArray([w, s, e, s, e, n, w, n, w, s]),
        width: 2,
        clampToGround: true,
        material: new C.ColorMaterialProperty(
          C.Color.fromCssColorString('#3ef2a0').withAlpha(0.95)),
      },
      label: {
        text: `🗺 本地离线 · ${a.city.name} z${a.city.maxz}`,
        font: '600 12px "Microsoft YaHei", sans-serif',
        fillColor: C.Color.fromCssColorString('#3ef2a0'),
        outlineColor: C.Color.fromCssColorString('#06210f').withAlpha(0.9),
        outlineWidth: 3,
        showBackground: false,
        verticalOrigin: C.VerticalOrigin.CENTER,
        horizontalOrigin: C.HorizontalOrigin.CENTER,
        pixelOffset: new C.Cartesian2(0, 0),
        eyeOffset: new C.Cartesian3(0, 0, -2000),   // 轻微抬升，避免被地形吃掉
      },
      // ⭐ 标签放 bbox 中心而不是左上角：拉近到城市尺度时左上角早跑出画面（实测 60km 高度
      //    就完全看不到标签），中心点在任何视高都稳定可见。
      position: C.Cartesian3.fromDegrees((w + e) / 2, (s + n) / 2, 0),
    });
    _coverBox.__coverKey = key;
    _coverBoxViewer = v;
  } catch (e) {
    console.warn('[osm-scene] 覆盖范围框线绘制失败:', e);
  }
}

// 每 400ms 更新浮动区显隐（相机 tick 驱动；DOM class 切换极轻）
export function updateGlobeOverlay() {
  updateOsmButtonState();                                            // OSM 按钮「本地可用」高亮（自身处理 _active / 非地球）
  if (_overlay) _overlay.classList.toggle('hidden', !!_active);   // OSM 场景激活 → 让位 MapLibre
  // 右侧场景三钮（晨夜/海底/地形夸张）是球体专属，OSM 场景内无意义 → 一并让位
  const col = document.getElementById('sceneNavCol');
  if (col) col.classList.toggle('hidden', !!_active);
}

export function initOsmScene() {
  // 侧栏 #btnOsmScene 已于 2026-10-30 彻底移除（用户确认不再需要）；OSM 唯一入口是右侧导航列那颗。
  // 这里同步失效 _btn 变量，避免后续代码误以为还有第二颗按钮。
  _btn = null;
  registerPmtProtocol();
  registerOsmVtProtocol();
  loadManifest();                       // 预加载城市清单（提示卡/探测都用）
  attachGlobeOverlay();
  setInterval(updateGlobeOverlay, 400); // 浮动区显隐轮询
  // 控制台调试入口
  window.__osmScene = {
    show: showOsmScene,
    hide: hideOsmScene,
    toggle: toggleOsmScene,
    isActive: () => _active,
    setMode: applyMode,
    getMode: () => _mode,
    getMap: () => _map,   // 调试：拿 MapLibre 实例
    switch: (opts) => switchToOsmScene(opts),   // 提示卡路径（handoff 拉远）
    hitCity: (lng, lat) => hitCity(lng, lat),
  };
}
