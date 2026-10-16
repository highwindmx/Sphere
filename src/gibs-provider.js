// src/gibs-provider.js — NASA GIBS Blue Marble Next Generation（EPSG:4326 非二分网格 → 地理瓦片重采样）
//
// 背景（2026-10-16 截图实测：极区楔形错位、「角坐标不闭合」）：
//   GIBS EPSG:4326 的「500m」TileMatrixSet 不是 2:1 二分网格！capabilities 实测：
//     L0=2×1, L1=3×2, L2=5×3, L3=10×5, L4=20×10, L5=40×20, L6=80×40, L7=160×80
//   （512px 瓦片、固定 ~500m 地面分辨率，每级瓦片数按覆盖全球取整，且级间不嵌套：
//   3×2 → 5×3 并非整数倍细分）。Cesium 四叉树要求每级严格翻倍，任何 TilingScheme
//   都表达不了这种网格；且本 vendored build 的 WMTS provider 无 ScaleDenominator
//   解析（grep 0 命中），只是把 (x,y,level) 原样填进 URL 模板 —— 直接对接必然
//   越界 400 + 瓦片贴错矩形（即用户截图的楔形错位）。
//
// 解法（与 terrarium-provider.js 同思路：对外地理方案 + 内部重采样）：
//   · 对外：GeographicTilingScheme，Cesium 四叉树正常覆盖 ±90°。
//   · 对内：requestImage(x,y,level) 收到地理瓦片后：
//       1. 取该瓦片经纬矩形（度）；GIBS 级 g=level（同下标时 GIBS 瓦片恒比 Cesium
//          瓦片宽，单瓦片请求最多扩到 2×2 张，无组合爆炸）。
//       2. 计算覆盖它的 GIBS 瓦片范围（col/row 由经纬线性反算，clamp 到合法域）。
//       3. 逐张拉取 GIBS jpeg（crossOrigin anonymous，GIBS 全站 CORS），
//          按两个矩形的经纬交集换算 源像素矩形 → 目标画布矩形，drawImage 贴图。
//       两边都是等经纬线性网格，仿射对应 → 角坐标严格闭合，极区不拉伸。
//   · level > 7 时 Cesium 会自动钳到 maximumLevel 复用 L7 纹理，无需自处理。
//
// REST 模板（capabilities ResourceURL，curl 实测 200）：BMNg 的 default 时间直接省略：
//   https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/BlueMarble_NextGeneration/default/500m/{TileMatrix}/{TileRow}/{TileCol}.jpeg

import * as Cesium from 'cesium';

// ── Debug 瓦片模式（按 GIBS 真实网格生成带坐标标注的调试瓦片，验证坐标转换）──
// 启用：URL 加 ?gibs-debug=1，或控制台 __setGibsDebug(true)。
let DEBUG = false;
try { DEBUG = new URLSearchParams(location.search).has('gibs-debug'); } catch { /* 非浏览器 */ }
export function setGibsDebug(v) { DEBUG = !!v; }

