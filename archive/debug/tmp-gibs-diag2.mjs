// 临时诊断 2：复现 冒烟 step2→step3 序列，逐步打印内部状态
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
const { default: WebSocket } = await import(`file:///C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js`);
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9232', '--disable-gpu', '--no-first-run', '--user-data-dir=C:/Users/KaishengMao/AppData/Local/Temp/sphere-gibsdiag2', 'about:blank'], { stdio: 'ignore', detached: false });
process.on('exit', () => { try { edge.kill(); } catch {} });
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  await sleep(2500);
  const list = await (await fetch('http://127.0.0.1:9232/json/list')).json();
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  const pending = new Map();
  const exceptions = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description || ''));
  });
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

  const snap = () => evaluate(`(() => ({
    currentId: window.__imagerySourceMgr.currentId,
    profileId: (window.__polarDebug() || {}).polarProfile && window.__polarDebug().polarProfile.id,
    statusText: (document.getElementById('polarProfileInfo') || {}).textContent,
    status: (document.getElementById('status') || {}).textContent.slice(0, 80),
  }))()`);

  console.log('初始:', JSON.stringify(await snap()));
  // step2：切 aws-s2
  await evaluate(`(() => { const el = document.getElementById('onlineSource'); el.value = 'aws-s2'; el.dispatchEvent(new Event('change')); })()`);
  await sleepMs(2500);
  console.log('切aws后:', JSON.stringify(await snap()));
  // step3：切 gibs（带 try/catch 捕获同步异常）
  const r3 = await evaluate(`(() => {
    try {
      const el = document.getElementById('onlineSource');
      el.value = 'gibs';
      el.dispatchEvent(new Event('change'));
      return { dispatched: true, value: el.value };
    } catch (e) { return { dispatched: false, err: String(e && e.message || e) }; }
  })()`);
  console.log('dispatch gibs:', JSON.stringify(r3));
  await sleepMs(3000);
  console.log('切gibs后:', JSON.stringify(await snap()));
  // 再手动调一次 setSource 看报什么
  const r4 = await evaluate(`(() => {
    try {
      window.__imagerySourceMgr.setSource('gibs');
      return { ok: true, currentId: window.__imagerySourceMgr.currentId };
    } catch (e) { return { ok: false, err: String(e && e.message || e), stack: String(e && e.stack || '').slice(0, 300) }; }
  })()`);
  console.log('手动setSource:', JSON.stringify(r4));
  await sleepMs(1500);
  console.log('最终:', JSON.stringify(await snap()));
  console.log('exceptions:', JSON.stringify(exceptions.slice(0, 3), null, 2));
} finally {
  try { edge.kill(); } catch {}
}
