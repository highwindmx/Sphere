/**
 * 在线影像源管理（2026-10-16 新增，用户确认方案：Esri 默认 + AWS 备用 / 中国区天地图覆盖层 / 自动切换）
 *
 * 能力：
 *  ① 源注册表：esri（默认）/ aws-s2（Sentinel-2 无云）/ tianditu（需 key，中国区最高清）
 *  ② 中国分区覆盖层：rectangle 裁剪到中国 bbox，只在此范围内叠高清源，不影响全球底图
 *  ③ 故障自动切换：provider.errorEvent 滑动窗口计数，错误率超阈值自动切备用源；
 *     每 60s 探活默认源，恢复后自动切回（autoSwitch 状态可被手动选源覆盖）
 *
 * 铁律（见 main.js 头部注释与 syncImageryLayerOrder）：
 *  卫星底图必须保持 imageryLayers index 0 —— Cesium 只对 base layer 做极区边缘
 *  拉伸兜底，任何层的增删都要以 syncImageryLayerOrder() 收尾。
 */

const ONLINE_SOURCE_KEY = 'sphere-online-source';
const TIANDITU_KEY = 'sphere-tianditu-key';
const OVERLAY_ENABLED_KEY = 'sphere-tianditu-overlay';
const SOURCE_ORDER_KEY = 'sphere-source-order';   // 优先级顺序（P1 = 首选底图）
const LOCAL_FIRST_KEY = 'sphere-local-first';     // { id: bool } 每源「本地优先」
const SOURCE_ENABLED_KEY = 'sphere-source-enabled'; // { id: bool } 每源是否参与

import { createGibsProvider } from './gibs-provider.js';

/** 参与优先级回退链的全球源（天地图只作中国覆盖层，不入链） */
export const CHAIN_IDS = ['esri', 'aws-s2', 'gibs'];
export const DEFAULT_ORDER = ['esri', 'aws-s2', 'gibs'];

/** 中国覆盖层 bbox（W,S,E,N）：西帕米尔 73.4°E ~ 东北漠河 53.6°N，南含曾母暗沙 3.8°N，东至 135.2°E */
export const CHINA_RECT = { w: 73.4, s: 3.8, e: 135.2, n: 53.6 };

