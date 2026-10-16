// src/layers/index.js — 图层注册表
// 从 dist index--AIpTfEu.js 提取分类树

import { LAYER as tiangong } from './tiangong.js';
import { LAYER as moonmission } from './moonmission.js';

import { LAYER as geolines } from './geolines.js';
import { LAYER as plates } from './plates.js';
import { LAYER as currents } from './currents.js';
import { LAYER as worldocean } from './worldocean.js';

// 山川形胜 = 关隘 + 山脉 + 河流 + 大运河 + 蜀道 + 茶马古道（合并图层）
import { LAYER as shanhai } from './shanhai.js';

import { LAYER as wall } from './wall.js';
import { LAYER as longmarch } from './longmarch.js';
import { LAYER as g318 } from './g318.js';
import { LAYER as waterworks } from './waterworks.js';
import { LAYER as silkroad } from './silkroad.js';
import { LAYER as zhenghe } from './zhenghe.js';
import { LAYER as xuanzang } from './xuanzang.js';
import { LAYER as dynasties } from './dynasties.js';
import { LAYER as cities } from './cities.js';

import { LAYER as civilizations } from './civilizations.js';
import { LAYER as wonders } from './wonders.js';
import { LAYER as heritage } from './heritage.js';
import { LAYER as ageofsail } from './ageofsail.js';
import { LAYER as rome } from './rome.js';
import { LAYER as crusades } from './crusades.js';
import { LAYER as mongol } from './mongol.js';
import { LAYER as alexander } from './alexander.js';
import { LAYER as wwars } from './wwars.js';
import { LAYER as worldcapitals } from './worldcapitals.js';
import { LAYER as peaks } from './peaks.js';
import { LAYER as worldrivers } from './worldrivers.js';

// LAYERS 数组（按 categories 中 layerIds 出现顺序）
export const LAYERS = [
  // 航天探索
  tiangong, moonmission,
  // 自然地理
  geolines, plates, worldocean, currents,
  // 中国史（历史路线放在长征之后）
  shanhai, wall, longmarch, silkroad, zhenghe, xuanzang, g318, cities, dynasties, waterworks,
  // 世界史
  civilizations, wonders, heritage, ageofsail, rome, crusades, mongol, alexander, wwars,
  worldcapitals, peaks, worldrivers,
];

// 快速查找表
export const LAYER_MAP = new Map(LAYERS.map((l) => [l.id, l]));

/**
 * LAYER_CATEGORIES — 分类树
 * 从 dist index--AIpTfEu.js nn 数组提取
 * 注意：dist 原始分类含 straits / scenery（旧 id），对应修正为 worldocean / mountains
 */
export const LAYER_CATEGORIES = [
  {
    id: 'space',
    name: '航天探索',
    layerIds: ['tiangong', 'moonmission'],
  },
  {
    id: 'nature',
    name: '自然地理',
    layerIds: ['geolines', 'plates', 'worldocean', 'currents'],
  },
  {
    id: 'china',
    name: '中国史',
    layerIds: [
      'shanhai', 'wall', 'longmarch',
      'silkroad', 'zhenghe', 'xuanzang', 'g318',
      'cities', 'dynasties', 'waterworks',
    ],
  },
  {
    id: 'world',
    name: '世界史',
    layerIds: [
      'ageofsail', 'rome', 'crusades', 'mongol', 'alexander',
      'wwars', 'civilizations', 'heritage', 'wonders',
      'worldcapitals', 'peaks', 'worldrivers',
    ],
  },
];

/**
 * 把 layerIds 解析成 LAYER 对象引用
 * @returns {Array<{id,name,layers:LAYER[]}>}
 */
export function resolveCategories() {
  return LAYER_CATEGORIES.map((cat) => ({
    id: cat.id,
    name: cat.name,
    layers: cat.layerIds
      .map((id) => LAYER_MAP.get(id))
      .filter(Boolean),
  }));
}
