/**
 * 阶段 E — 决定性实验：给 GIBS 强制打开极冠合成层（Yx.show=true）
 * 若打开后南极变完整白盖 → globe 渲染极区几何没问题，问题在 GIBS 影像→globe 映射；
 * 若仍是楔形 → globe 渲染层问题。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';

const { default: WebSocket } = await import(`file:///C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js`);

const URL = 'http://127.0.0.1:5008/';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const UD = 'C:/Users/KaishengMao/AppData/Local/Temp/sphere-gibs-e';
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9234', '--disable-gpu', '--no-first-run', `--user-data-dir=${UD}`, 'about:blank'], { stdio: 'ignore', detached: false });
const cleanup = () => { try { edge.kill(); } catch { /* ignore */ } };
process.on('exit', cleanup);

const OUTDIR = 'D:/Share/Scripts/Explore/sphere/tools';

const evalProbe = `(async (p) => {
  try {
    const el = document.getElementById('onlineSource');
    el.value = 'gibs';
    el.dispatchEvent(new Event('change'));
    let mgr = null;
    for (let i = 0; i < 24; i++) { mgr = window.__imagerySourceMgr; if (mgr && mgr.currentId === 'gibs' && mgr.onlineLayer) break; await new Promise(r => setTimeout(r, 500)); }
    if (!mgr || mgr.currentId !== 'gibs' || !mgr.onlineLayer) return { err: 'switch failed' };
    const Cesium = window.Cesium, viewer = window.viewer;

    // 等防抖隐藏逻辑跑完，再强制打开极冠合成层
    await new Promise(r => setTimeout(r, 3000));
    const names = [];
    let patchLayer = null;
    for (let i = 0; i < viewer.imageryLayers.length; i++) {
      const ly = viewer.imageryLayers.get(i);
      const nm = ly.imageryProvider && ly.imageryProvider.constructor && ly.imageryProvider.constructor.name;
      names.push({ i, nm, show: ly.show });
      if (nm !== 'GibsBlueMarbleProvider') patchLayer = ly;
    }
    if (patchLayer) { patchLayer.show = true; }
    const forcedShow = patchLayer ? patchLayer.show : null;

    viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.h) });
    await new Promise(r => setTimeout(r, 7000));
    // 防抖可能又把它关了，再强制一次并记录
    let finalShow = null;
    if (patchLayer) { patchLayer.show = true; finalShow = patchLayer.show; }
    await new Promise(r => setTimeout(r, 1200));
    if (patchLayer) { patchLayer.show = true; finalShow = patchLayer.show; }

    const stack = [];
    for (let i = 0; i < viewer.imageryLayers.length; i++) {
      const ly = viewer.imageryLayers.get(i);
      stack.push({ i, nm: ly.imageryProvider && ly.imageryProvider.constructor && ly.imageryProvider.constructor.name, show: ly.show });
    }
    return { ok: true, forcedShow, finalShow, names, stack };
  } catch(e){ return { fatal: String((e&&e.stack)||e) }; }
})`;

try {
  await sleep(2500);
  const list = await (await fetch('http://127.0.0.1:9234/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const send = (method, params = {}) => new Promise((res, rej) => { const id = Math.floor(Math.random() * 1e9); pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id, method, params })); });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: URL }); await sleep(9000);

  const cases = [
    { lon: 0, lat: -88, h: 1e6, tag: 'gibs-patchon-1000km' },
    { lon: 0, lat: -88, h: 5e5, tag: 'gibs-patchon-500km' },
  ];
  const results = [];
  for (const p of cases) {
    const r = await (await send('Runtime.evaluate', { expression: `${evalProbe}(${JSON.stringify(p)})`, returnByValue: true, awaitPromise: true })).result.value;
    results.push(r);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`${OUTDIR}/e-${p.tag}.png`, Buffer.from(shot.data, 'base64'));
  }
  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
} finally { cleanup(); }