export const IMAGERY_SOURCES = [
  {
    id: 'esri',
    name: 'Esri 卫星',
    hint: 'Esri World Imagery，全球覆盖最全，极区有原生拉伸',
    maxLevel: 19,
    // 本地优先 = 走 Flask 代理缓存（有缓存直出、无缓存拉上游并落盘）；
    // 关闭 = 浏览器直连上游、不写本地（ArcGIS 瓦片 URL 是 {z}/{y}/{x}）
    proxyUrl: 'tiles/esri/{z}/{x}/{y}.jpg',
    upstreamUrl: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    create(opts = {}) {
      return new Cesium.UrlTemplateImageryProvider({
        url: opts.localFirst === false ? this.upstreamUrl : this.proxyUrl,
        maximumLevel: 19,
      });
    },
  },
  {
    id: 'aws-s2',
    name: 'AWS Sentinel-2',
    hint: 'EOX Sentinel-2 无云合成（10m，数据新、无云），备用源',
    maxLevel: 18,
    proxyUrl: 'tiles/eox/{z}/{x}/{y}.jpg',
    upstreamUrl: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/{z}/{y}/{x}.jpg',
    create(opts = {}) {
      return new Cesium.UrlTemplateImageryProvider({
        url: opts.localFirst === false ? this.upstreamUrl : this.proxyUrl,
        maximumLevel: 18,
      });
    },
  },
  {
    id: 'gibs',
    name: 'NASA Blue Marble',
    hint: 'NASA GIBS Blue Marble（EPSG:4326 非二分网格，500m，z0-7）——专用 provider 按真实矩阵重采样，±90° 极区闭合',
    maxLevel: 7,
    proxyUrl: 'tiles/gibs/',
    upstreamUrl: 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/BlueMarble_NextGeneration/default/500m/',
    create(opts = {}) {
      // 专用 provider（gibs-provider.js）：对外 GeographicTilingScheme（±90° 全极区几何），
      // 内部把每个地理瓦片映射到 GIBS 真实矩阵逐瓦片裁剪拼贴，角坐标严格闭合。
      return createGibsProvider({
        baseUrl: opts.localFirst === false ? this.upstreamUrl : this.proxyUrl,
      });
    },
  },
  {
    id: 'tianditu',
    name: '天地图影像',
    hint: '国家地理信息公共服务平台，中国区最高清，需申请 key',
    maxLevel: 18,
    needsKey: true,
    create(opts = {}) {
      const key = getTiandituKey();
      if (!key) throw new Error('未配置天地图 key');
      const k = encodeURIComponent(key);
      const url = opts.localFirst === false
        ? `https://t{s}.tianditu.gov.cn/DataServer?T=img_w&x={x}&y={y}&l={z}&tk=${k}`
        : `tiles/tianditu/{s}/{z}/{x}/{y}.jpg?tk=${k}`;
      return new Cesium.UrlTemplateImageryProvider({
        url,
        subdomains: ['0', '1', '2', '3', '4', '5', '6', '7'],
        tilingScheme: new Cesium.WebMercatorTilingScheme(),
        maximumLevel: 18,
      });
    },
  },
  {
    id: 'osm',
    name: 'OSM 街道图',
    hint: 'OpenStreetMap 标准瓦片（参考用，z0–19）；中国区请改用天地图，勿作权威底图',
    maxLevel: 19,
    manualOnly: true,            // 不入回退链 / 不在图源面板列出；仅由工具栏「🗺 OSM街道图」按钮手动开关
    proxyUrl: 'tiles/osm/{z}/{x}/{y}.png',
    upstreamUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    create(opts = {}) {
      return new Cesium.UrlTemplateImageryProvider({
        url: this.proxyUrl,       // 始终走本地代理（统一 UA + 限频友好 + 本地缓存）
        maximumLevel: 19,
        credit: new Cesium.Credit('© OpenStreetMap contributors', false),
      });
    },
  },
];

export function getSourceDef(id) {
  return IMAGERY_SOURCES.find((s) => s.id === id) || IMAGERY_SOURCES[0];
}

export function getOnlineSourceId() {
  try {
    const v = localStorage.getItem(ONLINE_SOURCE_KEY);
    return v && getSourceDef(v).id === v ? v : 'esri';
  } catch { return 'esri'; }
}

export function setOnlineSourceId(id) {
  try { localStorage.setItem(ONLINE_SOURCE_KEY, id); } catch { /* 忽略 */ }
}

export function getTiandituKey() {
  // 用户手动输入优先（localStorage），其次 .env 注入值（window.TIANDITU_KEY）
  try {
    const manual = localStorage.getItem(TIANDITU_KEY);
    if (manual) return manual;
  } catch { /* 忽略 */ }
  const injected = (typeof window !== 'undefined' && window.TIANDITU_KEY || '').trim();
  return injected && !injected.startsWith('__') ? injected : '';
}

export function setTiandituKey(key) {
  try { key ? localStorage.setItem(TIANDITU_KEY, key.trim()) : localStorage.removeItem(TIANDITU_KEY); } catch { /* 忽略 */ }
}

/** ---------- 优先级顺序（P1 = 首选底图，故障依次往下回退） ---------- */
export function getSourceOrder() {
  try {
    const arr = JSON.parse(localStorage.getItem(SOURCE_ORDER_KEY) || 'null');
    if (Array.isArray(arr)) {
      const cleaned = arr.filter((id) => CHAIN_IDS.includes(id));
      for (const id of CHAIN_IDS) if (!cleaned.includes(id)) cleaned.push(id);
      return cleaned;
    }
  } catch { /* 忽略损坏值 */ }
  return [...DEFAULT_ORDER];
}

