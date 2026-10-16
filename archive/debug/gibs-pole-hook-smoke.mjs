/**
 * 1000km 南极视图：钩 requestImage 记录 Cesium 实际请求的每一块瓦片
 * （x/y/level/矩形/透明率/平均RGB），同时记录 globe baseColor 与合成层 show 状态。
 * 回答：黑块/蓝块对应的瓦片到底有没有被请求、内容是冰(白)还是海(蓝)还是空(透明)。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';

const { default: WebSocket } = await import(`file:///C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js`);
const URL = 'http://127.0.0.1:5008/';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const UD = 'C:/Users/KaishengMao/AppData/Local/Temp/sphere-gibs-hook';
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9237', '--disable-gpu', '--no-first-run', `--user-data-dir=${UD}`, 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { edge.kill(); } catch { /* ignore */ } };
process.on('exit', cleanup);
const OUTDIR = 'D:/Share/Scripts/Explore/sphere/tools';

const probe = `(async () => {
  try {
    const el = document.getElementById('onlineSource');
    el.value = 'gibs'; el.dispatchEvent(new Event('change'));
    let mgr = null;
    for (let i = 0; i < 30; i++) { mgr = window.__imagerySourceMgr; if (mgr && mgr.currentId === 'gibs' && mgr.onlineLayer) break; await new Promise(r => setTimeout(r, 500)); }
    if (!mgr || !mgr.onlineLayer) return { err: 'switch failed' };
    const Cesium = window.Cesium, viewer = window.viewer;
    const layer = viewer.imageryLayers.get(0);
    const prov = layer._imageryProvider || layer.imageryProvider;

    // 钩 requestImage：记录每次调用的瓦片与返回画布的内容统计
    const rec = new Map(); // key -> {x,y,level,rect,alphaPct,rgb,done}
    const orig = prov.requestImage.bind(prov);
    prov.requestImage = async function (x, y, level) {
      const key = level + '/' + x + '/' + y;
      let e = rec.get(key);
      if (!e) {
        const D2 = Cesium.Math.toDegrees;
        const r = prov.tilingScheme.tileXYToRectangle(x, y, level);
        e = { x, y, level, w: +D2(r.west).toFixed(1), e2: +D2(r.east).toFixed(1), s: +D2(r.south).toFixed(1), n: +D2(r.north).toFixed(1) };
        rec.set(key, e);
      }
      try {
        const cv = await orig(x, y, level);
        if (cv && cv.getContext) {
          const ctx = cv.getContext('2d');
          const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
          let trans = 0, rs = 0, gs = 0, bs = 0, opaque = 0;
          for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] === 0) { trans++; continue; }
            opaque++; rs += d[i]; gs += d[i + 1]; bs += d[i + 2];
          }
          e.alphaPct = +(100 * (1 - trans / (cv.width * cv.height))).toFixed(1);
          e.rgb = opaque ? [ (rs/opaque)|0, (gs/opaque)|0, (bs/opaque)|0 ] : null;
        } else { e.noCanvas = true; }
        e.done = true;
      } catch (err) { e.error = String(err && err.message || err); }
      return orig(x, y, level);
    };

    viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(0, -88, 1e6) });
    await new Promise(r => setTimeout(r, 12000));

    const globe = viewer.scene.globe;
    const tiles = [...rec.values()];
    // 南半球瓦片按纬度排：看最南边那些
    tiles.sort((a, b) => b.s - a.s);
    const south = tiles.filter(t => t.s < -60).map(t => ({ lv: t.level, xy: t.x + ',' + t.y, rect: t.s + '~' + t.n + '/' + t.w + '~' + t.e2, a: t.alphaPct, rgb: t.rgb, err: t.error }));
    const lvCount = {};
    for (const t of tiles) lvCount[t.level] = (lvCount[t.level] || 0) + 1;
    const layer1 = viewer.imageryLayers.length > 1 ? viewer.imageryLayers.get(1) : null;
    return {
      globeBaseColor: globe.baseColor ? [globe.baseColor.red, globe.baseColor.green, globe.baseColor.blue] : null,
      layer1Show: layer1 ? layer1.show : 'none',
      requestedLevels: lvCount,
      totalRequested: tiles.length,
      southTiles: south,
    };
  } catch (e) { return { fatal: String((e && e.stack) || e) }; }
})()`;

try {
  await sleep(2500);
  const list = await (await fetch('http://127.0.0.1:9237/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const send = (method, params = {}) => new Promise((res, rej) => { const id = Math.floor(Math.random() * 1e9); pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id, method, params })); });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: URL }); await sleep(9000);
  const r = await (await send('Runtime.evaluate', { expression: probe, returnByValue: true, awaitPromise: true })).result.value;
  console.log(JSON.stringify(r, null, 2));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUTDIR}/gibs-hook-south-1000km.png`, Buffer.from(shot.data, 'base64'));
  process.exit(0);
} finally { cleanup(); }
