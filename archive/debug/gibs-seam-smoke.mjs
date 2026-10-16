/**
 * 拼接线定位：① 扫合成画布列亮度/透明度找缝（Cesium L2 瓦片，内含 g2 边界 -36/-108）；
 * ② 对比 GIBS 相邻源瓦片边缘像素，分辨「我们拼出来的缝」vs「源数据自带的缝」。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const { default: WebSocket } = await import(`file:///C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js`);
const URL = 'http://127.0.0.1:5008/';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const UD = 'C:/Users/KaishengMao/AppData/Local/Temp/sphere-gibs-seam';
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
    // 等 warmup 预取完成（g0+g2 共 17 张）
    await new Promise(r => setTimeout(r, 20000));

    // 列扫描：每列平均 RGB + 非透明像素数；找出与邻域均值的突降列
    const scan = (cv) => {
      const ctx = cv.getContext('2d');
      const { width: w, height: h } = cv;
      const d = ctx.getImageData(0, 0, w, h).data;
      const colMean = new Array(w).fill(0);
      const colAlpha = new Array(w).fill(0);
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let y = 0; y < h; y++) { const i = (y * w + x) * 4; s += (d[i] + d[i + 1] + d[i + 2]) / 3; if (d[i + 3] < 250) colAlpha[x]++; }
        colMean[x] = s / h;
      }
      const dips = [];
      for (let x = 2; x < w - 2; x++) {
        const nb = (colMean[x - 2] + colMean[x - 1] + colMean[x + 1] + colMean[x + 2]) / 4;
        const drop = nb - colMean[x];
        if (drop > 3 || colAlpha[x] > 0) dips.push({ x, drop: +drop.toFixed(1), alpha: colAlpha[x], mean: +colMean[x].toFixed(1) });
      }
      return { dips: dips.slice(0, 20), dipCount: dips.length };
    };

    const tiles = [
      { x: 3, y: 1, level: 2, note: 'lon -45..0 lat 0..45, g2边界-36在px51.2' },
      { x: 1, y: 1, level: 2, note: 'lon -135..-90, g2边界-108在px153.6' },
      { x: 2, y: 1, level: 2, note: '对照: lon -90..-45 无g2边界' },
    ];
    const out = [];
    for (const t of tiles) {
      try {
        const cv = await prov.requestImage(t.x, t.y, t.level);
        out.push({ ...t, ...scan(cv) });
      } catch (e) { out.push({ ...t, error: String(e && e.message || e) }); }
    }
    return { out };
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
