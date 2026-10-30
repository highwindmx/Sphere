// src/shown-layers.js — 侧栏「📌 显示图层」列表
//
// 2026-10-29 用户设计：检索结果的落地点。点一条检索结果 = 往这里加一行；
//   · 默认**互斥**：加入新项时把其它项切成"不显示"（留在列表里变灰，不删）；
//   · 每行可手动点亮（叠加，例如「中国名城 + 历代长城」同时看）；
//   · 每行 ✕ 删除（= 关掉并移出列表）；
//   · 每行点击 = 切显隐。
//
// 条目结构：
//   { key, label, icon, kind: 'layer'|'place'|'tour'|'history',
//     setOn(), setOff(), mutex: true|false }
//   mutex=false 的项（地点导航）不参与互斥：它不产生图层，只是"最近去过哪"。

export function createShownLayers({ host }) {
  const items = new Map(); // key -> item

  function render() {
    if (!host) return;
    if (!items.size) {
      host.innerHTML = '<div class="sl-empty">搜一个地点 / 图层 / 巡礼 / 朝代，点结果即加入这里</div>';
      return;
    }
    let html = '';
    for (const it of items.values()) {
      html += `<div class="sl-row${it.on ? ' on' : ''}" data-key="${it.key}">`
        + `<span class="sl-ico">${it.icon || '•'}</span>`
        + `<span class="sl-name" title="${it.label}">${it.label}</span>`
        + `<button type="button" class="sl-x" data-x="${it.key}" title="移除并关闭">✕</button>`
        + `</div>`;
    }
    host.innerHTML = html;
    host.querySelectorAll('.sl-row').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.sl-x')) return;
        toggle(row.dataset.key);
      });
    });
    host.querySelectorAll('.sl-x').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        remove(btn.dataset.x);
      });
    });
  }

  /** 点亮一项（不参与互斥）：仅调用它的 setOn 与状态位 */
  function turnOn(it) {
    try { it.setOn?.(); } catch (e) { console.error('[shown] 打开失败', it.key, e); }
    it.on = true;
  }
  function turnOff(it) {
    try { it.setOff?.(); } catch (e) { console.error('[shown] 关闭失败', it.key, e); }
    it.on = false;
  }

  /** 加入（或更新）一项；默认互斥：先把其它非 mutex:false 的项全部置为不显示 */
  function add(item) {
    const prev = items.get(item.key);
    if (item.mutex !== false) {
      for (const it of items.values()) {
        if (it.key !== item.key && it.mutex !== false && it.on) turnOff(it);
      }
    }
    const next = { icon: '•', mutex: true, on: false, ...(prev || {}), ...item };
    items.set(next.key, next);
    turnOn(next);
    render();
    return next;
  }

  /** 显式点亮 / 关闭某一行（手动点击，不做互斥 → 允许叠加） */
  function toggle(key) {
    const it = items.get(key);
    if (!it) return;
    if (it.on) turnOff(it); else turnOn(it);
    render();
  }

  /** 关闭并从列表移除（✕） */
  function remove(key) {
    const it = items.get(key);
    if (!it) return;
    if (it.on) turnOff(it);
    items.delete(key);
    render();
  }

  /** 外部把某项置为不显示（例如用户在底部面板点了「停止」） */
  function markOff(key) {
    const it = items.get(key);
    if (!it || !it.on) return;
    it.on = false;
    render();
  }

  /** 关掉所有项（切到月球/火星等场景用） */
  function clear() {
    for (const it of items.values()) if (it.on) turnOff(it);
    items.clear();
    render();
  }

  function has(key) {
    return items.has(key);
  }

  render();
  return { add, toggle, remove, markOff, clear, has, render, items };
}
