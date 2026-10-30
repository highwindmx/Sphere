// src/offscreen.js — 屏幕边缘指示器（球背面标记的扇区聚合引出）
//
// 需求背景：球背面的标记原本靠 disableDepthTestDistance=∞ 透视显示，成了「贴在球面上的幽灵文字」。
// 现在背面标记在球体上直接隐藏（layer-renderer 用 EllipsoidalOccluder 判定），改在【屏幕边缘】引出。
//
// 交互（2026-10-28 用户定版）：名称标签放在离目标最近的屏幕边缘 + 折线引出 + 目标圆点，
//   落在球体圆盘内的那一段用虚线。
//
// ⭐ 2026-10-29 重写（实测数据驱动，用户确认）：
//   旧版缺陷：① `MAX_ITEMS=20` —— 全球视角 412 个背面标注只画 20 条（4.8%），其余无声消失；
//             ② 引线从边缘一路画到球盘内的投影点 → 20 条线横穿整个球面成束（低空尤甚，
//                因为背面点的投影落在球盘中心附近）；③ 挑选优先级是「离视口中心近」，
//                而不是「离地平线近（马上要转过来）」。
//   新版：按【屏幕方向 16 扇区】聚合 —— 每扇区一条标签（代表 = 该方向离地平线最近的那一个，
//   其余计成 +N），只画 30px「短须 + 箭头」指向内侧，不再横穿球盘；点击标签直接飞过去。
//   → 屏幕上恒定 ≤16 条，但 100% 的背面标注都可达（不再有"无声消失"）。

import * as Cesium from 'cesium';

const SVG_NS = 'http://www.w3.org/2000/svg';
const SECTORS = 16;        // 屏幕方向扇区数（每 22.5°）
const M = 12;              // 左右边缘内缩
const RIGHT_NAV = 86;      // 右侧内缩：让开 cesium-navigation 控件列（right:48 + 30px 宽 + 8px 间隙），
                           // 否则右边缘标签/引线正好压在罗盘、缩放 ±、场景三钮上（2026-10-29 实测）
const MT = 40;             // 顶部避让（标题/导航区）
const MB = 26;             // 底部避让（版权条）
const MIN_GAP = 6;         // 同边相邻标签的净间隙（按包围盒算，不再是锚点间距）
const LABEL_H = 16;
const STUB = 30;           // 短须长度（不再一路画到球盘内）
const ARROW = 5;           // 箭头半宽

