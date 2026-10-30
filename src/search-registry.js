// src/search-registry.js — 统一检索栏的数据索引与查询
//
// 四类结果：
//   👁 图层 layer   : 勾选即显示（含航天天宫/探月两个特殊层）
//   📍 地点 place   : 点状标注图层里的具名地物，点击定位（camera.flyTo）
//   🎬 巡礼 tour    : 长征/革命路线巡礼（含每个诗词/站点节点）
//   📜 历史 history : 朝代（DYNASTY_DATA）+ 里程碑 + 世界年份档
//   🌙 月面 moon / 🔴 火星 mars : 月球与火星的标注点（MOON_GROUPS / MARS_GROUPS），
//      点击会先切到对应球体再定位（2026-10-29 用户要求：两个行星的标注也要能搜）
//
// 设计要点：索引纯前端、同步构建；历史索引惰性读取 window.DYNASTY_DATA（由 index.html
// 提前加载 map_data.js 提供，避免触发 2.7MB 几何包）。search(q) 返回按类型分组的命中。

import { LAYERS, LAYER_CATEGORIES, LAYER_MAP } from './layers/index.js';
import { LONG_MARCH_STATIONS } from './layers/longmarch.js';
import { REVOLUTION_STATIONS } from './layers/revolution.js';
import { MOON_GROUPS } from './lunar.js';
import { MARS_GROUPS } from './mars.js';

// 点图层 harvest 优先级（重名时保留前者，避免"北京"在多个层里重复出结果）
const PLACE_LAYER_PRIORITY = ['cities', 'worldcities', 'worldcapitals', 'peaks', 'wonders', 'heritage'];

function normName(n) {
  return (n || '').replace(/[（）()\s]/g, '').toLowerCase();
}

// 从括号/斜杠提取别名：北京（蓟/幽州/大都） → [北京, 蓟, 幽州, 大都]
function extractAliases(name) {
  const out = [name];
  const m = name.match(/[（(]([^）)]+)[）)]/);
  if (m) {
    m[1].split(/[/／\s,，]+/).forEach((a) => a && out.push(a));
  }
  return out;
}

function buildLayerIndex() {
  return LAYERS.map((l) => {
    // ⚠ 这里必须先拼成数组再 join：早期写成 [..].join(' ') 后再 push → TypeError: kw.push is not a function，
    //   整个 createSearchRegistry 抛出 → 检索栏直接不挂载（2026-10-29 实测）。
    const kw = [l.name, l.id, l.description || '', l.icon || ''];
    // 航天两个特殊层补关键词，保证"天宫""探月"能命中
    if (l.id === 'tiangong') kw.push('天宫 轨道 空间站 卫星');
    if (l.id === 'moonmission') kw.push('探月 月球 火箭 任务 嫦娥');
    return { type: 'layer', id: l.id, name: l.name, searchText: kw.join(' ').toLowerCase() };
  });
}

