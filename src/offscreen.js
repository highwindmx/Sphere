// src/offscreen.js — 屏幕边缘指示器（Off-screen / 球背面标记的折线引出）
//
// 需求背景：球背面的标记原本靠 disableDepthTestDistance=∞ 透视显示，成了「贴在球面上的幽灵文字」。
// 现在背面标记在球体上直接隐藏（layer-renderer 用 EllipsoidalOccluder 判定），改在画布边缘用
// 「折线 + 箭头 + 名称」引出，兼顾「不污染球面」和「知道对面有什么」。
//
// 算法（业界成熟的 minimap/edge-indicator 套路，与 Cesium 无关、纯相机基向量分解）：
//   1. 相对相机方向 d = P − camPos，投影到相机右/上/前三个基向量 → (x, y, z)；
//   2. z ≤ 0 表示点在相机后方（正面屏外或球背面），此时屏幕方向取 (−x, −y)；
//   3. 从画布中心沿屏幕方向射线与「内缩矩形」求交 → 得到边缘锚点；
//   4. 从锚点向画布内画 18px 引线 + 朝外三角 + 文本标签。
// 纯屏幕空间，不涉及地球几何，因此对球背面、视锥外、被地形遮挡的点都成立。

import * as Cesium from 'cesium';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_ITEMS = 16;      // 单帧最多绘制的指示条（再多会糊成一片，也拖慢绘制）
const PER_DIR_MAX = 2;     // 每个 15° 方向扇区最多几条——让指示沿边缘散开，不堆在一角
const EDGE_MARGIN = 62;    // 内缩边距：避开右上角导航控件与左下角版权
const LEAD_LEN = 18;       // 引线长度
const MIN_GAP = 22;        // 同一条边上相邻指示条的最小间距
const LABEL_H = 16;

