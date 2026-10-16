/**
 * 决定性验证用户假设：globe 几何与 imagery provider 的投影/范围是否 mismatch。
 *   - 读 globe(terrain) 的 tilingScheme 矩形（±90 ≈ ±1.5708 为 Geographic；±1.484 ≈ ±85.05 为 WebMercator）
 *     以及 numberOfLevelZeroTiles（Geographic=2×1，Mercator=1×1）。
 *   - 读 imagery provider 的 tilingScheme 同上。
 *   - 钩住 requestImage，统计低 level (≤4) 实际被请求的 (x,y) 最大值（列数/行数揭示真实投影）。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const { default: WebSocket } = await import(`file:///C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js`);

const URL = 'http://127.0.0.1:5008/';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9235', '--disable-gpu', '--no-first-run', '--user-data-dir=C:/Users/KaishengMao/AppData/Local/Temp/sphere-gibs-scheme-profile', 'about:blank'], { stdio: 'ignore', detached: false });
const cleanup = () => { try { edge.kill(); } catch { /* 忽略 */ } };
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
  if (!mgr || mgr.currentId !== 'gibs' || !mgr.onlineLayer) return { err: 'switch failed', hasViewer: !!window.viewer, hasMgr: !!window.__imagerySourceMgr, curId: window.__imagerySourceMgr && window.__imagerySourceMgr.currentId };

  const Cesium = window.Cesium;
  const s2d = Cesium.Math.toDegrees;
  const describeScheme = (ts) => {
    if (!ts) return { none: true };
    const r = ts.rectangle;
    return {
      northDeg: +s2d(r.north).toFixed(3), southDeg: +s2d(r.south).toFixed(3),
      westDeg: +s2d(r.west).toFixed(3), eastDeg: +s2d(r.east).toFixed(3),
      levelZeroX: ts.numberOfLevelZeroTilesX, levelZeroY: ts.numberOfLevelZeroTilesY,
    };
  };
  // globe 几何
  const globeTs = (window.viewer.scene.globe._surface && window.viewer.scene.globe._surface._tileProvider && window.viewer.scene.globe._surface._tileProvider._tilingScheme)
    || window.viewer.terrainProvider.tilingScheme;
  // imagery 几何
  const prov = mgr.onlineLayer._imageryProvider || mgr.onlineLayer.imageryProvider;
  const imgTs = prov.tilingScheme;

  // ── 钩住 requestImage，统计实际请求范围 ──
  const seen = {}; // level -> {maxX,maxY,minY}
  const orig = prov.requestImage.bind(prov);
  prov.requestImage = function (x, y, level) {
    const s = seen[level] || (seen[level] = { maxX: -1, maxY: -1, minY: 1e9 });
    s.maxX = Math.max(s.maxX, x);
    s.maxY = Math.max(s.maxY, y);
    s.minY = Math.min(s.minY, y);
    return orig(x, y, level);
  };

  // 拉远看全球，触发低 level 请求
  window.viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(0, 0, 3.0e7) });
  await new Promise(r => setTimeout(r, 7000));

  // 赤道瓦片矩形对照
  const rectInfo = [];
  for (let L = 1; L <= 4; L++) {
    const yt = 2 ** L;
    const yEq = yt / 2 - 1;
    try {
      const rc = imgTs.tileXYToRectangle(0, yEq, L);
      rectInfo.push({ L, yEq, west: +s2d(rc.west).toFixed(2), south: +s2d(rc.south).toFixed(2), east: +s2d(rc.east).toFixed(2), north: +s2d(rc.north).toFixed(2) });
    } catch (e) { rectInfo.push({ L, err: String(e) }); }
  }

  return {
    globeScheme: describeScheme(globeTs),
    imageryScheme: describeScheme(imgTs),
    requestedRange: seen,
    equatorTileRect: rectInfo,
  };
 } catch (e) { return { caught: String(e && e.stack || e) }; }
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
  await sleep(300);
  await send('Page.navigate', { url: URL }); await sleep(9000);
  const report = await (await send('Runtime.evaluate', { expression: evalProbe, returnByValue: true, awaitPromise: true })).result.value;

  console.log(JSON.stringify({ report, jsErrors: errors.slice(0, 6) }, null, 2));
  process.exit(0);
} finally { cleanup(); }
