/**
 * 补充验证 v2（headless Edge + CDP）——层序回正后：
 *   ⑦ 中纬卫星底图瓦片 READY（极区判定修正：完全超出 ±85.05° 才算极区瓦片）
 *   ⑧ red 模式：轮询等合成画布真变红 → 飞北极 → 屏幕中心像素 = 红
 *      南极同理（正常模式应为白冰；red 模式为红）
 * 用法：node tools/polar-geo-smoke2.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const WS_PATH = 'C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js';
const { default: WebSocket } = await import(`file:///${WS_PATH}`);

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9349;

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

const report = {};

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: 'http://127.0.0.1:5008/' });
await sleep(14000);

// ⑦ 中纬卫星底图（飞到中国上空；极区判定 = 瓦片完全超出 ±85.05°）
try {
  await evaluate(`window.viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(110, 32, 2500000), orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 } })`);
  let sat = null;
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    sat = await evaluate(`(() => {
      const surf = window.viewer.scene.globe._surface;
      const tiles = surf._tilesToRender || [];
      let found = null, total = 0, withSat = 0, poleOnly = 0;
      for (const t of tiles) {
        if (!t.rectangle) continue;
        total++;
        const purePole = t.rectangle.south > 1.4844 || t.rectangle.north < -1.4844;
        if (purePole) { poleOnly++; continue; }
        for (const ti of ((t.data && t.data.imagery) || [])) {
          const im = ti.readyImagery || ti.loadingImagery || ti.imagery;
          if (!im || !im.imageryLayer) continue;
          if (im.imageryLayer.imageryProvider instanceof Cesium.SingleTileImageryProvider) continue;
          withSat++;
          if (!found && im.state === 4 && im.texture) found = { state: im.state, tex: [im.texture.width, im.texture.height] };
        }
      }
      return { totalTiles: total, purePoleTiles: poleOnly, satImageryCount: withSat, readySample: found };
    })()`).catch(() => null);
    if (sat && sat.readySample) break;
  }
  report.midLatSatellite = sat;
} catch (e) { report.midLatErr = String(e.message); }

// ⑧ red 模式：先轮询等画布真变红（recalibrate 里有异步接缝采样）
try {
  await evaluate(`__setPolarDebug('red')`);
  let canvasRed = null;
  for (let i = 0; i < 25; i++) {
    await sleep(1000);
    canvasRed = await evaluate(`(() => {
      const c = window.__polarComposite;
      if (!c) return null;
      const px = (x, y) => { const d = c.getContext('2d').getImageData(x, y, 1, 1).data; return [d[0], d[1], d[2], d[3]]; };
      return { mode: __polarDebug().polarDebug, topBand: px(c.width >> 1, 30), equator: px(c.width >> 1, c.height >> 1), bottomBand: px(c.width >> 1, c.height - 30) };
    })()`).catch(() => null);
    if (canvasRed && canvasRed.topBand && canvasRed.topBand[0] === 255 && canvasRed.topBand[1] === 0) break;
  }
  report.redCanvas = canvasRed;
} catch (e) { report.redCanvasErr = String(e.message); }

// 飞北极 + 屏幕中心像素（轮询等合成层 READY）
try {
  await evaluate(`__flyToPole(true)`);
  let px = null;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const ready = await evaluate(`(() => {
      const surf = window.viewer.scene.globe._surface;
      for (const t of (surf._tilesToRender || [])) {
        for (const ti of ((t.data && t.data.imagery) || [])) {
          const im = ti.readyImagery || ti.loadingImagery || ti.imagery;
          if (im && im.imageryLayer && im.imageryLayer.imageryProvider instanceof Cesium.SingleTileImageryProvider) {
            return im.state === 4 && !!im.texture;
          }
        }
      }
      return false;
    })()`).catch(() => false);
    if (!ready) continue;
    const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 692, y: 492, width: 16, height: 16, scale: 1 } });
    px = await evaluate(`(async () => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,${shot.data}'; });
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const cx = c.getContext('2d');
      cx.drawImage(img, 0, 0);
      const d = cx.getImageData(8, 8, 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    })()`);
    break;
  }
  report.northPolePixelRedMode = px;
} catch (e) { report.northPoleErr = String(e.message); }

// 关闭 red，飞南极，正常模式应为白冰
try {
  await evaluate(`__setPolarDebug('')`);
  await evaluate(`__flyToPole(false)`);
  let px = null;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const ready = await evaluate(`(() => {
      const surf = window.viewer.scene.globe._surface;
      for (const t of (surf._tilesToRender || [])) {
        for (const ti of ((t.data && t.data.imagery) || [])) {
          const im = ti.readyImagery || ti.loadingImagery || ti.imagery;
          if (im && im.imageryLayer && im.imageryLayer.imageryProvider instanceof Cesium.SingleTileImageryProvider) {
            return im.state === 4 && !!im.texture;
          }
        }
      }
      return false;
    })()`).catch(() => false);
    if (!ready) continue;
    const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 692, y: 492, width: 16, height: 16, scale: 1 } });
    px = await evaluate(`(async () => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,${shot.data}'; });
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const cx = c.getContext('2d');
      cx.drawImage(img, 0, 0);
      const d = cx.getImageData(8, 8, 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    })()`);
    break;
  }
  report.southPolePixelNormal = px;
} catch (e) { report.southPoleErr = String(e.message); }

report.jsErrors = errors;
console.log(JSON.stringify(report, null, 1));
ws.close();
edge.kill();
process.exit(0);
