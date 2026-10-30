/**
 * tools/smoke/min-probe-tiles.mjs
 * 在最小复现页里把「每块 z 层瓦片的状态」全部吐出来，定位是几何没画还是瓦片没取到。
 * 用法：node tools/smoke/min-probe-tiles.mjs <lng> <lat> <zoom>
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const WS_PATH = 'C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js';
const { default: WebSocket } = await import(`file:///${WS_PATH}`);
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9399;
const [LNG, LAT, ZOOM] = [+(process.argv[2] || 121.4906), +(process.argv[3] || 31.2325), +(process.argv[4] || 15)];
const URL_ = `http://127.0.0.1:5008/_probe_min.html?lng=${LNG}&lat=${LAT}&z=${ZOOM}`;

const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  '--no-default-browser-check', '--disable-extensions', '--use-gl=angle', '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--window-size=1920,919', 'about:blank'],
  { stdio: 'ignore' });

let wsUrl = null;
for (let i = 0; i < 40 && !wsUrl; i++) {
  await sleep(500);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (p) { wsUrl = p.webSocketDebuggerUrl; break; }
    const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL_)}`, { method: 'PUT' });
    if (r.ok) wsUrl = (await r.json()).webSocketDebuggerUrl;
  } catch {}
}
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let id = 0; const pend = new Map(); const logs = []; const netFail = [];
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); return; }
  if (m.method === 'Runtime.exceptionThrown') logs.push('[exc] ' + (m.params.exceptionDetails?.exception?.description || '').slice(0, 300));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push('[err] ' + (m.params.args || []).map(a => a.value ?? '').join(' ').slice(0, 200));
  if (m.method === 'Network.loadingFailed') netFail.push(`${m.params.requestId} ${m.params.errorText}`);
  if (m.method === 'Network.responseReceived' && m.params.response.status >= 400)
    netFail.push(`${m.params.response.status} ${m.params.response.url.slice(0, 120)}`);
});
const send = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((res, rej) => pend.set(i, { res, rej })); };
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; };

await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
await send('Page.navigate', { url: URL_ });
let ok = false;
for (let i = 0; i < 60 && !ok; i++) { await sleep(1000); try { ok = await ev('!!window.__ready'); } catch {} }
await sleep(2500);

console.log('状态:', JSON.stringify(await ev('window.__state')));

// MapLibre 内部瓦片状态：sourceCache._tiles 的 key 是 "z/x/y"
const dump = await ev(`(() => {
  const out = {};
  const caches = map.style.sourceCaches || {};
  for (const [k, c] of Object.entries(caches)) {
    const tiles = (c && c._tiles) || {};
    out[k] = Object.entries(tiles).map(([key, t]) => {
      const st = t.state;
      return { key, state: st, loaded: !!(t.texture || (t.latestFeatureIndex !== undefined && t.latestFeatureIndex !== null)),
               hasData: typeof t.state === 'number' ? t.state : String(st) };
    });
  }
  return { caches: Object.keys(caches), tiles: out,
           transform: { zoom: map.getZoom(), center: map.getCenter().toArray(), worldSize: map.transform.worldSize, tileSize: map.transform.tileSize } };
})()`);
console.log('缓存名:', JSON.stringify(dump.caches));
console.log('transform:', JSON.stringify(dump.transform));
for (const [name, list] of Object.entries(dump.tiles || {})) {
  console.log(`\n--- source ${name}: ${list.length} 块`);
  const byZ = {};
  for (const t of list) { const z = t.key.split('/')[0]; (byZ[z] = byZ[z] || []).push(t); }
  for (const [z, arr] of Object.entries(byZ)) {
    console.log(` z${z}: ${arr.length} 块  状态分布 ${JSON.stringify(arr.reduce((a, t) => (a[t.state] = (a[t.state] || 0) + 1, a), {}))}`);
    const xs = arr.map(t => +t.key.split('/')[1]), ys = arr.map(t => +t.key.split('/')[2]);
    console.log(`   x ${Math.min(...xs)}..${Math.max(...xs)}  y ${Math.min(...ys)}..${Math.max(...ys)}`);
    const bad = arr.filter(t => t.state !== 'loaded' && t.state !== 2);
    if (bad.length) console.log(`   非 loaded: ${bad.slice(0, 20).map(t => `${t.key}=${t.state}`).join(' ')}`);
  }
}
console.log('\n网络失败:', netFail.slice(0, 10));
console.log('异常:', logs.slice(0, 8));
ws.close(); edge.kill();
