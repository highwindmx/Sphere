/**
 * 图源设置抽屉（2026-10-16 真机版）
 *
 * 用户确认的形态：
 *  ① 图源选择/排序从左侧栏摘出，放进右侧抽屉（宽度 ≤40%，地球始终 ≥60%，可边配置边观察）；
 *     侧栏只保留「图层是否显影」的勾选 + 一个「图源设置」入口按钮。
 *  ② 优先级即首选：P1 = 当前底图源，故障按 P1→P2→P3 依次回退（不再单独设「设为首选」按钮）。
 *  ③ 每源独立「本地优先」：走本地代理缓存（有缓存直出 / 无缓存拉上游并落盘）vs 直连上游不缓存。
 *  ④ 分段下载：骨架 z0–4 / 低清 z5–8 / 高清 z9–11，调 /api/downloader/start（kind=tiles），
 *     进度由 /api/downloader/state 回传（复用下载器既有链路）。
 *
 * 侧栏原有控件（底图 / 在线源 / 天地图开关+key）用 DOM 迁移接管——监听器不丢失，
 * 因此 main.js 的既有绑定逻辑无需改动。
 */

import {
  CHAIN_IDS,
  CHINA_RECT,
  getSourceDef,
  getSourceOrder,
  isLocalFirst,
  isSourceEnabled,
  getOverlayEnabled,
  getTiandituKey,
} from './imagery-sources.js';

/** 下载脚本 --source 名（tools/download-tiles.mjs；注意 aws-s2 的目录是 eox） */
const DL_SOURCE = { esri: 'esri', 'aws-s2': 'eox', gibs: 'gibs', tianditu: 'tianditu', terrain: 'terrain' };
/** /api/downloader/scan 的统计字段 */
const SCAN_KEY = { esri: 'esri', 'aws-s2': 'eox', gibs: 'gibs', tianditu: 'tianditu', terrain: 'terrain' };
/** 本地缓存实测均瓦片大小（KB，2026-10-16 扫盘） */
const AVG_KB = { esri: 11.6, 'aws-s2': 10.2, gibs: 30, tianditu: 13.1, terrain: 47.6 };
const MAX_Z = { esri: 19, 'aws-s2': 18, gibs: 7, tianditu: 18, terrain: 15 };
const DOC = {
  esri: ['https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9', 'Esri World Imagery'],
  'aws-s2': ['https://s2maps.eu/', 'Sentinel-2 无云合成'],
  gibs: ['https://nasa-gibs.github.io/gibs-api-docs/', 'GIBS API 文档'],
  tianditu: ['https://lbs.tianditu.gov.cn/', '天地图开发文档'],
  terrain: ['https://registry.opendata.aws/terrain-tiles/', 'AWS 开放数据'],
};
// 4 个清晰度档位：高清拆成「标注点周边」与「全部」两个子集（常用/量级差异大）。
// key 带后缀 -p/-f 便于队列用 `${id}|${key}|${subset}` 唯一定位一行。
const TIERS = [
  { key: 'skel', label: '骨架', zmin: 0, zmax: 4, subset: 'full' },
  { key: 'low', label: '低清', zmin: 5, zmax: 8, subset: 'full' },
  { key: 'high-p', label: '高清（标注点）', zmin: 9, zmax: 11, subset: 'points' },
  { key: 'high-f', label: '高清（全部）', zmin: 9, zmax: 11, subset: 'full' },
];
/** 标注点子集半径（km）选项与持久化 */
const RADIUS_KEY = 'sphere.tileRadiusKm';
const RADIUS_OPTS = [10, 25, 50];
const getRadius = () => {
  const v = Number(localStorage.getItem(RADIUS_KEY));
  return RADIUS_OPTS.includes(v) ? v : 25;
};
const setRadius = (v) => localStorage.setItem(RADIUS_KEY, String(v));
const SUBSET_LABEL = { points: '标注点', full: '全部' };
// GIBS 非二分网格每级瓦片数（与 gibs-provider.js 的 COLS×ROWS 对应）
const GIBS_GRID = [2, 6, 15, 50, 200, 800, 3200, 12800];

const lon2x = (lon, z) => Math.floor((lon + 180) / 360 * Math.pow(2, z));
const lat2y = (lat, z) => Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, z));
const fmtSize = (b) => b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : b > 1e3 ? (b / 1e3).toFixed(0) + ' KB' : b + 'B';
const fmtN = (n) => n >= 1e8 ? (n / 1e8).toFixed(1) + ' 亿' : n >= 1e4 ? (n / 1e4).toFixed(n >= 1e6 ? 0 : 1) + ' 万' : n.toLocaleString();

function countXyz(zmin, zmax, bbox) {
  let n = 0;
  for (let z = zmin; z <= zmax; z++) {
    if (bbox) {
      n += Math.max(0, lon2x(bbox.e, z) - lon2x(bbox.w, z) + 1) * Math.max(0, lat2y(bbox.s, z) - lat2y(bbox.n, z) + 1);
    } else {
      n += Math.pow(4, z);
    }
  }
  return n;
}
const countFor = (id, zmin, zmax) => {
  if (id === 'gibs') return GIBS_GRID.slice(zmin, zmax + 1).reduce((a, b) => a + b, 0);
  return countXyz(zmin, zmax, id === 'tianditu' ? CHINA_RECT : null);
};
const estLabel = (id, zmin, zmax) => `${countFor(id, zmin, zmax).toLocaleString()} 张 · ${fmtSize(countFor(id, zmin, zmax) * AVG_KB[id] * 1024)}`;

