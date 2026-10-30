// src/history-atlas.js — 历史时空：把两套开源历史地图数据叠到三维地球上
//
// 数据源 A：aourednik/historical-basemaps（GPL-3.0）
//   世界历史国界，54 个年份快照（前 123000 → 2010）。由 tools/history/build-world-basemaps.py
//   简化成按年分片 JSON，属性 n=NAME / s=SUBJECTO(宗主国) / f=PARTOF / b=BORDERPRECISION。
// 数据源 B：DeanChensj/jiangshan-map（GPL-3.0，府州层含 CHGIS V6 学术非商业条款）
//   中国历代疆域，17 朝代 / 181 阶段快照（前 403 → 1948），三层政区 + 城邑 + 事件 + 廊道。
//   资产是它自带的 VLQ 惰性解码包（2.7 MB），切阶段时才解码单个面。
//
// 两者共用一根年份轴：给定年份，落在世界快照档位上就画世界国界，
// 落在 -403..1948 内就画中国政区，重叠年份两套同时显示（如 1900 年的清帝国 + 世界列强）。
//
// 渲染约定：
//   - 面用半透明填充 + 描边，clampToGround 贴地形（关掉可省 GPU，见 setClampGround）
//   - 世界国界按 SUBJECTO 着色（同一宗主国同色，殖民帝国一眼可辨）
//   - 中国政区用数据自带的 tint，按 polity / region / prefecture 分层开关
//   - 年份切换 = 清空当前 DataSource 重建，不做增量 diff（单阶段 40~160 个面，代价可接受）

import * as Cesium from 'cesium';

const WORLD_BASE = '/data/history/world';
const CHINA_BASE = '/data/history/china';
const CHINA_FILES = ['map_data.js', 'atlas_snapshots.js'];

// 宗主国着色板：低饱和、互相可辨，避免与卫星底图撞色
const PALETTE = [
  '#c0392b', '#2980b9', '#27ae60', '#d35400', '#8e44ad', '#16a085',
  '#c9a227', '#7f8c8d', '#a93226', '#1f6f8b', '#5d8a3a', '#b9770e',
  '#6c3483', '#2874a6', '#a04000', '#4a6f8a', '#8d6e63', '#2e86c1',
  '#9b59b6', '#17a589', '#cb4335', '#7d3c98', '#1e8449', '#b7950b',
];

function colorFor(key) {
  if (!key) return Cesium.Color.fromCssColorString('#8e9aaf');
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return Cesium.Color.fromCssColorString(PALETTE[h % PALETTE.length]);
}

function cssColor(hex, fallback) {
  if (!hex || typeof hex !== 'string') return Cesium.Color.fromCssColorString(fallback);
  try {
    return Cesium.Color.fromCssColorString(hex);
  } catch {
    return Cesium.Color.fromCssColorString(fallback);
  }
}

/** 年份展示：负数 = 公元前 */
export function formatYear(y) {
  if (y === null || y === undefined) return '—';
  return y < 0 ? `前 ${Math.abs(y)} 年` : `${y} 年`;
}

async function fetchJSON(url) {
  const r = await fetch(url, { cache: 'force-cache' });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = () => resolve(url);
    s.onerror = () => reject(new Error('脚本加载失败 ' + url));
    document.head.appendChild(s);
  });
}

/** 外环近似面积（度²），用于按重要性排序与剔除碎片 */
function ringAreaDeg(ring) {
  let a = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(a) * 0.5;
}

function outerRing(geom) {
  const c = geom && geom.coordinates;
  if (!c || !c.length) return null;
  return geom.type === 'MultiPolygon' ? c[0][0] : c[0];
}

/**
 * 环合法性清洗：丢掉非有限值/连续重复点，保证闭合且至少 4 个顶点。
 * 返回扁平的 [lon,lat,lon,lat,...]，无效返回 null。
 */
