// src/tiangong.js — 天宫空间站轨道加载（stub）
// dist 中完整逻辑：从 celestrak.org 拉 TLE，用 satellite.js 解算轨道位置
// 此处只提供 stub 接口，实际实现可后续补充

import * as Cesium from 'cesium';

let _orbitEntity = null;
let _labelEntity = null;
let _clockSubscription = null;

/**
 * 加载天宫空间站实时轨道
 * @param {Cesium.Viewer} viewer
 * @returns {Promise<boolean>} 是否成功加载
 */
export async function loadTiangong(viewer) {
  // stub 实现：只在 console 打印，不创建实际轨道
  console.log('[tiangong] loadTiangong — stub（需 TLE + satellite.js）');
  // TODO: 实际实现 = fetch TLE → satellite.js.propagate → SampledPositionProperty → billboard + polyline
  return false;
}

export function removeTiangong(viewer) {
  if (_orbitEntity) {
    viewer.entities.remove(_orbitEntity);
    _orbitEntity = null;
  }
  if (_labelEntity) {
    viewer.entities.remove(_labelEntity);
    _labelEntity = null;
  }
  if (_clockSubscription) {
    _clockSubscription();
    _clockSubscription = null;
  }
}

export function isTiangongLoaded() {
  return !!_orbitEntity;
}
