/**
 * tools/smoke/project-probe.mjs
 * 在最小复现页里用 map.project 反算若干经纬度的屏幕坐标，用于校验外部脚本的投影公式。
 * 用法：node tools/smoke/project-probe.mjs <lng> <lat> <zoom> [lng2,lat2 ...]
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const WS_PATH = 'C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js';
const { default: WebSocket } = await import(`file:///${WS_PATH}`);
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9397;
const LNG = +(process.argv[2] || 121.4906), LAT = +(process.argv[3] || 31.2325), ZOOM = +(process.argv[4] || 15);
const PTS = process.argv.slice(5).map((s) => s.split(',').map(Number));
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
let id = 0; const pend = new Map();
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
});
const send = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((res, rej) => pend.set(i, { res, rej })); };
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; };

await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: URL_ });
let ok = false;
for (let i = 0; i < 60 && !ok; i++) { await sleep(1000); try { ok = await ev('!!window.__ready'); } catch {} }
await sleep(2000);

const info = await ev(`({
  zoom: map.getZoom(), center: map.getCenter().toArray(), pitch: map.getPitch(), bearing: map.getBearing(),
  canvas: [map.getCanvas().width, map.getCanvas().height],
  padding: map.transform.padding,
  worldSize: map.transform.worldSize, tileSize: map.transform.tileSize,
  dpr: window.devicePixelRatio,
  bbox: map.getBounds().toArray()
})`);
console.log('页面参数:', JSON.stringify(info));

const res = await ev(`(${JSON.stringify(PTS)}).map(p => { const q = map.project(p); return [p[0], p[1], q.x, q.y]; })`);
console.log('| lng | lat | screen_x | screen_y |');
for (const [lo, la, x, y] of res) console.log(`| ${lo} | ${la} | ${x.toFixed(2)} | ${y.toFixed(2)} |`);
ws.close(); edge.kill();
