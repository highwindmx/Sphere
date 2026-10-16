/**
 * 接缝 overlap 修复后验证：跨 g4 边界的陆地瓦片（西非 L4 x=14 y=7，-18° 源台阶 Δ57）
 * 与海洋对照（L4 x=12 y=7，-36° 平海），看接缝列梯度是否降到背景水平。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const { default: WebSocket } = await import(`file:///C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js`);
const URL = 'http://127.0.0.1:5008/';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const UD = 'C:/Users/KaishengMao/AppData/Local/Temp/sphere-gibs-seamverify';
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9236', '--disable-gpu', '--no-first-run', `--user-data-dir=${UD}`, 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { edge.kill(); } catch { /* ignore */ } };
process.on('exit', cleanup);

const probe = `(async () => {
  try {
    const Cesium = window.Cesium, viewer = window.viewer;
    const el = document.getElementById('onlineSource');
    el.value = 'gibs'; el.dispatchEvent(new Event('change'));
    let mgr = null;
    for (let i = 0; i < 30; i++) { mgr = window.__imagerySourceMgr; if (mgr && mgr.currentId === 'gibs' && mgr.onlineLayer) break; await new Promise(r => setTimeout(r, 500)); }
    if (!mgr || !mgr.onlineLayer) return { err: 'switch failed' };
    await new Promise(r => setTimeout(r, 1000));
    const layer = viewer.imageryLayers.get(0);
    const prov = layer._imageryProvider || layer.imageryProvider;
    const tiles = [
      { x: 14, y: 7, level: 4, jCol: 102.4, note: '西非 -18 陆地边界(maxΔ57)' },
      { x: 12, y: 7, level: 4, jCol: 204.8, note: '大西洋 -36 海洋(对照)' },
      { x: 13, y: 7, level: 4, jCol: 102.4, note: '西非 -18 另一块' },
    ];
    const out = [];
    for (const t of tiles) {
      try {
        const cv = await prov.requestImage(t.x, t.y, t.level);
        const w = cv.width, h = cv.height;
        const d = cv.getContext('2d').getImageData(0, 0, w, h).data;
        const lum = (x, y) => { const i = (y * w + x) * 4; return d[i] + d[i+1] + d[i+2]; };
        const colG = new Float64Array(w);
        for (let x = 0; x < w - 1; x++) { let s = 0; for (let y = 0; y < h; y++) s += Math.abs(lum(x+1, y) - lum(x, y)); colG[x] = s / h; }
        const md = [...colG].sort((a,b)=>a-b)[Math.floor(w/2)];
        const j = Math.floor(t.jCol);
        out.push({ ...t, seamColGrad: +colG[j].toFixed(2), seamColGrad2: +colG[j+1].toFixed(2), medianGrad: +md.toFixed(2) });
      } catch (e) { out.push({ ...t, error: String(e && e.message || e) }); }
    }
    return out;
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
  console.log(JSON.stringify(await (await send('Runtime.evaluate', { expression: probe, returnByValue: true, awaitPromise: true })).result.value, null, 2));
  process.exit(0);
} finally { cleanup(); }
