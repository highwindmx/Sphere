/*
 * src/osm-glyphs.js
 *
 * 离线字形（glyph SDF）本地生成 —— 让拉丁 / 西里尔 / 希腊等文字在**完全离线**下也能显示。
 *
 * ── 为什么要这个模块（2026-10-29 米兰实测） ──
 *   · 离线 pmtiles 数据里街道名一条不少（米兰 z15 中心瓦片 707 条道路、214 条带 name）；
 *   · 但 MapLibre 渲染任何文字前，必须先取到该字符的 **SDF 字形**，唯一来源是 style.glyphs；
 *   · 离线时 glyphs 服务器不可达，旧兜底是返回「空字形 PBF」（fontstack 存在、glyphs 为空）：
 *       - 中日韩字符：MapLibre 有 localIdeographFontFamily 回退 → 用本机字体现生成 → 能显示；
 *       - 拉丁字母：**不在 ideograph 回退范围内** → 一个字形都拿不到 → **整条标签被丢弃**。
 *     实测证据：米兰 pmt-road-label = 0、pmt-area-label = 0，而 pmt-road = 3724、pmt-3d = 1773。
 *     推论：上海看着正常只是因为中文走了 ideograph 回退；欧洲 / 美洲城市必然整城无字。
 *
 * ── 方案 ──
 *   Canvas 2D 用本机字体画出字符 → 计算 SDF（Felzenszwalb 距离变换，参数与 MapLibre 内置的
 *   tiny-sdf 完全一致：fontSize 24 / buffer 3 / radius 8 / cutoff 0.25）→ 按 sdf-glyphs 规范
 *   编码 protobuf 返回。零网络、零等待，任何本机字体支持的字符都能显示。
 *
 * ── 与 localIdeographFontFamily 的分工 ──
 *   本模块只处理 **非 CJK** 区间（< U+2E80）：拉丁、西里尔、希腊、阿拉伯、假名等；
 *   CJK 区间返回 null，仍交给 MapLibre 内置的 ideograph 回退（已验证可用，且更快）。
 */

// —— 参数必须与 MapLibre 内置 tiny-sdf 一致，否则字形边缘阈值对不上（会变粗/变细/糊） ——
const FONT_SIZE = 24;
const BUFFER = 3;      // SDF 四周留白（像素）
const RADIUS = 8;      // SDF 有效半径
const CUTOFF = 0.25;   // 0.5 - 0.25 = 0.25 → 轮廓处 alpha ≈ 191，正好是 MapLibre 的 buffer 0.75
const INF = 1e20;

// 首个 CJK 及以后的区间：交给 localIdeographFontFamily
const CJK_START = 0x2e80;

let _canvas = null, _ctx = null;
function ctx2d() {
  if (!_ctx) {
    _canvas = document.createElement('canvas');
    _ctx = _canvas.getContext('2d', { willReadFrequently: true });
  }
  return _ctx;
}