let _panel = null;
let _body = null;
let _mgr = null;
let _setStatus = () => {};
let _scan = null;
let _poll = null;

/** 打开时拉一次本地统计（懒加载：scan 全盘遍历 ~2.3s，服务端另有 30s TTL 缓存） */
async function refreshScan() {
  try {
    const r = await fetch('/api/downloader/scan');
    _scan = await r.json();
  } catch { _scan = null; }
  renderCache();
  await refreshPlanTitles();   // 顺带精算标注点子集张数（服务端 --dry-run，按参数缓存）
}

function cacheChip(id) {
  if (!isLocalFirst(id)) return '<span class="sp-chip off">未启用本地优先</span>';
  if (_scan === null) return '<span class="sp-chip none">统计中…</span>';   // 扫盘未完成：别误报「暂无」
  const d = _scan && _scan[SCAN_KEY[id]];
  if (!d || !d.total) return '<span class="sp-chip none">暂无本地缓存</span>';
  const levels = Object.keys(d.levels || {}).map(Number).sort((a, b) => a - b);
  const span = levels.length ? `（z${levels[0]}–z${levels[levels.length - 1]}）` : '';
  return `<span class="sp-chip cache">已缓存 ${d.total.toLocaleString()} 张${span} · ${fmtSize(d.bytes)}</span>`;
}

function renderCache() {
  if (!_body) return;
  _body.querySelectorAll('[data-cache]').forEach((el) => {
    el.outerHTML = `<span data-cache="${el.dataset.cache}">${cacheChip(el.dataset.cache)}</span>`;
  });
  // ① 每张下载表的 ②列「已缓存 / 该档总量」
  _body.querySelectorAll('[data-cache-tier]').forEach((el) => {
    const [id, tk] = el.dataset.cacheTier.split('|');
    const s = srcDef(id);
    const t = tiersFor(s).find((x) => x.key === tk);
    if (!t || t.over) return;
    el.title = '该档位逐 z 明细：\n' + cachedOfTier(s, t).detail;
    el.innerHTML = cacheCellHtml(s, t);
  });
  // ② 折叠头汇总：该源已缓存总量 + 进行中/排队标记（抽成 paintDlSums，队列事件也要刷）
  paintDlSums();
  // ③ 合计：影像 + 高程（高程常占大头，必须单独可见）
  let tiles = 0, bytes = 0, imgT = 0, imgB = 0;
  for (const k of ['esri', 'eox', 'gibs', 'tianditu']) {
    const d = _scan && _scan[k];
    if (d) { tiles += d.total; bytes += d.bytes; imgT += d.total; imgB += d.bytes; }
  }
  const td = _scan && _scan.terrain;
  if (td) { tiles += td.total; bytes += td.bytes; }
  const t = document.getElementById('spTotalTiles');
  const b = document.getElementById('spTotalBytes');
  if (t) t.textContent = tiles ? `${tiles.toLocaleString()} 张` : '0 张';
  if (b) b.textContent = bytes ? fmtSize(bytes) : '0 B';
  const subT = document.getElementById('spTotalTilesSub');
  const subB = document.getElementById('spTotalBytesSub');
  if (subT) subT.textContent = `影像 ${fmtN(imgT)} 张 · 高程 ${fmtN(td?.total || 0)} 张`;
  if (subB) subB.textContent = `影像 ${fmtSize(imgB)} · 高程 ${fmtSize(td?.bytes || 0)}`;
}

/** 折叠头汇总：该源已缓存总量 + 进行中/排队标记。
 *  renderCache 只在开面板/任务结束/改半径时跑，入队→开跑→取消这条链不经过它，
 *  故抽成独立函数由队列事件（startDownload/pumpQueue/cancelJob/finishDl）直接调用，
 *  否则折叠着头永远不显示「▶ 下载中×N」。 */
function paintDlSums() {
  if (!_body) return;
  _body.querySelectorAll('[data-dlsum]').forEach((el) => {
    const s = srcDef(el.dataset.dlsum);
    const d = s.scanKey ? (_scan && _scan[s.scanKey]) : null;
    const base = _scan === null ? '统计中…'
      : d && d.total ? `已缓存 ${fmtN(d.total)} 张 · ${fmtSize(d.bytes)}` : '暂无缓存';
    const jobs = [..._dlActives.values(), ..._dlQueue].filter((j) => j.key.startsWith(`${s.id}|`));
    const run = jobs.filter((j) => _dlActives.has(j.key));
    el.innerHTML = base + (jobs.length
      ? ` · <span class="run">${run.length ? `▶ 下载中${run.length > 1 ? `×${run.length}` : ''}` : `⏳ ${jobs.length} 个排队`}</span>`
      : '');
  });
}

/** 把侧栏原有控件迁移进抽屉 —— 已废弃（2026-10-17）：旧控件整块删除， */
/* ---------- 下载任务（前端队列：按顺序逐个跑，按钮有排队/下载中反馈） ---------- */

/** 统一的源描述（表格渲染与统计用） */
function srcDef(id) {
  return {
    id,
    name: id === 'terrain' ? 'AWS Terrarium 高程' : getSourceDef(id).name,
    scanKey: SCAN_KEY[id] || null,
    maxZ: MAX_Z[id],
    avgKB: AVG_KB[id],
  };
}

