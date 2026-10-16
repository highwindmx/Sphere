// src/moon-landing.js — 月面着陆辅助（图标 + 动力下降高度曲线）
// 三幕剧中第三幕的「着陆器」形态与下降轨迹由本模块提供。

import * as Cesium from 'cesium';
import { MOON_ELLIPSOID } from './lunar.js';

// 着陆器图标（billboard：始终面向屏幕，用换图标表达姿态变化）
export const LANDER_ICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
      <path d="M12 3l3 6H9l3-6z" fill="#c2cde6"/>
      <rect x="8" y="9" width="8" height="5" rx="1" fill="#d4a04a"/>
      <path d="M6 14l-3 6 4-1.5L9 14zm12 0l3 6-4-1.5L15 14z" fill="#8b98b8"/>
      <circle cx="12" cy="16" r="1.6" fill="#ff6b6b"/>
      <rect x="11" y="17" width="2" height="3" fill="#6b7a9e"/>
    </svg>`
  );

// 火箭/转移段航天器图标（上面级）
export const SPACECRAFT_ICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
      <path d="M12 2c-2 4-2 8 0 12l-2-5 2-7zm0 0c2 4 2 8 0 12l2-5-2-7z" fill="#d4a04a"/>
      <rect x="10" y="12" width="4" height="7" fill="#4a5578"/>
      <path d="M8 19h8l-2 3h-4l-2-3z" fill="#ff6b6b"/>
      <path d="M6 12l-4 7 4-2v-5zm12 0l4 7-4-2v-5z" fill="#6b7a9e"/>
    </svg>`
  );

// 动力下降高度：s∈[0,1] 从 200 km 环月轨道降到月面（先快后慢，末段悬停式软着陆）
export function descentAltitude(s) {
  const s01 = Math.max(0, Math.min(1, s));
  const e = 1 - Math.pow(1 - s01, 2.2); // 缓出：越接近月面越慢
  return 200000 * (1 - e);
}

// 月面着陆点位置的笛卡尔坐标
export function sitePosition(site, altitude = 0) {
  return Cesium.Cartesian3.fromDegrees(site.lon, site.lat, altitude, MOON_ELLIPSOID);
}

export default { LANDER_ICON, SPACECRAFT_ICON, descentAltitude, sitePosition };
