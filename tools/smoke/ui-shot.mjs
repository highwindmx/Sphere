/**
 * 通用 UI 截图：打开页面 → （可选）执行一段 JS 调整视角/状态 → 等瓦片加载完 → 截图。
 * 用法：node tools/smoke/ui-shot.mjs <out.png> ["<可选 JS 表达式>"]
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';

const WS_PATH = 'C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js';
const { default: WebSocket } = await import(`file:///${WS_PATH}`);

const EDGE_BIN = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9401;
const URL = 'http://127.0.0.1:5008/';
const OUT = process.argv[2] || 'tools/shots/earth/ui-shot.png';
const EXPR = process.argv[3] || '';

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
if (!wsUrl) { edge.kill(); throw new Error('无法连接调试端口'); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let id = 0;
const pending = new Map();
const logs = [];
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    logs.push('[exception] ' + (msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || '').slice(0, 400));
  }
});
function send(method, params = {}) {
  const i = ++id;
  ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise((res, rej) => pending.set(i, { res, rej }));
}

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: URL });
for (let i = 0; i < 160; i++) {
  const ok = await send('Runtime.evaluate', { expression: '!!document.getElementById("unifiedSearch")', returnByValue: true })
    .then((r) => r.result.value);
  if (ok) break;
  await sleep(250);
}
if (EXPR) {
  const r = await send('Runtime.evaluate', { expression: EXPR, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) console.log('EXPR_ERROR', r.exceptionDetails.exception?.description || r.exceptionDetails.text);
}
// 等瓦片加载完再等 1.5s（否则拍到"均匀苍白膜"，见项目备忘）
for (let i = 0; i < 80; i++) {
  const loaded = await send('Runtime.evaluate', {
    expression: '!!window.viewer && window.viewer.scene.globe.tilesLoaded', returnByValue: true,
  }).then((r) => r.result.value).catch(() => false);
  if (loaded) break;
  await sleep(300);
}
await sleep(1500);
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
console.log('SAVED', OUT, logs.length ? JSON.stringify(logs) : '');
ws.close();
edge.kill();