/** 档位随源钳制：zmax 压到源最高层级；仅 zmin 超限时才整档禁用。
 *  GIBS（z0–7）因此：骨架 z0–4 ✓、低清自动钳成 z5–7 可下载、高清 z9–11 整档禁用。
 *  教训：别用「上界越界」连坐整档，否则 z5–7 本可下的部分也被禁。 */
function tiersFor(s) {
  return TIERS.map((t) => {
    const over = t.zmin > s.maxZ;
    return { ...t, zmax: over ? t.zmax : Math.min(t.zmax, s.maxZ), over };
  });
}

/** 某源某档位已缓存的张数/体积（把该 z 区间的 levels 加起来） */
function cachedOfTier(s, t) {
  const d = s.scanKey ? (_scan && _scan[s.scanKey]) : null;
  const lv = Object.entries((d && d.levels) || {})
    .map(([z, v]) => ({ z: Number(z), ...v }))
    .filter((l) => l.z >= t.zmin && l.z <= t.zmax)
    .sort((a, b) => a.z - b.z);
  return {
    count: lv.reduce((a, l) => a + l.count, 0),
    bytes: lv.reduce((a, l) => a + l.bytes, 0),
    detail: lv.map((l) => `z${l.z}: ${l.count.toLocaleString()} 张 · ${fmtSize(l.bytes)}`).join('\n')
      || '该层级区间暂无本地瓦片',
  };
}

/** ②列「已缓存 / 该档总量」单元格 */
function cacheCellHtml(s, t) {
  if (!s.scanKey) return '<span class="b">不落本地缓存</span>';
  if (isLocalFirst(s.id) === false) return '<span class="b">未启用本地优先</span>';
  if (_scan === null) return '<span class="b">统计中…</span>';   // 扫盘未完成：别误报「0 张」
  const c = cachedOfTier(s, t);
  // 标注点子集：优先用服务端精算（plan）。层内缓存可能来自「全部」下载，
  // 无法反推子集完成度 → 分开标注，不假报百分比与「已下满」
  if (t.subset === 'points') {
    const pl = _plans.get(`${s.id}|${t.zmin}|${t.zmax}|${getRadius()}`) || null;
    const total = pl ? pl.total : countFor(s.id, t.zmin, t.zmax);
    return `<span class="n">子集 ${fmtN(total)} 张</span><span class="b">（${pl ? `精算 · ${pl.points} 点` : '估算'}）</span>
      <span class="b"> · 层内已缓存 ${c.count.toLocaleString()} 张 / ${fmtSize(c.bytes)}</span>`;
  }
  // 实际张数可能多于理论网格数（接缝处 Cesium 会重复请求 x=2^z 那一列 → 真落盘了重影瓦片），
  // 分母取二者较大值，避免出现「372 / 341」这类分子大于分母的观感
  const total = countFor(s.id, t.zmin, t.zmax);
  const denom = Math.max(total, c.count);
  const p = denom ? c.count / denom * 100 : 0;
  const full = denom > 0 && p >= 99.5;
  return `<span class="n">${c.count.toLocaleString()} / ${fmtN(denom)} 张</span>
    <span class="b"> · ${fmtSize(c.bytes)}${c.count ? ` / ${fmtSize(denom * s.avgKB * 1024)}` : ''}${full ? ' <span class="full">✓ 已下满</span>' : ` · ${p.toFixed(0)}%`}</span>
    <div class="bar"><i style="width:${p.toFixed(1)}%"></i></div>`;
}

/** 每个图源一张 4×3 表：行 = 清晰度档位，②列 = 已缓存/总量（悬停看逐 z），
 *  ③列 = 下载按钮 + 行内进度 + 行内 ✕ 取消。整表默认折叠。 */
function tableHtml(s) {
  const rows = tiersFor(s).map((t) => {
    const dlkey = `${s.id}|${t.key}|${t.subset}`;   // 三截：源 | 档位 | 子集（高清两行靠此区分）
    const tip = t.subset === 'points'
      ? `左侧栏标注点周边 ±${getRadius()}km（打开面板后自动精算）`
      : `${countFor(s.id, t.zmin, t.zmax).toLocaleString()} 张 · ${fmtSize(countFor(s.id, t.zmin, t.zmax) * s.avgKB * 1024)}`;
    return `<tr data-tier="${t.key}">
      <td class="col-tier"><div class="t-tier">${t.label}<span class="z">z${t.zmin}–${t.zmax}${t.subset === 'points' ? ' · 标注点 ±' + getRadius() + 'km' : ''}${t.over ? ` · 超出源上限 z${s.maxZ}` : ''}</span></div></td>
      <td class="t-cache" data-cache-tier="${dlkey}" title="${t.over ? `超出该源最高层级 z${s.maxZ}` : ''}">${t.over ? '<span class="b">超出源最高层级</span>' : ''}</td>
      <td class="col-act">
        <div class="t-act" data-act="${dlkey}">
          <button class="sp-btn tier" data-dlkey="${dlkey}" data-tier="${t.key}" data-subset="${t.subset || 'full'}" data-plan="${t.subset === 'points' ? `${s.id}|${t.zmin}|${t.zmax}` : ''}" title="${tip}" ${t.over ? 'disabled' : ''}>${t.over ? '—' : '下载'}</button>
          <div class="t-prog"><i></i></div>
          <div class="t-row2"><span class="t-txt"></span><button class="t-cancel" data-cancel="${dlkey}" title="取消该档位（排队中 = 移出队列 / 下载中 = 中止）">✕ 取消</button></div>
        </div>
      </td>
    </tr>`;
  }).join('');
  return `<div class="dl-wrap" data-dlwrap="${s.id}">
    <div class="dl-toggle act-dl" title="展开/收起该图源的下载表"><span class="caret">▸</span>⬇ 下载与缓存<span class="sum" data-dlsum="${s.id}"></span></div>
    <div class="dl-body"><table class="dl">
      <thead><tr><th class="col-tier">清晰度</th><th>已缓存 / 该档总量</th><th class="col-act">下载 · 进度</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
  </div>`;
}

