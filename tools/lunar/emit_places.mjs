// tools/emit_places.mjs — 从 mountains.js 导出山脉折线中点（下载高精度地形用的 place 中心）
// 单一数据源：与 src/terrarium-provider.js 的 PLACE_RECTS 共用同一份 mountains.js
// 由 download_terrain_tiles.py 调用，输出 JSON：{ delta, places:[{name,lon,lat}] }

import { LAYER as MOUNTAINS } from '../../src/layers/mountains.js';

const PLACE_DELTA = 3; // 与 Python 下载器、provider 保持一致（±3°）

const places = MOUNTAINS.groups
  .flatMap((g) => g.entities)
  .filter((e) => e.type === 'polyline' && Array.isArray(e.coords) && e.coords.length > 1)
  .map((e) => {
    const m = e.coords[Math.floor(e.coords.length / 2)];
    return { name: e.name, lon: m[0], lat: m[1] };
  });

process.stdout.write(JSON.stringify({ delta: PLACE_DELTA, places }));
