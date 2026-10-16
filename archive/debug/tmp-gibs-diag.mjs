// 临时诊断：GIBS 源切换为何不生效
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
const { default: WebSocket } = await import(`file:///C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js`);
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9231', '--disable-gpu', '--no-first-run', '--user-data-dir=C:/Users/KaishengMao/AppData/Local/Temp/sphere-gibsdiag', 'about:blank'], { stdio: 'ignore', detached: false });
process.on('exit', () => { try { edge.kill(); } catch {} });
try {
  await sleep(2500);
  const list = await (await fetch('http://127.0.0.1:9231/json/list')).json();
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  const pending = new Map();
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = Math.floor(Math.random() * 1e9);
    pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;

  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:5008/' });
  await sleep(9000);

  const out = await evaluate(`(async () => {
    const mgr = window.__imagerySourceMgr;
    const before = { currentId: mgr.currentId, hasLayer: !!mgr.onlineLayer };
    // 直接调 create() 看是否抛错
    let createErr = null;
    try {
      const def = [...arguments] // noop
    } catch {}
    let providerOk = null;
    try {
      const src = mgr.constructor; // 无用，仅为占位
      const layer = mgr.applyOnlineLayer('gibs');
      providerOk = { layer: !!layer, currentId: mgr.currentId };
    } catch (e) { createErr = String(e && e.message || e); }
    return {
      before,
      providerOk,
      createErr,
      status: (document.getElementById('status') || {}).textContent,
      selectValue: (document.getElementById('onlineSource') || {}).value,
      selectOptions: [...document.getElementById('onlineSource').options].map(o => o.value),
    };
  })()`);
  console.log(JSON.stringify(out, null, 2));
} finally {
  try { edge.kill(); } catch {}
}
