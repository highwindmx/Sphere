/**
 * 阶段 D — 同机位 A/B 对照：GIBS vs Esri World Imagery（标准 provider）
 * 南极 1000km / 500km 各截一张，肉眼 + 白色占比对比。
 * 若 esri 南极大片白、gibs 只楔形白 → 坐实 gibs 铺设问题；若两者相同 → 相机/球体层问题。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';

const { default: WebSocket } = await import(`file:///C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js`);

const URL = 'http://127.0.0.1:5008/';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const UD = 'C:/Users/KaishengMao/AppData/Local/Temp/sphere-gibs-d';
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9234', '--disable-gpu', '--no-first-run', `--user-data-dir=${UD}`, 'about:blank'], { stdio: 'ignore', detached: false });
const cleanup = () => { try { edge.kill(); } catch { /* ignore */ } };
process.on('exit', cleanup);

const OUTDIR = 'D:/Share/Scripts/Explore/sphere/tools';

const evalProbe = `(async (p) => {
  try {
    const el = document.getElementById('onlineSource');
    el.value = p.source;
    el.dispatchEvent(new Event('change'));
    let mgr = null;
    for (let i = 0; i < 24; i++) { mgr = window.__imagerySourceMgr; if (mgr && mgr.currentId === p.source && mgr.onlineLayer) break; await new Promise(r => setTimeout(r, 500)); }
    if (!mgr || mgr.currentId !== p.source || !mgr.onlineLayer) return { err: 'switch failed', want: p.source, got: mgr && mgr.currentId };
    const Cesium = window.Cesium, viewer = window.viewer;
    viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.h) });
    await new Promise(r => setTimeout(r, 7000));
    // 极冠合成层状态（排除它参与渲染）
    const stack = [];
    for (let i = 0; i < viewer.imageryLayers.length; i++) {
      const ly = viewer.imageryLayers.get(i);
      stack.push({ i, name: ly.imageryProvider && ly.imageryProvider.constructor && ly.imageryProvider.constructor.name, show: ly.show });
    }
    return { ok: true, source: p.source, stack };
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
    { source: 'esri', lon: 0, lat: -88, h: 1e6, tag: 'esri-south-1000km' },
    { source: 'gibs', lon: 0, lat: -88, h: 1e6, tag: 'gibs-south-1000km' },
    { source: 'esri', lon: 0, lat: -88, h: 5e5, tag: 'esri-south-500km' },
    { source: 'gibs', lon: 0, lat: -88, h: 5e5, tag: 'gibs-south-500km' },
  ];
  const results = [];
  for (const p of cases) {
    const r = await (await send('Runtime.evaluate', { expression: `${evalProbe}(${JSON.stringify(p)})`, returnByValue: true, awaitPromise: true })).result.value;
    results.push(r);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`${OUTDIR}/ab-${p.tag}.png`, Buffer.from(shot.data, 'base64'));
  }
  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
} finally { cleanup(); }
