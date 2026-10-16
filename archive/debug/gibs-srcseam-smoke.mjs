/**
 * GIBS 源数据接缝检测：在浏览器内加载相邻 g2 源瓦片，
 * 比较边界两侧像素差（列边界 lon -36：c1|c2；行边界 lat 18：r0/r1），
 * 并与瓦片内自然梯度做基线对照。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const { default: WebSocket } = await import(`file:///C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js`);
const URL = 'http://127.0.0.1:5008/';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const UD = 'C:/Users/KaishengMao/AppData/Local/Temp/sphere-gibs-srcseam';
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9236', '--disable-gpu', '--no-first-run', `--user-data-dir=${UD}`, 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { edge.kill(); } catch { /* ignore */ } };
process.on('exit', cleanup);

const probe = `(async () => {
  try {
    const load = (src) => new Promise((res, rej) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => res(im); im.onerror = () => rej(new Error('load fail ' + src)); im.src = src; });
    const P = 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/BlueMarble_NextGeneration/default/500m/2/';
    // 大西洋赤道带：r1 (lat 18..-54) c1(-108..-36) c2(-36..36)
    const [c1, c2, r0c2, r1c2] = await Promise.all([load(P + '1/1.jpeg'), load(P + '1/2.jpeg'), load(P + '0/2.jpeg'), load(P + '1/2.jpeg')]);
    const cv = document.createElement('canvas'); cv.width = 512; cv.height = 512;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const grab = (img) => { ctx.clearRect(0, 0, 512, 512); ctx.drawImage(img, 0, 0); return ctx.getImageData(0, 0, 512, 512).data; };
    const d1 = grab(c1), d2 = grab(c2), d0 = grab(r0c2);
    const px = (d, x, y) => { const i = (y * 512 + x) * 4; return [d[i], d[i + 1], d[i + 2]]; };
    const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

    // 纵向边界 lon=-36：c1 右缘列 vs c2 左缘列（逐行）
    let sum = 0, max = 0, rows = [];
    for (let y = 0; y < 512; y++) {
      const dd = dist(px(d1, 511, y), px(d2, 0, y));
      sum += dd; if (dd > max) max = dd;
      if (dd > 30) rows.push(y);
    }
    const vertBoundary = { mean: +(sum / 512).toFixed(1), max, bigRows: rows.length, sampleRows: rows.slice(0, 10) };

    // 基线：c2 内部相邻列（col 0 vs 1，col 255 vs 256）
    let s1 = 0, s2 = 0;
    for (let y = 0; y < 512; y++) { s1 += dist(px(d2, 0, y), px(d2, 1, y)); s2 += dist(px(d2, 255, y), px(d2, 256, y)); }
    const baseline = { col0vs1: +(s1 / 512).toFixed(1), col255vs256: +(s2 / 512).toFixed(1) };

    // 横向边界 lat=18：r0 底行 vs r1 顶行（c2，逐列）
    let hsum = 0, hmax = 0, cols = [];
    for (let x = 0; x < 512; x++) {
      const dd = dist(px(d0, x, 511), px(d2, x, 0));
      hsum += dd; if (dd > hmax) hmax = dd;
      if (dd > 30) cols.push(x);
    }
    const horizBoundary = { mean: +(hsum / 512).toFixed(1), max, bigCols: cols.length, sampleCols: cols.slice(0, 10) };

    // 纵向边界的行剖面：取几行看具体值（海洋 y≈250-400 一带）
    const profile = [];
    for (const y of [200, 260, 300, 340, 380]) {
      profile.push({ y, c1col511: px(d1, 511, y), c1col510: px(d1, 510, y), c2col0: px(d2, 0, y), c2col1: px(d2, 1, y) });
    }
    return { vertBoundary, baseline, horizBoundary, profile };
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
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
} finally { cleanup(); }
