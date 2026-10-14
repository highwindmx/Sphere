// src/lunar.js — 月球 Viewer & 地形（stub + 核心常量）

import * as Cesium from 'cesium';

// 月球椭球（从 dist je / ba 类提取：3个半轴相同，球形）
export const MOON_ELLIPSOID = new Cesium.Ellipsoid(
  1737400, // 月球半径 ~1737.4 km
  1737400,
  1737400
);

let _moonViewer = null;

/**
 * 创建月球 Viewer（stub）
 * 实际实现参考 dist 中 Ma 函数：
 *   - new Cesium.Viewer({ ellipsoid: MOON_ELLIPSOID, globe: new Cesium.Globe(MOON_ELLIPSOID) })
 *   - 加载 lunar_wac.jpg 作为底图
 *   - 设置 LOLA DEM terrain provider
 */
export function createMoonViewer(containerId = 'moonContainer', onReady = null) {
  console.log('[lunar] createMoonViewer — stub, container=', containerId);
  // stub：不实际创建 viewer，返回 null
  return null;
}

export function getMoonViewer() {
  return _moonViewer;
}

export function destroyMoonViewer() {
  if (_moonViewer) {
    try { _moonViewer.destroy(); } catch {}
    _moonViewer = null;
  }
}

/**
 * 显隐月球标注分组
 */
export function toggleLunarGroup(groupId, visible) {
  console.log('[lunar] toggleLunarGroup — stub', groupId, visible);
}

export function setMoonViewer(viewer) {
  _moonViewer = viewer;
}

/**
 * 获取所有月面标注分组定义（从 dist mn 数组提取，stub 返回空）
 */
export function getMoonGroups() {
  return [];
}

export default {
  createMoonViewer,
  destroyMoonViewer,
  toggleLunarGroup,
  getMoonViewer,
  MOON_ELLIPSOID,
};
