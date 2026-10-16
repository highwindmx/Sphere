/**
 * 检查 Cesium 是否为南极 globe 区域请求并就绪 GIBS imagery 瓦片。
 *   - 南半球瓦片（rect.south < -80）根本不存在于 cache → globe 几何/culling 没覆盖南极（渲染层根因）
 *   - 存在但 state=FAILED(5) → Cesium 上下文源加载失败（与独立 requestImage 成功矛盾，需查）
 *   - 存在且 READY(4) → Cesium 已贴图，洞可能是被覆盖层遮挡或混合问题
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const { default: WebSocket } = await import(`file:///C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js`);

const URL = 'http://127.0.0.1:5008/';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9233', '--disable-gpu', '--no-first-run', '--user-data-dir=C:/Users/KaishengMao/AppData/Local/Temp/sphere-gibs-cache-profile', 'about:blank'], { stdio: 'ignore', detached: false });
const cleanup = () => { try { edge.kill(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

const evalProbe = `(async () => {
  const el = document.getElementById('onlineSource');
  el.value = 'gibs';
  el.dispatchEvent(new Event('change'));
  let mgr = null;
  for (let i = 0; i < 24; i++) {
    mgr = window.__imagerySourceMgr;
    if (mgr && mgr.currentId === 'gibs' && mgr.onlineLayer) break;
    await new Promise(r => setTimeout(r, 500));
  }
  if (!mgr || mgr.currentId !== 'gibs' || !mgr.onlineLayer) return { err: 'switch failed' };
  const layer = mgr.onlineLayer;
  // 相机转到南极上方，强制加载南极瓦片
  try {
    if (window.viewer) {
      window.viewer.camera.setView({ destination: window.Cesium.Cartesian3.fromDegrees(0, -85, 6e6) });
    }
  } catch (e) { /* ignore */ }
  await new Promise(r => setTimeout(r, 6000));
  const cache = layer._imageryCache;
  const entries = cache instanceof Map ? [...cache.values()] : (cache && typeof cache === 'object' ? Object.values(cache) : []);
  const states = {};
  let southCount = 0, southReady = 0, southFailed = 0, total = 0;
  for (const img of entries) {
    total++;
    const s = img.rectangle ? img.rectangle.south : null;
    const st = img.state;
    states[st] = (states[st] || 0) + 1;
    if (s != null && s < -80 * Math.PI / 180) {
      southCount++;
      if (st === 4) southReady++;
      if (st === 5) southFailed++;
    }
  }
  return {
    entryCount: total, states, southCount, southReady, southFailed,
    hasCache: !!cache,
    keys: Object.keys(layer).filter((k) => /cache|tile/i.test(k)),
  };
})()`;

try {
  await sleep(2500);
  const list = await (await fetch('http://127.0.0.1:9233/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map(); const errors = [];
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text); });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const send = (method, params = {}) => new Promise((res, rej) => { const id = Math.floor(Math.random() * 1e9); pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id, method, params })); });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: URL }); await sleep(9000);
  const report = await (await send('Runtime.evaluate', { expression: evalProbe, returnByValue: true, awaitPromise: true })).result.value;
  const ok = report && report.hasCache && report.southCount > 0 && report.southReady >= report.southCount * 0.8;
  console.log(JSON.stringify({ diagnosed: ok ? '南极瓦片已就绪→洞在覆盖/混合层' : '南极瓦片缺失→根因在 globe 几何/culling', report, errors }, null, 2));
  process.exit(0);
} finally { cleanup(); }
