/**
 * 阶段 B — Cesium 实际请求/铺设端（低 zoom 南半球 + 赤道对照）
 *
 * 目的：阶段 A 已证明 provider 输出正确且铺满。本阶段查 Cesium 到底有没有
 *   为南纬高纬带（含南极）请求影像瓦片、铺的矩形是否真到 -90°、状态是否 READY。
 *   若「南纬最底瓦片缺失或状态非 READY」→ 坐实「南极洞」根因在铺设端。
 *
 * 测法：切 gibs 源 → 相机分别压到 1000/500/300km 高度、对准南纬（-78°）与赤道（0°）
 *   → 等渲染 → 枚举 imageryLayer._tiles：x,y,level,矩形(度),state(映射 ImageryState)
 *   → 统计南纬覆盖：READY 瓦片的最小 southDeg；是否真有瓦片覆盖 -90。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const { default: WebSocket } = await import(`file:///C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js`);

const URL = 'http://127.0.0.1:5008/';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const UD = 'C:/Users/KaishengMao/AppData/Local/Temp/sphere-gibs-b';
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9234', '--disable-gpu', '--no-first-run', `--user-data-dir=${UD}`, 'about:blank'], { stdio: 'ignore', detached: false });
const cleanup = () => { try { edge.kill(); } catch { /* ignore */ } };
process.on('exit', cleanup);

const evalProbe = `(async (cam) => {
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
    const diag = { hasMgr: !!mgr, currentId: mgr && mgr.currentId, hasOnline: !!(mgr && mgr.onlineLayer), hasViewer: typeof window.viewer, hasCesium: typeof window.Cesium };
    if (!mgr || mgr.currentId !== 'gibs' || !mgr.onlineLayer) return { ...diag, err: 'switch failed' };

    const Cesium = window.Cesium;
    const viewer = window.viewer;
    const layerCount = viewer.imageryLayers.length;
    const layers = [];
    for (let i = 0; i < layerCount; i++) {
      const ly = viewer.imageryLayers.get(i);
      layers.push({ i, name: ly.imageryProvider && ly.imageryProvider.constructor && ly.imageryProvider.constructor.name, show: ly.show });
    }
    const layer = viewer.imageryLayers.get(0);
    diag.layerCount = layerCount;
    diag.layer0Name = layer.imageryProvider && layer.imageryProvider.constructor && layer.imageryProvider.constructor.name;
    diag.layerKeys = Object.keys(layer).filter(k => /tile|imagery|state/i.test(k));
    diag.imageryStateType = typeof Cesium.ImageryState;

    const D2 = Cesium.Math.toDegrees;

    // 钩 provider.requestImage：抓 Cesium 真实影像请求流
    const called = [];
    const prov = layer.imageryProvider;
    const origRI = prov.requestImage.bind(prov);
    prov.requestImage = function (x, y, level) { called.push({ x, y, level }); return origRI(x, y, level); };

    // 设相机
    viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(cam.lon, cam.lat, cam.h) });
    await new Promise(r => setTimeout(r, 7000)); // 等瓦片请求+加载

    // 反算每个请求瓦片的地理矩形
    const scheme = prov.tilingScheme;
    const imgRects = called.map(c => {
      const r = scheme.tileXYToRectangle(c.x, c.y, c.level);
      return { x: c.x, y: c.y, level: c.level, w: +D2(r.west).toFixed(2), e: +D2(r.east).toFixed(2), s: +D2(r.south).toFixed(2), n: +D2(r.north).toFixed(2) };
    });
    const imgSouth = imgRects.map(t => t.s);
    const minImgSouth = imgSouth.length ? Math.min(...imgSouth) : null;
    const imgCoversPole = imgRects.some(t => t.s <= -89.5);
    const imgSouthTiles = imgRects.filter(t => t.s < -60);

    // globe surface 实际渲染瓦片（_tilesToRender，每帧填充，无需递归）
    const surf = viewer.scene.globe._surface;
    diag.surfKeys = surf ? Object.keys(surf).filter(k => /tile|level|quad|render/i.test(k)) : null;
    let globeRects = [];
    const rendered = surf && Array.isArray(surf._tilesToRender) ? surf._tilesToRender : [];
    globeRects = rendered.map(t => {
      const r = t.rectangle;
      return { level: t.level, w: +D2(r.west).toFixed(2), e: +D2(r.east).toFixed(2), s: +D2(r.south).toFixed(2), n: +D2(r.north).toFixed(2) };
    }).filter(r => r);
    const globeSouth = globeRects.map(t => t.s);
    const minGlobeSouth = globeSouth.length ? Math.min(...globeSouth) : null;
    const globeCoversPole = globeRects.some(t => t.s <= -89.5);

    return {
      cam: cam.tag,
      layerRect: layer.rectangle ? { s: +D2(layer.rectangle.south).toFixed(2), n: +D2(layer.rectangle.north).toFixed(2) } : null,
      imgRequestCount: called.length,
      imgMinSouth: minImgSouth,
      imgCoversPole,
      imgSouthTiles: imgSouthTiles.slice(0, 12),
      globeTileCount: globeRects.length,
      globeMinSouth: minGlobeSouth,
      globeCoversPole,
      globeSouthTiles: globeRects.filter(t => t.s < -60),
      globeLevelDist: (() => { const m = {}; for (const t of globeRects) m[t.level] = (m[t.level] || 0) + 1; return m; })(),
    };
  } catch (e) { return { fatal: String((e && e.stack) || e) }; }
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

  const cams = [
    { lon: 0, lat: -78, h: 1e6, tag: '1000km@S78' },
    { lon: 0, lat: -78, h: 5e5, tag: '500km@S78' },
    { lon: 0, lat: -78, h: 3e5, tag: '300km@S78' },
    { lon: 0, lat: 0, h: 1e6, tag: '1000km@EQ' },
  ];
  const results = [];
  for (const cam of cams) {
    const r = await (await send('Runtime.evaluate', { expression: `${evalProbe}(${JSON.stringify(cam)})`, returnByValue: true, awaitPromise: true })).result.value;
    results.push(r);
  }
  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
} finally { cleanup(); }
