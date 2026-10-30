/**
 * 在线源管理冒烟（headless Edge + CDP）
 * 验证：源管理器就绪 / 初始层序（本地 0 + 极冠 1）/ 切 aws-s2 后 EOX 瓦片 READY 且底图位归它 /
 *       切回 esri 后 Esri 瓦片 READY / UI 同步 / 无 JS 错误。
 * 用法：先起 app.py，再 node tools/imagery-sources-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const WS_PATH = 'C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js';
const { default: WebSocket } = await import(`file:///${WS_PATH}`);

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9335;
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
await sleep(10000); // 等底图 + 极冠合成层就绪

const report = {};

// ① 管理器状态 + 初始层序
try {
  report.mgr = await evaluate(`(() => {
    const mgr = window.__imagerySourceMgr;
    if (!mgr) return { ready: false };
    const layers = window.viewer.imageryLayers;
    const list = [];
    for (let i = 0; i < layers.length; i++) {
      const p = layers.get(i).imageryProvider;
      list.push({ i, isBase: layers.get(i).isBaseLayer(), url: p && p.url ? String(p.url).slice(0, 50) : '' });
    }
    return { ready: true, currentId: mgr.debug().currentId, list };
  })()`);
} catch (e) { report.mgrErr = String(e.message); }

// ② 切 aws-s2
try {
  report.switchAws = await evaluate(`(() => {
    const mgr = window.__imagerySourceMgr;
    mgr.setSource('aws-s2');
    const layers = window.viewer.imageryLayers;
    const d = mgr.debug();
    const p = layers.get(0).imageryProvider;
    return {
      currentId: d.currentId,
      onlineLayerIndex: d.onlineLayerIndex,
      autoSwitched: d.autoSwitched,
      baseIsBaseLayer: layers.get(0).isBaseLayer(),
      baseProviderUrl: p && p.url ? String(p.url).slice(0, 60) : '',
      onlineSourceSelect: document.getElementById('onlineSource').value,
    };
  })()`);
} catch (e) { report.switchAwsErr = String(e.message); }

// ③ 等 EOX 瓦片 READY（GlobeSurface._tilesToRender → t.data.imagery[] → readyImagery）
try {
  let ready = null;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    ready = await evaluate(`(() => {
      const surf = window.viewer.scene.globe._surface;
      const tiles = surf._tilesToRender || [];
      let match = null;
      for (const t of tiles) {
        for (const ti of ((t.data && t.data.imagery) || [])) {
          const im = ti.readyImagery || ti.loadingImagery || ti.imagery;
          if (!im || !im.imageryLayer) continue;
          const url = String(im.imageryLayer.imageryProvider.url || '');
          if (!url.includes('eox.at')) continue;
          const m = { state: im.state, hasTexture: !!im.texture };
          if (im.state === 4 && im.texture) return { ready: true, ...m };
          match = match || { ready: false, ...m };
        }
      }
      return match || { ready: false, noMatch: true };
    })()`).catch((e) => ({ ready: false, err: String(e.message) }));
    if (ready && ready.ready) break;
  }
  report.awsTile = ready;
} catch (e) { report.awsTileErr = String(e.message); }

// ④ 切回 esri
try {
  report.switchEsri = await evaluate(`(() => {
    const mgr = window.__imagerySourceMgr;
    mgr.setSource('esri');
    const layers = window.viewer.imageryLayers;
    const d = mgr.debug();
    const p = layers.get(0).imageryProvider;
    return {
      currentId: d.currentId,
      onlineLayerIndex: d.onlineLayerIndex,
      baseIsBaseLayer: layers.get(0).isBaseLayer(),
      baseProviderUrl: p && p.url ? String(p.url).slice(0, 60) : '',
      onlineSourceSelect: document.getElementById('onlineSource').value,
    };
  })()`);
} catch (e) { report.switchEsriErr = String(e.message); }

// ⑤ 等 Esri 瓦片 READY
try {
  let ready = null;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    ready = await evaluate(`(() => {
      const surf = window.viewer.scene.globe._surface;
      const tiles = surf._tilesToRender || [];
      let match = null;
      for (const t of tiles) {
        for (const ti of ((t.data && t.data.imagery) || [])) {
          const im = ti.readyImagery || ti.loadingImagery || ti.imagery;
          if (!im || !im.imageryLayer) continue;
          const url = String(im.imageryLayer.imageryProvider.url || '');
          if (!url.includes('arcgisonline')) continue;
          const m = { state: im.state, hasTexture: !!im.texture };
          if (im.state === 4 && im.texture) return { ready: true, ...m };
          match = match || { ready: false, ...m };
        }
      }
      return match || { ready: false, noMatch: true };
    })()`).catch((e) => ({ ready: false, err: String(e.message) }));
    if (ready && ready.ready) break;
  }
  report.esriTile = ready;
} catch (e) { report.esriTileErr = String(e.message); }

report.jsErrors = errors;
console.log(JSON.stringify(report, null, 1));
ws.close();
edge.kill();
process.exit(0);
