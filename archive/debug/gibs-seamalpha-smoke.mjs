/**
 * 接缝 alpha 探针：量化「相邻 GIBS 源瓦片接缝处」合成画布的真实 alpha。
 * 假设：drawImage 目标坐标为小数 → 抗锯齿边缘覆盖 <100% → 半透明缝 →
 *       globe 底色 RGB(38,82,124) 渗出 = 用户看到的浅色拼接线。
 * 靶瓦片（大西洋，海面平坦，任何缺陷都裸露）：
 *   L2 x=3 (lon -45..0)  y=1 (0..45) / y=2 (-45..0)：g2 竖缝 lon -36 → dx=51.2
 *   L3 x=6 (lon -45..-22.5) y=3 (22.5..0)：g2 横缝 lat 18 → dy=51.2
 *   L4 x=12 (lon -45..-33.75) y=7 (11.25..0)：g4 竖缝 lon -36 → dx=204.8
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const { default: WebSocket } = await import(`file:///C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js`);
const URL = 'http://127.0.0.1:5008/';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const UD = 'C:/Users/KaishengMao/AppData/Local/Temp/sphere-gibs-seamalpha';
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9236', '--disable-gpu', '--no-first-run', `--user-data-dir=${UD}`, 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { edge.kill(); } catch { /* ignore */ } };
process.on('exit', cleanup);

const probe = `(async () => {
  try {
    const el = document.getElementById('onlineSource');
    el.value = 'gibs'; el.dispatchEvent(new Event('change'));
    let mgr = null;
    for (let i = 0; i < 30; i++) { mgr = window.__imagerySourceMgr; if (mgr && mgr.currentId === 'gibs' && mgr.onlineLayer) break; await new Promise(r => setTimeout(r, 500)); }
    if (!mgr || !mgr.onlineLayer) return { err: 'switch failed' };
    await new Promise(r => setTimeout(r, 1500));
    const layer = viewer.imageryLayers.get(0);
    const prov = layer._imageryProvider || layer.imageryProvider;

    const testTiles = [
      { x: 3, y: 1, level: 2, expect: { vCol: 51.2 } },
      { x: 3, y: 2, level: 2, expect: { vCol: 51.2 } },
      { x: 6, y: 3, level: 3, expect: { vCol: 102.4, hRow: 51.2 } },
      { x: 6, y: 4, level: 3, expect: { vCol: 102.4 } },
      { x: 12, y: 7, level: 4, expect: { vCol: 204.8 } },
    ];
    const out = [];
    for (const t of testTiles) {
      try {
        const cv = await prov.requestImage(t.x, t.y, t.level);
        const ctx = cv.getContext('2d');
        const w = cv.width, h = cv.height;
        const d = ctx.getImageData(0, 0, w, h).data;
        // 每列最小 alpha、每行最小 alpha
        const colMin = new Array(w).fill(255), rowMin = new Array(h).fill(255);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const a = d[(y * w + x) * 4 + 3];
            if (a < colMin[x]) colMin[x] = a;
            if (a < rowMin[y]) rowMin[y] = a;
          }
        }
        const dips = (arr, near) => {
          const res = [];
          for (let i = 0; i < arr.length; i++) {
            if (arr[i] < 255) {
              const last = res[res.length - 1];
              if (last && i - last.i2 <= 1 && arr[i] < last.min) { last.i2 = i; last.min = arr[i]; }
              else if (last && i - last.i2 <= 1) { last.i2 = i; }
              else res.push({ i1: i, i2: i, min: arr[i] });
            }
          }
          return res;
        };
        const colDips = dips(colMin), rowDips = dips(rowMin);
        // 接缝附近 RGB 采样（第 h/2 行，接缝列 ±2）
        const midRow = Math.floor(h / 2);
        const rgbAt = (x) => { const i = (midRow * w + x) * 4; return [d[i], d[i+1], d[i+2], d[i+3]]; };
        const seam = t.expect.vCol !== undefined ? Math.floor(t.expect.vCol) : null;
        const rgb = seam !== null ? { m2: rgbAt(seam-2), m1: rgbAt(seam-1), at: rgbAt(seam), p1: rgbAt(seam+1), p2: rgbAt(seam+2) } : null;
        out.push({ ...t, colDips, rowDips, rgbMid: rgb });
      } catch (e) { out.push({ ...t, error: String(e && e.message || e) }); }
    }
    return { out };
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