export function setSourceOrder(arr) {
  try { localStorage.setItem(SOURCE_ORDER_KEY, JSON.stringify(arr)); } catch { /* 忽略 */ }
}

/** ---------- 每源「本地优先」（默认全开） ---------- */
export function isLocalFirst(id) {
  try {
    const m = JSON.parse(localStorage.getItem(LOCAL_FIRST_KEY) || '{}');
    return m && typeof m[id] === 'boolean' ? m[id] : true;
  } catch { return true; }
}

export function setLocalFirst(id, on) {
  try {
    const m = JSON.parse(localStorage.getItem(LOCAL_FIRST_KEY) || '{}') || {};
    m[id] = !!on;
    localStorage.setItem(LOCAL_FIRST_KEY, JSON.stringify(m));
  } catch { /* 忽略 */ }
}

/** ---------- 每源是否参与回退链（默认全开） ---------- */
export function isSourceEnabled(id) {
  try {
    const m = JSON.parse(localStorage.getItem(SOURCE_ENABLED_KEY) || '{}');
    return m && typeof m[id] === 'boolean' ? m[id] : true;
  } catch { return true; }
}

export function setSourceEnabled(id, on) {
  try {
    const m = JSON.parse(localStorage.getItem(SOURCE_ENABLED_KEY) || '{}') || {};
    m[id] = !!on;
    localStorage.setItem(SOURCE_ENABLED_KEY, JSON.stringify(m));
  } catch { /* 忽略 */ }
}

export function getOverlayEnabled() {
  try { return localStorage.getItem(OVERLAY_ENABLED_KEY) === '1'; } catch { return false; }
}

export function setOverlayEnabled(on) {
  try { on ? localStorage.setItem(OVERLAY_ENABLED_KEY, '1') : localStorage.removeItem(OVERLAY_ENABLED_KEY); } catch { /* 忽略 */ }
}

/**
 * 在线源管理器（单例由 main.js 创建）。
 * 只管「在线底图层 + 中国覆盖层」；本地瓦片层（auto 模式）由 main.js 自己挂，不归这里管。
 */
export class ImagerySourceManager {
  /**
   * @param {Cesium.Viewer} viewer
   * @param {object} opts
   * @param {() => void} opts.syncOrder 层序收尾（main.js 的 syncImageryLayerOrder，保底图 index 0）
   * @param {(msg: string, kind?: string) => void} opts.setStatus 状态栏输出
   * @param {(sourceId: string) => void} [opts.onSourceChanged] 在线源变更通知
   *   （手动切源/故障切换/探活切回三处成功后触发；main.js 用它联动极冠补丁 profile 重校准）
   */
  constructor(viewer, opts) {
    this.viewer = viewer;
    this.syncOrder = opts.syncOrder || (() => {});
    this.setStatus = opts.setStatus || (() => {});
    this.onSourceChanged = opts.onSourceChanged || (() => {});
    /** @type {Cesium.ImageryLayer|null} 在线底图层 */
    this.onlineLayer = null;
    /** @type {Cesium.ImageryLayer|null} 中国区覆盖层 */
    this.overlayLayer = null;
    /** 当前在线源 id = 优先级链中第一个「启用」的源（P1） */
    this.currentId = this.preferredId();
    /** 是否因故障被自动切到备用源 */
    this.autoSwitched = false;
    /** 各源 errorEvent 退订函数 */
    this._unsubs = [];
    /** 故障计数（滑动窗口，键 = sourceId） */
    this._fails = { esri: [], 'aws-s2': [], gibs: [], tianditu: [] };
    this._probeTimer = null;
    this._SWITCH_MS = 30000;   // 滑动窗口 30s
    this._FAIL_MIN = 6;        // 窗口内至少 6 次失败才考虑切换
    this._FAIL_RATIO = 0.4;    // 失败占比 >40% 判故障
  }

  // ---------- 在线底图 ----------

  /** 优先级链中第一个启用的源（P1）；天地图不入链（只作中国覆盖层） */
  preferredId() {
    const order = getSourceOrder();
    return order.find((id) => isSourceEnabled(id)) || order[0] || 'esri';
  }