function cleanRing(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  const out = [];
  let lastLon = NaN;
  let lastLat = NaN;
  for (const p of ring) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const lon = Number(p[0]);
    const lat = Number(p[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (lon === lastLon && lat === lastLat) continue;
    lastLon = lon;
    lastLat = lat;
    out.push(lon, lat);
  }
  if (out.length < 8) return null;                     // 少于 4 个顶点
  if (out[0] !== out[out.length - 2] || out[1] !== out[out.length - 1]) {
    out.push(out[0], out[1]);                          // 补闭合
  }
  return out;
}

/** 折线清洗：≥2 个有效顶点，不去闭合。返回扁平数组或 null。 */
function cleanPath(pts) {
  if (!Array.isArray(pts)) return null;
  const out = [];
  let lastLon = NaN;
  let lastLat = NaN;
  for (const p of pts) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const lon = Number(p[0]);
    const lat = Number(p[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (lon === lastLon && lat === lastLat) continue;
    lastLon = lon;
    lastLat = lat;
    out.push(lon, lat);
  }
  return out.length >= 4 ? out : null;
}

function centroidOf(geom) {
  const ring = outerRing(geom);
  if (!ring || ring.length < 3) return null;
  let x = 0;
  let y = 0;
  let n = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    x += ring[i][0];
    y += ring[i][1];
    n++;
  }
  return n ? [x / n, y / n] : null;
}

/**
 * 创建历史时空控制器
 * @param {Cesium.Viewer} viewer
 * @param {{onStatus?:Function, onPick?:Function}} opts
 */
export function createHistoryAtlas(viewer, opts = {}) {
  let onStatus = opts.onStatus || (() => {});
  let onPick = opts.onPick || (() => {});

  const ds = new Cesium.CustomDataSource('history-atlas');
  ds.show = false;
  viewer.dataSources.add(ds);

  // ---- 状态 ----
  const state = {
    enabled: false,
    year: 1900,
    world: true,          // 世界国界
    china: true,          // 中国历代疆域
    layers: {
      polity: true, region: true, prefecture: false,
      settlements: true, corridors: true, milestones: false,
      places: false,   // 世界历史城市点（2220 个，默认关）
    },
    maxFeatures: 600,     // 世界图层单年份最多渲染面数（按面积降序）
    // ⚠ 默认不贴地：Cesium 的 polygon.clampToGround 按 terrainProvider 的**真实**高程
    //   生成几何，而球体现在开着垂直夸张（默认 1.2×）——两者不一致，政区面会整体沉到
    //   夸张后的地形之下，肉眼完全看不到（headless 截图已实证）。
    //   平铺在椭球面反而是历史政区想要的效果；想看贴地起伏就先把夸张调回 1× 再勾选。
    clampGround: false,
  };

  let worldIndex = null;   // {years:[{year,file,n}]}
  let chinaIndex = null;   // {dynasties, snapshots}
  let places = null;       // 世界历史城市点（按需加载一次）
  let chinaReady = false;
  let chinaLoading = null;
  let hovered = null;
  let loadingToken = 0;

  // ================= 数据装载 =================

  async function ensureWorldIndex() {
    if (worldIndex) return worldIndex;
    worldIndex = await fetchJSON(`${WORLD_BASE}/index.json`);
    return worldIndex;
  }

  async function ensureChina() {
    if (chinaReady) return true;
    if (chinaLoading) return chinaLoading;
    chinaLoading = (async () => {
      chinaIndex = await fetchJSON(`${CHINA_BASE}/index.json`);
      for (const f of CHINA_FILES) {
        if (f === 'map_data.js' && window.DYNASTY_DATA) continue;
        if (f === 'atlas_snapshots.js' && window.ATLAS_SNAPSHOTS) continue;
        await loadScript(`${CHINA_BASE}/${f}`);
      }
      hydrateSnapshots();
      chinaReady = true;
      return true;
    })();
    try {
      return await chinaLoading;
    } finally {
      chinaLoading = null;
    }
  }

  /**
   * 解析 prefRef / regionRef 继承链——必须按 key 顺序，链式引用才能收敛。
   * 与 jiangshan-map 官方 _hydrateSnapshots 完全一致的规则。
   */
  function hydrateSnapshots() {
    const S = window.ATLAS_SNAPSHOTS;
    if (!S) return;
    const lists = {};
    for (const [key, s] of Object.entries(S)) {
      if (key === 'neighbors') continue;
      lists[key] = { polities: s.polities, prefectures: s.prefectures, regions: s.regions };
    }
    for (const [key, s] of Object.entries(S)) {
      if (key === 'neighbors') continue;
      const l = lists[key];
      if (s.prefRef && (!l.prefectures || !l.prefectures.length) && lists[s.prefRef]) {
        l.prefectures = lists[s.prefRef].prefectures || [];
      }
      if (s.regionRef && (!l.regions || !l.regions.length) && lists[s.regionRef]) {
        l.regions = lists[s.regionRef].regions || [];
      }
    }
  }

  /** 年份 → 中国阶段（phase） */
  function phaseAt(year) {
    if (!chinaIndex) return null;
    for (const d of chinaIndex.dynasties) {
      if (year < d.from || year > d.to) continue;
      for (const p of d.phases) {
        if (year >= p.from && year <= p.to) return { dynasty: d, phase: p };
      }
    }
    return null;
  }

  /** 年份 → 世界快照文件名（取不晚于该年份的最近一档；更早于首档则取首档） */
  function worldFileAt(year) {
    if (!worldIndex) return null;
    const ys = worldIndex.years;
    let pick = null;
    for (const r of ys) {
      if (r.year <= year) pick = r;
      else break;
    }
    return pick || ys[0];
  }

  // ================= 渲染 =================

  /**
   * 建政区面。
   * ⚠ Cesium 的 polygon.hierarchy 只接受单个 PolygonHierarchy——传数组会让内部
   *   读 positions 得到 undefined，进而 normalize 出 NaN，整个场景 "Rendering has stopped"。
   *   所以 MultiPolygon 必须拆成多个 entity（同名、同属性），标签只挂在第一个上。
   * ⚠ 环还要做合法性过滤：不足 4 点、非有限值、连续重复点都会被剔除，
   *   否则退化几何同样会喂出 NaN 让渲染停摆。
   */
  function addPolygon(name, geom, color, alpha, opts = {}) {
    if (!geom || !geom.coordinates || !geom.coordinates.length) return null;
    const polys = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
    let first = null;
    for (const rings of polys) {
      if (!Array.isArray(rings) || !rings.length) continue;
      const outer = cleanRing(rings[0]);
      if (!outer) continue;
      const holes = [];
      for (let i = 1; i < rings.length; i++) {
        const h = cleanRing(rings[i]);
        if (h) holes.push({ positions: Cesium.Cartesian3.fromDegreesArray(h) });
      }
      const ent = {
        name,
        polygon: {
          hierarchy: {
            positions: Cesium.Cartesian3.fromDegreesArray(outer),
            holes: holes.length ? holes : undefined,
          },
          material: color.withAlpha(alpha),
          outline: true,
          outlineColor: color.withAlpha(Math.min(1, alpha + 0.45)),
          outlineWidth: opts.outlineWidth ?? 2,
          clampToGround: state.clampGround,
          perPositionHeight: false,
        },
      };
      // ⭐ 悬停高亮的「底色存档」必须在创建时就留一份：
      //   Cesium 的 ColorMaterialProperty.getValue() 返回的是材质 uniform 对象 {color: Color}，
      //   不是 Color 本身。把它原样塞回 polygon.material 会被当成「未知材质描述对象」，
      //   Cesium 退化成默认材质 → 地块渲染成纯白（用户实测：hover 后一片白，且不会恢复）。
      //   所以这里直接存创建时的 Color 引用，回读一律走它，绝不 getValue。
      ent._histFill = color.withAlpha(alpha);
      ent._histOutline = color.withAlpha(Math.min(1, alpha + 0.45));
      ent._histOutlineW = opts.outlineWidth ?? 2;
      if (opts.props) ent._hist = opts.props;
      if (opts.label && !first) {
        const c = opts.labelAt || centroidOf(geom);
        if (c) {
          ent.position = Cesium.Cartesian3.fromDegrees(c[0], c[1]);
          ent.label = {
            text: opts.label,
            font: opts.labelFont || '600 13px "Microsoft YaHei", sans-serif',
            fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.fromCssColorString('#0d1117'),
            outlineWidth: 3,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            verticalOrigin: Cesium.VerticalOrigin.CENTER,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            showBackground: true,
            backgroundColor: Cesium.Color.fromCssColorString('#0d1117').withAlpha(0.55),
            backgroundPadding: new Cesium.Cartesian2(5, 3),
            pixelOffset: new Cesium.Cartesian2(0, 0),
            scaleByDistance: new Cesium.NearFarScalar(2e5, 1.0, 1.2e7, 0.55),
            // 全球视角就够挤了：再远（出地球尺度）不再画标签
            distanceDisplayCondition: opts.labelDistance ||
              new Cesium.DistanceDisplayCondition(0, 2.0e7),
          };
        }
      }
      const e = ds.entities.add(ent);
      if (!first) first = e;
    }
    return first;
  }

  async function renderWorld(year, token) {
    const rec = worldFileAt(year);
    if (!rec) return 0;
    const data = await fetchJSON(`${WORLD_BASE}/${rec.file}`);
    // ⚠ 竞态闸门：年份被连切（或用户已关闭图层）后，这个请求的结果就作废了，
    //   直接 return，否则旧年份的面会在 removeAll 之后又塞回数据源。
    if (token !== loadingToken || !state.enabled) return 0;
    const feats = data.features.slice();
    // 按面积降序：保证碎片被裁掉时，留下的是主要政权
    for (const f of feats) {
      f._a = ringAreaDeg(outerRing(f.g) || []);
    }
    feats.sort((a, b) => b._a - a._a);
    const use = state.maxFeatures > 0 ? feats.slice(0, state.maxFeatures) : feats;
    // 只给面积最大的 25 个政权挂标签：全球视角下同屏 190 个国家名会糊成一片
    const labelTop = Math.min(use.length, 25);
    let n = 0;
    for (let i = 0; i < use.length; i++) {
      const f = use[i];
      const name = f.p.n || '';
      const base = colorFor(f.p.s || f.p.n);
      const alpha = f.p.b === 1 ? 0.18 : f.p.b === 2 ? 0.24 : 0.3;
      const e = addPolygon(name, f.g, base, alpha, {
        props: {
          kind: 'world',
          name,
          subjecto: f.p.s,
          partof: f.p.f,
          precision: f.p.b,
          year: rec.year,
        },
        label: i < labelTop ? name : null,
      });
      if (e) n++;
    }
    return { n, snappedYear: rec.year };
  }

  function renderChina(year, token) {
    if (token !== loadingToken || !state.enabled) return 0;
    const hit = phaseAt(year);
    if (!hit) return 0;
    const S = window.ATLAS_SNAPSHOTS;
    const snap = S && S[hit.phase.snap];
    if (!snap) return 0;
    let n = 0;

    // prefecture（府州）先画，polity（政权）压在最上层
    if (state.layers.prefecture) {
      (snap.prefectures || []).forEach((f, i) => {
        const c = cssColor(f.tint, '#5b7c99');
        const e = addPolygon(f.title, f.shape, c, 0.12, {
          props: { kind: 'prefecture', name: f.title, category: f.category },
          outlineWidth: 1,
        });
        if (e) n++;
      });
    }
    if (state.layers.region) {
      (snap.regions || []).forEach((f) => {
        const c = cssColor(f.tint, '#7d5a3c');
        const e = addPolygon(f.title, f.shape, c, 0.14, {
          props: { kind: 'region', name: f.title, category: f.category },
          outlineWidth: 2,
        });
        if (e) n++;
      });
    }
    if (state.layers.polity) {
      (snap.polities || []).forEach((f) => {
        const c = cssColor(f.tint, '#b03a2e');
        const anchor = Array.isArray(f.anchor) ? f.anchor : null;
        const e = addPolygon(f.title, f.shape, c, 0.22, {
          props: { kind: 'polity', name: f.title, category: f.category },
          label: f.title,
          labelAt: anchor,
          outlineWidth: 3,
        });
        if (e) n++;
      });
    }

    // 廊道：长城 / 运河 / 道路 / 海路
    if (state.layers.corridors && Array.isArray(window.CORRIDOR_DATA)) {
      for (const c of window.CORRIDOR_DATA) {
        if (c.span && (year < c.span[0] || year > Math.min(c.span[1], 1948))) continue;
        const segs = c.segments || [];
        const color =
          c.kind === 'wall' ? '#8d6e63' :
          c.kind === 'canal' ? '#2e86c1' :
          c.kind === 'sea' ? '#16a085' : '#b9770e';
        for (const seg of segs) {
          const flat = cleanPath(seg);
          if (!flat) continue;
          ds.entities.add({
            name: c.title,
            _hist: { kind: 'corridor', name: c.title, summary: c.summary },
            polyline: {
              positions: Cesium.Cartesian3.fromDegreesArray(flat),
              width: 3,
              material: Cesium.Color.fromCssColorString(color).withAlpha(0.9),
              clampToGround: state.clampGround,
            },
          });
          n++;
        }
      }
    }

    // 城邑：取当前朝代的聚落点（古今名对照 + 都城标记）
    if (state.layers.settlements) {
      const dy = (window.DYNASTY_DATA || []).find((d) => d.key === hit.dynasty.key);
      const list = dy && Array.isArray(dy.settlements) ? dy.settlements : [];
      const shown = list.filter((s) => !s.tier || s.tier <= 2);
      for (const s of shown) {
        if (!Array.isArray(s.coord)) continue;
        const capital = !!s.isCapital;
        ds.entities.add({
          name: s.ancient || s.modern || '',
          position: Cesium.Cartesian3.fromDegrees(s.coord[0], s.coord[1]),
          _hist: {
            kind: 'settlement',
            name: s.ancient,
            modern: s.modern,
            remark: s.remark,
            capital,
          },
          point: {
            pixelSize: capital ? 11 : 7,
            color: capital
              ? Cesium.Color.fromCssColorString('#ffd24a')
              : Cesium.Color.fromCssColorString('#f0f4f8'),
            outlineColor: Cesium.Color.fromCssColorString('#1b2430'),
            outlineWidth: 1.5,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 8.0e6),
          },
          label: {
            text: s.ancient || s.modern || '',
            font: capital
              ? '700 13px "Microsoft YaHei", sans-serif'
              : '400 11px "Microsoft YaHei", sans-serif',
            fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.fromCssColorString('#0d1117'),
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            pixelOffset: new Cesium.Cartesian2(0, -10),
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            showBackground: true,
            backgroundColor: Cesium.Color.fromCssColorString('#0d1117').withAlpha(0.5),
            backgroundPadding: new Cesium.Cartesian2(4, 2),
            scaleByDistance: new Cesium.NearFarScalar(1e5, 1.0, 6e6, 0.5),
            // 城邑名只在拉近到区域级（约 4000 km 视距）才出现，全球视角下不参与拥挤
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 4.0e6),
          },
        });
        n++;
      }
    }

    // 历史事件点：只显示当前年份前后 10 年内的里程碑
    if (state.layers.milestones) {
      const dyns = window.DYNASTY_DATA || [];
      for (const d of dyns) {
        for (const m of d.milestones || []) {
          if (!Array.isArray(m.coord) || Math.abs(m.year - year) > 10) continue;
          ds.entities.add({
            name: `${m.year} ${m.headline || ''}`,
            position: Cesium.Cartesian3.fromDegrees(m.coord[0], m.coord[1]),
            _hist: { kind: 'milestone', name: m.headline, year: m.year, site: m.site },
            point: {
              pixelSize: 9,
              color: Cesium.Color.fromCssColorString('#e74c3c'),
              outlineColor: Cesium.Color.WHITE,
              outlineWidth: 1.5,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
            label: {
              text: m.headline || '',
              font: '400 11px "Microsoft YaHei", sans-serif',
              fillColor: Cesium.Color.WHITE,
              outlineColor: Cesium.Color.fromCssColorString('#0d1117'),
              outlineWidth: 2,
              style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
              pixelOffset: new Cesium.Cartesian2(0, -12),
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              showBackground: true,
              backgroundColor: Cesium.Color.fromCssColorString('#5a1a12').withAlpha(0.7),
              backgroundPadding: new Cesium.Cartesian2(4, 2),
              distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 6.0e6),
            },
          });
          n++;
        }
      }
    }

    return { n, dynasty: hit.dynasty, phase: hit.phase };
  }

  /** 世界历史城市点：按 inhabitedSince / inhabitedUntil 过滤当前年份仍存在的聚落 */
  async function renderPlaces(year, token) {
    if (!places) {
      try {
        const p = await fetchJSON(`${WORLD_BASE}/places.json`);
        places = p.places || [];
      } catch {
        places = [];
      }
    }
    if (token !== loadingToken || !state.enabled) return 0;
    let n = 0;
    for (const it of places) {
      const s = it.p.s;
      const u = it.p.u;
      if (typeof s === 'number' && year < s) continue;
      if (typeof u === 'number' && year > u) continue;
      if (!Array.isArray(it.c)) continue;
      ds.entities.add({
        name: it.p.n || '',
        position: Cesium.Cartesian3.fromDegrees(it.c[0], it.c[1]),
        _hist: { kind: 'place', name: it.p.n, since: s, until: u },
        point: {
          pixelSize: 6,
          color: Cesium.Color.fromCssColorString('#7fe3e8'),
          outlineColor: Cesium.Color.fromCssColorString('#0d1117'),
          outlineWidth: 1,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 8.0e6),
        },
        label: {
          text: it.p.n || '',
          font: '400 11px "Microsoft YaHei", sans-serif',
          fillColor: Cesium.Color.fromCssColorString('#cfefff'),
          outlineColor: Cesium.Color.fromCssColorString('#0d1117'),
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(0, -8),
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString('#123642').withAlpha(0.6),
          backgroundPadding: new Cesium.Cartesian2(4, 2),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 2.5e6),
        },
      });
      n++;
    }
    return n;
  }

  // ================= 主流程 =================

  async function rebuild() {
    const token = ++loadingToken;
    ds.entities.removeAll();
    if (!state.enabled) {
      ds.show = false;
      return;
    }
    ds.show = true;
    const y = state.year;
    let info = { year: y, world: null, china: null };
    try {
      const jobs = [];
      // 每个 job 在真正写数据源之前都要过一次 token 闸门（见 renderWorld / renderChina）
      if (state.world) {
        jobs.push(
          ensureWorldIndex().then(async () => {
            const r = await renderWorld(y, token);
            if (state.layers.places && r && r.n) {
              r.places = await renderPlaces(y, token);
            }
            return r;
          })
        );
      }
      if (state.china) {
        jobs.push(
          ensureChina().then(() => {
            const r = renderChina(y, token);
            return r || 0;
          })
        );
      }
      const res = await Promise.all(jobs);
      if (token !== loadingToken) return; // 已被更新的请求取代
      let wi = 0;
      if (state.world) info.world = res[wi++];
      if (state.china) info.china = res[wi++];
      onStatus(info);
    } catch (err) {
      if (token !== loadingToken) return;
      console.error('[history-atlas]', err);
      onStatus({ year: y, error: String(err && err.message ? err.message : err) });
    }
  }

  // ================= 悬停 / 点击 =================

  function describe(h) {
    if (!h) return '';
    if (h.kind === 'world') {
      const parts = [`${h.name}`];
      if (h.subjecto && h.subjecto !== h.name) parts.push(`属 ${h.subjecto}`);
      if (h.precision === 1) parts.push('边界模糊');
      else if (h.precision === 3) parts.push('法定边界');
      return parts.join(' · ');
    }
    if (h.kind === 'settlement') {
      return `${h.name}${h.modern ? `（今 ${h.modern}）` : ''}${h.capital ? ' · 都城' : ''}${h.remark ? ` · ${h.remark}` : ''}`;
    }
    if (h.kind === 'milestone') return `${h.year} · ${h.name}${h.site ? ` @ ${h.site}` : ''}`;
    if (h.kind === 'place') {
      const span = `${h.since ?? '?'} — ${h.until ?? '至今'}`;
      return `${h.name} · 存续 ${span}`;
    }
    if (h.kind === 'corridor') return h.name + (h.summary ? ` · ${h.summary}` : '');
    const kindText = { polity: '政权', region: '高层政区', prefecture: '府州' }[h.kind] || '';
    return `${h.name}${kindText ? ` · ${kindText}` : ''}${h.category ? `（${h.category}）` : ''}`;
  }

  // 取回一个实体 polygon 的真实底色（只认 Color，绝不信 getValue 的返回值形状）。
  // 优先用创建时存档的 _histFill；没有存档时再尝试从材质里「安全地」抽出 Color。
  function baseFillOf(ent) {
    if (ent._histFill && typeof ent._histFill.red === 'number') return ent._histFill;
    const m = ent.polygon && ent.polygon.material;
    if (!m) return null;
    try {
      if (typeof m.red === 'number') return Cesium.Color.clone(m, new Cesium.Color());
      const v = m.getValue ? m.getValue(viewer.clock.currentTime) : m;
      // ColorMaterialProperty 的 getValue 返回 {color: Color} —— 必须再取一层 .color
      const c = v && typeof v.red === 'number' ? v : (v && v.color);
      if (c && typeof c.red === 'number') return Cesium.Color.clone(c, new Cesium.Color());
    } catch { /* 材质形态异常，放弃恢复 */ }
    return null;
  }

  function clearHover() {
    const ent = hovered;
    hovered = null;
    if (!ent || !ent.polygon) return;
    try {
      const fill = baseFillOf(ent);
      if (fill) ent.polygon.material = Cesium.Color.clone(fill, new Cesium.Color());
      if (ent._histOutline && typeof ent._histOutline.red === 'number') {
        ent.polygon.outlineColor = Cesium.Color.clone(ent._histOutline, new Cesium.Color());
      }
      ent.polygon.outlineWidth = ent._histOutlineW ?? 2;
    } catch { /* 实体已被清空，忽略 */ }
  }

  function setHover(ent) {
    if (hovered === ent) return;
    clearHover();
    hovered = ent;
    if (ent && ent.polygon) {
      // 只赋 Cesium.Color（会被自动包成 ColorMaterialProperty），绝不赋材质对象
      ent.polygon.material = Cesium.Color.fromCssColorString('#ffd24a').withAlpha(0.5);
      ent.polygon.outlineColor = Cesium.Color.fromCssColorString('#ffd24a');
      ent.polygon.outlineWidth = 4;
    }
  }

  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((movement) => {
    if (!state.enabled || !ds.show) return;
    const picked = viewer.scene.pick(movement.endPosition);
    const ent = picked && Cesium.defined(picked.id) ? picked.id : null;
    const hist = ent && ent._hist ? ent._hist : null;
    if (!hist) {
      clearHover();
      onPick(null);
      return;
    }
    setHover(ent);
    onPick({ title: describe(hist), hist });
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  handler.setInputAction((click) => {
    if (!state.enabled || !ds.show) return;
    const picked = viewer.scene.pick(click.position);
    const ent = picked && Cesium.defined(picked.id) ? picked.id : null;
    const hist = ent && ent._hist ? ent._hist : null;
    if (!hist) return;
    onPick({ title: describe(hist), hist, flyTo: true });
    if (ent.polygon && ent.polygon.hierarchy) {
      try {
        const h = ent.polygon.hierarchy.getValue(viewer.clock.currentTime);
        const positions = h && h.positions ? h.positions : h;
        viewer.camera.flyToBoundingSphere(
          Cesium.BoundingSphere.fromPoints(positions),
          { duration: 1.2, offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-55), 0) }
        );
      } catch { /* 几何异常不打断交互 */ }
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  // ================= 对外 API =================

  return {
    get state() {
      return state;
    },
    setEnabled(on) {
      state.enabled = !!on;
      if (!on) {
        ds.entities.removeAll();
        ds.show = false;
      }
      return rebuild();
    },
    isEnabled: () => state.enabled,
    setYear(y) {
      state.year = Math.round(Number(y));
      return rebuild();
    },
    getYear: () => state.year,
    setWorld(on) {
      state.world = !!on;
      return rebuild();
    },
    setChina(on) {
      state.china = !!on;
      return rebuild();
    },
    setLayer(name, on) {
      if (!(name in state.layers)) return Promise.resolve();
      state.layers[name] = !!on;
      return rebuild();
    },
    setMaxFeatures(n) {
      state.maxFeatures = Number(n) || 0;
      return rebuild();
    },
    setClampGround(on) {
      state.clampGround = !!on;
      return rebuild();
    },
    /** 年份轴：世界快照档位 + 中国各阶段起始年，合并排序去重 */
    async getTimeline() {
      const marks = new Map();
      try {
        const idx = await ensureWorldIndex();
        for (const r of idx.years) marks.set(r.year, { year: r.year, world: true });
      } catch { /* 世界数据缺失不影响中国轴 */ }
      try {
        await ensureChina();
        if (chinaIndex) {
          for (const d of chinaIndex.dynasties) {
            for (const p of d.phases) {
              const cur = marks.get(p.from) || { year: p.from };
              cur.china = true;
              cur.dynasty = d.title;
              cur.overview = p.overview || null;
              marks.set(p.from, cur);
            }
          }
        }
      } catch { /* ignore */ }
      return [...marks.values()].sort((a, b) => a.year - b.year);
    },
    /** 用中国索引补全年份轴（真实实现在 mountHistoryPanel 里用 index.json） */
    async ensureIndexes() {
      const out = { world: null, china: null };
      try {
        out.world = await ensureWorldIndex();
      } catch (e) {
        out.worldError = String(e.message || e);
      }
      try {
        await ensureChina();
        out.china = chinaIndex;
      } catch (e) {
        out.chinaError = String(e.message || e);
      }
      return out;
    },
    phaseAtYear: (y) => phaseAt(y),
    /** 面板挂载后再注入 UI 回调（DOM 元素此时才存在） */
    setHandlers(h) {
      if (h.onStatus) onStatus = h.onStatus;
      if (h.onPick) onPick = h.onPick;
    },
    clear() {
      ds.entities.removeAll();
      ds.show = false;
    },
    destroy() {
      handler.destroy();
      viewer.dataSources.remove(ds, true);
    },
    get dataSource() {
      return ds;
    },
  };
}

/* =========================================================================
 * 侧栏面板：年份轴 + 双数据源开关 + 分层
 * 由 main.js 调一次 mountHistoryPanel(atlas, el) 完成挂载，DOM 全部在此构建。
 * ========================================================================= */

const LAYER_LABELS = [
  ['polity', '政权'],
  ['region', '高层政区（道/路/省）'],
  ['prefecture', '府州'],
  ['settlements', '历代城邑'],
  ['corridors', '长城/运河/丝路'],
  ['milestones', '历史事件点'],
  ['places', '世界历史城市（2220）'],
];

export async function mountHistoryPanel(atlas, root) {
  if (!root) return null;
  const st = atlas.state;

  root.innerHTML = `
    <div class="hist-row">
      <label class="hist-enable"><input type="checkbox" id="histEnable" /> 启用历史时空</label>
    </div>
    <div class="hist-yearbox">
      <div class="hist-year" id="histYear">—</div>
      <div class="hist-era" id="histEra">加载年份轴…</div>
    </div>
    <input type="range" id="histSlider" class="hist-slider" min="0" max="0" value="0" disabled />
    <div class="hist-row hist-play">
      <button class="secondary" id="histPrev" title="上一档">‹</button>
      <button class="secondary" id="histPlay" title="沿年份轴自动播放">▶ 播放</button>
      <button class="secondary" id="histNext" title="下一档">›</button>
    </div>
    <div class="hist-card hidden" id="histCard"></div>
    <div class="hist-src">
      <label title="historical-basemaps：54 个年份的世界国界快照"><input type="checkbox" id="histWorld" checked /> 世界国界</label>
      <label title="jiangshan-map：17 朝代 / 181 阶段的中国政区"><input type="checkbox" id="histChina" checked /> 中国历代疆域</label>
    </div>
    <details class="hist-layers">
      <summary>分层与密度</summary>
      <div class="hist-layer-grid" id="histLayerGrid"></div>
      <div class="hist-row">
        <label class="hist-inline">面数上限
          <select id="histDensity">
            <option value="300">精简 300</option>
            <option value="600" selected>标准 600</option>
            <option value="0">全部（可能卡）</option>
          </select>
        </label>
      </div>
      <label class="hist-inline" title="贴上按真实高程生成几何；垂直夸张 > 1× 时政区会沉到地形下面看不见，需先把夸张调回 1×">
        <input type="checkbox" id="histClamp" /> 政区贴合地形（夸张须为 1×）
      </label>
    </details>
    <div class="hist-status" id="histStatus"></div>
    <div class="hist-pick" id="histPick"></div>
    <p class="hint">一根年份轴驱动两套开源历史地图：世界国界（aourednik/historical-basemaps，前 123000 — 2010）
      与中国历代疆域（DeanChensj/jiangshan-map，前 403 — 1948，含政权/道州/府州三层、历代城邑与长城运河丝路）。
      边界均为示意级精度，非测绘国界。悬停看归属，点击面可飞到该政权。</p>
  `;

  const $ = (id) => root.querySelector('#' + id);
  // ⚠ 底部巡礼面板（#tourPanel 一族）在 root 之外，必须用文档级查询；
  //   2026-10-29 曾误用上面的 root 版 $() 导致 showEraPanel 静默 return（面板永远不出现）。
  const $d = (id) => document.getElementById(id);
  const elEnable = $('histEnable');
  const elSlider = $('histSlider');
  const elYear = $('histYear');
  const elEra = $('histEra');
  const elStatus = $('histStatus');
  const elPick = $('histPick');
  const elPlay = $('histPlay');

  // 分层勾选
  const grid = $('histLayerGrid');
  for (const [key, label] of LAYER_LABELS) {
    const lab = document.createElement('label');
    lab.className = 'hist-inline';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!st.layers[key];
    cb.addEventListener('change', () => atlas.setLayer(key, cb.checked));
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(label));
    grid.appendChild(lab);
  }

  let timeline = [];
  let timer = null;
  let playWindow = null; // 历史巡礼窗口 [fromIdx, toIdx]，null = 整条时间轴

  function stopPlay(opts) {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    playWindow = null;
    elPlay.textContent = '▶ 播放';
    elPlay.classList.remove('active');
    const card = $('histCard');
    if (card) card.classList.add('hidden');
    // 2026-10-30：keepPanel —— 面板已被探月任务占用，只停表不收面板
    if (eraPanelActive && !(opts && opts.keepPanel)) hideEraPanel();
  }

  function updateLabels() {
    const y = atlas.getYear();
    elYear.textContent = formatYear(y);
    const hit = atlas.phaseAtYear(y);
    if (hit) {
      elEra.textContent = `${hit.dynasty.title} · ${hit.phase.overview || `${formatYear(hit.phase.from)} — ${formatYear(hit.phase.to)}`}`;
    } else {
      elEra.textContent = y > 1948 ? '（中国史数据止于 1948 年）' : '（中国史数据始于前 403 年）';
    }
  }

  atlas.setHandlers({
    onStatus(info) {
      if (info.error) {
        elStatus.textContent = '数据加载失败：' + info.error;
        elStatus.classList.add('warn');
        return;
      }
      elStatus.classList.remove('warn');
      const parts = [];
      if (info.world && info.world.n) {
        const pc = info.world.places ? ` · ${info.world.places} 城` : '';
        parts.push(`世界 ${formatYear(info.world.snappedYear)} · ${info.world.n} 面${pc}`);
      }
      if (info.china && info.china.n) {
        parts.push(`${info.china.dynasty.title} · ${info.china.n} 要素`);
      }
      if (!parts.length) parts.push('当前年份无可用数据');
      elStatus.textContent = parts.join(' ｜ ');
      updateLabels();
    },
    onPick(p) {
      elPick.textContent = p ? p.title : '';
      elPick.classList.toggle('visible', !!p);
    },
  });

  elEnable.addEventListener('change', () => {
    if (!elEnable.checked) stopPlay();
    elsToggle(elEnable.checked);
    atlas.setEnabled(elEnable.checked).then(() => { rebuildTimeline().then(updateLabels); });
  });

  function elsToggle(on) {
    elSlider.disabled = !on;
    for (const id of ['histPrev', 'histPlay', 'histNext', 'histWorld', 'histChina', 'histDensity', 'histClamp']) {
      const e = $(id);
      if (e) e.disabled = !on;
    }
  }

  elSlider.addEventListener('input', () => {
    stopPlay();
    const t = timeline[Number(elSlider.value)];
    if (t) atlas.setYear(t.year);
  });

  $('histPrev').addEventListener('click', () => step(-1));
  $('histNext').addEventListener('click', () => step(1));

  function step(d) {
    stopPlay();
    const v = Math.min(timeline.length - 1, Math.max(0, Number(elSlider.value) + d));
    elSlider.value = String(v);
    const t = timeline[v];
    if (t) atlas.setYear(t.year);
  }

  // 历史巡礼节点卡：随播放/起播展示当前朝代 + 阶段 + 邻近里程碑
  function updateHistCard(year) {
    const card = $('histCard');
    if (!card) return;
    const hit = atlas.phaseAtYear(year);
    let html = '';
    if (hit) {
      html += `<div class="hc-title">${hit.dynasty.title}</div>`;
      const phaseTxt = hit.phase
        ? (hit.phase.overview || `${formatYear(hit.phase.from)} — ${formatYear(hit.phase.to)}`)
        : '';
      if (phaseTxt) html += `<div class="hc-phase">${phaseTxt}</div>`;
    }
    const ms = (window.DYNASTY_DATA || [])
      .flatMap((d) => d.milestones || [])
      .filter((m) => Math.abs((m.year || 0) - year) <= 2);
    if (ms.length) {
      html += `<div class="hc-ms">${ms.map((m) => `${m.year < 0 ? '前' + -m.year : m.year} ${m.headline || ''}`).join('；')}</div>`;
    }
    card.innerHTML = html;
    card.classList.toggle('hidden', !html);

    // 侧栏「历史时空」区块已移除（2026-10-29），节点卡改在底部巡礼面板的解说行里显示：
    // 标题 = 朝代，tag = 阶段区间，正文 = 该年 ±2 年内最接近的里程碑。
    if (eraPanelActive) {
      const sn = $d('stageNarration');
      if (sn) {
        const idxT = $d('snIdx');
        if (idxT) idxT.textContent = '史';
        const tEl = $d('snTitle');
        // 面板标题/年份已经各占一处，解说行只写朝代 + 阶段概述，避免「唐 · 657 年 657 年 — 657 年」式重复
        if (tEl) tEl.textContent = hit ? hit.dynasty.title : '历史';
        const tag = $d('snTag');
        if (tag) tag.textContent = '';
        const aEl = $d('snA');
        const bEl = $d('snB');
        if (aEl) aEl.textContent = hit?.dynasty?.seat ? `立都 ${hit.dynasty.seat}` : '';
        if (bEl) bEl.textContent = '';
        const tx = $d('snText');
        if (tx) {
          tx.textContent = ms.length
            ? ms.map((m) => `${m.year < 0 ? '前' + -m.year : m.year} ${m.headline || ''}`).join('；')
            : (hit?.phase?.overview || hit?.dynasty?.summary || '');
        }
        sn.classList.remove('hidden');
      }
    }
  }

  // ===== 历史巡礼：把年份轴接到最下面的统一巡礼面板（#tourPanel）=====
  // 用户 2026-10-29：历史也做成「巡礼类」，年份轴就是它的时间轴；与长征 / 天宫 / 探月共用同一条面板，
  // 谁起播谁接管（main.js 的 releasePanels 负责先把别的播放循环停掉，避免串台）。
  let eraPanelActive = false;
  let eraStartIdx = 0;
  let eraEndIdx = 0;
  let eraSpeed = 1;      // 播放倍率（0.5× / 1× / 2× / 4× / 8×）
  let eraDynasty = null; // 当前朝代（画里程碑刻度、写标题用）
  let eraBound = false;

  function eraEls() {
    return {
      panel: $d('tourPanel'), title: $d('tourTitle'), clock: $d('tourClock'),
      bar: $d('tourBar'), prog: $d('tourProgressText'),
      pause: $d('tourPause'), spd: $d('timeSpeedLabel'),
    };
  }

  function paintEraTicks() {
    const host = $d('tourTicks');
    if (!host) return;
    host.innerHTML = '';
    const span = Math.max(1, eraEndIdx - eraStartIdx);
    for (const m of (eraDynasty?.milestones || [])) {
      const idx = timeline.findIndex((t) => t.year >= m.year);
      if (idx < eraStartIdx || idx > eraEndIdx) continue;
      const dot = document.createElement('span');
      dot.className = 'tour-tick tour-tick-note';
      dot.style.cssText = 'position:absolute;top:-5px;width:9px;height:9px;border-radius:50%;'
        + 'background:#ffe08a;border:1px solid rgba(0,0,0,.6);transform:translateX(-50%);cursor:pointer;z-index:3;';
      dot.style.left = `${(((idx - eraStartIdx) / span) * 100).toFixed(2)}%`;
      dot.title = `${m.year < 0 ? '前' + -m.year : m.year} ${m.headline || ''}`;
      dot.addEventListener('click', (ev) => { ev.stopPropagation(); if (timer) stopPlay(); setEraIdx(idx); });
      host.appendChild(dot);
    }
  }

  function syncEraPanel() {
    if (!eraPanelActive) return;
    const e = eraEls();
    if (!e.panel) return;
    const span = Math.max(1, eraEndIdx - eraStartIdx);
    const k = Math.min(Math.max(0, Number(elSlider.value) - eraStartIdx), span);
    if (e.bar) e.bar.style.width = `${((k / span) * 100).toFixed(2)}%`;
    const y = atlas.getYear();
    if (e.prog) e.prog.textContent = `${formatYear(y)} · ${k + 1}/${span + 1}`;
    if (e.clock) e.clock.textContent = formatYear(y);
    if (e.pause) e.pause.textContent = timer ? '暂停' : '播放';
    if (e.spd) e.spd.textContent = `${eraSpeed}×`;
  }

  function setEraIdx(idx) {
    const v = Math.min(eraEndIdx, Math.max(eraStartIdx, idx));
    elSlider.value = String(v);
    const t = timeline[v];
    if (t) atlas.setYear(t.year);
    updateHistCard(t ? t.year : atlas.getYear());
    syncEraPanel();
  }

  function eraSeekFromEvent(ev) {
    const track = $d('tourTrack');
    if (!track) return;
    const r = track.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (ev.clientX - r.left) / Math.max(1, r.width)));
    setEraIdx(Math.round(eraStartIdx + ratio * (eraEndIdx - eraStartIdx)));
  }

  function onEraDown(ev) {
    ev.preventDefault();
    eraSeekFromEvent(ev);
    window.addEventListener('pointermove', onEraMove);
    window.addEventListener('pointerup', onEraUp, { once: true });
  }
  function onEraMove(ev) { eraSeekFromEvent(ev); }
  function onEraUp() { window.removeEventListener('pointermove', onEraMove); }

  // 「暂停」只停计时器，面板继续留在屏幕上（年/阶段/里程碑仍可读）；
  //   ⚠ 不能走 stopPlay()：那个函数会顺带把面板收起来并解绑控件（曾导致暂停后面板消失、停止按钮失灵）。
  function onEraPause() {
    if (timer) {
      clearInterval(timer);
      timer = null;
      elPlay.textContent = '▶ 播放';
      elPlay.classList.remove('active');
      syncEraPanel();
    } else {
      // 已经播到区间末（或用户拖到末帧）→ 再按「播放」从区间头重播，否则一帧就被判结束
      if (eraPanelActive && Number(elSlider.value) >= eraEndIdx) setEraIdx(eraStartIdx);
      startPlay();
    }
  }
  // 「停止」= 停播 + 关掉历史疆域图层（行也随之置灰）；只想暂停保留地图请按「暂停」
  function onEraStop() {
    if (timer) stopPlay(); else hideEraPanel();
    if (elEnable) elEnable.checked = false;
    atlas.setEnabled(false).catch(() => {});
    window.dispatchEvent(new CustomEvent('history-tour-stopped'));
  }
  function onEraSlower() { applyEraSpeed(eraSpeed / 2); }
  function onEraFaster() { applyEraSpeed(eraSpeed * 2); }
  function applyEraSpeed(next) {
    eraSpeed = Math.min(8, Math.max(0.5, next));
    if (timer) { clearInterval(timer); timer = null; startPlay(); }
    syncEraPanel();
  }

  function bindEraControls() {
    if (eraBound) return;
    eraBound = true;
    $d('tourTrack')?.addEventListener('pointerdown', onEraDown);
    $d('tourPause')?.addEventListener('click', onEraPause);
    $d('tourStop')?.addEventListener('click', onEraStop);
    $d('timeSlower')?.addEventListener('click', onEraSlower);
    $d('timeFaster')?.addEventListener('click', onEraFaster);
  }
  function unbindEraControls() {
    if (!eraBound) return;
    eraBound = false;
    $d('tourTrack')?.removeEventListener('pointerdown', onEraDown);
    $d('tourPause')?.removeEventListener('click', onEraPause);
    $d('tourStop')?.removeEventListener('click', onEraStop);
    $d('timeSlower')?.removeEventListener('click', onEraSlower);
    $d('timeFaster')?.removeEventListener('click', onEraFaster);
  }

  function showEraPanel() {
    const e = eraEls();
    if (!e.panel) return;
    eraPanelActive = true;
    e.panel.classList.remove('hidden');
    if (e.title) e.title.textContent = eraDynasty ? `历史时间轴 · ${eraDynasty.title}` : '历史时间轴';
    // 其它模式专属控件一律收起（面板是共用的，长征/探月/天宫的按钮不能留在历史模式里）
    // 注意 stageNarration 不在此列：历史模式要用它显示「朝代 · 阶段 · 里程碑」解说。
    for (const id of ['flyControls', 'rocketControls', 'btnLaunch', 'rocketPhase']) {
      $(id)?.classList.add('hidden');
    }
    $d('tourFollow')?.classList.add('hidden');
    e.pause?.classList.remove('hidden');
    bindEraControls();
    paintEraTicks();
    updateHistCard(atlas.getYear());
    syncEraPanel();
  }

  function hideEraPanel() {
    eraPanelActive = false;
    const e = eraEls();
    if (e.panel) e.panel.classList.add('hidden');
    const ticks = $d('tourTicks');
    if (ticks) ticks.innerHTML = '';
    unbindEraControls();
  }

  // 朝代区间播到头：只停计时器，面板留在末年那一帧（用户 2026-10-29 反馈：播完面板整条消失，
  //   读作「一直播不停、最后啥也没留下」。这里与路线巡礼的落点一致——停住、留住画面）。
  function endEraPlayback() {
    if (timer) { clearInterval(timer); timer = null; }
    elPlay.textContent = '▶ 播放';
    elPlay.classList.remove('active');
    syncEraPanel();
    updateHistCard(atlas.getYear());
  }

  function startPlay() {
    elPlay.textContent = '⏸ 暂停';
    elPlay.classList.add('active');
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      const v = Number(elSlider.value) + 1;
      const end = playWindow ? playWindow[1] : timeline.length - 1;
      // ⚠ 用 > end：原来写 >= end 会永远看不到区间最后一帧（朝代末年那一档）
      if (v > end) { endEraPlayback(); return; }
      setEraIdx(v);
    }, Math.round(900 / eraSpeed));
    syncEraPanel();
  }

  // 侧栏「▶ 播放」已随「历史时空」区块藏起来，这里保留逻辑以兼容旧调用（走整条时间轴）
  elPlay.addEventListener('click', () => {
    if (timer) { stopPlay(); return; }
    playWindow = null;
    startPlay();
  });

  // 年份轴重建（启用后或起播前，确保中国阶段标记已就位）
  async function rebuildTimeline() {
    timeline = await atlas.getTimeline();
    window.historyTimeline = timeline;
    if (timeline.length) {
      elSlider.max = String(timeline.length - 1);
      let idx = timeline.findIndex((t) => t.year >= atlas.getYear());
      if (idx < 0) idx = timeline.length - 1;
      elSlider.value = String(idx);
    }
  }

  // 由统一检索栏调用：启用 atlas → 跳到某朝代（或某里程碑年）并自动播放该朝时间巡礼
  window.__historyStartEraTour = async (key, focusYear) => {
    if (!atlas.isEnabled()) await atlas.setEnabled(true);
    // UI 与真实状态对齐：检索栏起播时用户没勾过「启用」，否则会看到「未勾选却在放」的矛盾态
    if (elEnable && !elEnable.checked) {
      elEnable.checked = true;
      elsToggle(true);
    }
    await rebuildTimeline();
    const D = window.DYNASTY_DATA || [];
    const d = D.find((x) => x.key === key);
    if (!d) { console.warn('[history] 未找到朝代', key); return; }
    const fromIdx = timeline.findIndex((t) => t.year >= d.fromYear);
    if (fromIdx < 0) return;
    let startIdx = fromIdx;
    if (focusYear != null) {
      const fi = timeline.findIndex((t) => t.year >= focusYear);
      if (fi >= 0) startIdx = Math.max(fromIdx, fi);
    }
    let toIdx = timeline.length - 1;
    for (let k = timeline.length - 1; k >= 0; k--) {
      if (timeline[k].year <= d.toYear) { toIdx = k; break; }
    }
    if (timer) stopPlay();
    eraDynasty = d;
    eraStartIdx = startIdx;
    eraEndIdx = Math.max(startIdx, toIdx);
    eraSpeed = 1;
    playWindow = [eraStartIdx, eraEndIdx];
    showEraPanel();
    // ⭐ 2026-10-29 用户第 5 点：点「唐」应当**落在唐**（焦点年，一般取盛期），而不是把
    //   618→907 共 22 帧一路播完（≈20 秒），更不是播完把面板收掉——那和「点腊子口却重走全程」是同一个病。
    //   所以这里只定位、不自动 startPlay；用户想走一遍该朝时间轴再按面板的「播放」。
    const landYear = focusYear != null
      ? focusYear
      : (d.focusYear != null ? d.focusYear : d.fromYear);
    let landIdx = timeline.findIndex((t) => t.year >= landYear);
    landIdx = landIdx < 0 ? eraEndIdx : Math.min(eraEndIdx, Math.max(eraStartIdx, landIdx));
    setEraIdx(landIdx);
  };

  // 外部（显示图层关掉历史项、切月球/火星、起长征巡礼）统一调这个停历史巡礼
  // ⭐ 2026-10-30：keepPanel=true 表示「只停表，不收面板」——探月任务第三/四幕在月球容器里
  //   演出时正占用这块共用的 #tourPanel（enterMoonMode 会 releasePanels），历史这边只能停
  //   自己的计时器，绝不能把面板 hidden 掉、也不能清空 ticks（否则第三幕时间轴整条消失）。
  window.__historyStopTour = (opts) => {
    if (timer) stopPlay(opts);
    else if (!(opts && opts.keepPanel)) hideEraPanel();
  };

  $('histWorld').addEventListener('change', (e) => atlas.setWorld(e.target.checked));
  $('histChina').addEventListener('change', (e) => atlas.setChina(e.target.checked));
  $('histDensity').addEventListener('change', (e) => atlas.setMaxFeatures(e.target.value));
  $('histClamp').addEventListener('change', (e) => atlas.setClampGround(e.target.checked));

  // 年份轴：世界档位 + 中国阶段起点，合并去重
  timeline = await atlas.getTimeline();
  if (timeline.length) {
    elSlider.max = String(timeline.length - 1);
    // 默认落在 1900 年附近（两套数据同时可见，最直观）
    let idx = timeline.findIndex((t) => t.year >= 1900);
    if (idx < 0) idx = timeline.length - 1;
    elSlider.value = String(idx);
    atlas.state.year = timeline[idx].year;
  }
  elsToggle(false);
  updateLabels();
  // 调试/冒烟导出（与 window.viewer、window.renderer 同一套约定）
  window.historyAtlas = atlas;
  window.historyTimeline = timeline;
  return { timeline, stopPlay };
}
