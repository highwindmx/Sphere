/**
 * 浏览器内实测：Cesium 低空真实会用到的极点瓦片 (L5 y=31 / L6 y=63 / L7 y=127)
 * provider 输出透明度 + errorEvent 监听。真实模式（无 debug）。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const { default: WebSocket } = await import(`file:///C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js`);
const URL = 'http://127.0.0.1:5008/';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const UD = 'C:/Users/KaishengMao/AppData/Local/Temp/sphere-gibs-alpha';
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9236', '--disable-gpu', '--no-first-run', `--user-data-dir=${UD}`, 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { edge.kill(); } catch { /* ignore */ } };
process.on('exit', cleanup);

const probe = `(async () => {
  try {
    const el = document.getElementById('onlineSource');
    el.value = 'gibs'; el.dispatchEvent(new Event('change'));
    let mgr = null;
    for (let i = 0; i < 30; i++) { mgr = window.__imagerySourceMgr; if (mgr && mgr.currentId === 'gibs' && mgr.onlineLayer) break; await new Promise(r => setTimeout(r, 500)); }
    if (!mgr || !mgr.onlineLayer) return { err: 'switch failed' };
    await new Promise(r => setTimeout(r, 1500));
    const layer = viewer.imageryLayers.get(0);
    const prov = layer._imageryProvider || layer.imageryProvider;
    const errs = [];
    prov.errorEvent.addEventListener((p, x, y, lv, e) => errs.push({ x, y, level: lv, msg: String(e && e.message || e) }));
    const D2 = Cesium.Math.toDegrees;
    const testTiles = [
      { x: 0, y: 31, level: 5 }, { x: 7, y: 31, level: 5 },
      { x: 0, y: 63, level: 6 }, { x: 7, y: 63, level: 6 },
      { x: 0, y: 127, level: 7 }, { x: 7, y: 127, level: 7 },
      { x: 0, y: 0, level: 7 },   // 北极
      { x: 4, y: 4, level: 3 },   // 赤道对照
    ];
    const out = [];
    for (const t of testTiles) {
      try {
        const cv = await prov.requestImage(t.x, t.y, t.level);
        const ctx = cv.getContext('2d');
        const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
        let trans = 0, n = cv.width * cv.height;
        for (let i = 3; i < d.length; i += 4) if (d[i] === 0) trans++;
        const rect = prov.tilingScheme.tileXYToRectangle(t.x, t.y, t.level);
        out.push({ ...t, transparentPct: +(100 * trans / n).toFixed(2), s: +D2(rect.south).toFixed(2), n2: +D2(rect.north).toFixed(2) });
      } catch (e) { out.push({ ...t, error: String(e && e.message || e) }); }
    }
    return { errs, out };
  } catch (e) { return { fatal: String((e && e.stack) || e) }; }
})()`;

try {
  await sleep(2500);
  const list = await (await fetch('http://127.0.0.1:9236/json/list')).json();
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
