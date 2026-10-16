/**
 * debug 模式下，测各 level 真正的南极瓦片（Cesium 最南行 y=2^L-1）的中心色相。
 * debug 色相编码：hue = 210 - (r/(ROWS-1))*210 —— 北极(r=0)→210°蓝，南极(r=max)→0°红。
 *   若某 level 真正南极瓦片中心 hue 不是红（≈0）而是蓝/绿 → 该 level 映射把南极内容错位 → bug 定位。
 * 顺带测各 level 的 coverage（是否全填充）。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const { default: WebSocket } = await import(`file:///C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js`);

const URL = 'http://127.0.0.1:5008/?gibs-debug=1';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9234', '--disable-gpu', '--no-first-run', '--user-data-dir=C:/Users/KaishengMao/AppData/Local/Temp/sphere-gibs-lv-profile', 'about:blank'], { stdio: 'ignore', detached: false });
const cleanup = () => { try { edge.kill(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

const evalProbe = `(async () => {
  const el = document.getElementById('onlineSource');
  el.value = 'gibs'; el.dispatchEvent(new Event('change'));
  let mgr = null;
  for (let i = 0; i < 24; i++) { mgr = window.__imagerySourceMgr; if (mgr && mgr.currentId === 'gibs' && mgr.onlineLayer) break; await new Promise(r => setTimeout(r, 500)); }
  if (!mgr || mgr.currentId !== 'gibs' || !mgr.onlineLayer) return { err: 'switch failed', currentId: mgr && mgr.currentId };
  const p = mgr.onlineLayer.imageryProvider;
  function rgbHue(r,g,b){ r/=255;g/=255;b/=255; const mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn; let h=0; if(d!==0){ if(mx===r)h=((g-b)/d)%6; else if(mx===g)h=(b-r)/d+2; else h=(r-g)/d+4; h*=60; if(h<0)h+=360; } return Math.round(h); }
  const tiles = [
    [0,127,7],[80,127,7],[159,127,7],
    [0,63,6],[40,63,6],[79,63,6],
    [0,31,5],[20,31,5],[39,31,5],
    [0,15,4],[10,15,4],[19,15,4],
    [3,7,3],[1,3,2],
  ];
  const out = [];
  for (const [x,y,z] of tiles) {
    try {
      const cv = await p.requestImage(x, y, z);
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      const d = ctx.getImageData(0,0,cv.width,cv.height).data;
      const n = cv.width*cv.height; let opaque=0;
      // 中心像素
      const ci = ((cv.height>>1)*cv.width + (cv.width>>1))*4;
      const hue = rgbHue(d[ci], d[ci+1], d[ci+2]);
      for (let i=3;i<d.length;i+=4) if(d[i]===255) opaque++;
      out.push({ t:[x,y,z], hue, coverage:+(opaque/n).toFixed(3) });
    } catch (e) { out.push({ t:[x,y,z], error:String((e&&e.message)||e) }); }
  }
  return { rectNorth: p.tilingScheme.rectangle.north, tiles: out };
})()`;

try {
  await sleep(2500);
  const list = await (await fetch('http://127.0.0.1:9234/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map(); const errors = [];
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text); });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const send = (method, params = {}) => new Promise((res, rej) => { const id = Math.floor(Math.random() * 1e9); pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id, method, params })); });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: URL }); await sleep(9000);
  const report = await (await send('Runtime.evaluate', { expression: evalProbe, returnByValue: true, awaitPromise: true })).result.value;
  console.log(JSON.stringify({ report, errors }, null, 2));
  process.exit(0);
} finally { cleanup(); }
