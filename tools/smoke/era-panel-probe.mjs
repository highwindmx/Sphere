/**
 * 历史巡礼接管底部面板的专项探针：点「唐朝」后逐秒采样 #tourPanel 的归属与年份推进。
 * 用法：node tools/smoke/era-panel-probe.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const WS_PATH = 'C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js';
const { default: WebSocket } = await import(`file:///${WS_PATH}`);

const EDGE_BIN = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9398;
const URL = 'http://127.0.0.1:5008/';
const QUERY = process.argv[2] || '唐朝';

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
const errs = [];
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    errs.push((msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || '').slice(0, 400));
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    errs.push('[console.error] ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 400));
  }
});
function send(method, params = {}) {
  const i = ++id;
  ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise((res, rej) => pending.set(i, { res, rej }));
}
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __evalError: r.exceptionDetails.exception?.description };
  return r.result.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: URL });
for (let i = 0; i < 120; i++) {
  if (await evaluate(`!!document.getElementById('unifiedSearch')`)) break;
  await sleep(250);
}

const snap = () => evaluate(`(() => ({
  title: document.getElementById('tourTitle')?.textContent || '',
  clock: document.getElementById('tourClock')?.textContent || '',
  prog: document.getElementById('tourProgressText')?.textContent || '',
  hidden: document.getElementById('tourPanel')?.classList.contains('hidden'),
  enabled: !!window.historyAtlas?.isEnabled?.(),
  tl: (window.historyTimeline || []).length,
  eraStopFn: typeof window.__historyStopTour,
  rows: [...document.querySelectorAll('#shownLayers .sl-row')].map((r) => (r.classList.contains('on') ? '+' : '-') + r.querySelector('.sl-name').textContent.trim()),
}))()`);

console.log('BEFORE', JSON.stringify(await snap()));
await evaluate(`(async () => {
  const inp = document.getElementById('unifiedSearch');
  inp.focus(); inp.value = ${JSON.stringify(QUERY)}; inp.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 250));
  const b = [...document.querySelectorAll('#searchResults .sr-item')].find((x) => (x.querySelector('.sr-hint')?.textContent || '').includes('历史'));
  if (!b) return 'NO_BTN:' + document.getElementById('searchResults').textContent.slice(0, 120);
  b.click();
  return 'CLICKED';
})()`).then((r) => console.log('CLICK', r));

for (let s = 1; s <= 40; s++) {
  await sleep(1000);
  const st = await snap();
  console.log(`T+${s}s`, JSON.stringify(st));
  if (st.title && st.title.includes('历史时间轴') && st.clock) break;
}
console.log('ERRORS', JSON.stringify(errs.slice(0, 8), null, 2));
ws.close();
edge.kill();
