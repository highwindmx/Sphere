/**
 * 极冠黑洞根治验证（headless Edge + CDP）
 * 根因：globe 瓦片几何 tilingScheme 曾继承自 WebMercator 的 terrain provider → ±85.05° 外无几何。
 * 修复：terrarium-provider 改为对外 GeographicTilingScheme + 内部墨卡托重采样。
 * 验证项：
 *   ① globe 几何方案 = Geographic，矩形北界 ≈ π/2（±90°）
 *   ② 默认视角 _tilesToRender 的根瓦片 rect 跨 ±90°（极区几何存在）
 *   ③ 极区瓦片 imagery 含合成层 skeleton（READY + 8192×4096 texture）
 *   ④ terrain provider 方案 = Geographic；珠峰高程 > 3000m（重采样链路通）
 *   ⑤ 中纬卫星瓦片仍 READY（地形/层序改动没弄坏底图）
 *   ⑥ 零 JS 错误
 * 用法：先起 app.py，再 node tools/polar-geo-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const WS_PATH = 'C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js';
const { default: WebSocket } = await import(`file:///${WS_PATH}`);

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9346;
const URL = 'http://127.0.0.1:5008/';

const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  '--disable-extensions', '--use-gl=angle', '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader', '--window-size=1400,1000', 'about:blank',
], { stdio: 'ignore' });

let wsUrl = null;
for (let i = 0; i < 40 && !wsUrl; i++) {
  await sleep(500);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) wsUrl = page.webSocketDebuggerUrl;
  } catch { /* 还没起来 */ }
}
if (!wsUrl) { edge.kill(); throw new Error('无法连接 Edge 调试端口'); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

let id = 0;
const pending = new Map();
const errors = [];
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params.exceptionDetails?.text + ' ' + (m.params.exceptionDetails?.exception?.description ?? ''));
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push('console.error: ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
  }
});
const send = (method, params = {}) => {
  const i = ++id;
  ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise((res, rej) => pending.set(i, { res, rej }));
};
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval error');
  return r.result.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: URL });
await sleep(15000); // 等极冠合成层 + 底图 + 地形就绪

const report = {};
const D = 180 / Math.PI;

// ①②③⑤：结构 + 极区瓦片 skeleton + 中纬瓦片
try {
  report.geometry = await evaluate(`(() => {
    const gts = window.viewer.scene.globe._surface._tileProvider.tilingScheme;
    const surf = window.viewer.scene.globe._surface;
    const tiles = surf._tilesToRender || [];
    let rootRect = null, poleComposite = null, midSat = null, maxLat = 0, minLat = 0;
    for (const t of tiles) {
      if (!t.rectangle) continue;
      if (t.level === 0) rootRect = [+t.rectangle.south.toFixed(3), +t.rectangle.north.toFixed(3)];
      if (t.rectangle.north > maxLat) maxLat = t.rectangle.north;
      if (t.rectangle.south < minLat) minLat = t.rectangle.south;
      const isPoleTile = t.rectangle.north > 1.48 || t.rectangle.south < -1.48;
      for (const ti of ((t.data && t.data.imagery) || [])) {
        const im = ti.readyImagery || ti.loadingImagery || ti.imagery;
        if (!im || !im.imageryLayer) continue;
        const p = im.imageryLayer.imageryProvider;
        const isSingle = p instanceof Cesium.SingleTileImageryProvider;
        const rec = { state: im.state, hasTexture: !!im.texture, texSize: im.texture ? [im.texture.width, im.texture.height] : null };
        if (isSingle && isPoleTile && !poleComposite) poleComposite = rec;
        if (!isSingle && !isPoleTile && !midSat) midSat = rec;
      }
    }
    const tp = window.viewer.scene.globe.terrainProvider;
    return {
      globeScheme: { ctor: gts.constructor.name, northDeg: +(gts.rectangle.north * ${D}).toFixed(2) },
      terrainScheme: { ctor: tp.tilingScheme.constructor.name, northDeg: +(tp.tilingScheme.rectangle.north * ${D}).toFixed(2) },
      rootTileRectDeg: rootRect,
      maxLatDeg: +(maxLat * ${D}).toFixed(2),
      minLatDeg: +(minLat * ${D}).toFixed(2),
      tileCount: tiles.length,
      poleTileComposite: poleComposite,
      midLatSatellite: midSat,
      polarDebugGlobe: __polarDebug().globeScheme,
    };
  })()`);
} catch (e) { report.geometryErr = String(e.message); }

// ④：飞到珠峰，读高程（验证墨卡托→地理重采样链路）
try {
  await evaluate(`window.viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(86.9, 28, 260000), orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 } })`);
  let everest = null, ocean = null;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    everest = await evaluate(`(() => {
      const h = window.viewer.scene.globe.getHeight(Cesium.Cartographic.fromDegrees(86.9225, 27.9881));
      return (h === undefined || h === null) ? null : Math.round(h);
    })()`).catch(() => null);
    ocean = await evaluate(`(() => {
      const h = window.viewer.scene.globe.getHeight(Cesium.Cartographic.fromDegrees(140, 20));
      return (h === undefined || h === null) ? null : Math.round(h);
    })()`).catch(() => null);
    if (everest !== null) break;
  }
  report.terrainHeights = { everest, pacificNearJapan: ocean };
} catch (e) { report.terrainErr = String(e.message); }

report.jsErrors = errors;
console.log(JSON.stringify(report, null, 1));
ws.close();
edge.kill();
process.exit(0);
