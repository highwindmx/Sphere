/**
 * 极区渲染诊断：真实 GIBS + 调试渐变（gibs-debug=1）两套，
 * 南极/北极、1000km/300km 各截一张，供人工 Read 看洞形状。
 * 渐变约定：北极=蓝(hue210)、南极=红(hue0)，瓦片满铺无透明——
 *   若极点区看到渐变色 → 影像确实渲染到该极；若看到深蓝底色 → 是洞。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';

const { default: WebSocket } = await import(`file:///C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js`);

const BASE = 'http://127.0.0.1:5008/';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const UD = 'C:/Users/KaishengMao/AppData/Local/Temp/sphere-gibs-diag';
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9235', '--disable-gpu', '--no-first-run', `--user-data-dir=${UD}`, 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { edge.kill(); } catch { /* ignore */ } };
process.on('exit', cleanup);

const OUTDIR = 'D:/Share/Scripts/Explore/sphere/tools';

const evalProbe = `(async (cfg) => {
  try {
    const el = document.getElementById('onlineSource');
    if (el) { el.value = 'gibs'; el.dispatchEvent(new Event('change')); }
    let mgr = null;
    for (let i = 0; i < 30; i++) { mgr = window.__imagerySourceMgr; if (mgr && mgr.currentId === 'gibs' && mgr.onlineLayer) break; await new Promise(r => setTimeout(r, 500)); }
    if (!mgr || mgr.currentId !== 'gibs' || !mgr.onlineLayer) return { err: 'switch failed' };
    const Cesium = window.Cesium, viewer = window.viewer;
    viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(cfg.lon, cfg.lat, cfg.h) });
    await new Promise(r => setTimeout(r, cfg.longWait ? 25000 : 7000));
    // 记录 Cesium 实际请求的瓦片（钩 requestImage）
    const layer = viewer.imageryLayers.get(0);
    const prov = layer._imageryProvider || layer.imageryProvider;
    let logged = false, rec = [];
    if (prov && prov.requestImage) {
      const orig = prov.requestImage.bind(prov);
      prov.requestImage = function (x, y, level) { if (!logged) rec.push({ x, y, level }); return orig(x, y, level); };
      logged = true;
    }
    await new Promise(r => setTimeout(r, 1500));
    const D2 = Cesium.Math.toDegrees;
    const rect = prov.tilingScheme.rectangle;
    return {
      cfg: cfg.tag,
      provRect: { s: +D2(rect.south).toFixed(2), n: +D2(rect.north).toFixed(2), w: +D2(rect.west).toFixed(2), e: +D2(rect.east).toFixed(2) },
      requestedSample: rec.slice(0, 40),
      layerCount: viewer.imageryLayers.length,
    };
  } catch(e){ return { fatal: String((e&&e.stack)||e) }; }
})`;

try {
  await sleep(2500);
  const list = await (await fetch('http://127.0.0.1:9235/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const send = (method, params = {}) => new Promise((res, rej) => { const id = Math.floor(Math.random() * 1e9); pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id, method, params })); });
  await send('Runtime.enable'); await send('Page.enable');

  const cfgs = [
    { debug: false, lon: 0, lat: 0, h: 1e6, tag: 'equator-real-1000km', longWait: true },
    { debug: false, lon: 20, lat: 0, h: 1e6, tag: 'africa-real-1000km', longWait: true },
    
  ];
  for (const cfg of cfgs) {
    const url = BASE + (cfg.debug ? '?gibs-debug=1' : '');
    await send('Page.navigate', { url }); await sleep(9000);
    const info = await (await send('Runtime.evaluate', { expression: `${evalProbe}(${JSON.stringify(cfg)})`, returnByValue: true, awaitPromise: true })).result.value;
    console.log(JSON.stringify(info));
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(`${OUTDIR}/gibs-diag-${cfg.tag}.png`, Buffer.from(shot.data, 'base64'));
  }
  process.exit(0);
} finally { cleanup(); }
