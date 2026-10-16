/**
 * 验证 terrain provider 的 tileAvailable 在极点 vs 赤道随 level 的差异：
 *   若极点瓦片在低级 (L3~L5) 返回 false（不可用）→ Cesium 不生成该表面几何
 *   → 影像没处贴 → 极区洞；高级 (L7+) 返回 true → 完整。
 *   同时打印地形 provider 类型与是否自定义 terrarium。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const { default: WebSocket } = await import(`file:///C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js`);

const URL = 'http://127.0.0.1:5008/';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9236', '--disable-gpu', '--no-first-run', '--user-data-dir=C:/Users/KaishengMao/AppData/Local/Temp/sphere-gibs-terr-profile', 'about:blank'], { stdio: 'ignore', detached: false });
const cleanup = () => { try { edge.kill(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

const evalProbe = `(async () => {
 try {
  await new Promise(r => setTimeout(r, 3000));
  const v = window.viewer;
  const tp = v.terrainProvider;
  const Cesium = window.Cesium;
  const out = { tpType: tp.constructor && tp.constructor.name, hasAvailability: !!(tp.availability), hasTileAvailable: typeof tp.tileAvailable === 'function' };
  // 探测极点 / 赤道 tileAvailable
  const rows = [];
  for (let L = 3; L <= 8; L++) {
    const yt = 2 ** L;
    const yPole = yt - 1;     // 最南行（含 -90）
    const yEq = Math.floor(yt / 2); // 赤道附近行
    const x = 0;
    let pole = null, eq = null;
    if (typeof tp.tileAvailable === 'function') {
      pole = tp.tileAvailable(x, yPole, L);
      eq = tp.tileAvailable(x, yEq, L);
    } else if (tp.availability && typeof tp.availability.computeTileAvailability === 'function') {
      pole = tp.availability.computeTileAvailability(x, yPole, L);
      eq = tp.availability.computeTileAvailability(x, yEq, L);
    }
    rows.push({ L, yPole, yEq, pole: String(pole), eq: String(eq) });
  }
  out.tileAvailableByLevel = rows;
  // 采样地形高度：南极点 vs 赤道，看是否 NaN/异常
  const hs = await Promise.all([
    v.scene.globe.getHeight? null : null,
  ]);
  // 直接用 sampleTerrain
  let hPole = null, hEq = null;
  try {
    const posPole = Cesium.Cartographic.fromDegrees(0, -89.9);
    const posEq = Cesium.Cartographic.fromDegrees(0, 0);
    const r1 = await Cesium.sampleTerrain(v.terrainProvider, 7, [posPole]);
    const r2 = await Cesium.sampleTerrain(v.terrainProvider, 7, [posEq]);
    hPole = r1[0] && r1[0].height; hEq = r2[0] && r2[0].height;
  } catch (e) { out.heightErr = String(e); }
  out.heights = { poleL7: hPole, equatorL7: hEq };
  return out;
 } catch (e) { return { caught: String(e && e.stack || e) }; }
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
  await sleep(300);
  await send('Page.navigate', { url: URL }); await sleep(9000);
  const report = await (await send('Runtime.evaluate', { expression: evalProbe, returnByValue: true, awaitPromise: true })).result.value;
  console.log(JSON.stringify({ report, jsErrors: errors.slice(0, 6) }, null, 2));
  process.exit(0);
} finally { cleanup(); }
