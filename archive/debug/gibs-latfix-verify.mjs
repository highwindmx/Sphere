/**
 * 纬度修正验证（2026-10-16）：真实 GIBS + 经纬网 + 调试渐变，世界视图看赤道/两极是否对称。
 * 调试渐变约定：北极=蓝(hue210)、赤道=绿(hue105)、南极=红(hue0)，分布应关于赤道对称。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';

const { default: WebSocket } = await import(`file:///C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js`);

const BASE = 'http://127.0.0.1:5008/';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const UD = 'C:/Users/KaishengMao/AppData/Local/Temp/sphere-gibs-latfix';
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9236', '--disable-gpu', '--no-first-run', `--user-data-dir=${UD}`, 'about:blank'], { stdio: 'ignore' });
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
    const D2 = Cesium.Math.toDegrees;
    const prov = viewer.imageryLayers.get(0)._imageryProvider || viewer.imageryLayers.get(0).imageryProvider;
    const rect = prov.tilingScheme.rectangle;
    return {
      cfg: cfg.tag,
      provRect: { s: +D2(rect.south).toFixed(2), n: +D2(rect.north).toFixed(2) },
      layerCount: viewer.imageryLayers.length,
      g2span: 288/Math.pow(2,2),
    };
  } catch(e){ return { fatal: String((e&&e.stack)||e) }; }
})`;

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

  const cfgs = [
    // 世界视图（赤道居中，看 EQ 线是否在地理赤道、南北是否对称）
    { debug: false, lon: 0, lat: 0, h: 1.2e7, tag: 'world-real-eq', longWait: true },
    { debug: false, lon: 0, lat: 35, h: 2.6e7, tag: 'world-real-tilt', longWait: true },
    // 调试渐变（无需网络）：看 N→S 颜色是否关于赤道对称
    { debug: true,  lon: 0, lat: 0, h: 1.2e7, tag: 'world-debug-eq', longWait: false },
  ];
  for (const cfg of cfgs) {
    const url = BASE + (cfg.debug ? '?gibs-debug=1' : '?gibs-grid=1');
    await send('Page.navigate', { url }); await sleep(9000);
    const info = await (await send('Runtime.evaluate', { expression: `${evalProbe}(${JSON.stringify(cfg)})`, returnByValue: true, awaitPromise: true })).result.value;
    console.log(JSON.stringify(info));
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(`${OUTDIR}/gibs-latfix-${cfg.tag}.png`, Buffer.from(shot.data, 'base64'));
  }
  process.exit(0);
} finally { cleanup(); }