function buildPlaceIndex() {
  const out = [];
  const seen = new Map(); // normName -> entry（去重）
  const ordered = [...LAYERS].sort((a, b) => {
    const ia = PLACE_LAYER_PRIORITY.indexOf(a.id);
    const ib = PLACE_LAYER_PRIORITY.indexOf(b.id);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  for (const layer of ordered) {
    for (const g of layer.groups || []) {
      for (const e of g.entities || []) {
        if (e.type === 'point' && isFinite(e.lon) && isFinite(e.lat)) {
          const norm = normName(e.name);
          if (seen.has(norm)) continue; // 重名保留高优先级层
          const entry = {
            type: 'place',
            name: e.name,
            lon: e.lon,
            lat: e.lat,
            sourceLayer: layer.id,
            sourceLayerName: layer.name,
            desc: e.desc || '',
            url: e.url || '',
            searchText: extractAliases(e.name).join(' ').toLowerCase(),
          };
          seen.set(norm, entry);
          out.push(entry);
        }
      }
    }
  }
  return out;
}

function buildTourIndex() {
  const out = [];
  const tourLayers = [
    { id: 'longmarch', stations: LONG_MARCH_STATIONS, name: '长征巡礼' },
    { id: 'revolution', stations: REVOLUTION_STATIONS, name: '革命巡礼' },
  ];
  for (const tl of tourLayers) {
    const layer = LAYERS.find((l) => l.id === tl.id);
    if (!layer) continue;
    // 找到含 stations 的折线实体（与图层树"▶ 巡礼"按钮同源）
    let ent = null;
    for (const g of layer.groups || []) {
      for (const e of g.entities || []) {
        if (e.type === 'polyline' && Array.isArray(e.coords) && Array.isArray(e.stations)) {
          ent = e;
          break;
        }
      }
      if (ent) break;
    }
    if (!ent) continue;
    // 巡礼整体入口（搜"长征/革命"直接启动，从头播放）
    out.push({
      type: 'tour',
      tourKind: 'head',
      layerId: tl.id,
      layerName: tl.name,
      ent,
      station: null,
      name: tl.name,
      searchText: (tl.name + ' ' + tl.id + ' 巡礼 路线 长征 革命').toLowerCase(),
    });
    // 每个站点（搜诗词正文/站点名 → 落到具体节点，点击跳过去）
    for (const s of ent.stations) {
      const text = [s.name, s.title, s.body, s.note, tl.name].filter(Boolean).join(' ').toLowerCase();
      out.push({
        type: 'tour',
        tourKind: 'station',
        layerId: tl.id,
        layerName: tl.name,
        ent,
        station: s,
        name: s.name || s.title || tl.name,
        searchText: text,
      });
    }
  }
  return out;
}

/**
 * 月球 / 火星标注索引。
 * 这两个球体不走 LAYERS（它们是独立 Cesium Viewer + 各自的 MOON_GROUPS / MARS_GROUPS），
 * 所以单独建一份索引；条目里带 body/groupId，main.js 据此「切球体 → 勾选分组 → 相机定位」。
 */
function buildBodyIndex() {
  const pack = (groups, body, bodyLabel, extraKw) => {
    const out = [];
    for (const g of groups) {
      for (const e of g.entities || []) {
        if (!isFinite(e.lon) || !isFinite(e.lat)) continue;
        out.push({
          type: body,              // 'moon' | 'mars'
          body,                    // main.js 判据
          bodyLabel,               // '月球' | '火星'
          id: `${body}:${g.id}:${e.name}`,
          groupId: g.id,
          groupName: g.name,
          name: e.name,
          lon: e.lon,
          lat: e.lat,
          desc: e.description || g.name,
          searchText: [e.name, e.text, e.description, g.name, bodyLabel, extraKw]
            .filter(Boolean).join(' ').toLowerCase(),
        });
      }
    }
    return out;
  };
  return {
    moon: pack(MOON_GROUPS, 'moon', '月球', '月面 月海 环形山 着陆点 登月'),
    mars: pack(MARS_GROUPS, 'mars', '火星', '火面 地貌 着陆点 极冠'),
  };
}

let historyIndexCache = null;
function buildHistoryIndex() {
  if (historyIndexCache) return historyIndexCache;
  const out = [];
  const D = window.DYNASTY_DATA || [];
  for (const d of D) {
    const phasesTxt = (d.phases || []).map((p) => p.overview || '').join(' ');
    out.push({
      type: 'history',
      histKind: 'dynasty',
      key: d.key,
      title: d.title,
      focusYear: d.focusYear,
      fromYear: d.fromYear,
      toYear: d.toYear,
      summary: d.summary || '',
      seat: d.seat || '',
      name: d.title,
      // 用户习惯搜「唐朝 / 汉朝」，而 DYNASTY_DATA 的 title 只写「唐」「汉」→ 补一个「朝」别名参与匹配
      searchText: (d.title + `${d.title}朝` + ' ' + (d.summary || '') + ' ' + (d.seat || '') + ' ' + phasesTxt).toLowerCase(),
    });
    for (const m of d.milestones || []) {
      out.push({
        type: 'history',
        histKind: 'milestone',
        dynastyKey: d.key,
        dynastyTitle: d.title,
        year: m.year,
        headline: m.headline || '',
        site: m.site || '',
        coord: Array.isArray(m.coord) ? m.coord : null,
        name: m.headline || d.title,
        searchText: (m.headline + ' ' + (m.site || '') + ' ' + d.title).toLowerCase(),
      });
    }
  }
  historyIndexCache = out;
  return out;
}

export const TYPE_META = {
  tour: { icon: '🎬', label: '巡礼' },
  place: { icon: '📍', label: '地点' },
  layer: { icon: '👁', label: '图层' },
  history: { icon: '📜', label: '历史' },
  moon: { icon: '🌙', label: '月面' },
  mars: { icon: '🔴', label: '火星' },
};

export function createSearchRegistry() {
  const layerIdx = buildLayerIndex();
  const placeIdx = buildPlaceIndex();
  const tourIdx = buildTourIndex();
  const bodyIdx = buildBodyIndex();

  /**
   * 图层目录（检索框为空时下拉直接显示）。
   * ⭐ 2026-10-29 用户决定：删掉侧栏「标注图层」勾选树后，检索栏兼做目录 ——
   *   否则 27 个图层只能靠记名字才找得到。
   * 返回 [{ id, name, icon, layers: [{id,name,icon,description}] }]，空分类略过。
   */
  function catalog() {
    const out = [];
    for (const cat of LAYER_CATEGORIES) {
      const layers = (cat.layerIds || [])
        .map((id) => LAYER_MAP.get(id))
        .filter(Boolean)
        .map((l) => ({ id: l.id, name: l.name, icon: l.icon || '', description: l.description || '' }));
      if (layers.length) out.push({ id: cat.id, name: cat.name, layers });
    }
    // 兜底：分类表没覆盖到的图层追加在最后，保证"任何图层都能在目录里找到"
    const listed = new Set(out.flatMap((c) => c.layers.map((l) => l.id)));
    const rest = LAYERS.filter((l) => !listed.has(l.id))
      .map((l) => ({ id: l.id, name: l.name, icon: l.icon || '', description: l.description || '' }));
    if (rest.length) out.push({ id: 'other', name: '其它', layers: rest });
    // 行星标注（2026-10-29）：目录里也能浏览月面 / 火星的标注点，点一条 = 切到那个球体并定位。
    //   kind:'body' 让 search-bar 走另一套渲染（没有 #layer-* checkbox 可查"已显示"）。
    const bodyCat = (body, name, icon) => {
      const items = bodyIdx[body].map((e) => ({ id: e.id, name: e.name, icon, kind: 'body', entry: e }));
      if (items.length) out.push({ id: `body-${body}`, name, layers: items });
    };
    bodyCat('moon', '🌙 月面标注', '🌙');
    bodyCat('mars', '🔴 火星标注', '🔴');
    return out;
  }

  function search(q) {
    q = (q || '').trim().toLowerCase();
    const res = { tour: [], place: [], layer: [], history: [], moon: [], mars: [] };
    if (!q) return res;
    const match = (entry) => entry.searchText.includes(q);
    // 「能一键起一段巡礼」的聚合条目（朝代 / 巡礼整体）永远排在本组的普通节点之前，
    // 否则搜「唐朝」会被一堆唐史里程碑压在下面（实测 name 匹配分数更高，减 0.4 不够）。
    const rank = (e) => ((e.histKind === 'dynasty' || e.tourKind === 'head') ? 0 : 1);
    const score = (entry) => {
      const nm = (entry.name || '').toLowerCase();
      if (nm === q) return 0;
      if (nm.startsWith(q)) return 1;
      if (nm.includes(q)) return 2;
      return 3;
    };
    const push = (list, bucket) => {
      for (const e of list) if (match(e)) res[bucket].push(e);
      res[bucket].sort((a, b) => rank(a) - rank(b) || score(a) - score(b));
      if (res[bucket].length > 8) res[bucket] = res[bucket].slice(0, 8);
    };
    push(layerIdx, 'layer');
    push(placeIdx, 'place');
    push(tourIdx, 'tour');
    push(buildHistoryIndex(), 'history');
    push(bodyIdx.moon, 'moon');
    push(bodyIdx.mars, 'mars');
    return res;
  }

  return { search, catalog, TYPE_META };
}