// ── 人为偏移旋钮（实验用：验证「赤道北移 / 经线错位」是否由瓦片映射引起）──
// 语义：把 GIBS 源内容整体在球上「滑动」offset 度。
//   LAT_OFF>0 → 内容整体北移 offset°（把源纬度 φ 的内容显示到 φ+offset）
//   LON_OFF>0 → 内容整体东移 offset°
// 来源：URL ?gibs-latoff= & ?gibs-lonoff= ；或控制台 __setGibsLatOff/__setGibsLonOff
let LAT_OFF = 0;
let LON_OFF = 0;
let LAT_SCALE = 1; // 纬度缩放（绕赤道 lat0 拉伸/压缩）；=1 不变。≠1 会在两极对称留洞
let LON_SCALE = 1; // 经度缩放（绕 lon0）
let GRID = false; // ?gibs-grid=1：在真实影像上也画固定经纬参考线（用于肉眼比对偏移）
let MERID = false; // ?gibs-merid=1：叠加「候选边界经线标尺」（分辨拼接线属于哪类边界）
try {
  const _p = new URLSearchParams(location.search);
  if (_p.has('gibs-latoff')) LAT_OFF = parseFloat(_p.get('gibs-latoff')) || 0;
  if (_p.has('gibs-lonoff')) LON_OFF = parseFloat(_p.get('gibs-lonoff')) || 0;
  if (_p.has('gibs-latscale')) LAT_SCALE = parseFloat(_p.get('gibs-latscale')) || 1;
  if (_p.has('gibs-lonscale')) LON_SCALE = parseFloat(_p.get('gibs-lonscale')) || 1;
  if (_p.has('gibs-grid')) GRID = true;
  if (_p.has('gibs-merid')) MERID = true;
} catch { /* 非浏览器 */ }
export function setGibsLatOff(v) { LAT_OFF = +v || 0; }
export function setGibsLonOff(v) { LON_OFF = +v || 0; }
export function setGibsLatScale(v) { LAT_SCALE = +v || 1; }
export function setGibsLonScale(v) { LON_SCALE = +v || 1; }

/** GIBS「500m」集每级真实矩阵（WMTSCapabilities.xml 2026-10-16 解析，勿按 2:1 猜） */
const COLS = [2, 3, 5, 10, 20, 40, 80, 160];
const ROWS = [1, 2, 3, 5, 10, 20, 40, 80];
const TILE_PX = 512;   // GIBS 瓦片边长（px）
const MAX_LEVEL = 7;   // GIBS 最高级
const OUT = 256;       // 输出画布尺寸（Cesium 地理瓦片标准尺寸）
// 接缝修复重叠量（画布像素，每侧）。每张 GIBS 源瓦片在取源与目标矩形各外扩此值，
// 使相邻源瓦片在接缝处交叠，盖掉 GIBS 源瓦片边界因重投影/压缩产生的 1px 辐射台阶
// （Leaflet #3575 思路：瓦片自身多渲染 1px 覆盖亚像素取整缝隙；实测 g4 边界 maxΔ=130）。
// 2.5px 在各级都把源边界台阶（≈0.8~1.25 画布 px）包住；同时让 Cesium 瓦片边界
// （如 lat0）的两侧画布边缘都有正确邻居内容，一并消除横缝。
const TILE_OVERLAP = 2.5;

// ── GIBS 4326 GCS 真实瓦片几何（关键修正，2026-10-16）──
// 此前用 180/ROWS[g] 算 tileH（g2 得 60°），但 GIBS 4326 GCS 的 level0 单瓦片跨度是
// 288°（经纬度同值，正方形度网格），即 span = 288 / 2^g。用 60° 替代真实 72° 会让纬度
// 被非线性压扁 —— 表现为「北半球压缩、南半球拉伸、赤道北移」。
// 用 288/2^g 反推 COLS/ROWS 与 capabilities 实测完全一致（L0 2×1 … L7 160×80）。
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const SPAN0 = 288; // level0 单瓦片度数跨度（经纬度同值）
const gibsSpan = (g) => SPAN0 / Math.pow(2, g);
// 经纬度 → GIBS (col,row)，clamp 到合法域（避免请求越界瓦片）
const gibsCol = (lon, g) => clamp(Math.floor((lon + 180) * Math.pow(2, g) / SPAN0), 0, COLS[g] - 1);
const gibsRow = (lat, g) => clamp(Math.floor((90 - lat) * Math.pow(2, g) / SPAN0), 0, ROWS[g] - 1);
// GIBS (c,r) → 自然经纬矩形（不 clamp 到 ±90：边缘瓦片自然越界部分靠与目标矩形交集裁剪）
function gibsRect(c, r, g) {
  const sp = gibsSpan(g);
  const gw = -180 + c * sp;
  const ge = gw + sp;
  const gn = 90 - r * sp;
  const gs = gn - sp;
  return { gw, ge, gn, gs };
}