// 'Noto Sans Regular' / 'Open Sans Bold Italic' → canvas font 字符串
function canvasFontFor(stack) {
  const s = String(stack || '');
  const weight = /\bbold\b/i.test(s) ? 'bold ' : '';
  const style = /\b(italic|oblique)\b/i.test(s) ? 'italic ' : '';
  const fam = s.replace(/\b(regular|bold|italic|oblique|medium|light|semibold|condensed)\b/ig, '')
    .replace(/[^\w\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  // 家族名带空格必须加引号；再串一条通用回退链，保证任何系统都有字形
  const first = fam ? `"${fam}", ` : '';
  return `${style}${weight}${FONT_SIZE}px ${first}"Segoe UI", "Microsoft YaHei", Arial, sans-serif`;
}

// ---------- Felzenszwalb & Huttenlocher 欧氏距离变换（2D） ----------
// 参考 tiny-sdf / mapbox sdf-glyph-foundry；O(n) 复杂度，先用 1D 逐列再逐行。
let _f = null, _v = null, _z = null;
function edt1d(grid, offset, stride, length, f, v, z) {
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  f[0] = grid[offset];
  for (let q = 1, k = 0, s = 0; q < length; q++) {
    f[q] = grid[offset + q * stride];
    const qq = q * q;
    do {
      const r = v[k];
      s = (f[q] - f[r] + qq - r * r) / (q - r) / 2;
    } while (s <= z[k] && --k > -1);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  for (let q = 0, k = 0; q < length; q++) {
    while (z[k + 1] < q) k++;
    const r = v[k];
    const qr = q - r;
    grid[offset + q * stride] = f[r] + qr * qr;
  }
}
let _outer = null, _inner = null;
function edt2d(grid, w, h) {
  const len = Math.max(w, h);
  if (!_f || _f.length < len) {
    _f = new Float64Array(len);
    _v = new Int32Array(len);
    _z = new Float64Array(len + 1);
  }
  for (let x = 0; x < w; x++) edt1d(grid, x, w, h, _f, _v, _z);
  for (let y = 0; y < h; y++) edt1d(grid, y * w, 1, w, _f, _v, _z);
}
// alpha（0–255，抗锯齿灰度）→ SDF alpha（轮廓处 191，内部 255，外部 0）
function computeSDF(alpha, w, h) {
  const n = w * h;
  if (!_outer || _outer.length < n) {
    _outer = new Float64Array(n);
    _inner = new Float64Array(n);
  }
  const outer = _outer, inner = _inner;
  for (let i = 0; i < n; i++) {
    const a = alpha[i] / 255;
    outer[i] = a === 1 ? 0 : a === 0 ? INF : Math.pow(Math.max(0, 0.5 - a), 2);
    inner[i] = a === 1 ? INF : a === 0 ? 0 : Math.pow(Math.max(0, a - 0.5), 2);
  }
  edt2d(outer, w, h);
  edt2d(inner, w, h);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const d = Math.sqrt(outer[i]) - Math.sqrt(inner[i]);
    const a = Math.round(255 - 255 * (d / RADIUS + CUTOFF));
    out[i] = a < 0 ? 0 : a > 255 ? 255 : a;
  }
  return out;
}

// 画一个字符 → { bitmap(SDF), width, height, left, top, advance }
function renderGlyph(ch, font) {
  const ctx = ctx2d();
  ctx.font = font;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#000';
  const m = ctx.measureText(ch);
  // actualBoundingBoxLeft 是「对齐点到左边界的距离，向左为正」→ 左边界 x = -left
  const l = -m.actualBoundingBoxLeft;
  const r = m.actualBoundingBoxRight;
  const asc = m.actualBoundingBoxAscent;
  const desc = m.actualBoundingBoxDescent;
  // ⭐⭐ 墨迹尺寸（不含 buffer）与画布尺寸（含 buffer）必须分开：
  //   MapLibre 4.x 解析字形时执行 `bitmap = new Image({width: w + 2*3, height: h + 2*3}, bytes)`
  //   —— 它假定 PBF 里的 width/height 是**墨迹尺寸**，padding 由它自己补 3px。
  //   若把 buffer 算进 width/height，字节数就对不上，抛 "mismatched image size"
  //   （实测：空格 6×6 → 期望 (6+6)×(6+6)=144 字节，只给了 36）→ 整批字形作废。
  const wInk = Math.max(1, Math.ceil(r - l));
  const hInk = Math.max(1, Math.ceil(asc + desc));
  const w = wInk + BUFFER * 2;
  const h = hInk + BUFFER * 2;
  if (_canvas.width < w || _canvas.height < h) {
    _canvas.width = Math.max(_canvas.width, w);
    _canvas.height = Math.max(_canvas.height, h);
    ctx.font = font;                       // 改尺寸会重置上下文状态，必须重设
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#000';
  } else {
    ctx.clearRect(0, 0, w, h);
  }
  ctx.fillText(ch, BUFFER - l, BUFFER + asc);
  const px = ctx.getImageData(0, 0, w, h).data;
  const alpha = new Uint8Array(w * h);
  let any = false;
  for (let i = 0; i < w * h; i++) { const a = px[i * 4 + 3]; alpha[i] = a; if (a) any = true; }
  return {
    bitmap: any ? computeSDF(alpha, w, h) : new Uint8Array(w * h),
    width: wInk, height: hInk,           // ← 墨迹尺寸；bitmap 实际是 (wInk+6)×(hInk+6)
    left: Math.floor(l) - BUFFER,        // 相对笔位（可为负）
    top: Math.ceil(asc) + BUFFER,        // 基线上方距离
    advance: Math.round(m.width),
  };
}

// ---------- protobuf（sdf-glyphs v1） ----------
//   glyph     { uint32 id=1; bytes bitmap=2; uint32 width=3; uint32 height=4;
//               sint32 left=5; sint32 top=6; uint32 advance=7 }
//   fontstack { string name=1; string range=2; repeated glyph glyphs=3 }
//   glyphs    { repeated fontstack stacks=1 }
function pushVarint(out, n) {
  n = n >>> 0;
  do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n);
}
function pushTag(out, field, wire) { pushVarint(out, (field << 3) | wire); }
function pushBytes(out, field, bytes) {
  pushTag(out, field, 2);
  pushVarint(out, bytes.length);
  for (let i = 0; i < bytes.length; i++) out.push(bytes[i]);
}
function pushStr(out, field, s) { pushBytes(out, field, Array.from(new TextEncoder().encode(s))); }
function glyphMessage(out, id, g) {
  pushTag(out, 1, 0); pushVarint(out, id);
  pushBytes(out, 2, g.bitmap);
  pushTag(out, 3, 0); pushVarint(out, g.width);
  pushTag(out, 4, 0); pushVarint(out, g.height);
  pushTag(out, 5, 0); pushZigzagVarint(out, g.left);
  pushTag(out, 6, 0); pushZigzagVarint(out, g.top);
  pushTag(out, 7, 0); pushVarint(out, g.advance);
}
function pushZigzagVarint(out, n) { pushVarint(out, (((n << 1) ^ (n >> 31)) >>> 0)); }

const _cache = new Map();

/**
 * 生成一段 range（如 0-255）的字形 PBF。
 * @returns {Uint8Array|null}  null = 本模块不处理（CJK 区间，交给 localIdeographFontFamily）
 */
export function glyphRangePbf(stack, start, end) {
  if (!(end >= start) || start >= CJK_START) return null;
  const key = stack + ':' + start + '-' + end;
  if (_cache.has(key)) return _cache.get(key);
  const font = canvasFontFor(stack);
  const glyphs = [];
  // 控制字符不生成字形（MapLibre 遇到缺失会跳过该字符，不会整条丢弃）
  for (let id = Math.max(start, 32); id <= Math.min(end, 0xffff); id++) {
    let ch;
    try { ch = String.fromCharCode(id); } catch (e) { continue; }
    let g;
    try { g = renderGlyph(ch, font); } catch (e) { continue; }
    if (!g) continue;
    const out = [];
    glyphMessage(out, id, g);
    glyphs.push(Uint8Array.from(out));
  }
  const stacks = [];
  const inner = [];
  pushStr(inner, 1, stack);
  pushStr(inner, 2, start + '-' + end);
  for (const g of glyphs) pushBytes(inner, 3, g);
  pushBytes(stacks, 1, Uint8Array.from(inner));
  const data = Uint8Array.from(stacks);
  _cache.set(key, data);
  return data;
}

// 调试用：清空缓存
export function clearGlyphCache() { _cache.clear(); }
