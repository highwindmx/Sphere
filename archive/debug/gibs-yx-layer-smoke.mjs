/**
 * 拆开 imagery 图层栈里那个未知层（Yx，index 1）：它的类型、show 状态、矩形范围、alpha。
 *   若它是极冠合成层且 show=true 且矩形覆盖南极 → 它盖在 GIBS 之上造成南洞（不对称）。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const { default: WebSocket } = await import(`file:///C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js`);

const URL = 'http://127.0.0.1:5008/';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9238', '--disable-gpu', '--no-first-run', '--user-data-dir=C:/Users/KaishengMao/AppData/Local/Temp/sphere-gibs-yx-profile', 'about:blank'], { stdio: 'ignore', detached: false });
const cleanup = () => { try { edge.kill(); } catch { /* */ } };
process.on('exit', cleanup);

const evalProbe = `(async () => {
 try {
  const el = document.getElementById('onlineSource');
  el.value = 'gibs';
  el.dispatchEvent(new Event('change'));
  let mgr = null;
  for (let i = 0; i < 24; i++) { mgr = window.__imagerySourceMgr; if (mgr && mgr.currentId === 'gibs' && mgr.onlineLayer) break; await new Promise(r => setTimeout(r, 500)); }
  if (!mgr || mgr.currentId !== 'gibs') return { err: 'switch failed' };

  // 等够防抖（schedulePolarRecalibrate 1500ms）真正跑完 recalibrate
  await new Promise(r => setTimeout(r, 4000));

  const Cesium = window.Cesium, v = window.viewer;
  const out = { layerCount: v.imageryLayers.length, layers: [] };
  for (let i = 0; i < v.imageryLayers.length; i++) {
    const ly = v.imageryLayers.get(i);
    const p = ly._imageryProvider || ly.imageryProvider;
    const r = p && p.rectangle;
    out.layers.push({
      index: i,
      type: p && p.constructor && p.constructor.name,
      show: ly.show,
      alpha: ly.alpha,
      credit: p && p.credit && (p.credit.text || (p.credit._text)),
      rect: r ? { n: +(Cesium.Math.toDegrees(r.north)).toFixed(2), s: +(Cesium.Math.toDegrees(r.south)).toFixed(2), w: +(Cesium.Math.toDegrees(r.west)).toFixed(2), e: +(Cesium.Math.toDegrees(r.east)).toFixed(2) } : null,
    });
  }
  // 极冠合成层是否隐藏（native 策略下应为 false）
  out.polarCompositeShown = window.__polarDebug ? null : undefined;
  try { out.recalibrateInfo = (typeof window.__sphereRecalibrate === 'function') ? 'has fn' : 'no fn'; } catch(e){}
  return out;
 } catch (e) { return { caught: String(e && e.stack || e) }; }
})()`;

try {
  await sleep(2500);
  const list = await (await fetch('http://127.0.0.1:9238/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map(); const errors = [];
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text); });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const send = (method, params = {}) => new Promise((res, rej) => { const id = Math.floor(Math.random() * 1e9); pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id, method, params })); });
  await send('Runtime.enable'); await send('Page.enable'); await sleep(300);
  await send('Page.navigate', { url: URL }); await sleep(9000);
  const report = await (await send('Runtime.evaluate', { expression: evalProbe, returnByValue: true, awaitPromise: true })).result.value;
  console.log(JSON.stringify({ report, jsErrors: errors.slice(0, 6) }, null, 2));
  process.exit(0);
} finally { cleanup(); }
