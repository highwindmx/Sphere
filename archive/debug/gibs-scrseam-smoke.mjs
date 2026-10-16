/**
 * 屏幕级拼接线定位：复现用户机位（lon -35.11, lat 2.91, 1000km），
 * 截屏后在浏览器内做列亮度扫描找竖线，并钩 requestImage 记录实际影像瓦片边界，
 * 把线的屏幕位置换算成经度，与 Cesium 影像瓦片边界对账。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const { default: WebSocket } = await import(`file:///C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js`);
const URL = 'http://127.0.0.1:5008/';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const UD = 'C:/Users/KaishengMao/AppData/Local/Temp/sphere-gibs-scrseam';
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9236', '--disable-gpu', '--no-first-run', '--window-size=1080,720', `--user-data-dir=${UD}`, 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { edge.kill(); } catch { /* ignore */ } };
process.on('exit', cleanup);

const probe = `(async () => {
  try {
    const el = document.getElementById('onlineSource');
    el.value = 'gibs'; el.dispatchEvent(new Event('change'));
    let mgr = null;
    for (let i = 0; i < 30; i++) { mgr = window.__imagerySourceMgr; if (mgr && mgr.currentId === 'gibs' && mgr.onlineLayer) break; await new Promise(r => setTimeout(r, 500)); }
    if (!mgr || !mgr.onlineLayer) return { err: 'switch failed' };
    await new Promise(r => setTimeout(r, 25000)); // 等 warmup 预取完成

    const layer = viewer.imageryLayers.get(0);
    const prov = layer._imageryProvider || layer.imageryProvider;
    // 钩 requestImage 记录本次视图实际请求的影像瓦片
    const reqs = [];
    const orig = prov.requestImage.bind(prov);
    prov.requestImage = function (x, y, level) { reqs.push({ x, y, level }); return orig(x, y, level); };

    viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(-35.11, 2.91, 1.15e7) });
    await new Promise(r => setTimeout(r, 15000));
    const levels = [...new Set(reqs.map(r => r.level))].sort();

    // 关键假设检验：GIBS 不同级在「同一地理海洋点」的颜色是否一致
    // 点：大西洋 (lat 0, lon -35)、(lat 10, lon -30)、(lat -20, lon -35)
    const load = (src) => new Promise((res, rej) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => res(im); im.onerror = () => rej(new Error('fail ' + src)); im.src = src; });
    const px = (img, lat, lon) => {
      const cv = px._cv || (px._cv = document.createElement('canvas'));
      cv.width = 512; cv.height = 512;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.clearRect(0, 0, 512, 512); ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, 512, 512).data;
      const g = +img.dataset.g;
      const span = 288 / Math.pow(2, g);
      const c = Math.floor((lon + 180) / span), r = Math.floor((90 - lat) / span);
      const fx = ((lon + 180) - c * span) / span * 511, fy = ((90 - lat) - r * span) / span * 511;
      const xi = Math.round(fx), yi = Math.round(fy);
      const i = (Math.min(511, Math.max(0, yi)) * 512 + Math.min(511, Math.max(0, xi))) * 4;
      return [d[i], d[i + 1], d[i + 2]];
    };
    const radiometry = [];
    for (const g of [2, 4, 5]) {
      // 三个点可能落在不同瓦片，逐点加载：简单起见每级只测 (0,-35) 与 (10,-30)
      const pts = [];
      for (const [lat, lon] of [[0, -35], [10, -30], [-20, -35]]) {
        const span = 288 / Math.pow(2, g);
        const c = Math.floor((lon + 180) / span), r = Math.floor((90 - lat) / span);
        const img = await load(\`https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/BlueMarble_NextGeneration/default/500m/\${g}/\${r}/\${c}.jpeg\`);
        img.dataset.g = g;
        pts.push({ lat, lon, rgb: px(img, lat, lon) });
      }
      radiometry.push({ g, pts });
    }

    // 屏幕投影锚点：赤道上每 10° 一个点，用于把检测到的线的 x 反算成经度
    const projPoints = [];
    for (const lon of [-120, -100, -80, -60, -45, -36, -30, -22.5, -15, 0, 15, 30, 45]) {
      const cart = Cesium.Cartesian3.fromDegrees(lon, 0);
      const p = viewer.scene.cartesianToCanvasCoordinates(cart);
      if (p) projPoints.push({ lon, x: +p.x.toFixed(1), y: +p.y.toFixed(1) });
    }

    return { reqCount: reqs.length, levels, radiometry, proj: projPoints, reqs: reqs.slice(0, 300) };
  } catch (e) { return { fatal: String((e && e.stack) || e) }; }
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
  const r = await (await send('Runtime.evaluate', { expression: probe, returnByValue: true, awaitPromise: true })).result.value;

  // 截屏（真实合成画面）并落盘
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const b64 = shot.data;
  const fs = await import('node:fs');
  fs.writeFileSync('D:/Share/Scripts/Explore/sphere/tools/gibs-scrseam-view.png', Buffer.from(b64, 'base64'));
  // 在页面里分析截屏列亮度
  // 在页面里分析截屏列亮度（只扫球面海洋区，避开 UI）
  const anal = await (await send('Runtime.evaluate', {
    expression: `(async (b64) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
      const ctx = cv.getContext('2d'); ctx.drawImage(img, 0, 0);
      const w = img.width, h = img.height;
      const d = ctx.getImageData(0, 0, w, h).data;
      const x0 = Math.floor(w * 0.36), x1 = Math.floor(w * 0.95);
      const y0 = Math.floor(h * 0.25), y1 = Math.floor(h * 0.9);
      const col = new Array(w).fill(0);
      for (let x = x0; x < x1; x++) { let s = 0; for (let y = y0; y < y1; y++) { const i = (y * w + x) * 4; s += (d[i] + d[i+1] + d[i+2]) / 3; } col[x] = s / (y1 - y0); }
      const lines = [];
      for (let x = x0 + 3; x < x1 - 3; x++) {
        const nb = (col[x-3] + col[x-2] + col[x-1] + col[x+1] + col[x+2] + col[x+3]) / 6;
        const diff = col[x] - nb;
        if (Math.abs(diff) > 1.5) lines.push({ x, diff: +diff.toFixed(2), col: +col[x].toFixed(1) });
      }
      const merged = [];
      for (const L of lines) { const last = merged[merged.length - 1]; if (last && L.x - last.x2 <= 2) { last.x2 = L.x; last.peak = Math.max(last.peak, Math.abs(L.diff)); } else merged.push({ x1: L.x, x2: L.x, peak: Math.abs(L.diff) }); }
      return { w, h, x0, x1, lines: merged };
    })('${b64}')`,
    returnByValue: true, awaitPromise: true,
  })).result.value;

  console.log(JSON.stringify({ probe: r, screenLines: anal }, null, 2));
  process.exit(0);
} finally { cleanup(); }