// 源瓦片根路径。默认走本地代理缓存 /tiles/gibs/（与主应用同源，可离线复用）；
// 图源设置里关闭「本地优先」时，createGibsProvider 会切到 NASA GIBS 上游直连。
let URL_PREFIX = '/tiles/gibs/';

// 对外地理方案（与 terrarium-provider.js 共用语义；globe 已是 Geographic）
const geoScheme = new Cesium.GeographicTilingScheme();

const IMG_CACHE_MAX = 1200;  // 源瓦片 promise 缓存上限
const FAIL_RETRY_MS = 10000; // 拉取失败后的静默期（防错误风暴；期间该源瓦片按缺失处理走粗级回填）

/** 源瓦片 promise 缓存（缓存 promise 顺带去重并发请求） */
const imgCache = new Map();
/** 已成功解码的源瓦片（key→Image）：粗级回填的数据源（只有成功过的才进这里） */
const okImgs = new Map();
/** 失败静默期登记 key → Date.now() */
const failAt = new Map();

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous'; // GIBS 全站 CORS；没有它 canvas 会被污染、纹理上传报错
    img.onload = () => img.decode().then(() => resolve(img)).catch(() => reject(new Error('decode failed: ' + url)));
    img.onerror = () => reject(new Error('load failed: ' + url));
    img.src = url;
  });
}

async function loadGibsTile(g, c, r) {
  const key = `${g}/${c}/${r}`;
  const hit = imgCache.get(key);
  if (hit) return hit;
  const failed = failAt.get(key);
  if (failed && Date.now() - failed < FAIL_RETRY_MS) return null;
  const p = loadImage(`${URL_PREFIX}${g}/${r}/${c}.jpeg`)
    .then((img) => { okImgs.set(key, img); return img; })
    .catch((e) => {
      imgCache.delete(key);
      failAt.set(key, Date.now());
      throw e;
    });
  if (imgCache.size >= IMG_CACHE_MAX) { imgCache.clear(); failAt.clear(); }
  imgCache.set(key, p);
  return p;
}

/**
 * 用更低级、已成功缓存的 GIBS 内容回填缺失区域（源瓦片失败时避免永久透明洞）。
 * (fx0,fx1,fSc,fNc) 为缺失区域在「源坐标系」的经纬度（度），(W,E,S,N) 为目标瓦片矩形。
 * 逐级走 gg = g-1 … 0，用已解析的 okImgs 贴交集；没有任何缓存可填时才留透明。
 */
function drawCoarseFill(ctx, gg, fx0, fx1, fSc, fNc, W, E, S, N) {
  for (let lg = gg - 1; lg >= 0; lg--) {
    const c0 = gibsCol(fx0, lg);
    const c1 = gibsCol(fx1, lg);
    const r0 = gibsRow(fNc, lg);
    const r1 = gibsRow(fSc, lg);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const img = okImgs.get(`${lg}/${c}/${r}`);
        if (!img) continue;
        const { gw, ge, gn, gs } = gibsRect(c, r, lg);
        const x0 = Math.max(fx0, gw), x1 = Math.min(fx1, ge);
        const n2 = Math.min(fNc, gn), s2 = Math.max(fSc, gs);
        if (x1 <= x0 || n2 <= s2) continue;
        const sx = ((x0 - gw) / (ge - gw)) * TILE_PX;
        const sw = ((x1 - x0) / (ge - gw)) * TILE_PX;
        const sy = ((gn - n2) / (gn - gs)) * TILE_PX;
        const sh = ((n2 - s2) / (gn - gs)) * TILE_PX;
        // 源坐标 → 显示坐标（偏移/缩放旋钮）→ 画布像素
        const ix0 = LON_SCALE * x0 + LON_OFF, ix1 = LON_SCALE * x1 + LON_OFF;
        const iN = LAT_SCALE * n2 + LAT_OFF, iS = LAT_SCALE * s2 + LAT_OFF;
        const dx = ((ix0 - W) / (E - W)) * OUT;
        const dw = ((ix1 - ix0) / (E - W)) * OUT;
        const dy = ((N - iN) / (N - S)) * OUT;
        const dh = ((iN - iS) / (N - S)) * OUT;
        // 接缝修复：与 drawGibsTile 同款重叠
        const sxr = sw > 0 ? sw / dw : 0;
        const syr = sh > 0 ? sh / dh : 0;
        let sxx = sx - TILE_OVERLAP * sxr;
        let syy = sy - TILE_OVERLAP * syr;
        let sww = sw + 2 * TILE_OVERLAP * sxr;
        let shh = sh + 2 * TILE_OVERLAP * syr;
        if (sxx < 0) { sww += sxx; sxx = 0; }
        if (syy < 0) { shh += syy; syy = 0; }
        if (sxx + sww > TILE_PX) sww = TILE_PX - sxx;
        if (syy + shh > TILE_PX) shh = TILE_PX - syy;
        ctx.drawImage(img, sxx, syy, sww, shh, dx - TILE_OVERLAP, dy - TILE_OVERLAP, dw + 2 * TILE_OVERLAP, dh + 2 * TILE_OVERLAP);
      }
    }
  }
}

