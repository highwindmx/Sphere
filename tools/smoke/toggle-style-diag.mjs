/**
 * toggle-style-diag.mjs — 量 .osm-mode-toggle 按钮本体的实际尺寸与计算样式，
 * 定位「wrapper 高 36 而非 28」的来源。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const WS_PATH = 'C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js';
const { default: WebSocket } = await import(`file:///${WS_PATH}`);

const EDGE_BIN = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9399;
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
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __evalError: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r.result.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: URL });

const ready = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 160; i++) {
    if (window.Cesium && window.viewer) return { ok: true };
    await sleep(250);
  }
  return { ok: false };
})()`);
if (!ready.ok) { edge.kill(); throw new Error('页面未就绪'); }

await evaluate(`(async () => { const b = document.querySelector('.osm-nav-btn'); if (b) b.click(); return 1; })()`);

const out = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let ctl = null;
  for (let i = 0; i < 60; i++) { ctl = document.querySelector('#osmMap .osm-mode-ctl'); if (ctl) break; await sleep(500); }
  if (!ctl) return { timeout: true };
  const btn = ctl.querySelector('.osm-mode-toggle');
  const cs = getComputedStyle(btn);
  const csW = getComputedStyle(ctl);
  const rb = btn.getBoundingClientRect();
  const rc = ctl.getBoundingClientRect();
  return {
    btn: { w: +rb.width.toFixed(1), h: +rb.height.toFixed(1) },
    ctl: { w: +rc.width.toFixed(1), h: +rc.height.toFixed(1) },
    btnStyle: { height: cs.height, boxSizing: cs.boxSizing, padding: cs.padding, borderWidth: cs.borderWidth, display: cs.display, fontSize: cs.fontSize, lineHeight: cs.lineHeight },
    ctlStyle: { display: csW.display, padding: csW.padding, lineHeight: csW.lineHeight, fontSize: csW.fontSize, alignItems: csW.alignItems, height: csW.height },
  };
})()`);
console.log(JSON.stringify(out, null, 2));

ws.close();
edge.kill();