/**
 * 创建屏幕边缘指示器
 * @param {Cesium.Viewer} viewer
 * @param {HTMLElement} container 画布容器（一般是 #cesiumContainer）
 */
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

  const pool = [];          // 复用 DOM，避免每帧增删节点
  let items = [];
  let enabled = true;

  function node(i) {
    if (pool[i]) return pool[i];
    const g = document.createElementNS(SVG_NS, 'g');
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('stroke-width', '1.6');
    line.setAttribute('stroke-linecap', 'round');
    const arrow = document.createElementNS(SVG_NS, 'polygon');
    const bg = document.createElementNS(SVG_NS, 'rect');
    bg.setAttribute('rx', '3');
    bg.setAttribute('ry', '3');
    bg.setAttribute('fill', 'rgba(8,12,24,0.82)');
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('font', 'bold 12px "Microsoft YaHei","PingFang SC","Noto Sans SC",sans-serif');
    text.setAttribute('fill', '#eef3ff');
    text.setAttribute('dominant-baseline', 'middle');
    g.appendChild(line); g.appendChild(arrow); g.appendChild(bg); g.appendChild(text);
    svg.appendChild(g);
    pool[i] = { g, line, arrow, bg, text };
    return pool[i];
  }

  /**
   * 画布中心沿 (dx, dy) 射线与内缩矩形的交点参数 t（中心 + t*(dx,dy) 落在矩形边上）
   */
  function rayToBox(dx, dy, W, H) {
    const mx = W / 2 - EDGE_MARGIN;
    const my = H / 2 - EDGE_MARGIN;
    if (mx <= 4 || my <= 4) return 1;
    const tx = Math.abs(dx) > 1e-6 ? mx / Math.abs(dx) : Infinity;
    const ty = Math.abs(dy) > 1e-6 ? my / Math.abs(dy) : Infinity;
    return Math.min(tx, ty);
  }

  function update() {
    if (!enabled) { svg.style.display = 'none'; return; }
    const scene = viewer.scene;
    const canvas = scene && scene.canvas;
    if (!canvas) return;
    const W = container.clientWidth || canvas.clientWidth || 0;
    const H = container.clientHeight || canvas.clientHeight || 0;
    if (!W || !H || !items.length) {
      svg.style.display = 'none';
      return;
    }
    svg.style.display = 'block';
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

    const cam = viewer.camera;
    const camPos = cam.positionWC;
    const right = cam.rightWC;
    const up = cam.upWC;
    const fwd = cam.directionWC;

    const placed = [];
    for (const it of items) {
      if (!it || !it.position) continue;
      let x = 0, y = 0, z = 0;
      {
        const dx = it.position.x - camPos.x;
        const dy = it.position.y - camPos.y;
        const dz = it.position.z - camPos.z;
        x = dx * right.x + dy * right.y + dz * right.z;
        y = dx * up.x + dy * up.y + dz * up.z;
        z = dx * fwd.x + dy * fwd.y + dz * fwd.z;
      }
      let sx = x;
      let sy = -y;                 // 屏幕 y 轴向下
      if (z <= 0) { sx = -sx; sy = -sy; }
      const len = Math.hypot(sx, sy);
      if (len < 1e-3) continue;
      const ux = sx / len;
      const uy = sy / len;
      const t = rayToBox(ux, uy, W, H);
      let ex = W / 2 + ux * t;
      let ey = H / 2 + uy * t;

      // 落在哪条边（用于文字对齐与同边错开）
      const onLeft = Math.abs(ex - EDGE_MARGIN) < 2;
      const onRight = Math.abs(ex - (W - EDGE_MARGIN)) < 2;
      const side = onLeft ? 'left' : onRight ? 'right' : (uy < 0 ? 'top' : 'bottom');
      const along = (side === 'left' || side === 'right') ? ey : ex;
      placed.push({ it, ex, ey, ux, uy, side, along });
    }

    // 方向扇区限流：背面点动辄上百个，全画会糊成一圈。按屏幕方向角 15° 一桶，
    // 每桶最多 PER_DIR_MAX 条 —— 结果是沿边缘均匀分布的稀疏指示，而不是一坨。
    const BUCKET = Math.PI / 12;
    const bucketN = new Map();
    const picked = [];
    for (const p of placed) {
      let ang = Math.atan2(p.uy, p.ux);
      if (ang < 0) ang += Math.PI * 2;
      const k = Math.floor(ang / BUCKET);
      const n = bucketN.get(k) || 0;
      if (n >= PER_DIR_MAX) continue;
      bucketN.set(k, n + 1);
      picked.push(p);
    }
    if (picked.length > MAX_ITEMS) picked.length = MAX_ITEMS;

    // 同边内按沿边坐标排序后推开，避免指示条叠在一起
    const bySide = { top: [], bottom: [], left: [], right: [] };
    for (const p of picked) bySide[p.side].push(p);
    for (const key of Object.keys(bySide)) {
      const arr = bySide[key];
      arr.sort((a, b) => a.along - b.along);
      const lo = EDGE_MARGIN;
      const hi = (key === 'left' || key === 'right') ? H - EDGE_MARGIN : W - EDGE_MARGIN;
      let prev = -Infinity;
      for (const p of arr) {
        p.along = Math.max(p.along, prev + MIN_GAP);
        if (p.along > hi) p.along = hi;
        prev = p.along;
        if (key === 'left' || key === 'right') p.ey = p.along;
        else p.ex = p.along;
      }
      // 推开越界时反向压缩一遍（从末尾往前顶）
      for (let i = arr.length - 1; i >= 0; i--) {
        const next = i === arr.length - 1 ? hi : arr[i + 1].along - MIN_GAP;
        if (arr[i].along > next) arr[i].along = next;
        if (arr[i].along < lo) arr[i].along = lo;
        if (key === 'left' || key === 'right') arr[i].ey = arr[i].along;
        else arr[i].ex = arr[i].along;
      }
    }

    let idx = 0;
    for (const key of ['top', 'bottom', 'left', 'right']) {
      for (const p of bySide[key]) {
        if (idx >= MAX_ITEMS) break;
        const n = node(idx++);
        const color = p.it.color || '#ffd24a';
        const innerX = p.ex - p.ux * LEAD_LEN;
        const innerY = p.ey - p.uy * LEAD_LEN;
        n.line.setAttribute('x1', p.ex.toFixed(1));
        n.line.setAttribute('y1', p.ey.toFixed(1));
        n.line.setAttribute('x2', innerX.toFixed(1));
        n.line.setAttribute('y2', innerY.toFixed(1));
        n.line.setAttribute('stroke', color);
        // 朝外的小三角（边长 7）
        const ax = p.ux, ay = p.uy;
        const px = -ay, py = ax;
        const tipX = p.ex + ax * 3;
        const tipY = p.ey + ay * 3;
        const b1x = p.ex - ax * 5 + px * 4;
        const b1y = p.ey - ay * 5 + py * 4;
        const b2x = p.ex - ax * 5 - px * 4;
        const b2y = p.ey - ay * 5 - py * 4;
        n.arrow.setAttribute('points',
          `${tipX.toFixed(1)},${tipY.toFixed(1)} ${b1x.toFixed(1)},${b1y.toFixed(1)} ${b2x.toFixed(1)},${b2y.toFixed(1)}`);
        n.arrow.setAttribute('fill', color);

        const label = String(p.it.name || '');
        const wEst = 0;   // 由 getComputedTextLength 兜底不易（SVG 未布局时为 0），按字符数估
        let em = 0;
        for (const ch of label) em += ch.codePointAt(0) > 0x2e80 ? 12 : 6.6;
        const tw = em + 8;
        let tx = innerX - p.ux * 4;
        let anchor = 'middle';
        if (p.side === 'left') { tx = innerX + 5; anchor = 'start'; }
        else if (p.side === 'right') { tx = innerX - 5; anchor = 'end'; }
        else { tx = innerX; anchor = 'middle'; }
        let ty = innerY - p.uy * 4;
        // 标签别出画布
        tx = Math.max(EDGE_MARGIN - 26, Math.min(W - EDGE_MARGIN + 26, tx));
        ty = Math.max(LABEL_H, Math.min(H - LABEL_H, ty));
        n.text.setAttribute('x', tx.toFixed(1));
        n.text.setAttribute('y', ty.toFixed(1));
        n.text.setAttribute('text-anchor', anchor);
        n.text.textContent = label;
        const bx = anchor === 'start' ? tx - 3 : anchor === 'end' ? tx - tw + 3 : tx - tw / 2;
        n.bg.setAttribute('x', bx.toFixed(1));
        n.bg.setAttribute('y', (ty - LABEL_H / 2).toFixed(1));
        n.bg.setAttribute('width', tw.toFixed(1));
        n.bg.setAttribute('height', String(LABEL_H));
        n.g.setAttribute('opacity', '1');
        void wEst;
      }
    }
    for (let i = idx; i < pool.length; i++) pool[i].g.setAttribute('opacity', '0');
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
    /** 冒烟用：当前绘制了几条指示条 */
    debugCount: () => pool.filter((p) => p.g.getAttribute('opacity') === '1').length,
    destroy() {
      try { svg.remove(); } catch { /* 忽略 */ }
      pool.length = 0;
    },
  };
}

export default { createOffscreenIndicator };