function buildSourceRow(id, idx, chainLength) {
  const def = getSourceDef(id);
  const [docUrl, docLabel] = DOC[id] || ['#', '文档'];
  const enabled = isSourceEnabled(id);
  const local = isLocalFirst(id);
  const s = srcDef(id);
  const table = tableHtml(s);
  const row = document.createElement('div');
  row.className = 'sp-src' + (idx === 0 ? ' active' : '');
  row.dataset.id = id;
  row.draggable = true;
  row.innerHTML = `
    <div class="sp-top">
      <span class="sp-handle" title="拖动调整优先级">⠿</span>
      <span class="sp-name">${def.name}</span>
      <span class="sp-dot" title="当前底图"></span>
      <button class="sp-btn icon btn-up" title="提升优先级">▲</button>
      <button class="sp-btn icon btn-down" title="降低优先级">▼</button>
      <span class="sp-order ${idx === 0 ? '' : 'backup'}">P${idx + 1}</span>
    </div>
    <div class="sp-chips">
      <span class="sp-chip">z0–${MAX_Z[id]}</span>
      ${id === 'tianditu' ? '<span class="sp-chip">中国区覆盖层</span>' : ''}
      <span data-cache="${id}"></span>
      <span class="sp-chip est" title="按本地实测均瓦片大小（${AVG_KB[id]} KB/张）推算">预估 z0–${Math.min(10, MAX_Z[id])}：${estLabel(id, 0, Math.min(10, MAX_Z[id]))}</span>
      <a class="sp-chip" href="${docUrl}" target="_blank" rel="noopener">📖 ${docLabel} ↗</a>
    </div>
    <div class="sp-ops">
      <label class="sp-cb" title="是否参与优先级链（停用后故障不会回退到它）"><input type="checkbox" class="cb-enable" ${enabled ? 'checked' : ''} /> 启用</label>
      <label class="sp-cb" title="走本地代理缓存：有缓存直出、无缓存拉上游并落盘；关闭则直连上游不缓存"><input type="checkbox" class="cb-local" ${local ? 'checked' : ''} /> 本地优先</label>
    </div>
    ${table}`;

  row.querySelector('.cb-enable').addEventListener('change', (e) => {
    _mgr.setEnabledFor(id, e.target.checked);
  });
  row.querySelector('.cb-local').addEventListener('change', (e) => {
    _mgr.setLocalFirstFor(id, e.target.checked);
    renderCache();
  });
  row.querySelector('.btn-up').addEventListener('click', () => move(id, -1));
  row.querySelector('.btn-down').addEventListener('click', () => move(id, +1));
  bindDlRow(row, s);
  return row;
}

/** 绑定源行内下载表的三类交互：折叠 / 入队 / 行内取消（排队=移出，下载中=中止） */
function bindDlRow(row, s) {
  const wrap = row.querySelector('.dl-wrap');
  const tog = row.querySelector('.act-dl');
  if (tog && wrap) {
    tog.addEventListener('click', (e) => { e.stopPropagation(); wrap.classList.toggle('open'); });
  }
  row.querySelectorAll('.t-cancel').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    cancelJob(b.dataset.cancel);
  }));
  row.querySelectorAll('.tier[data-dlkey]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const t = tiersFor(s).find((x) => x.key === b.dataset.dlkey.split('|')[1]);
    if (t) startDownload(s.id, t, t.subset || 'full');
  }));
}

/** 展开某源行内的下载表（入队时自动展开，让用户看到行内进度） */
function openDlWrap(id) {
  _body?.querySelector(`[data-dlwrap="${id}"]`)?.classList.add('open');
}

function move(id, dir) {
  const order = getSourceOrder();
  const i = order.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return;
  const [m] = order.splice(i, 1);
  order.splice(j, 0, m);
  _mgr.setOrder(order);
  renderSources();
}

function renderSources() {
  const host = document.getElementById('spSrcList');
  if (!host) return;
  host.innerHTML = '';
  const order = getSourceOrder();
  order.forEach((id, i) => host.appendChild(buildSourceRow(id, i, order.length)));
  bindDnD(host);
  renderCache();
  // 重建按钮后恢复队列状态（排队/下载中的按钮保持禁用与文案）
  for (const k of _dlQueued) paintDl(k, 'queued');
  for (const [k, j] of _dlActives) paintDl(k, 'active', `${j.btnBase} ▶ 下载中`);
}