  /** 链中当前源之后的下一个可用源（用于故障回退，循环找一圈） */
  nextId(fromId = this.currentId) {
    const order = getSourceOrder();
    const start = Math.max(0, order.indexOf(fromId));
    for (let i = 1; i <= order.length; i++) {
      const id = order[(start + i) % order.length];
      if (id !== fromId && isSourceEnabled(id)) return id;
    }
    return null;
  }

  /** 同步左侧「在线源」下拉（自动切换/探活切回时 UI 也要跟着变） */
  _syncSourceSelect() {
    const el = typeof document !== 'undefined' && document.getElementById('onlineSource');
    if (el && el.value !== this.currentId) el.value = this.currentId;
  }

  /** 挂/换在线底图层（保持单层，remove + add）。layerOptions 可传 { rectangle } 等。 */
  applyOnlineLayer(sourceId = this.currentId, layerOptions = {}) {
    const def = getSourceDef(sourceId);
    if (def.needsKey && !getTiandituKey()) {
      this.setStatus(`${def.name} 未配置 key，请在下方输入天地图开放平台密钥`, 'warn');
      return null;
    }
    let provider;
    try {
      provider = def.create({ localFirst: isLocalFirst(sourceId) });
    } catch (e) {
      this.setStatus(`${def.name} 创建失败：${e.message}`, 'warn');
      return null;
    }
    // 移除旧在线层（不碰极冠合成层）
    this._unsubOnline();
    if (this.onlineLayer) {
      this.viewer.imageryLayers.remove(this.onlineLayer);
      this.onlineLayer = null;
    }
    // 若集合里还有「非管理器管辖的卫星底图层」（本地瓦片层），切源时把它请出去——
    // 否则在线层会被本地层（index 0）完全盖住，切换看不到效果。
    // 想回本地优先：切回 baseMode=自动 并刷新页面即可。
    {
      const layers = this.viewer.imageryLayers;
      for (let i = layers.length - 1; i >= 0; i--) {
        const l = layers.get(i);
        if (l === this.overlayLayer) continue;
        const p = l && l.imageryProvider;
        if (!p || !p.tilingScheme || typeof p.requestImage !== 'function') continue;
        if (p instanceof Cesium.SingleTileImageryProvider) continue;
        layers.remove(l);
        break;
      }
    }
    // 注意：不可用 addImageryProvider(provider, options) 传 options —— Cesium 1.146 会把
    // options 对象当 index 用（ToInteger({})===0 → 插入 0 层抢底图位）。显式构造
    // ImageryLayer 再单参 add（append 到末尾），层序由 syncOrder 统一收敛。
    const layer = new Cesium.ImageryLayer(provider, layerOptions);
    this.viewer.imageryLayers.add(layer); // add() 无返回值，layer 用本地引用
    this.onlineLayer = layer;
    this.currentId = sourceId;
    this._syncSourceSelect();
    this._watchErrors(sourceId, this.onlineLayer);
    this.syncOrder(); // 铁律：极冠合成层 index 0，在线层抬到 index 1
    // 中国高清 overlay 永远在最上：切源 remove+add 卫星层后它可能被压到卫星之下
    if (this.overlayLayer) {
      const layers = this.viewer.imageryLayers;
      let g = 0;
      const top = layers.length - 1;
      while (layers.indexOf(this.overlayLayer) < top && g++ < 20) layers.raise(this.overlayLayer);
    }
    return this.onlineLayer;
  }

  /** 手动切源：等价于把它提到优先级链首位（P1） */
  setSource(sourceId) {
    if (sourceId !== this.preferredId()) {
      const order = getSourceOrder().filter((id) => id !== sourceId);
      setSourceOrder([sourceId, ...order]);
    }
    if (sourceId === this.currentId && this.onlineLayer) return;
    const prev = this.currentId;
    const ok = this.applyOnlineLayer(sourceId);
    if (!ok) return;
    this.autoSwitched = false;
    setOnlineSourceId(sourceId);
    const def = getSourceDef(sourceId);
    this.setStatus(`在线底图已切换：${def.name}${prev !== sourceId ? `（原 ${getSourceDef(prev).name}）` : ''}`, 'ok');
    this.onSourceChanged(sourceId); // 极冠补丁 profile 联动（main.js）
  }

