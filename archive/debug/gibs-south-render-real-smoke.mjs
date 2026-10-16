/**
 * 真实 GIBS 模式（不带 ?gibs-debug）渲染采样南极中心 rgb。
 *   - 接近 globe.baseColor [38,82,124] → 南极露底（洞，baseColor 深蓝）
 *   - 接近白色 [240,240,240] → GIBS 白冰贴上（无洞）
 *   - 深蓝海洋 → 正常海洋（非洞）
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const { default: WebSocket } = await import(`file:///C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js`);

const URL = 'http://127.0.0.1:5008/';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9236', '--disable-gpu', '--no-first-run', '--user-data-dir=C:/Users/KaishengMao/AppData/Local/Temp/sphere-gibs-real-profile', 'about:blank'], { stdio: 'ignore', detached: false });
const cleanup = () => { try { edge.kill(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

const evalProbe = `(async () => {
  const el = document.getElementById('onlineSource');
  el.value = 'gibs'; el.dispatchEvent(new Event('change'));
  let mgr = null;
  for (let i = 0; i < 24; i++) { mgr = window.__imagerySourceMgr; if (mgr && mgr.currentId === 'gibs' && mgr.onlineLayer) break; await new Promise(r => setTimeout(r, 500)); }
  if (!mgr || mgr.currentId !== 'gibs' || !mgr.onlineLayer) return { err: 'switch failed' };
  const C = window.Cesium, v = window.viewer, scene = v.scene;
  function near(a, b, t) { return Math.abs(a - b) <= t; }
  function sampleSouth(hkm) {
    v.camera.setView({ destination: C.Cartesian3.fromDegrees(0, -88, hkm * 1000),
      orientation: { heading: 0, pitch: -C.Math.PI_OVER_TWO, roll: 0 } });
    return new Promise((res) => {
      // 等 GIBS 远程瓦片加载（真实模式有网络延迟），多帧渲染
      let n = 0;
      const tick = () => {
        scene.render();
        if (n++ < 12) { setTimeout(tick, 700); return; }
        const canvas = scene.canvas, gl = scene.context._gl;
        const cx = canvas.width >> 1, cy = canvas.height >> 1;
        const px = new Uint8Array(4);
        gl.readPixels(cx, cy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        // 判断是否接近 baseColor 深蓝 [38,82,124]
        const isBase = near(px[0],38,40) && near(px[1],82,40) && near(px[2],124,40);
        res({ hkm, rgb:[px[0],px[1],px[2]], isBaseColorDeepBlue: isBase });
      };
      tick();
    });
  }
  const out = [];
  for (const h of [300, 500, 1000, 2000]) out.push(await sampleSouth(h));
  return { out };
})()`;

try {
  await sleep(2500);
  const list = await (await fetch('http://127.0.0.1:9236/json/list')).json();
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
