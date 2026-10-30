/**
 * 万能页内求值器：加载页面 → 在页面上下文执行一段 JS（可 await）→ 打印结果与异常。
 * 用法：node tools/smoke/eval-page.mjs "(async()=>{ ... return x })()"
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const WS_PATH = 'C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js';
const { default: WebSocket } = await import(`file:///${WS_PATH}`);

const EDGE_BIN = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9399;
const URL = 'http://127.0.0.1:5008/';
const EXPR = process.argv[2];
if (!EXPR) { console.error('用法: node tools/smoke/eval-page.mjs "<表达式>"'); process.exit(1); }

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
    logs.push('[exception] ' + (msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || '').slice(0, 500));
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    logs.push(`[${msg.params.type}] ` + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 400));
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
  if (await send('Runtime.evaluate', { expression: '!!document.getElementById("unifiedSearch")', returnByValue: true }).then((r) => r.result.value)) break;
  await sleep(250);
}

const r = await send('Runtime.evaluate', { expression: EXPR, awaitPromise: true, returnByValue: true });
if (r.exceptionDetails) {
  console.log('EVAL_ERROR', r.exceptionDetails.exception?.description || r.exceptionDetails.text);
} else {
  console.log('RESULT', JSON.stringify(r.result.value, null, 2));
}
console.log('LOGS', JSON.stringify(logs.slice(-15), null, 2));
ws.close();
edge.kill();