let _dragIdx = null;
function bindDnD(host) {
  const rows = Array.from(host.children);
  rows.forEach((row, i) => {
    row.addEventListener('dragstart', () => { _dragIdx = i; row.classList.add('dragging'); });
    row.addEventListener('dragend', () => { row.classList.remove('dragging'); _dragIdx = null; });
    row.addEventListener('dragover', (e) => e.preventDefault());
    row.addEventListener('drop', () => {
      if (_dragIdx === null || _dragIdx === i) return;
      const order = getSourceOrder();
      const [m] = order.splice(_dragIdx, 1);
      order.splice(i, 0, m);
      _mgr.setOrder(order);
      renderSources();
    });
  });
}

/* ---------- 下载任务（复用 /api/downloader/* 既有链路） ---------- */

/** 标注点子集参数（mode=points；天地图仍按中国 bbox 交集裁剪，区外点自动剔除） */
function pointsParams(id, tier) {
  const params = {
    source: DL_SOURCE[id], minZ: tier.zmin, maxZ: tier.zmax,
    mode: 'points', radiusKm: getRadius(),
  };
  if (id === 'tianditu') params.bbox = [CHINA_RECT.w, CHINA_RECT.s, CHINA_RECT.e, CHINA_RECT.n];
  return params;
}

/** 向服务端精算「标注点子集」真实瓦片数（--dry-run 只数不下载，结果按参数缓存） */
const _plans = new Map();
async function planPoints(id, zmin, zmax) {
  const key = `${id}|${zmin}|${zmax}|${getRadius()}`;
  if (_plans.has(key)) return _plans.get(key);
  try {
    const r = await fetch('/api/downloader/plan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'tiles', params: pointsParams(id, { zmin, zmax }) }),
    });
    const j = await r.json();
    if (j.error || j.total == null) return null;
    const v = { total: j.total, points: j.points };
    _plans.set(key, v);
    return v;
  } catch { return null; }
}

/** 打开面板 / 改半径后，把各源「高清·标注点」按钮的 tooltip 填成真实张数 */
let _planToken = 0;
async function refreshPlanTitles() {
  if (!_body) return;
  const token = ++_planToken;
  const hint = document.getElementById('spPointsHint');
  const nodes = Array.from(_body.querySelectorAll('[data-plan]'));
  let first = null;
  for (const b of nodes) {
    if (token !== _planToken) return;
    if (!b.dataset.plan) continue;                 // 非标注点档
    const [id, zmin, zmax] = b.dataset.plan.split('|');
    const p = await planPoints(id, Number(zmin), Number(zmax));
    if (token !== _planToken) return;
    if (!p) { b.title = '标注点子集张数计算失败（服务端未响应）'; continue; }
    if (!first) {
      first = { id, ...p };
      if (hint) hint.textContent = `${p.points} 个标注点 · ±${getRadius()}km（各源张数见②列与按钮）`;
    }
    b.title = `${p.points} 个标注点 ±${getRadius()}km · ${p.total.toLocaleString()} 张 · 约 ${fmtSize(p.total * AVG_KB[id] * 1024)}`;
    // 按钮文案恒为「下载」：张数已在 ②列「子集 N 张（精算）」与悬停提示里，不往按钮上堆
  }
  if (hint && !first) hint.textContent = '标注点子集张数计算失败';
  renderCache();   // 精算到位后重绘 ②列（「子集 N 张（精算）」）
}

/* ---------- 下载任务：前端队列 ----------
 * 后端进程池并发 2（_DL_MAX_JOBS），前端队列喂槽位：
 *   点击 → 入队（按钮 ⏳ 第N位，重复点击同任务被忽略）→ 有空槽即开跑（▶ 下载中/pct%）
 *   → 结束（✓ 已完成 2.5s 后还原，队列补位）。
 * 队列状态回写到按钮靠 data-dlkey；面板底部进度条显示第一个运行中任务。 */
const DL_CONCURRENCY = 2;          // 与 app.py _DL_MAX_JOBS 保持一致
const _dlQueue = [];
const _dlQueued = new Set();
const _dlActives = new Map();      // key -> { key, label, params, btnBase }
const _dlDoneIds = new Set();      // 已结算过的后端 job id（防重复结算）

function taskLabel(id, tier, subset) {
  const sub = subset === 'points' ? `·标注点 ±${getRadius()}km` : '·全部';
  // 用 srcDef 而非 getSourceDef：后者对未注册 id（terrain）回退成 IMAGERY_SOURCES[0]（esri），
  // 会让地形任务标签错显示「Esri 卫星」
  return `${srcDef(id).name} ${tier.label}${sub} z${tier.zmin}–${tier.zmax}`;
}

/** 取某档位行的单元格容器（.t-act） */
const cellOf = (key) => _body && _body.querySelector(`[data-act="${key}"]`);

function paintDl(key, state, txt, cellTxt) {
  const b = _body && _body.querySelector(`[data-dlkey="${key}"]`);
  if (!b) return;
  if (!b.dataset.base) b.dataset.base = b.textContent;   // 首次捕获原始文案（恒为「下载」）
  b.classList.toggle('dl-active', state === 'active');
  b.classList.toggle('dl-queued', state === 'queued');
  // 行内格子：排队/下载中才露出进度条、文本与「✕ 取消」
  const c = cellOf(key);
  if (c) {
    c.classList.toggle('busy', state === 'active' || state === 'queued');
    const t = c.querySelector('.t-txt');
    if (t) {
      if (state === 'queued') { t.classList.add('on'); t.textContent = cellTxt || txt || '队列中'; }
      if (state === 'idle') { t.classList.remove('on'); t.textContent = ''; }
    }
  }
  if (state === 'idle') {
    b.disabled = false;
    b.textContent = b.dataset.base;
  } else {
    b.disabled = true;
    if (txt) b.textContent = txt;
  }
}