/**
 * 生成一张 debug 瓦片画布（512×512）：纬度渐变底色（北极蓝→南极红，暴露纬度偏移）+
 * 贯穿的经纬网格线（相邻瓦片边界对齐即证明坐标转换连续）+ L/r/c 与经纬边界标注。
 * @param {number} g  GIBS 级
 * @param {number} c  GIBS 列
 * @param {number} r  GIBS 行（纬度方向，r=0 北极）
 */
function makeDebugTile(g, c, r) {
  const cv = document.createElement('canvas');
  cv.width = TILE_PX;
  cv.height = TILE_PX;
  const x = cv.getContext('2d');
  // 纬度编码底色：r=0（北极）→ 蓝(210°)，r=ROWS-1（南极）→ 红(0°)
  const t = ROWS[g] > 1 ? r / (ROWS[g] - 1) : 0;
  const hue = 210 - t * 210;
  x.fillStyle = `hsl(${hue}, 65%, 55%)`;
  x.fillRect(0, 0, TILE_PX, TILE_PX);
  // 细分网格（每瓦片 4×4），相邻瓦片边界应精确对齐 → 暴露经/纬线断裂
  x.strokeStyle = 'rgba(255,255,255,0.55)';
  x.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const p = (i / 4) * TILE_PX;
    x.beginPath(); x.moveTo(p, 0); x.lineTo(p, TILE_PX); x.stroke();
    x.beginPath(); x.moveTo(0, p); x.lineTo(TILE_PX, p); x.stroke();
  }
  // 外边框（粗，强调瓦片边界）
  x.strokeStyle = 'rgba(0,0,0,0.85)';
  x.lineWidth = 4;
  x.strokeRect(2, 2, TILE_PX - 4, TILE_PX - 4);
  // 标注
  const { gw, ge, gn, gs } = gibsRect(c, r, g);
  x.fillStyle = '#000';
  x.textAlign = 'center';
  x.font = 'bold 30px monospace';
  x.fillText(`L${g} r${r} c${c}`, TILE_PX / 2, TILE_PX / 2 - 34);
  x.font = '19px monospace';
  x.fillText(`lon ${gw.toFixed(1)}~${(gw + 360 / COLS[g]).toFixed(1)}`, TILE_PX / 2, TILE_PX / 2 + 4);
  x.fillText(`lat ${gs.toFixed(1)}~${gn.toFixed(1)}`, TILE_PX / 2, TILE_PX / 2 + 32);
  return cv;
}

/**
 * 把地理瓦片 (x, y, level) 拼贴成 OUT×OUT 画布。
 * 失败路径（部分源瓦片拉取失败）对相应区域留透明——极区底图另有原生拉伸兜底，
 * 全失败时 errorEvent 会被 ImagerySourceManager 计数并自动切备用源。
 */
