/**
 * 接缝诊断 v2（分两段，避免单段异常吞掉整体）：
 *  A 段：世界视图机位实际渲染的 level + L2~L5 靶瓦片（含 -36 竖缝）全表面阶梯扫描。
 *  B 段：直接加载 GIBS 源瓦片，对比 g4 c7|c8（-36 竖边界）与 g4 r5|r6（lat0 横边界）边缘像素，
 *        同时对照 g2 c1|c2（-36 也是 g2 边界）。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const { default: WebSocket } = await import(`file:///C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js`);
const URL = 'http://127.0.0.1:5008/';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const UD = 'C:/Users/KaishengMao/AppData/Local/Temp/sphere-gibs-seamfull2';
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9236', '--disable-gpu', '--no-first-run', `--user-data-dir=${UD}`, 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { edge.kill(); } catch { /* ignore */ } };
process.on('exit', cleanup);

const probeA = `(async () => {
  const out = { stage: 'A' };
  try {
    const Cesium = window.Cesium, viewer = window.viewer;
    const el = document.getElementById('onlineSource');
    el.value = 'gibs'; el.dispatchEvent(new Event('change'));
    let mgr = null;
    for (let i = 0; i < 30; i++) { mgr = window.__imagerySourceMgr; if (mgr && mgr.currentId === 'gibs' && mgr.onlineLayer) break; await new Promise(r => setTimeout(r, 500)); }
    if (!mgr || !mgr.onlineLayer) return { stage: 'A', err: 'switch failed' };
    await new Promise(r => setTimeout(r, 1000));
    const layer = viewer.imageryLayers.get(0);
    const prov = layer._imageryProvider || layer.imageryProvider;
    const reqs = [];
    const orig = prov.requestImage.bind(prov);
    prov.requestImage = function (x, y, level) { reqs.push({ x, y, level }); return orig(x, y, level); };
    viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(-29.2, 2.02, 1.2e7) });
    await new Promise(r => setTimeout(r, 14000));
    const lv = {}; for (const q of reqs) lv['L' + q.level] = (lv['L' + q.level] || 0) + 1;
    out.levelsSeen = lv;
    const tiles = [
      { x: 3, y: 1, level: 2, jCol: 51.2 }, { x: 3, y: 2, level: 2, jCol: 51.2 },
      { x: 6, y: 3, level: 3, jCol: 102.4 }, { x: 6, y: 4, level: 3, jCol: 102.4 },
      { x: 12, y: 6, level: 4, jCol: 204.8 }, { x: 12, y: 7, level: 4, jCol: 204.8 },
      { x: 24, y: 15, level: 5, jCol: 153.6 }, { x: 24, y: 16, level: 5, jCol: 153.6 },
    ];
    const analyze = (cv, jc) => {
      const w = cv.width, h = cv.height;
      const d = cv.getContext('2d').getImageData(0, 0, w, h).data;
      const lum = (x, y) => { const i = (y * w + x) * 4; return d[i] + d[i+1] + d[i+2]; };
      const colG = new Float64Array(w);
      for (let x = 0; x < w - 1; x++) { let s = 0; for (let y = 0; y < h; y++) s += Math.abs(lum(x+1, y) - lum(x, y)); colG[x] = s / h; }
      const rowG = new Float64Array(h);
      for (let y = 0; y < h - 1; y++) { let s = 0; for (let x = 0; x < w; x++) s += Math.abs(lum(x, y+1) - lum(x, y)); rowG[y] = s / w; }
      const top = (arr, n) => [...arr.keys()].sort((a,b)=>arr[b]-arr[a]).slice(0,n).map(i=>({i, g:+arr[i].toFixed(2)}));
      const md = [...colG].sort((a,b)=>a-b)[Math.floor(w/2)];
      const j = Math.floor(jc);
      return { seamColGrad: +colG[j].toFixed(2), seamColGrad2: +colG[j+1].toFixed(2), medianGrad: +md.toFixed(2), topCols: top(colG,4), topRows: top(rowG,4) };
    };
    out.canvasScan = [];
    for (const t of tiles) { try { const cv = await prov.requestImage(t.x, t.y, t.level); out.canvasScan.push({ ...t, ...analyze(cv, t.jCol) }); } catch (e) { out.canvasScan.push({ ...t, error: String(e && e.message || e) }); } }
  } catch (e) { out.Aerr = String((e && e.stack) || e); }
  return out;
})()`;

const probeB = `(async () => {
  const out = { stage: 'B' };
  try {
    const P = 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/BlueMarble_NextGeneration/default/500m/';
    const load = (u) => new Promise((res, rej) => { const im = new Image(); im.crossOrigin='anonymous'; im.onload=()=>res(im); im.onerror=()=>rej(new Error('load '+u)); im.src=u; });
    const px = (im, x, y) => { const c = document.createElement('canvas'); c.width=c.height=512; const g=c.getContext('2d'); g.drawImage(im,0,0); const dd=g.getImageData(0,0,512,512).data; const i=(y*512+x)*4; return [dd[i],dd[i+1],dd[i+2]]; };
    const edgeDiff = async (g, c1, r1, c2, r2, dir) => {
      const [a, b] = await Promise.all([load(P+g+'/'+r1+'/'+c1+'.jpeg'), load(P+g+'/'+r2+'/'+c2+'.jpeg')]);
      const diffs = []; const big = [];
      for (let k = 48; k < 512; k += 32) {
        let pa, pb;
        if (dir === 'v') { pa = px(a, 511, k); pb = px(b, 0, k); }
        else { pa = px(a, k, 511); pb = px(b, k, 0); }
        const dd = Math.abs(pa[0]-pb[0]) + Math.abs(pa[1]-pb[1]) + Math.abs(pa[2]-pb[2]);
        diffs.push(dd); if (dd > 8) big.push({ k, a: pa, b: pb });
      }
      return { max: Math.max(...diffs), nBig: big.length, big: big.slice(0,4) };
    };
    out.g2_c1c2_r1 = await edgeDiff(2, 1, 1, 2, 1, 'v');
    out.g4_c7c8_r5 = await edgeDiff(4, 7, 5, 8, 5, 'v');
    out.g4_c7c8_r4 = await edgeDiff(4, 7, 4, 8, 4, 'v');
    out.g4_r5r6_c7 = await edgeDiff(4, 7, 5, 7, 6, 'h');
    out.g4_r5r6_c8 = await edgeDiff(4, 8, 5, 8, 6, 'h');
    out.g2_c1c2_r2 = await edgeDiff(2, 1, 2, 2, 2, 'v');
  } catch (e) { out.Berr = String((e && e.stack) || e); }
  return out;
})()`;

try {
  await sleep(2500);
  const list = await (await fetch('http://127.0.0.1:9236/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const send = (method, params = {}) => new Promise((res, rej) => { const id = Math.floor(Math.random() * 1e9); pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id, method, params })); });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: URL }); await sleep(9000);
  console.log('=== A ===');
  console.log(JSON.stringify(await (await send('Runtime.evaluate', { expression: probeA, returnByValue: true, awaitPromise: true })).result.value, null, 2));
  console.log('=== B ===');
  console.log(JSON.stringify(await (await send('Runtime.evaluate', { expression: probeB, returnByValue: true, awaitPromise: true })).result.value, null, 2));
  process.exit(0);
} finally { cleanup(); }
