/**
 * tools/smoke/min-probe-shot.mjs
 * 打开最小复现页（/_probe_min.html）截一张图，用于把「数据 + MapLibre」与「应用样式」隔离比对。
 * 用法：node tools/smoke/min-probe-shot.mjs <lng> <lat> <zoom> <out.png>
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
const WS_PATH = 'C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js';
const { default: WebSocket } = await import(`file:///${WS_PATH}`);
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9398;
const [LNG, LAT, ZOOM, OUT] = [+(process.argv[2] || 121.4906), +(process.argv[3] || 31.2325),
  +(process.argv[4] || 15), process.argv[5] || 'tools/shots/ui/min-probe.png'];
const FILEARG = process.argv[6] ? `&file=${encodeURIComponent(process.argv[6])}` : '';
const URL_ = `http://127.0.0.1:5008/_probe_min.html?lng=${LNG}&lat=${LAT}&z=${ZOOM}${FILEARG}`;
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
let id = 0; const pend = new Map(); const logs = [];
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); return; }
  if (m.method === 'Runtime.exceptionThrown') logs.push('[exc] ' + (m.params.exceptionDetails?.exception?.description || '').slice(0, 300));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push('[err] ' + (m.params.args || []).map(a => a.value ?? '').join(' ').slice(0, 200));
});
const send = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((res, rej) => pend.set(i, { res, rej })); };
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; };
await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: URL_ });
let ok = false;
for (let i = 0; i < 60 && !ok; i++) { await sleep(1000); try { ok = await ev('!!window.__ready'); } catch {} }
await sleep(2500);
console.log('状态:', JSON.stringify(await ev('window.__state')));
console.log('异常:', logs.slice(0, 5));
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.mkdirSync('tools/shots/ui', { recursive: true });
fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
console.log('已保存:', OUT);
ws.close(); edge.kill();