async function drawGibsTile(x, y, level) {
  // 低层级（Cesium L0~L3）统一取 GIBS g2：
  //   低空视图需要的低级影像瓦片动辄近百张（1000km 实测 96 张），逐张排队拉取
  //   每张 1~15s = 「低 zoom 极区大片露 globe 底色（洞）」的根因。
  //   g2 全网仅 15 张、含两极，启动预取后低空视图全部命中缓存、秒级铺满。
  //   L3 分辨率 7km/px vs g2 15.7km/px——在低空的屏幕分辨率下肉眼无差。
  //   L4 起逐级用同名 g（视野小、张数少，网络可承受）。
  const g = clamp(level <= 3 ? 2 : level, 0, MAX_LEVEL);
  const rect = geoScheme.tileXYToRectangle(x, y, level);
  const D2 = Cesium.Math.toDegrees;
  // 目标瓦片经纬矩形（度）：W<E、S<N
  const W = D2(rect.west), E = D2(rect.east), S = D2(rect.south), N = D2(rect.north);

  // 偏移 + 缩放旋钮（绕赤道 lat0 / 本初子午线 lon0）：
  //   显示纬度 L → 源纬度 f = (L − LAT_OFF) / LAT_SCALE；源 f → 显示 LAT_SCALE·f + LAT_OFF
  //   LAT_OFF>0 内容北移；LAT_SCALE>1 纬度被拉向两极（两极对称留洞）。
  const fW = (W - LON_OFF) / LON_SCALE;
  const fE = (E - LON_OFF) / LON_SCALE;
  const fS = (S - LAT_OFF) / LAT_SCALE;
  const fN = (N - LAT_OFF) / LAT_SCALE;

  const c0 = gibsCol(fW, g);
  const c1 = gibsCol(fE, g);
  const r0 = gibsRow(fN, g);
  const r1 = gibsRow(fS, g);

  // 并发拉取所有相关源瓦片，单张失败不拖垮整瓦（留透明）
  const jobs = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (DEBUG) {
        // 调试瓦片：按 GIBS 真实网格生成带坐标标注 + 纬度渐变色 + 贯穿网格线的画布，
        // 复用同一套经纬度映射贴到球面。球面沿经线应无缝连续、南极到 -90。
        jobs.push(Promise.resolve(makeDebugTile(g, c, r)));
      } else {
        jobs.push(loadGibsTile(g, c, r).catch(() => null));
      }
    }
  }
  const imgs = await Promise.all(jobs);

  const canvas = document.createElement('canvas');
  canvas.width = OUT;
  canvas.height = OUT;
  const ctx = canvas.getContext('2d');

  let i = 0;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++, i++) {
      const img = imgs[i];
      // 该 GIBS 瓦片真实经纬矩形（自然跨度 = 288/2^g，边缘瓦片自然越界由交集裁剪）
      const { gw, ge, gn, gs } = gibsRect(c, r, g);
      // 取源窗口（已偏移/缩放）与 GIBS 瓦片的交集
      const fx0 = Math.max(fW, gw), fx1 = Math.min(fE, ge);
      const fNc = Math.min(fN, gn), fSc = Math.max(fS, gs);
      if (fx1 <= fx0 || fNc <= fSc) continue;
      if (!img) {
        // 源瓦片拉取失败：用更低级、已缓存的内容回填，避免永久透明洞（露 globe 底色）
        drawCoarseFill(ctx, g, fx0, fx1, fSc, fNc, W, E, S, N);
        continue;
      }
      // 源像素矩形（512×512，行 0 在北；用自然跨度 ge-gw / gn-gs）
      const sx = ((fx0 - gw) / (ge - gw)) * TILE_PX;
      const sw = ((fx1 - fx0) / (ge - gw)) * TILE_PX;
      const sy = ((gn - fNc) / (gn - gs)) * TILE_PX;
      const sh = ((fNc - fSc) / (gn - gs)) * TILE_PX;
      // 目标画布矩形（256×256）：源 f → 显示 LAT_SCALE·f + LAT_OFF / LON_SCALE·f + LON_OFF
      const ix0 = LON_SCALE * fx0 + LON_OFF, ix1 = LON_SCALE * fx1 + LON_OFF;
      const iN = LAT_SCALE * fNc + LAT_OFF, iS = LAT_SCALE * fSc + LAT_OFF;
      const dx = ((ix0 - W) / (E - W)) * OUT;
      const dw = ((ix1 - ix0) / (E - W)) * OUT;
      const dy = ((N - iN) / (N - S)) * OUT;
      const dh = ((iN - iS) / (N - S)) * OUT;
      // 接缝修复：源/目标各外扩 TILE_OVERLAP，交叠盖掉源边界台阶
      const sxr = sw > 0 ? sw / dw : 0; // 源 px / 画布 px（横）
      const syr = sh > 0 ? sh / dh : 0; // 纵
      let sxx = sx - TILE_OVERLAP * sxr;
      let syy = sy - TILE_OVERLAP * syr;
      let sww = sw + 2 * TILE_OVERLAP * sxr;
      let shh = sh + 2 * TILE_OVERLAP * syr;
      if (sxx < 0) { sww += sxx; sxx = 0; }
      if (syy < 0) { shh += syy; syy = 0; }
      if (sxx + sww > TILE_PX) sww = TILE_PX - sxx;
      if (syy + shh > TILE_PX) shh = TILE_PX - syy;
      const dxx = dx - TILE_OVERLAP;
      const dyy = dy - TILE_OVERLAP;
      const dww = dw + 2 * TILE_OVERLAP;
      const dhh = dh + 2 * TILE_OVERLAP;
      ctx.drawImage(img, sxx, syy, sww, shh, dxx, dyy, dww, dhh);
    }
  }

  // 调试/网格：画「真·地理赤道 / 本初子午线」固定参考线（基于原始 N,S,W,E，
  // 不随偏移滑动）——肉眼比对内容（渐变或真实影像）相对真经纬网是否错位。
  if (DEBUG || GRID) {
    const yEq = ((N - 0) / (N - S)) * OUT;
    const xMe = ((0 - W) / (E - W)) * OUT;
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    if (yEq >= 0 && yEq <= OUT) {
      ctx.beginPath(); ctx.moveTo(0, yEq); ctx.lineTo(OUT, yEq); ctx.stroke();
      ctx.fillStyle = '#000'; ctx.font = 'bold 15px monospace'; ctx.textAlign = 'left';
      ctx.fillText('EQ lat0', 3, Math.min(Math.max(yEq - 4, 13), OUT - 3));
    }
    if (xMe >= 0 && xMe <= OUT) {
      ctx.beginPath(); ctx.moveTo(xMe, 0); ctx.lineTo(xMe, OUT); ctx.stroke();
      ctx.fillText('lon0', Math.min(Math.max(xMe + 2, 2), OUT - 36), 13);
    }
  }

  // 拼接线归属标尺：把所有「候选边界经线」按家族着色画在影像上。
  // 球面上看到的拼接线若压在某一色的线上，即归属该类边界：
  //   红 = Cesium L2 瓦片边界（45° 间隔）   黄 = Cesium L3（22.5°）
  //   橙 = Cesium L4（11.25°）             青 = GIBS g2 源瓦片（72°）
  //   品红 = GIBS g3（36°）                紫 = GIBS g4（18°）
  // 都不压 → 非瓦片边界（GPU mip/滤波伪影或地物）。
  if (MERID && !DEBUG) {
    const fams = [
      { w: 45, color: '#ff3030', tag: 'L2' },
      { w: 22.5, color: '#ffe000', tag: 'L3' },
      { w: 11.25, color: '#ff9000', tag: 'L4' },
      { w: 72, color: '#00e5ff', tag: 'g2' },
      { w: 36, color: '#ff40ff', tag: 'g3' },
      { w: 18, color: '#a060ff', tag: 'g4' },
    ];
    ctx.lineWidth = 1;
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'left';
    for (const f of fams) {
      // 边界经度：-180 + k·w（覆盖到 +180）
      let k0 = Math.ceil((-180 - W) / f.w);
      const k1 = Math.floor((180 - W) / f.w);
      for (; k0 <= k1; k0++) {
        const lon = -180 + k0 * f.w;
        if (lon < W || lon > E) continue;
        const xPx = ((lon - W) / (E - W)) * OUT;
        if (xPx < 0 || xPx > OUT) continue;
        ctx.strokeStyle = f.color;
        ctx.globalAlpha = 0.9;
        ctx.beginPath(); ctx.moveTo(xPx + 0.5, 0); ctx.lineTo(xPx + 0.5, OUT); ctx.stroke();
        ctx.fillStyle = f.color;
        ctx.globalAlpha = 1;
        ctx.fillText(f.tag, Math.min(xPx + 1, OUT - 14), 10);
      }
    }
    ctx.globalAlpha = 1;
  }
  return canvas;
}