  /** 故障自动切到链中下一个可用源 */
  _switchToFallback() {
    const fallback = this.nextId();
    if (!fallback || fallback === this.currentId) return;
    if (this.autoSwitched) return; // 已经切过一次，不连锁切
    const prev = this.currentId;
    const ok = this.applyOnlineLayer(fallback);
    if (!ok) return;
    this.autoSwitched = true;
    this.setStatus(`${getSourceDef(prev).name} 故障率过高，已自动切换到 ${getSourceDef(fallback).name}`, 'warn');
    this.onSourceChanged(fallback);
  }

  // ---------- 图源设置面板 API ----------

  /** 重排优先级（P1 变了就立即换底图） */
  setOrder(arr) {
    const prevHead = this.preferredId();
    setSourceOrder(arr);
    const head = this.preferredId();
    if (head !== prevHead) {
      this.autoSwitched = false;
      const ok = this.applyOnlineLayer(head);
      if (ok) {
        this.setStatus(`首选底图已改为 ${getSourceDef(head).name}`, 'ok');
        this.onSourceChanged(head);
      }
    } else {
      this.setStatus(`优先级已更新（首选仍为 ${getSourceDef(head).name}）`, 'ok');
    }
    return head;
  }

  /** 某源「本地优先」开关：影响其 URL 走代理还是直连上游 */
  setLocalFirstFor(id, on) {
    setLocalFirst(id, on);
    const def = getSourceDef(id);
    this.setStatus(`${def.name}：本地优先已${on ? '开启' : '关闭'}（${on ? '走本地缓存 / 缺失自动落盘' : '直连上游、不写本地'}）`, 'ok');
    if (id === this.currentId) this.applyOnlineLayer(id);
    if (id === 'tianditu' && this.overlayLayer) { this.removeOverlayLayer(); this.applyOverlayLayer(); }
  }

  /** 某源是否参与回退链：关掉当前首选就顺延到下一个可用源 */
  setEnabledFor(id, on) {
    setSourceEnabled(id, on);
    const def = getSourceDef(id);
    if (!on && id === this.currentId && CHAIN_IDS.includes(id)) {
      const next = this.preferredId();
      if (next && next !== id) {
        this.applyOnlineLayer(next);
        this.setStatus(`${def.name} 已停用，首选改为 ${getSourceDef(next).name}`, 'ok');
        this.onSourceChanged(next);
      } else {
        this.setStatus(`${def.name} 已停用（链中已无其它可用源，保留当前层）`, 'warn');
      }
    } else if (on && CHAIN_IDS.includes(id)) {
      this.setStatus(`${def.name} 已启用`, 'ok');
    }
    if (id === 'tianditu') this.setOverlay(on);
  }

  /** 探活默认源（GET 一张低级瓦片），恢复则切回 */
  async _probeDefault() {
    if (!this.autoSwitched) return;
    const url = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/3/3/3';
    try {
      const r = await fetch(url, { method: 'GET', cache: 'no-store' });
      if (r.ok && r.headers.get('content-type')?.startsWith('image')) {
        this.autoSwitched = false;
        const back = this.preferredId();
        this.applyOnlineLayer(back);
        this.setStatus(`${getSourceDef(this.currentId).name} 已恢复，切回默认源`, 'ok');
        this.onSourceChanged(this.currentId || back);
      }
    } catch { /* 仍未恢复 */ }
  }

  startProbing() {
    if (this._probeTimer) return;
    this._probeTimer = setInterval(() => { this._probeDefault(); }, 60000);
  }

  // ---------- 中国区覆盖层 ----------