/** 下载中：把 pct 写进行内进度条与文本 */
function paintCell(key, pct, txt) {
  const c = cellOf(key);
  if (!c) return;
  c.classList.add('busy');
  const bar = c.querySelector('.t-prog');
  if (bar) { bar.classList.add('on'); bar.querySelector('i').style.width = `${pct}%`; }
  const t = c.querySelector('.t-txt');
  if (t) { t.classList.add('on'); if (txt) t.textContent = txt; }
}

/** 收尾：清掉行内进度条与文本 */
function clearCell(key) {
  const c = cellOf(key);
  if (!c) return;
  c.classList.remove('busy');
  const bar = c.querySelector('.t-prog');
  if (bar) { bar.classList.remove('on'); bar.querySelector('i').style.width = '0%'; }
  const t = c.querySelector('.t-txt');
  if (t) { t.classList.remove('on'); t.textContent = ''; }
}

/** 行内取消：排队 = 移出队列并重排序号；下载中 = 中止（后端按 key 精准取消） */
async function cancelJob(key) {
  // start 请求还在飞（后端尚未真正起跑）→ 先等它落地，否则取消会「打空」：
  // 后端回「没有运行中任务」，而任务随后照常起跑 / 409 回队被重试拉活，取消形同虚设
  const flying = _dlActives.get(key);
  if (flying?.starting) {
    try { await flying.starting; } catch { /* 忽略 */ }
  }
  const qi = _dlQueue.findIndex((j) => j.key === key);
  if (qi >= 0) {
    const [j] = _dlQueue.splice(qi, 1);
    _dlQueued.delete(j.key);          // 必须同步清去重集合，否则该按钮再点击会被「已在队列中」挡掉
    clearCell(j.key); paintDl(j.key, 'idle');
    _dlQueue.forEach((q, i) => paintDl(q.key, 'queued', `⏳ 第${i + 1}位`));
    paintDlSums();
    _setStatus(`已移出队列：${j.label}`, 'ok');
    refreshPlanTitles();
    return;
  }
  const job = _dlActives.get(key);
  if (!job) return;
  try {
    await fetch('/api/downloader/cancel', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
  } catch { /* 忽略 */ }
  _setStatus(`已中止下载：${job.label}`, 'warn');
  // 后端进程被 CTRL_BREAK 终止后，轮询会在下一拍结算该 job 并自动补位
  paintDlSums();
}

function finishDl(job, ok) {
  _dlQueued.delete(job.key);
  _dlActives.delete(job.key);
  clearCell(job.key);
  paintDl(job.key, 'idle');
  paintDlSums();
  const b = _body && _body.querySelector(`[data-dlkey="${job.key}"]`);
  if (b && ok) {
    b.textContent = `${b.dataset.base} ✓`;
    setTimeout(() => { if (!b.classList.contains('dl-active') && !b.classList.contains('dl-queued')) b.textContent = b.dataset.base; }, 2500);
  }
  pumpQueue();
}

function pumpQueue() {
  while (_dlActives.size < DL_CONCURRENCY && _dlQueue.length) {
    const job = _dlQueue.shift();
    _dlActives.set(job.key, job);
    paintDl(job.key, 'active', `${job.btnBase} ▶ 下载中`);
    _startJob(job);   // 不 await：占位后立即尝试下一个槽位
  }
  paintDlSums();
}

async function _startJob(job) {
  // 把整个启动过程挂到 job.starting：取消时若请求还在飞，先等它落地再取消，
  // 否则后端会回「没有运行中任务」（取消打空），而任务随后照常起跑
  job.starting = (async () => {
    try {
      const r = await fetch('/api/downloader/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'tiles', params: job.params, key: job.key, label: job.label }),
      });
      const j = await r.json();
      if (j.error) {
        // 409 = 后端进程池未退净（取消后 node 退出有 1-3s 窗口，前端槽位已空、后端还占着）。
        // 不当作失败：退回队列头部，1.5s 后重试；重试过多才真正报败。
        if (r.status === 409 && (job.tries || 0) < 8) {
          job.tries = (job.tries || 0) + 1;
          _dlActives.delete(job.key);
          _dlQueue.unshift(job);   // _dlQueued 未删过（finishDl 才删），去重状态保持一致
          paintDl(job.key, 'queued', '⏳ 等槽位', '⏳ 等待并发槽位释放…');
          _setStatus(`等待并发槽位（${job.tries}/8）：${job.label}`, 'warn');
          setTimeout(pumpQueue, 1500);
          return;
        }
        _setStatus(`下载启动失败：${j.error}（${job.label}）`, 'warn');
        finishDl(job, false);
        return;
      }
      _setStatus(`开始下载：${job.label}（在跑 ${_dlActives.size}/${DL_CONCURRENCY}）`, 'ok');
      startPolling();
    } catch (e) {
      _setStatus(`下载启动失败：${e.message}（${job.label}）`, 'warn');
      finishDl(job, false);
    } finally {
      job.starting = null;
    }
  })();
  await job.starting;
}

