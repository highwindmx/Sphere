/**
 * 真实渲染 + 屏幕中心像素采样，最终裁决「500km 南极洞」。
 *   - ?gibs-debug=1：南极应为红(hue≈0)；若读到 baseColor 深蓝(hue≈217) → 漏贴
 *   - 分别取 300km / 500km 相机高度对准南极，对比 hue
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const { default: WebSocket } = await import(`file:///C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js`);

const URL = 'http://127.0.0.1:5008/?gibs-debug=1';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9235', '--disable-gpu', '--no-first-run', '--user-data-dir=C:/Users/KaishengMao/AppData/Local/Temp/sphere-gibs-render-profile', 'about:blank'], { stdio: 'ignore', detached: false });
const cleanup = () => { try { edge.kill(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

const evalProbe = `(async () => {
  const el = document.getElementById('onlineSource');
  el.value = 'gibs'; el.dispatchEvent(new Event('change'));
  let mgr = null;
  for (let i = 0; i < 24; i++) { mgr = window.__imagerySourceMgr; if (mgr && mgr.currentId === 'gibs' && mgr.onlineLayer) break; await new Promise(r => setTimeout(r, 500)); }
  if (!mgr || mgr.currentId !== 'gibs' || !mgr.onlineLayer) return { err: 'switch failed' };
  const C = window.Cesium, v = window.viewer, scene = v.scene;
  function rgbHue(r,g,b){ r/=255;g/=255;b/=255; const mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn; let h=0; if(d!==0){ if(mx===r)h=((g-b)/d)%6; else if(mx===g)h=(b-r)/d+2; else h=(r-g)/d+4; h*=60; if(h<0)h+=360; } return Math.round(h); }
  function sampleSouth(hkm) {
    v.camera.setView({ destination: C.Cartesian3.fromDegrees(0, -88, hkm * 1000),
      orientation: { heading: 0, pitch: -C.Math.PI_OVER_TWO, roll: 0 } });
    scene.render();
    const canvas = scene.canvas, gl = scene.context._gl;
    const cx = canvas.width >> 1, cy = canvas.height >> 1;
    const px = new Uint8Array(4);
    gl.readPixels(cx, cy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return { hkm, rgb: [px[0], px[1], px[2]], hue: rgbHue(px[0], px[1], px[2]) };
  }
  const out = [];
  for (const h of [300, 500, 1000, 2000]) { await new Promise(r=>setTimeout(r,800)); out.push(sampleSouth(h)); }
  return { out };
})()`;

try {
  await sleep(2500);
  const list = await (await fetch('http://127.0.0.1:9235/json/list')).json();
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
