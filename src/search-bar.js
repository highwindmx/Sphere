// src/search-bar.js — 统一检索栏 UI + 结果下拉
//
// 2026-10-29 重构（用户决定删掉侧栏「标注图层」「历史时空」「航天探索」三块）：
//   · 检索框为空 → 下拉直接列出**图层目录**（分类 → 图层），点一条即显示，替代原来的勾选树；
//   · 有查询 → 按类型分组渲染结果（🎬巡礼 / 📍地点 / 👁图层 / 📜历史 / 🌙月面 / 🔴火星）；
//   · 点击结果只负责派发到 ctx，由 main.js 决定"加入显示图层列表 + 默认互斥"。

import { TYPE_META } from './search-registry.js';

export function initSearchBar({ registry, ctx }) {
  const bar = document.getElementById('searchBar');
  if (!bar) return;
  bar.innerHTML = `
    <div class="search-input-wrap">
      <span class="search-icon">🔍</span>
      <input type="text" id="unifiedSearch" class="unified-search"
             placeholder="搜地点 / 图层 / 巡礼 / 朝代 …" autocomplete="off" spellcheck="false" />
      <button type="button" id="searchClear" class="search-clear hidden" title="清空">✕</button>
    </div>
    <div id="searchResults" class="search-results hidden"></div>
  `;
  const input = bar.querySelector('#unifiedSearch');
  const results = bar.querySelector('#searchResults');
  const clearBtn = bar.querySelector('#searchClear');

  // ⚠ 下拉必须挂到 body 下（2026-10-29 第三轮踩坑）：
  //   #panel 现在带 backdrop-filter（半透明毛玻璃 = 用户第 3 点），而 backdrop-filter / filter / transform
  //   都会让元素成为 **position:fixed 后代的包含块** → 下拉不再是"相对视口"，而是被面板的 overflow 裁掉，
  //   还把面板撑出滚动条（实测 panel.scrollHeight 695 > clientHeight 413，球体按钮被挤成两行）。
  //   挂到 body 后 fixed 恢复相对视口，裁剪与滚动条同时消失。
  document.body.appendChild(results);

  let current = []; // [{ entry, type }]

  function renderLabel(e) {
    if (e.type === 'tour' && e.tourKind === 'station') return `${e.layerName} · ${e.name}`;
    if (e.type === 'history') {
      if (e.histKind === 'dynasty') return e.title;
      if (e.histKind === 'milestone') return `${e.headline}（${e.year < 0 ? '前' + -e.year : e.year}）`;
      return e.name;
    }
    if (e.type === 'moon' || e.type === 'mars') return `${e.name} · ${e.groupName}`;
    return e.name;
  }
  function renderHint(e) {
    if (e.type === 'place') return '定位';
    if (e.type === 'layer') return '显示';
    if (e.type === 'tour') return e.tourKind === 'station' ? '跳到节点' : '开始巡礼';
    if (e.type === 'history') return e.histKind === 'dynasty' ? '历史巡礼' : '跳到年份';
    // 行星标注：跳转时会自动切球体，提示写清"去哪"
    if (e.type === 'moon') return '跳月面';
    if (e.type === 'mars') return '跳火面';
    return '';
  }

  /**
   * 下拉定位到视口（position:fixed）+ 动态 max-height。
   * ⚠ 侧栏从 2026-10-29 起是「浮在球面上的自适应高度卡片」，只有内容那么高（~385px），
   *   而 #panel 仍是 overflow-y:auto —— 下拉若用 position:absolute 会被面板底边直接裁掉
   *   （实测面板底 385、下拉底 482）。改成 fixed 后由 JS 按输入框真实位置摆放，不再受裁剪。
   */
  function positionResults() {
    if (results.classList.contains('hidden')) return;
    const r = input.getBoundingClientRect();
    // 侧栏被折叠（display:none）时输入框宽度为 0：下拉已挂在 body 上，会孤零零飘在屏幕上
    if (!r.width) { close(); return; }
    const gap = 6;
    results.style.left = `${Math.round(r.left)}px`;
    results.style.width = `${Math.round(r.width)}px`;
    results.style.top = `${Math.round(r.bottom + gap)}px`;
    const room = window.innerHeight - r.bottom - gap - 10;
    results.style.maxHeight = `${Math.max(180, Math.min(room, window.innerHeight * 0.62))}px`;
  }

  function showResults() {
    results.classList.remove('hidden');
    positionResults();
  }

  // —— 目录视图（空查询）——
  function renderCatalog() {
    current = [];
    const cats = registry.catalog();
    let html = '';
    // 行星分类（🌙/🔴）的标题已自带图标，不再套 📁
    const catIcon = (cat) => (cat.id.startsWith('body-') ? '' : '📁 ');
    for (const cat of cats) {
      html += `<div class="sr-group"><div class="sr-group-title">${catIcon(cat)}${cat.name}</div>`;
      for (const l of cat.layers) {
        if (l.kind === 'body') {
          // 月面 / 火星标注：没有 #layer-* checkbox，提示写"跳转"而不是"显示"
          html += `<button class="sr-item" data-type="body" data-idx="${current.length}">`
            + `<span class="sr-label">${l.icon} ${l.name}</span>`
            + `<span class="sr-hint">跳到${l.entry.bodyLabel}</span></button>`;
          current.push({ entry: l.entry, type: 'body' });
          continue;
        }
        const on = !!document.getElementById(`layer-${l.id}`)?.checked;
        html += `<button class="sr-item" data-type="layer" data-idx="${current.length}">`
          + `<span class="sr-label">${l.icon ? l.icon + ' ' : ''}${l.name}</span>`
          + `<span class="sr-hint${on ? ' on' : ''}">${on ? '已显示' : '显示'}</span></button>`;
        current.push({ entry: { ...l, type: 'layer' }, type: 'layer' });
      }
      html += `</div>`;
    }
    html += `<div class="sr-foot">共 ${cats.reduce((n, c) => n + c.layers.length, 0)} 项 · 点一条即加入「显示图层」</div>`;
    results.innerHTML = html;
    showResults();
    bindItems();
  }

  // —— 检索结果视图 ——
  function renderResults(res) {
    current = [];
    const order = ['tour', 'place', 'layer', 'history', 'moon', 'mars'];
    let html = '';
    for (const t of order) {
      const list = res[t] || [];
      if (!list.length) continue;
      const meta = TYPE_META[t];
      html += `<div class="sr-group"><div class="sr-group-title">${meta.icon} ${meta.label}</div>`;
      for (const e of list) {
        // 2026-10-29：地点若当前落在球背面，提示写「🌗 背面」——点它会自动把球转过去
        // （flyToCoords 会把相机飞到该经纬度上方，标注随即转到正面）。
        let hint = renderHint(e);
        let hintCls = 'sr-hint';
        if (t === 'place' && typeof ctx.isBackside === 'function' && ctx.isBackside(e)) {
          hint = '🌗 背面';
          hintCls += ' back';
        }
        // ⭐ 2026-10-30：地点若带 url，右侧动作区加一枚「🔗 线上漫游」胶囊，放在「定位」右侧；
        //   点胶囊只开网页（bindItems 里命中 .sr-link 即 return，不触发飞行），点「定位」/整行才飞球。
        let actions;
        if (t === 'place') {
          const linkCapsule = (e.url)
            ? `<span class="sr-link" data-idx="${current.length}" role="link" title="线上漫游 ↗">🔗 线上漫游</span>`
            : '';
          actions = `<span class="sr-actions">`
            + `<span class="${hintCls}">${hint}</span>`
            + linkCapsule
            + `</span>`;
        } else {
          actions = `<span class="${hintCls}">${hint}</span>`;
        }
        html += `<button class="sr-item" data-type="${t}" data-idx="${current.length}">`
          + `<span class="sr-label">${renderLabel(e)}</span>`
          + actions
          + `</button>`;
        current.push({ entry: e, type: t });
      }
      html += `</div>`;
    }
    if (!current.length) {
      results.innerHTML = '<div class="sr-empty">没有匹配结果</div>';
      showResults();
      return;
    }
    results.innerHTML = html;
    showResults();
    bindItems();
  }

  function bindItems() {
    results.querySelectorAll('.sr-item').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        const link = ev.target.closest('.sr-link');
        if (link) {
          const idx = Number(link.dataset.idx);
          const item = current[idx];
          if (item && item.entry && item.entry.url) {
            window.open(item.entry.url, '_blank', 'noopener');
          }
          return;
        }
        activate(Number(btn.dataset.idx));
      });
    });
  }

  function activate(idx) {
    const item = current[idx];
    if (!item) return;
    const e = item.entry;
    if (item.type === 'layer') ctx.onLayer(e);
    else if (item.type === 'place') ctx.onPlace(e);
    else if (item.type === 'tour') ctx.onTour(e);
    else if (item.type === 'history') ctx.onHistory(e);
    // 目录视图的条目 type 记作 'body'，检索结果视图的记作 'moon'/'mars'（= 分组名），两种都要认
    else if (item.type === 'body' || item.type === 'moon' || item.type === 'mars') ctx.onBody(e);
    input.value = '';
    clearBtn.classList.add('hidden');
    close();
  }

  function close() {
    results.classList.add('hidden');
    results.innerHTML = '';
    current = [];
  }

  function refresh() {
    const q = input.value.trim();
    clearBtn.classList.toggle('hidden', !q);
    if (!q) renderCatalog();
    else renderResults(registry.search(q));
  }

  input.addEventListener('input', refresh);
  input.addEventListener('focus', refresh);
  clearBtn.addEventListener('click', () => {
    input.value = '';
    refresh();
    input.focus();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (current.length) activate(0);
    } else if (e.key === 'Escape') {
      close();
      input.blur();
    }
  });
  document.addEventListener('click', (e) => {
    // 下拉已移到 body 下，不能再只看 bar —— 否则点结果项会被判成"点外面"而立刻关闭
    if (!bar.contains(e.target) && !results.contains(e.target)) close();
  });

  // 视口变化 / 侧栏滚动时跟随输入框（fixed 定位不会随父容器滚动）
  window.addEventListener('resize', positionResults);
  document.getElementById('panel')?.addEventListener('scroll', positionResults, { passive: true });

  // 供外部使用：把当前输入框里的词塞进去并展开（例如「显示图层」点空白处唤起目录）
  return { refresh, open: () => { input.focus(); refresh(); }, close };
}