async function startDownload(id, tier, subset = 'full') {
  const source = DL_SOURCE[id];
  if (!source) return;
  const key = `${id}|${tier.key}|${subset}`;
  if (_dlQueued.has(key) || _dlActives.has(key)) {
    _setStatus('该下载任务已在队列中（按钮上的 ⏳ / ▶ 即在跑）', 'warn');
    return;
  }
  const params = subset === 'points'
    ? pointsParams(id, tier)
    : { source, minZ: tier.zmin, maxZ: tier.zmax };
  // 天地图按中国 bbox 下载（全球下它没意义，且天地图本就是中国区服务）
  if (subset !== 'points' && id === 'tianditu') params.bbox = [CHINA_RECT.w, CHINA_RECT.s, CHINA_RECT.e, CHINA_RECT.n];
  const label = taskLabel(id, tier, subset);
  const btn = _body && _body.querySelector(`[data-dlkey="${key}"]`);
  if (btn && !btn.dataset.base) btn.dataset.base = btn.textContent;
  const btnBase = btn?.dataset.base || label;
  _dlQueue.push({ key, label, params, btnBase });
  _dlQueued.add(key);
  const behind = _dlQueue.length + _dlActives.size;   // 含在跑的，排位更真实
  paintDl(key, 'queued', `⏳ 第${behind}位`, `⏳ 队列中 · 前面还有 ${behind - 1} 个任务`);
  paintDlSums();
  _setStatus(`已加入下载队列：${label}（排队/在跑共 ${behind} 个）`, 'ok');
  openDlWrap(id);      // 折叠着的表自动展开，让用户看到行内进度
  pumpQueue();
}

function startPolling() {
  if (_poll) return;
  const tick = async () => {
    let s;
    try { s = await (await fetch('/api/downloader/state')).json(); } catch { return; }
    const box = document.getElementById('spTask');
    if (!box) return;
    const jobs = Array.isArray(s.jobs) ? s.jobs : [];
    const runningJobs = jobs.filter((j) => j.running);
    // ① 按钮进度回写：每个运行中任务按 key 找到自己的档位行
    for (const j of runningJobs) {
      const job = _dlActives.get(j.key);
      if (job && j.progress?.pct != null) {
        paintDl(j.key, 'active', `▶ ${Math.round(j.progress.pct)}%`);
        const p = j.progress;
        paintCell(j.key, p.pct,
          `${p.done}/${p.total} · 新 ${p.ok} · 跳过 ${p.skip} · 失败 ${p.fail}${p.rate ? ` · ${p.rate}/s` : ''}${p.eta ? ` · 剩 ${p.eta}` : ''}`);
      }
    }
    // ② 面板底部进度条显示第一个运行中任务（汇总视图；单任务取消在各源行内 ✕）
    const cur = runningJobs[0];
    if (cur) {
      box.hidden = false;
      const p = cur.progress;
      document.getElementById('spTaskLabel').textContent = _dlActives.get(cur.key)?.label || cur.label || cur.kind || '';
      document.getElementById('spTaskBar').style.width = p?.pct != null ? p.pct + '%' : '0%';
      document.getElementById('spTaskTxt').textContent = p
        ? `${p.done}/${p.total} · ${Math.round(p.pct)}% · 新 ${p.ok} · 跳过 ${p.skip} · 失败 ${p.fail}${p.rate ? ` · ${p.rate}/s` : ''}${p.eta ? ` · 剩 ${p.eta}` : ''}`
        : '准备中…';
      document.getElementById('spTaskCount').textContent = `在跑 ${runningJobs.length}/${DL_CONCURRENCY} · 排队 ${_dlQueue.length}`;
    } else {
      box.hidden = true;
    }
    // ③ 结算：已结束且没结算过的后端任务 → 对应前端 job 收尾
    const settled = jobs.filter((j) => !j.running && j.exitCode != null && !_dlDoneIds.has(j.id));
    for (const j of settled) {
      _dlDoneIds.add(j.id);
      const job = _dlActives.get(j.key);
      if (!job) continue;
      // 退出码 3221225786 = 0xC000013A STATUS_CONTROL_C_EXIT：被「✕ 取消」CTRL_BREAK 终止，
      // 属正常取消而非故障，给友好文案；其它非零码照实显示便于排查
      const ecTxt = j.exitCode === 0 ? '下载任务已完成'
        : (j.exitCode === 3221225786 ? '下载任务已取消' : `下载任务结束（退出码 ${j.exitCode}）`);
      _setStatus(`${ecTxt}：${job.label}`, j.exitCode === 0 ? 'ok' : 'warn');
      refreshScan();               // 任务结束刷新一次本地统计（不进轮询）
      finishDl(job, j.exitCode === 0);   // 队列补位
    }
    // ④ 空闲则停轮询
    if (!runningJobs.length && !_dlQueue.length && !_dlActives.size) {
      clearInterval(_poll); _poll = null;
    }
  };
  tick();
  _poll = setInterval(tick, 1000);
}

