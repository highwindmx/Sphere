/**
 * 用 performance.getEntriesByType('resource') 查看 GIBS 瓦片在浏览器里的
 * 真实下载情况（transferSize/duration/responseStatus）——判断"洞"是不是加载慢/失败。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const { default: WebSocket } = await import(`file:///C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js`);
const URL = 'http://127.0.0.1:5008/';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const UD = 'C:/Users/KaishengMao/AppData/Local/Temp/sphere-gibs-perf';
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9238', '--disable-gpu', '--no-first-run', `--user-data-dir=${UD}`, 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { edge.kill(); } catch { /* ignore */ } };
process.on('exit', cleanup);

const probe = `(async () => {
  try {
    const el = document.getElementById('onlineSource');
    el.value = 'gibs'; el.dispatchEvent(new Event('change'));
    let mgr = null;
    for (let i = 0; i < 30; i++) { mgr = window.__imagerySourceMgr; if (mgr && mgr.currentId === 'gibs' && mgr.onlineLayer) break; await new Promise(r => setTimeout(r, 500)); }
    if (!mgr || !mgr.onlineLayer) return { err: 'switch failed' };
    const Cesium = window.Cesium, viewer = window.viewer;
    viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(0, -88, 1e6) });
    await new Promise(r => setTimeout(r, 15000));
    const res = performance.getEntriesByType('resource').filter(e => e.name.includes('gibs.earthdata'));
    const stat = res.map(e => ({ u: e.name.split('500m/')[1], size: e.transferSize, ms: Math.round(e.duration), st: e.responseStatus }));
    const failed = stat.filter(s => !s.size);
    const slow = stat.filter(s => s.ms > 3000).sort((a,b)=>b.ms-a.ms).slice(0, 12);
    return { total: res.length, okCount: stat.filter(s => s.st === 200).length, failedCount: failed.length, failedSample: failed.slice(0, 10), slowest: slow, sample: stat.slice(0, 20) };
  } catch (e) { return { fatal: String((e && e.stack) || e) }; }
})()`;

try {
  await sleep(2500);
  const list = await (await fetch('http://127.0.0.1:9238/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const send = (method, params = {}) => new Promise((res, rej) => { const id = Math.floor(Math.random() * 1e9); pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id, method, params })); });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: URL }); await sleep(9000);
  const r = await (await send('Runtime.evaluate', { expression: probe, returnByValue: true, awaitPromise: true })).result.value;
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
} finally { cleanup(); }
