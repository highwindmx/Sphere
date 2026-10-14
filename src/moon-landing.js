// src/moon-landing.js — 月面着陆（stub）

import * as Cesium from 'cesium';

export function createMoonLanding(moonViewer) {
  console.log('[moon-landing] createMoonLanding — stub');
  return {
    start() { console.log('[moon-landing] start'); },
    stop() { console.log('[moon-landing] stop'); },
    isActive() { return false; },
  };
}

export default createMoonLanding;
