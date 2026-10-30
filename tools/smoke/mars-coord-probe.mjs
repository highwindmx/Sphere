/**
 * 火星坐标栏探针：切到火星后，验证左上坐标控件是否写入火星经纬度/海拔。
 * 用法：先启动 app.py，再 node tools/smoke/mars-coord-probe.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
const WS_PATH = 'C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js';
const { default: WebSocket } = await import(`file:///${WS_PATH}`);

const EDGE_BIN = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9387;
const URL = 'http://127.0.0.1:5008/';

const edge = spawn(EDGE_BIN, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  '--no-default-browser-check', '--disable-extensions', '--use-gl=angle',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage',
  '--window-size=1280,800', 'about:blank',
], { stdio: 'ignore' });

let wsUrl = null;
for (let i = 0; i < 40 && !wsUrl; i++) {
  await sleep(500);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) { wsUrl = page.webSocketDebuggerUrl; break; }
    const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL)}`, { method: 'PUT' });
    if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; }
  } catch { /* 还没起来 */ }
}
if (!wsUrl) { edge.kill(); throw new Error('无法连接 Edge 调试端口'); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let id = 0;
const pending = new Map();
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
  }
});
function send(method, params = {}) {
  const i = ++id;
  ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise((res, rej) => pending.set(i, { res, rej }));
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('eval 异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}

await send('Page.enable');
await send('Page.navigate', { url: URL });
await sleep(2500);
for (let i = 0; i < 60; i++) {
  const ok = await evaluate(`(() => !!document.getElementById('layersTree') && document.getElementById('layersTree').children.length > 0)()`).catch(() => false);
  if (ok) break;
  await sleep(500);
}

const out = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  document.getElementById('btnMarsMode').click();
  for (let i = 0; i < 60; i++) {
    const mv = window.__getMarsViewer && window.__getMarsViewer();
    if (mv && !mv.isDestroyed()) break;
    await sleep(500);
  }
  const read = () => ({
    lon: document.getElementById('gotoLon').placeholder,
    lat: document.getElementById('gotoLat').placeholder,
    alt: document.getElementById('coordAlt').textContent.trim(),
    altDisplay: getComputedStyle(document.getElementById('coordAlt')).display,
    homeHidden: document.getElementById('btnHome').classList.contains('hidden'),
  });
  const before = read();
  // 触发 updateCursorCoord：在火星 canvas 中心派发 mousemove
  const mv = window.__getMarsViewer();
  const cv = mv.scene.canvas;
  const rect = cv.getBoundingClientRect();
  const ev = new MouseEvent('mousemove', { clientX: rect.left + rect.width/2, clientY: rect.top + rect.height/2, bubbles: true });
  document.dispatchEvent(ev);
  await sleep(300);
  const afterHover = read();
  // 相机正下方（非悬停）刷新
  if (window.refreshCoordUI) window.refreshCoordUI();
  await sleep(200);
  const afterRefresh = read();
  return { before, afterHover, afterRefresh, canvasRect: { w: Math.round(rect.width), h: Math.round(rect.height) } };
})()`);

console.log(JSON.stringify(out, null, 1));
edge.kill();
ws.close();
process.exit(0);
