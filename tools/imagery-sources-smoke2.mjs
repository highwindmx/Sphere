/**
 * 补充冒烟：online 模式（无本地层）+ 天地图 overlay 层结构（假 key，只验层不验瓦片）
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
const WS_PATH = 'C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js';
const { default: WebSocket } = await import(`file:///${WS_PATH}`);
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9340;
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run', '--disable-extensions', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 40 && !wsUrl; i++) {
  await sleep(500);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) wsUrl = page.webSocketDebuggerUrl;
  } catch { /* wait */ }
}
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let id = 0; const pending = new Map(); const errors = [];
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); return; }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.text + ' ' + (m.params.exceptionDetails?.exception?.description ?? ''));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error: ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
});
const send = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((res, rej) => pending.set(i, { res, rej })); };
const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval error'); return r.result.value; };

const dumpLayers = `(() => {
  const layers = window.viewer.imageryLayers;
  const list = [];
  for (let i = 0; i < layers.length; i++) {
    const l = layers.get(i); const p = l.imageryProvider;
    list.push({ i, isBase: l.isBaseLayer(), url: p && p.url ? String(p.url).slice(0, 55) : '', rect: l.rectangle ? [+l.rectangle.west.toFixed(1), +l.rectangle.south.toFixed(1), +l.rectangle.east.toFixed(1), +l.rectangle.north.toFixed(1)] : null });
  }
  return list;
})()`;

await send('Runtime.enable'); await send('Page.enable');
const out = {};

// —— 场景 A：online 模式 ——
await send('Page.navigate', { url: 'http://127.0.0.1:5008/' });
await sleep(6000);
await evaluate(`localStorage.setItem('sphere-base-mode', 'online')`);
await send('Page.navigate', { url: 'http://127.0.0.1:5008/' });
await sleep(10000);
out.A_onlineMode = await evaluate(`(() => {
  const mgr = window.__imagerySourceMgr;
  return { currentId: mgr.debug().currentId, onlineLayerIndex: mgr.debug().onlineLayerIndex, layers: ${dumpLayers} };
})()`);
// 在 online 模式下切 aws-s2（remove + add 路径）
out.A_switchAws = await evaluate(`(() => {
  const mgr = window.__imagerySourceMgr;
  mgr.setSource('aws-s2');
  return { currentId: mgr.debug().currentId, onlineLayerIndex: mgr.debug().onlineLayerIndex, layers: ${dumpLayers} };
})()`);

// —— 场景 B：overlay 层（假 key，只验层结构）——
await send('Page.navigate', { url: 'http://127.0.0.1:5008/' });
await sleep(6000);
await evaluate(`localStorage.setItem('sphere-tianditu-key', 'FAKE_KEY_FOR_STRUCTURE_TEST'); localStorage.setItem('sphere-tianditu-overlay', '1')`);
await send('Page.navigate', { url: 'http://127.0.0.1:5008/' });
await sleep(10000);
out.B_overlay = await evaluate(`(() => {
  const mgr = window.__imagerySourceMgr;
  const d = mgr.debug();
  const layers = window.viewer.imageryLayers;
  const ol = mgr.overlayLayer;
  return {
    overlayEnabled: d.overlayEnabled,
    overlayLayerIndex: d.overlayLayerIndex,
    overlayRect: ol && ol.rectangle ? [+ol.rectangle.west.toFixed(1), +ol.rectangle.south.toFixed(1), +ol.rectangle.east.toFixed(1), +ol.rectangle.north.toFixed(1)] : null,
    overlayUrl: ol && ol.imageryProvider.url ? String(ol.imageryProvider.url).slice(0, 60) : '',
    baseIsEsri: layers.get(0).imageryProvider.url.includes('arcgisonline'),
    layers: ${dumpLayers},
  };
})()`);

// —— 清理测试用 localStorage，恢复现场 ——
await evaluate(`localStorage.removeItem('sphere-base-mode'); localStorage.removeItem('sphere-tianditu-key'); localStorage.removeItem('sphere-tianditu-overlay')`);
out.jsErrors = errors;
console.log(JSON.stringify(out, null, 1));
ws.close(); edge.kill(); process.exit(0);