export function createOffscreenIndicator(viewer, container) {
  if (!viewer || !container) return null;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'offscreen-layer');
  svg.setAttribute('pointer-events', 'none');
  svg.style.position = 'absolute';
  svg.style.inset = '0';
  svg.style.width = '100%';
  svg.style.height = '100%';
  svg.style.overflow = 'visible';
  svg.style.zIndex = '6';
  svg.style.display = 'none';
  container.appendChild(svg);

  const pool = [];
  let items = [];
  let enabled = true;
  const _scratch = new Cesium.Cartesian2();

  // 量宽用的隐藏文本节点（font 与正式标签保持一致）
  const meas = document.createElementNS(SVG_NS, 'text');
  meas.setAttribute('font', 'bold 12px "Microsoft YaHei","PingFang SC","Noto Sans SC",sans-serif');
  meas.setAttribute('visibility', 'hidden');
  meas.setAttribute('x', '0');
  meas.setAttribute('y', '0');
  svg.appendChild(meas);
  const _v1 = new Cesium.Cartesian3();
  const _v2 = new Cesium.Cartesian3();
  const _v3 = new Cesium.Cartesian3();
  const _v4 = new Cesium.Cartesian3();
  const _u1 = new Cesium.Cartesian3();
  const _u2 = new Cesium.Cartesian3();

  function node(i) {
    if (pool[i]) return pool[i];
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('pointer-events', 'auto');   // 父 svg 是 none，子级显式打开才能点击
    g.style.cursor = 'pointer';
    const stub = document.createElementNS(SVG_NS, 'polyline');
    stub.setAttribute('fill', 'none');
    stub.setAttribute('stroke-width', '1.4');
    stub.setAttribute('stroke-linecap', 'round');
    stub.setAttribute('stroke-dasharray', '4 3');   // 虚线 = 指向球体背后
    const arrow = document.createElementNS(SVG_NS, 'polygon');
    const bg = document.createElementNS(SVG_NS, 'rect');
    bg.setAttribute('rx', '3');
    bg.setAttribute('ry', '3');
    bg.setAttribute('fill', 'rgba(8,12,24,0.82)');
    bg.setAttribute('stroke-width', '1');
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('font', 'bold 12px "Microsoft YaHei","PingFang SC","Noto Sans SC",sans-serif');
    text.setAttribute('fill', '#eef3ff');
    text.setAttribute('dominant-baseline', 'middle');
    const tip = document.createElementNS(SVG_NS, 'title');   // 悬停列出该方向的若干名称
    g.appendChild(stub); g.appendChild(arrow); g.appendChild(bg); g.appendChild(text); g.appendChild(tip);
    svg.appendChild(g);
    pool[i] = { g, stub, arrow, bg, text, tip };
    return pool[i];
  }

  /** 目标点相对相机的屏幕方向（单位向量，y 向下）。用相机基向量算，不依赖投影 → 点在相机后方也成立 */
  function screenDir(pos) {
    const cam = viewer.camera;
    if (!cam) return null;
    const to = Cesium.Cartesian3.subtract(pos, cam.positionWC, _v1);
    const x = Cesium.Cartesian3.dot(to, cam.rightWC);
    const y = -Cesium.Cartesian3.dot(to, cam.upWC);   // 屏幕 y 向下
    const len = Math.hypot(x, y);
    if (!(len > 1e-9)) return null;
    return { x: x / len, y: y / len };
  }

  /** 离地平线的接近度：dot(点法向, 相机方向) 越大 = 越接近地平线（马上要转到正面） */
  function horizonDot(pos) {
    Cesium.Cartesian3.normalize(pos, _u1);
    Cesium.Cartesian3.normalize(viewer.camera.positionWC, _u2);
    return Cesium.Cartesian3.dot(_u1, _u2);
  }

  // ⭐ 左侧内缩要避开侧栏：#panel 是浮在球面上的卡片（z20，宽 310 + left12），
  //   指示器 SVG 只有 z6，贴左边缘的标签会被它整条盖住（2026-10-29 实测）。
  //   折叠（body.panel-collapsed）时侧栏宽度为 0，恢复默认内缩。
  function leftInset() {
    try {
      const p = document.getElementById('panel');
      if (!p) return M;
      const r = p.getBoundingClientRect();
      if (!r.width || r.right <= 0) return M;
      return Math.max(M, r.right + 8);
    } catch {
      return M;
    }
  }

  /** 从 (cx,cy) 沿单位方向 (dx,dy) 到内缩矩形边界的交点 */
  function rayToRect(cx, cy, dx, dy, W, H) {
    const left = leftInset(), right = W - RIGHT_NAV, top = MT, bottom = H - MB;
    let t = Infinity;
    if (dx > 1e-6) t = Math.min(t, (right - cx) / dx);
    else if (dx < -1e-6) t = Math.min(t, (left - cx) / dx);
    if (dy > 1e-6) t = Math.min(t, (bottom - cy) / dy);
    else if (dy < -1e-6) t = Math.min(t, (top - cy) / dy);
    if (!isFinite(t) || t <= 0) return null;
    return { x: cx + dx * t, y: cy + dy * t };
  }

  function edgeOf(p, W, H) {
    if (p.x >= W - RIGHT_NAV - 1.5) return 'right';
    if (p.x <= leftInset() + 1.5) return 'left';
    if (p.y <= MT + 1.5) return 'top';
    return 'bottom';
  }

  /** 标签宽度估算（CJK ≈12px/字，拉丁/数字 ≈6.6px/字）+ 内边距 */
  function estimateWidth(s) {
    let em = 0;
    for (const ch of s) em += ch.codePointAt(0) > 0x2e80 ? 12 : 6.6;
    return em + 10;
  }

  // ⭐ 用真实 bbox 量宽（2026-10-29 实测）：按字符数估算系统性偏小 20~45px
  //   （「德朗海峡（东北航道瓶颈）+2」估算 174 / 实际 219）→ 同边 dodge 按错宽度排布仍会叠字。
  //   visibility:hidden 的节点仍有几何，getBBox() 可用（display:none 才量不到）。
  function textWidth(s) {
    try {
      meas.textContent = s;
      const w = meas.getBBox().width;
      if (w > 0) return w + 10;
    } catch { /* 量不到就用估算 */ }
    return estimateWidth(s);
  }

  /** 计算球体在屏幕上的圆盘（轮廓）圆心与半径（像素）；无法计算时返回 null */
  function computeSilhouette(W, H) {
    try {
      const scene = viewer.scene;
      const ellipsoid = (scene.globe && scene.globe.ellipsoid) || Cesium.Ellipsoid.WGS84;
      const R = ellipsoid.maximumRadius;
      const camPos = viewer.camera.positionWC;
      const center = Cesium.Cartesian3.ZERO;
      const d = Cesium.Cartesian3.distance(camPos, center);
      if (!(d > R)) return null;                       // 相机在地表内（异常）则放弃
      // 轮廓圆心 = 球心沿「相机→球心」方向距离 a = R²/d 处的点（球冠切点平面中心）
      const dir = Cesium.Cartesian3.normalize(Cesium.Cartesian3.subtract(center, camPos, _v1), _v2);
      const a = (R * R) / d;
      const limbC = Cesium.Cartesian3.add(camPos, Cesium.Cartesian3.multiplyByScalar(dir, a, _v3), _v4);
      const c = scene.cartesianToCanvasCoordinates(limbC, _scratch);
      if (!c) return null;
      const fovy = viewer.camera.frustum && viewer.camera.frustum.fov;
      if (!fovy) return null;
      const ppr = (H / 2) / Math.tan(fovy / 2);        // 每弧度像素数（竖向）
      const alpha = Math.asin(Math.min(1, R / d));     // 角半径
      const r = alpha * ppr;
      if (!(r > 0) || !isFinite(r)) return null;
      return { cx: c.x, cy: c.y, r };
    } catch { return null; }
  }

  /** 点击扇区标签 → 把球转到该点（保持当前视高，正俯视） */
  function flyToItem(pos) {
    if (!pos) return;
    try {
      const ell = (viewer.scene && viewer.scene.globe && viewer.scene.globe.ellipsoid) || Cesium.Ellipsoid.WGS84;
      const dist = Cesium.Cartesian3.magnitude(viewer.camera.positionWC);
      const h = Math.min(2.4e7, Math.max(3e5, dist - ell.maximumRadius));
      const n = Cesium.Cartesian3.normalize(pos, new Cesium.Cartesian3());
      const dest = Cesium.Cartesian3.add(
        pos,
        Cesium.Cartesian3.multiplyByScalar(n, h, new Cesium.Cartesian3()),
        new Cesium.Cartesian3()
      );
      viewer.camera.flyTo({
        destination: dest,
        orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
        duration: 1.8,
      });
    } catch { /* 相机飞行失败不影响指示器 */ }
  }

  function update() {
    if (!enabled) { svg.style.display = 'none'; return; }
    const scene = viewer.scene;
    const canvas = scene && scene.canvas;
    if (!canvas) return;
    const W = container.clientWidth || canvas.clientWidth || 0;
    const H = container.clientHeight || canvas.clientHeight || 0;
    if (!W || !H || !items.length) { svg.style.display = 'none'; return; }
    svg.style.display = 'block';
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

    const sil = computeSilhouette(W, H);
    const cx0 = sil ? sil.cx : W / 2;
    const cy0 = sil ? sil.cy : H / 2;

    // 1) 按屏幕方向分扇区（16 个），记录方向均值与成员
    const sectors = new Map();
    for (const it of items) {
      if (!it || !it.position) continue;
      const d = screenDir(it.position);
      if (!d) continue;
      const ang = Math.atan2(d.y, d.x);                       // (-π, π]
      let si = Math.floor((ang + Math.PI) / ((2 * Math.PI) / SECTORS));
      if (si < 0) si = 0;
      if (si >= SECTORS) si = SECTORS - 1;
      let s = sectors.get(si);
      if (!s) { s = { sx: 0, sy: 0, items: [] }; sectors.set(si, s); }
      s.sx += d.x; s.sy += d.y;
      s.items.push(it);
    }
    if (!sectors.size) { svg.style.display = 'none'; return; }

    // 2) 每扇区出一条：代表 = 该方向离地平线最近的那个（马上要转过来），其余记 +N
    const placed = [];
    for (const s of sectors.values()) {
      const len = Math.hypot(s.sx, s.sy);
      if (!(len > 1e-9)) continue;
      const dx = s.sx / len, dy = s.sy / len;
      let best = null, bestDot = -Infinity;
      for (const it of s.items) {
        const dd = horizonDot(it.position);
        if (dd > bestDot) { bestDot = dd; best = it; }
      }
      if (!best) continue;
      const a = rayToRect(cx0, cy0, dx, dy, W, H);
      if (!a) continue;
      const label = s.items.length > 1 ? `${String(best.name || '')} +${s.items.length - 1}` : String(best.name || '');
      placed.push({
        name: String(best.name || ''),
        label,
        tw: textWidth(label),                      // 提前算好：dodge 要按包围盒排，不能按锚点间距
        count: s.items.length,
        names: s.items.map((x) => String(x.name || '')).filter(Boolean),
        position: best.position,
        ax: a.x, ay: a.y, edge: edgeOf(a, W, H),
        dx, dy,                                        // 由中心指向边缘的单位方向
        color: best.color || '#ffd24a',
      });
    }
    if (!placed.length) { svg.style.display = 'none'; return; }

    // 3) 按边分组，沿边方向 dodge（按**包围盒半宽**排布，不是锚点间距 —— 长标签才不会咬在一起）
    const groups = { top: [], bottom: [], left: [], right: [] };
    for (const p of placed) groups[p.edge].push(p);
    for (const key of Object.keys(groups)) {
      const arr = groups[key];
      const vert = key === 'left' || key === 'right';
      arr.sort((a, b) => (vert ? a.ay - b.ay : a.ax - b.ax));
      const lo = vert ? MT : (key === 'left' ? leftInset() : M);
      const hi = vert ? H - MB : (key === 'right' ? W - RIGHT_NAV : W - M);
      const half = (p) => (vert ? LABEL_H / 2 + 3 : p.tw / 2 + 4);
      const get = (p) => (vert ? p.ay : p.ax);
      const put = (p, v) => { if (vert) p.ay = v; else p.ax = v; };
      // 正向推开
      let prevEnd = -Infinity;
      for (const p of arr) {
        const h = half(p);
        put(p, Math.max(get(p), prevEnd + MIN_GAP + h));
        prevEnd = get(p) + h;
      }
      // 回压（越界时从末尾往前顶）
      let nextStart = Infinity;
      for (let i = arr.length - 1; i >= 0; i--) {
        const p = arr[i];
        const h = half(p);
        const limit = i === arr.length - 1 ? hi - h : nextStart - MIN_GAP - h;
        const cur = get(p);
        if (cur > limit) put(p, Math.max(limit, lo + h));
        nextStart = get(p) - h;
      }
    }

    // 4) 绘制
    const LI = leftInset();
    const order = ['right', 'left', 'top', 'bottom'];
    let idx = 0;
    for (const key of order) {
      for (const p of groups[key]) {
        const n = node(idx++);
        const color = p.color;
        const label = p.label;
        const tw = p.tw;
        // 标签盒与文字锚点（沿用四条边的排布规则）
        let bxL, bxR, byT, byB, textX, anchor;
        if (p.edge === 'right') {
          bxR = p.ax - 6; bxL = bxR - tw; byT = p.ay - LABEL_H / 2; byB = p.ay + LABEL_H / 2;
          textX = bxR - 4; anchor = 'end';
        } else if (p.edge === 'left') {
          bxL = p.ax + 6; bxR = bxL + tw; byT = p.ay - LABEL_H / 2; byB = p.ay + LABEL_H / 2;
          textX = bxL + 4; anchor = 'start';
        } else if (p.edge === 'top') {
          let cx = p.ax; bxL = cx - tw / 2; bxR = cx + tw / 2;
          if (bxL < LI) { bxL = LI; bxR = LI + tw; }
          if (bxR > W - RIGHT_NAV) { bxR = W - RIGHT_NAV; bxL = bxR - tw; }
          byB = p.ay - 6; byT = byB - LABEL_H; textX = (bxL + bxR) / 2; anchor = 'middle';
        } else { // bottom
          let cx = p.ax; bxL = cx - tw / 2; bxR = cx + tw / 2;
          if (bxL < LI) { bxL = LI; bxR = LI + tw; }
          if (bxR > W - RIGHT_NAV) { bxR = W - RIGHT_NAV; bxL = bxR - tw; }
          byT = p.ay + 6; byB = byT + LABEL_H; textX = (bxL + bxR) / 2; anchor = 'middle';
        }
        const textY = (byT + byB) / 2;
        // 短须起点（标签朝内一侧的中点），方向朝内（-dx,-dy），长度 STUB
        const attachX = (p.edge === 'right') ? bxL : (p.edge === 'left') ? bxR : (bxL + bxR) / 2;
        const attachY = (p.edge === 'top') ? byB : (p.edge === 'bottom') ? byT : textY;
        const inx = -p.dx, iny = -p.dy;
        const tipX = attachX + inx * STUB;
        const tipY = attachY + iny * STUB;

        n.stub.setAttribute('points', `${attachX.toFixed(1)},${attachY.toFixed(1)} ${tipX.toFixed(1)},${tipY.toFixed(1)}`);
        n.stub.setAttribute('stroke', color);
        // 箭头（朝内）
        const px = -iny, py = inx;    // 垂直分量
        n.arrow.setAttribute('points',
          `${(tipX + inx * ARROW * 1.6).toFixed(1)},${(tipY + iny * ARROW * 1.6).toFixed(1)} `
          + `${(tipX + px * ARROW).toFixed(1)},${(tipY + py * ARROW).toFixed(1)} `
          + `${(tipX - px * ARROW).toFixed(1)},${(tipY - py * ARROW).toFixed(1)}`);
        n.arrow.setAttribute('fill', color);

        n.text.setAttribute('x', textX.toFixed(1));
        n.text.setAttribute('y', textY.toFixed(1));
        n.text.setAttribute('text-anchor', anchor);
        n.text.textContent = label;
        n.bg.setAttribute('x', bxL.toFixed(1));
        n.bg.setAttribute('y', byT.toFixed(1));
        n.bg.setAttribute('width', tw.toFixed(1));
        n.bg.setAttribute('height', String(LABEL_H));
        n.bg.setAttribute('stroke', color);
        n.tip.textContent = p.count > 1
          ? `该方向背面共 ${p.count} 处：${p.names.slice(0, 8).join('、')}${p.count > 8 ? ' …' : ''}（点击飞到最近的一处）`
          : `${p.name}（在球体背面，点击飞过去）`;
        n.g.setAttribute('opacity', '1');
        n.g.onclick = () => flyToItem(p.position);
      }
    }
    for (let i = idx; i < pool.length; i++) {
      pool[i].g.setAttribute('opacity', '0');
      pool[i].g.onclick = null;
    }
  }

  viewer.camera.changed.addEventListener(() => { if (enabled) update(); });
  window.addEventListener('resize', () => { if (enabled) update(); });

  return {
    setItems(list) { items = Array.isArray(list) ? list : []; },
    update,
    setEnabled(on) {
      enabled = !!on;
      if (!enabled) svg.style.display = 'none';
      else update();
    },
    isEnabled: () => enabled,
    /** 冒烟用：当前绘制了几条指示条（= 有背面标注的方向扇区数） */
    debugCount: () => pool.filter((p) => p.g.getAttribute('opacity') === '1').length,
    destroy() {
      try { svg.remove(); } catch { /* 忽略 */ }
      pool.length = 0;
    },
  };
}

export default { createOffscreenIndicator };