let warmed = false;
/**
 * 预取 g0（2 张，全球兜底）+ g2（15 张，全层级 L0~L3 的内容源，含两极）。
 * 共 17 张 ~400KB：低 zoom 铺满不再依赖上百张逐张排队；
 * 同时给 drawCoarseFill 提供任何层级失败时的回填底图。
 */
function warmup() {
  if (warmed) return;
  warmed = true;
  for (let c = 0; c < COLS[0]; c++) loadGibsTile(0, c, 0).catch(() => {});
  for (let c = 0; c < COLS[2]; c++) {
    for (let r = 0; r < ROWS[2]; r++) loadGibsTile(2, c, r).catch(() => {});
  }
}

/**
 * GIBS Blue Marble Next Generation 影像 provider（鸭子类型实现 ImageryProvider 接口，
 * Cesium 1.146 对 imagery provider 是鸭子类型调用：requestImage/getTileCredits/
 * tilingScheme/tileWidth/... 无需继承基类）。
 */
export class GibsBlueMarbleProvider {
  constructor() {
    warmup();
    this.tilingScheme = geoScheme;          // ±90° 全极区几何
    this.rectangle = geoScheme.rectangle;
    this.tileWidth = OUT;
    this.tileHeight = OUT;
    this.minimumLevel = 0;
    this.maximumLevel = MAX_LEVEL;          // 超出后 Cesium 自动复用 L7 纹理
    this.errorEvent = new Cesium.Event();   // ImagerySourceManager 故障计数依赖
    this.hasAlphaChannel = true;
    this.credit = new Cesium.Credit('NASA GIBS / Blue Marble Next Generation');
    this.enablePickFeatures = false;
  }

  getTileCredits() { return []; }

  requestImage(x, y, level) {
    return drawGibsTile(x, y, level).catch((e) => {
      // 上抛 errorEvent（自动切换计数），同时 reject 让 Cesium 走失败重试
      try { this.errorEvent.raiseEvent(this, x, y, level, e); } catch { /* 忽略 */ }
      throw e;
    });
  }
}

/**
 * 创建 GIBS Blue Marble provider。
 * @param {{baseUrl?: string}} [opts] baseUrl：源瓦片根路径，默认本地代理缓存
 *   '/tiles/gibs/'；传上游地址则直连 NASA GIBS（不写本地缓存）。
 */
export function createGibsProvider(opts = {}) {
  if (opts.baseUrl) URL_PREFIX = opts.baseUrl;
  return new GibsBlueMarbleProvider();
}

if (typeof window !== 'undefined') {
  // 控制台切换 debug 瓦片：__setGibsDebug(true/false)，无需刷新即可对比坐标映射
  window.__setGibsDebug = setGibsDebug;
  window.__setGibsLatOff = setGibsLatOff;
  window.__setGibsLonOff = setGibsLonOff;
  window.__setGibsLatScale = setGibsLatScale;
  window.__setGibsLonScale = setGibsLonScale;
}
