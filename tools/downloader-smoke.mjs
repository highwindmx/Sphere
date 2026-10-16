/**
 * 下载器 GUI 页面冒烟（headless Edge + CDP）
 * 验证：页面 200、无 JS 报错、4 个任务卡片 + 日志面板渲染、状态接口可达。
 * 用法：先起 app.py，再 node tools/downloader-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const WS_PATH = 'C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js';
const { default: WebSocket } = await import(`file:///${WS_PATH}`);

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9334;
const URL = 'http://127.0.0.1:5008/downloader';

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
// 等 scan 表异步填充（后端统计 ~1s，最多等 10s）
for (let i = 0; i < 20; i++) {
  await sleep(500);
  const filled = await evaluate(`(() => {
    const tb = document.querySelector('#scanTable tbody');
    if (!tb) return false;
    const t = tb.innerText;
    return t && !t.includes('加载中') && t.trim().length > 0;
  })()`).catch(() => false);
  if (filled) break;
}
await sleep(500);

const report = {};
try {
  report.ui = await evaluate(`(() => ({
    title: document.title,
    cards: document.querySelectorAll('.card').length,
    buttons: [...document.querySelectorAll('button.primary[data-kind]')].map((b) => b.dataset.kind),
    scanRows: document.querySelectorAll('#scanTable tbody tr').length,
    scanText: document.querySelector('#scanTable tbody').innerText.replace(/\\s+/g, ' ').slice(0, 220),
    lunarHints: [$('lunarImgState').textContent.trim(), $('lunarDemState').textContent.trim()],
    statePill: $('taskPill').textContent,
  }))()`);
} catch (e) { report.uiErr = String(e.message); }

report.jsErrors = errors;
console.log(JSON.stringify(report, null, 1));
ws.close();
edge.kill();
process.exit(0);
