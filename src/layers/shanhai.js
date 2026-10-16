// 坐标系: WGS84 (EPSG:4326)，十进制度，坐标顺序统一为 [经度 lon, 纬度 lat]。
//   渲染端由 Cesium.Cartesian3.fromDegrees(lon, lat) / fromDegreesArray 直接使用，无需额外转换。
// 数据性质: 教学示意级。城市/地点坐标为近似位置（精度约市级 ±1–5 km）；
//           历史疆域/路线为简化示意，非考据级边界，仅供空间认知。
// 来源: 编译自公开地理资料与通史常识，非测绘权威数据；用于科普与家庭教育。

// src/layers/shanhai.js — 山川形胜（合并图层）
// = 重要关隘(points) + 主要山脉 + 主要河流 + 大运河 + 蜀道 + 茶马古道
// 数据沿用各自原始模块，此处只做组合与自动文字标注。

import { LAYER as passesSrc } from './passes.js';
import { LAYER as mountainsSrc } from './mountains.js';
import { LAYER as riverSrc } from './river.js';
import { LAYER as canalSrc } from './canal.js';
import { LAYER as shudaoSrc } from './shudao.js';
import { LAYER as teahorseSrc } from './teahorse.js';

// 给折线实体批量补文字标注：取折线中点，避免每条线手工选坐标。
// text 用折线自身 name（黄河/喜马拉雅山脉/金牛道…），随所在 group 一起显隐。
function autoLabels(entities) {
  const labels = [];
  for (const e of entities) {
    if (
      e.type === 'polyline' &&
      e.name &&
      Array.isArray(e.coords) &&
      e.coords.length > 2
    ) {
      const m = e.coords[Math.floor(e.coords.length / 2)];
      labels.push({
        type: 'label',
        name: e.name + ' · 标注',
        lon: m[0],
        lat: m[1],
        text: e.name,
      });
    }
  }
  entities.push(...labels);
  return entities;
}

// 把多个源 group 的实体扁平合并进一个 group（单勾选项）
function flattenGroups(srcLayer) {
  const entities = [];
  for (const g of srcLayer.groups) entities.push(...g.entities);
  return entities;
}

const mountainEntities = autoLabels(flattenGroups(mountainsSrc));
const riverEntities = autoLabels(flattenGroups(riverSrc));
const canalEntities = autoLabels(flattenGroups(canalSrc));
const shudaoEntities = autoLabels(flattenGroups(shudaoSrc));
const teahorseEntities = autoLabels(flattenGroups(teahorseSrc));

export const LAYER = {
  id: 'shanhai',
  name: '山川形胜',
  description:
    '关隘要冲 · 主要山脉 · 主要河流 · 运河古道（大运河/蜀道/茶马古道），山川险要与交通命脉一览。',
  icon: '⛰',
  defaultColor: '#f1c40f',
  groups: [
    passesSrc.groups[0], // 关隘星点（30 处，含名称标注）
    {
      id: 'ranges',
      name: '主要山脉',
      color: '#7cb342',
      entities: mountainEntities,
    },
    {
      id: 'rivers',
      name: '主要河流',
      color: '#4a8eb8',
      entities: riverEntities,
    },
    {
      id: 'canal',
      name: '大运河',
      color: '#2e5cb8',
      entities: canalEntities,
    },
    {
      id: 'shudao',
      name: '蜀道',
      color: '#b8902e',
      entities: shudaoEntities,
    },
    {
      id: 'teahorse',
      name: '茶马古道',
      color: '#8a5a2e',
      entities: teahorseEntities,
    },
  ],
};

export default LAYER;
