/**
 * 图源设置 demo 冒烟（headless Edge + CDP）
 * 验证：demo 页 Cesium 地球启动、面板在右、地球占比 ≥60%、无 JS 异常。
 * 用法：先启动 app.py，再 node tools/source-settings-demo-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
const WS_PATH = 'C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js';
const { default: WebSocket } = await import(`file:///${WS_PATH}`);

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9355;
const URL = 'http://127.0.0.1:5008/source-settings-demo.html';

const edge = spawn(EDGE, [
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
const errors = [];
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    errors.push(msg.params.exceptionDetails?.text + ' ' + (msg.params.exceptionDetails?.exception?.description ?? ''));
  }
});
function send(method, params = {}) {
  const i = ++id;
  ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise((res, rej) => pending.set(i, { res, rej }));
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval error');
  return r.result.value;
}

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: URL });
await sleep(14000);

const report = {};
try {
  report.layout = await evaluate(`(() => {
    const stage = document.getElementById('stage').getBoundingClientRect();
    const panel = document.getElementById('panel').getBoundingClientRect();
    return {
      vw: innerWidth, vh: innerHeight,
      stageW: Math.round(stage.width), panelW: Math.round(panel.width),
      stagePct: Math.round(stage.width / innerWidth * 100),
      panelPct: Math.round(panel.width / innerWidth * 100),
    };
  })()`);
} catch (e) { report.layoutErr = String(e.message); }
try {
  report.globe = await evaluate(`(() => {
    const c = document.querySelector('#globe canvas');
    return { hasCanvas: !!c, w: c && c.width, h: c && c.height };
  })()`);
} catch (e) { report.globeErr = String(e.message); }
try {
  report.srcRows = await evaluate(`document.querySelectorAll('#src-list .src').length`);
  report.localFirstToggles = await evaluate(`document.querySelectorAll('#src-list .act-local-first').length`);
  report.tierBtns = await evaluate(`document.querySelectorAll('#src-list .act-tier').length`);
  report.docLinks = await evaluate(`document.querySelectorAll('#src-list a.chip').length`);
} catch (e) { report.srcRowsErr = String(e.message); }
try {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const { writeFileSync } = await import('node:fs');
  writeFileSync('tools/.source-settings-demo.png', Buffer.from(shot.data, 'base64'));
  report.screenshot = 'tools/.source-settings-demo.png';
} catch (e) { report.shotErr = String(e.message); }

report.errors = errors.slice(0, 5);
console.log(JSON.stringify(report, null, 2));
ws.close();
edge.kill();
process.exit(0);