async function cancelDownload() {
  // 全部中止（面板级快捷方式）；日常取消请用各源行内「✕ 取消」（只停自己那个）
  try {
    await fetch('/api/downloader/cancel', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
  } catch { /* 忽略 */ }
}

/* ---------- 面板装配 ---------- */

export function initSourcePanel({ manager, setStatus }) {
  _mgr = manager;
  _setStatus = setStatus || (() => {});
  _panel = document.getElementById('sourcePanel');
  _body = document.getElementById('sourcePanelBody');
  if (!_panel || !_body) return null;

  _body.innerHTML = `
    <div class="sp-sec">🖼 影像源优先级<span class="tag">P1 = 首选底图</span></div>
    <p class="sp-legend">
      <b>P1 = 首选底图</b>（故障按 P1→P2→P3 回退，拖动行或 ▲▼ 调整）；<b>本地优先</b> = 走本地代理缓存；<b>启用</b> = 参与回退链。详见 README「图源设置面板」。
    </p>
    <div class="sp-total" title="本地影像 + 高程合计；悬停看各源分项">
      <div class="box">本地合计（含高程）<b id="spTotalTiles">—</b><span id="spTotalTilesSub"></span></div>
      <div class="box">本地体积（含高程）<b id="spTotalBytes">—</b><span id="spTotalBytesSub"></span></div>
    </div>
    <div id="spSrcList"></div>

    <div class="sp-sec">⛰ 地形源<span class="tag">整体启用 · 不入链</span></div>
    <div id="spTerrain"></div>

    <div class="sp-sec">⬇ 下载与缓存<span class="tag">每源一张表 · 按清晰度</span></div>
    <div class="sp-ops" style="margin-bottom:8px">
      <span class="sp-cb">标注点周边半径</span>
      <select id="spRadius" title="「高清（标注点）」以左侧栏全部标注点为圆心，下载该半径内的瓦片">
        ${RADIUS_OPTS.map((r) => `<option value="${r}" ${r === getRadius() ? 'selected' : ''}>± ${r} km</option>`).join('')}
      </select>
      <span id="spPointsHint" class="sp-prog-txt">标注点子集张数精算中…</span>
    </div>
    <p class="sp-legend">
      每源一张 <b>4×3 表</b>：行 = 清晰度（骨架 / 低清 / 高清两行），②列 = 已缓存 / 该档总量（悬停看逐 z），③列 = 下载 + 行内进度；点击即入队，并发 2、行内「✕ 取消」只停自己。<b>高清分「标注点 / 全部」</b>两行（标注点小一到两个量级）。详见 README「图源设置面板」。
    </p>
    <div id="spTask" hidden>
      <div style="display:flex;align-items:center;gap:8px;font-size:11px;color:#8fa3cc">
        <span id="spTaskLabel"></span>
        <span id="spTaskCount" style="margin-left:auto"></span>
      </div>
      <div class="sp-prog on" style="margin-top:6px"><i id="spTaskBar"></i></div>
      <div id="spTaskTxt" class="sp-prog-txt" style="display:block;margin-top:4px"></div>
    </div>

    <p class="sp-note">
      地形全球一致、不入回退链；下载分段：骨架 z0–4 → 低清 z5–8 → 高清 z9–11（建议先只下标注点子集）。
    </p>`;

  renderSources();

  // 地形行：本地优先 + 三段下载
  const tHost = document.getElementById('spTerrain');
  const tRow = document.createElement('div');
  tRow.className = 'sp-src';
  const tDef = srcDef('terrain');
  tRow.innerHTML = `
    <div class="sp-top"><span class="sp-name">${tDef.name}</span></div>
    <div class="sp-chips">
      <span class="sp-chip">全球 z0–${tDef.maxZ}</span>
      <span data-cache="terrain"></span>
      <span class="sp-chip est">预估 z0–10：${estLabel('terrain', 0, 10)}</span>
      <a class="sp-chip" href="${DOC.terrain[0]}" target="_blank" rel="noopener">📖 ${DOC.terrain[1]} ↗</a>
    </div>
    <div class="sp-ops">
      <label class="sp-cb" title="地形同样走本地优先代理"><input type="checkbox" class="cb-local" ${isLocalFirst('terrain') ? 'checked' : ''} /> 本地优先</label>
    </div>
    ${tableHtml(tDef)}`;
  tRow.querySelector('.cb-local').addEventListener('change', (e) => {
    _mgr.setLocalFirstFor('terrain', e.target.checked);
    renderCache();
  });
  bindDlRow(tRow, tDef);
  tHost.appendChild(tRow);

  // 面板底部只做汇总；取消入口在各源行内「✕ 取消」
  const cnt = document.getElementById('spTaskCount');
  if (cnt) cnt.title = '并发上限与排队数；取消单个任务请到对应源行内点「✕ 取消」';

  // 半径切换：清掉旧精算结果 → 重绘按钮文案 → 重新精算
  const radiusSel = document.getElementById('spRadius');
  if (radiusSel) radiusSel.addEventListener('change', () => {
    setRadius(Number(radiusSel.value));
    _plans.clear();
    renderSources();      // 影像源行重绘（地形行按钮同样带 data-plan，交给 refreshPlanTitles 更新）
    refreshPlanTitles();
  });

  // 开/关
  const btn = document.getElementById('btnSourceSettings');
  const close = document.getElementById('sourcePanelClose');
  const open = () => {
    _panel.classList.remove('hidden');
    refreshScan();
    startPolling();
  };
  const shut = () => _panel.classList.add('hidden');
  if (btn) btn.addEventListener('click', () => (_panel.classList.contains('hidden') ? open() : shut()));
  if (close) close.addEventListener('click', shut);

  window.__sourcePanel = {
    open, close: shut, refreshScan,
    get order() { return getSourceOrder(); },
    get queueLen() { return _dlQueue.length + _dlActives.size; },   // 排队中 + 下载中
    get queue() { return [..._dlQueue.map((j) => j.label), ...[..._dlActives.values()].map((j) => j.label)]; },
  };
  return window.__sourcePanel;
}