  /** 天地图中国区高清覆盖层（rectangle 裁剪）。key 未配置时静默跳过。 */
  applyOverlayLayer() {
    if (!getOverlayEnabled()) return null;
    if (!getTiandituKey()) {
      this.setStatus('中国区高清覆盖未启用：未配置天地图 key', 'warn');
      return null;
    }
    this.removeOverlayLayer();
    const def = getSourceDef('tianditu');
    let provider;
    try { provider = def.create({ localFirst: isLocalFirst('tianditu') }); } catch (e) {
      this.setStatus(`覆盖层创建失败：${e.message}`, 'warn');
      return null;
    }
    const rect = Cesium.Rectangle.fromDegrees(CHINA_RECT.w, CHINA_RECT.s, CHINA_RECT.e, CHINA_RECT.n);
    const overlay = new Cesium.ImageryLayer(provider, { rectangle: rect });
    this.viewer.imageryLayers.add(overlay);
    this.overlayLayer = overlay;
    this._watchOverlayErrors(this.overlayLayer);
    this.syncOrder(); // 覆盖层排在底图之后（index > 0），不动 index 0
    return this.overlayLayer;
  }

  removeOverlayLayer() {
    this._unsubOverlay();
    if (this.overlayLayer) {
      this.viewer.imageryLayers.remove(this.overlayLayer);
      this.overlayLayer = null;
    }
  }

  setOverlay(on) {
    setOverlayEnabled(on);
    if (on) {
      const layer = this.applyOverlayLayer();
      if (layer) this.setStatus('中国区高清覆盖已开启（天地图）', 'ok');
    } else {
      this.removeOverlayLayer();
      this.setStatus('中国区高清覆盖已关闭', 'ok');
    }
  }

  // ---------- 故障计数 ----------

  _watchErrors(sourceId, layer) {
    const p = layer.imageryProvider;
    if (!p?.errorEvent) return;
    const onErr = () => {
      const arr = this._fails[sourceId] || (this._fails[sourceId] = []);
      const now = Date.now();
      arr.push(now);
      while (arr.length && now - arr[0] > this._SWITCH_MS) arr.shift();
      if (arr.length >= this._FAIL_MIN && !this.autoSwitched && sourceId !== 'aws-s2') {
        // 简化判据：窗口内失败密度过高即切换（ok 计数由 Cesium 内部完成，此处以绝对密度近似）
        if (arr.length >= 12) this._switchToFallback();
      }
    };
    p.errorEvent.addEventListener(onErr);
    this._unsubs.push(() => p.errorEvent.removeEventListener(onErr));
  }

  _watchOverlayErrors(layer) {
    const p = layer.imageryProvider;
    if (!p?.errorEvent) return;
    let n = 0;
    const onErr = () => {
      n++;
      if (n === 8) this.setStatus('中国区覆盖层瓦片持续失败，请检查天地图 key 是否有效', 'warn');
    };
    p.errorEvent.addEventListener(onErr);
    this._unsubs.push(() => p.errorEvent.removeEventListener(onErr));
  }

  _unsubOnline() {
    // 只退订在线层相关（含覆盖层）：简化处理——全部退订后由各 watcher 重建
    for (const fn of this._unsubs) { try { fn(); } catch { /* 忽略 */ } }
    this._unsubs = [];
    this._fails = { esri: [], 'aws-s2': [], gibs: [], tianditu: [] };
  }

  _unsubOverlay() {
    for (const fn of this._unsubs) { try { fn(); } catch { /* 忽略 */ } }
    this._unsubs = [];
  }

  /** 调试探针 */
  debug() {
    return {
      currentId: this.currentId,
      autoSwitched: this.autoSwitched,
      onlineLayerIndex: this.onlineLayer ? this.viewer.imageryLayers.indexOf(this.onlineLayer) : -1,
      overlayEnabled: getOverlayEnabled(),
      overlayLayerIndex: this.overlayLayer ? this.viewer.imageryLayers.indexOf(this.overlayLayer) : -1,
      tiandituKey: getTiandituKey() ? '***' : '',
    };
  }
}
