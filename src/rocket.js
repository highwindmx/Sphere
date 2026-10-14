// src/rocket.js — 火箭发射动画（stub）

import * as Cesium from 'cesium';

export function createRocketLaunch(viewer) {
  let active = false;
  let trackEntity = null;
  let rocketEntity = null;

  return {
    start(options = {}) {
      if (active) return;
      active = true;
      console.log('[rocket] start — stub', options);
    },
    stop() {
      active = false;
      if (trackEntity) { viewer.entities.remove(trackEntity); trackEntity = null; }
      if (rocketEntity) { viewer.entities.remove(rocketEntity); rocketEntity = null; }
      console.log('[rocket] stop — stub');
    },
    getTrackEntity: () => trackEntity,
    isActive: () => active,
  };
}

export default createRocketLaunch;
