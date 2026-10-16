/**
 * 极冠补丁 profile 注册表（2026-10-16，用户目标架构：每源一份补丁，切源自动换补丁）
 *
 * 背景：各在线源极区表现不同（2026-10-16 实测 z5 北极边缘瓦片 79.2°-85.05°）：
 *   Esri World Imagery → (23,84,100) 无冰海水（夏态）
 *   EOX s2cloudless-2025 → (18,34,62) 深蓝（全年无云合成，无季节概念）
 *   GIBS Blue Marble NG → EPSG:4326 地理投影，原生覆盖 ±90° 真数据 → 不需要补丁
 * 南极三源均为白冰（Esri 243,246,254 / EOX 250,250,251），无源差异。
 *
 * 资产由 tools/build_polar_patches.py 从 bluemarble.jpg 生成（HSV 色系搬移，
 * 只动 |lat|>84.96° 极带）；运行时 recalibratePolarCaps() 逐列接缝精调。
 * 图级做粗调、运行时做精调，两者分工不重复。
 *
 * 新增源流程：① tools/build_polar_patches.py 加目标色生成补丁图；
 *            ② 本表加 profile；③ imagery-sources.js IMAGERY_SOURCES 加源。
 */

const SEASON_KEY = 'sphere-polar-season';

const PROFILES = {
  esri: {
    id: 'esri',
    label: 'Esri 卫星',
    patchImage: 'patch/esri.jpg',
    poleStrategy: 'patch', // patch=合成层补丁 / native=源自身有极区真数据，补丁隐藏
    season: 'summer',
    note: 'Esri 极区实测无冰海水 (23,84,100)，专属色版',
  },
  'aws-s2': {
    id: 'aws-s2',
    label: 'AWS Sentinel-2',
    patchImage: 'patch/eox.jpg',
    poleStrategy: 'patch',
    season: 'summer',
    note: 'EOX s2cloudless 全年无云合成 (18,34,62)，无季节概念',
  },
  gibs: {
    id: 'gibs',
    label: 'NASA Blue Marble',
    patchImage: null,
    poleStrategy: 'native',
    season: null,
    note: 'GIBS EPSG:4326 原生 ±90° 极区真数据，补丁自动关闭',
  },
  // 本地瓦片模式：tiles/esri 由 Flask 代理 Esri 派生（见 app.py proxy_esri_tile），
  // 极区表现与 Esri 一致 → 复用 Esri 补丁
  local: {
    id: 'local',
    label: '本地瓦片',
    patchImage: 'patch/esri.jpg',
    poleStrategy: 'patch',
    season: 'summer',
    note: '本地瓦片 = Flask 代理 Esri 派生，同 Esri 补丁',
  },
};

const FALLBACK = PROFILES.esri;

/**
 * 解析当前应生效的极冠 profile。
 * @param {object} ctx
 * @param {string} ctx.baseMode 'auto' | 'online'
 * @param {string} ctx.sourceId 当前在线源 id
 * @param {boolean} ctx.localActive 本地瓦片层是否在画面中（auto 模式检测到时）
 */
export function resolvePolarProfile({ baseMode = 'auto', sourceId = 'esri', localActive = false } = {}) {
  if (localActive) return PROFILES.local;
  return PROFILES[sourceId] || FALLBACK;
}

export function getSeason() {
  try { return localStorage.getItem(SEASON_KEY) || 'summer'; } catch { return 'summer'; }
}

export function setSeason(s) {
  try { s ? localStorage.setItem(SEASON_KEY, s) : localStorage.removeItem(SEASON_KEY); } catch { /* 忽略 */ }
}

/** 状态栏文案：「极冠补丁：Esri 卫星 · 夏季」/「… · 原生极区（不补丁）」 */
export function profileStatusText(profile, season) {
  if (profile.poleStrategy === 'native') return `极冠补丁：${profile.label} · 原生极区（不补丁）`;
  return `极冠补丁：${profile.label} · ${season === 'winter' ? '冬季' : '夏季'}`;
}

export const POLAR_PROFILES = PROFILES;
