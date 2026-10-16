/**
 * 一站式决定性诊断（在同一把里回答三个问题）：
 *  1) terrain provider 的 tileAvailable 在极点 vs 赤道随 level 的差异（低级极点若 false → 不生成表面几何 → 洞）
 *  2) imagery 图层堆叠：有没有残留的旧 base 层（如 aws-s2 Web Mercator ±85）压在下面
 *  3) 南极真实 GIBS 内容：极点瓦片画布里 WHITE（冰）占比，确认南纬内容确实在南纬（非错位）
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const { default: WebSocket } = await import(`file:///C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js`);

const URL = 'http://127.0.0.1:5008/';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9237', '--disable-gpu', '--no-first-run', '--user-data-dir=C:/Users/KaishengMao/AppData/Local/Temp/sphere-gibs-decisive-profile', 'about:blank'], { stdio: 'ignore', detached: false });
const cleanup = () => { try { edge.kill(); } catch { /* */ } };
process.on('exit', cleanup);

const evalProbe = `(async () => {
 try {
  const el = document.getElementById('onlineSource');
  el.value = 'gibs';
  el.dispatchEvent(new Event('change'));
  let mgr = null;
  for (let i = 0; i < 24; i++) {
    mgr = window.__imagerySourceMgr;
    if (mgr && mgr.currentId === 'gibs' && mgr.onlineLayer) break;
    await new Promise(r => setTimeout(r, 500));
  }
  if (!mgr || mgr.currentId !== 'gibs') return { err: 'switch failed', cur: window.__imagerySourceMgr && window.__imagerySourceMgr.currentId };

  const Cesium = window.Cesium, v = window.viewer;
  const tp = v.terrainProvider;
  const out = { tpType: tp.constructor && tp.constructor.name, hasTileAvailable: typeof tp.tileAvailable === 'function', hasAvailability: !!(tp.availability) };

  // 1) tileAvailable 极点 vs 赤道
  const avail = [];
  for (let L = 3; L <= 9; L++) {
    const yt = 2 ** L, yPole = yt - 1, yEq = Math.floor(yt / 2);
    let p = null, e = null;
    if (typeof tp.tileAvailable === 'function') { p = tp.tileAvailable(0, yPole, L); e = tp.tileAvailable(0, yEq, L); }
    else if (tp.availability && tp.availability.computeTileAvailability) { p = tp.availability.computeTileAvailability(0, yPole, L); e = tp.availability.computeTileAvailability(0, yEq, L); }
    avail.push({ L, pole: String(p), eq: String(e) });
  }
  out.tileAvailable = avail;

  // 2) imagery 图层堆叠
  const layers = [];
  for (let i = 0; i < v.imageryLayers.length; i++) {
    const ly = v.imageryLayers.get(i);
    const p = ly._imageryProvider || ly.imageryProvider;
    layers.push({ index: i, type: p && p.constructor && p.constructor.name, isGibs: !!(p && p.credit && /GIBS/.test(p.credit.text || '')) });
  }
  out.imageryStack = layers;

  // 3) 南极真实内容：极点瓦片画布 WHITE(冰) 占比
  const prov = mgr.onlineLayer._imageryProvider || mgr.onlineLayer.imageryProvider;
  const whiteOf = async (L, x, y) => {
    const cv = await prov.requestImage(x, y, L);
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let white = 0, dark = 0, n = cv.width * cv.height;
    for (let k = 0; k < n; k++) {
      const r = d[k*4], g = d[k*4+1], b = d[k*4+2], a = d[k*4+3];
      if (a < 128) continue;
      const mx = Math.max(r,g,b), mn = Math.min(r,g,b);
      if (mx > 200 && mx - mn < 40) white++;          // 近白（冰/云）
      else if (mx + g + b < 120) dark++;
    }
    return { whitePct: +(100*white/n).toFixed(1), darkPct: +(100*dark/n).toFixed(1) };
  };
  const southContent = [];
  for (let L = 3; L <= 7; L++) {
    const y = 2 ** L - 1;                              // 真·南极行
    try { southContent.push({ L, y, ...(await whiteOf(L, 0, y)) }); }
    catch (e) { southContent.push({ L, y, err: String(e) }); }
  }
  out.southPoleContent = southContent;
  return out;
 } catch (e) { return { caught: String(e && e.stack || e) }; }
})()`;

try {
  await sleep(2500);
  const list = await (await fetch('http://127.0.0.1:9237/json/list')).json();
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
