/**
 * 对已存截屏（gibs-scrseam-view.png）做海洋区列亮度扫描（脱离完整流程，快速迭代）。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { readFileSync, writeFileSync } from 'node:fs';

const { default: WebSocket } = await import(`file:///C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js`);
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const UD = 'C:/Users/KaishengMao/AppData/Local/Temp/sphere-gibs-analyze';
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9236', '--disable-gpu', '--no-first-run', `--user-data-dir=${UD}`, 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { edge.kill(); } catch { /* ignore */ } };
process.on('exit', cleanup);

const b64 = readFileSync('D:/Share/Scripts/Explore/sphere/tools/gibs-scrseam-view.png').toString('base64');
const anal = `(async (b64) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
  const ctx = cv.getContext('2d'); ctx.drawImage(img, 0, 0);
  const w = img.width, h = img.height;
  const d = ctx.getImageData(0, 0, w, h).data;
  // 多个 y 带分别扫（球面不同纬度带），排除 UI 后尽量全覆盖
  const bands = [[0.30,0.45],[0.45,0.60],[0.60,0.75],[0.75,0.88]];
  const report = [];
  for (const [fy0, fy1] of bands) {
    const y0 = Math.floor(h * fy0), y1 = Math.floor(h * fy1);
    const x0 = Math.floor(w * 0.30), x1 = Math.floor(w * 0.96);
    const col = new Array(w).fill(0);
    for (let x = x0; x < x1; x++) { let s = 0; for (let y = y0; y < y1; y++) { const i = (y * w + x) * 4; s += (d[i] + d[i+1] + d[i+2]) / 3; } col[x] = s / (y1 - y0); }
    const lines = [];
    for (let x = x0 + 3; x < x1 - 3; x++) {
      const nb = (col[x-3] + col[x-2] + col[x-1] + col[x+1] + col[x+2] + col[x+3]) / 6;
      const diff = col[x] - nb;
      if (Math.abs(diff) > 1.0) lines.push({ x, diff: +diff.toFixed(2) });
    }
    const merged = [];
    for (const L of lines) { const last = merged[merged.length - 1]; if (last && L.x - last.x2 <= 2) { last.x2 = L.x; last.peak = Math.max(last.peak, Math.abs(L.diff)); } else merged.push({ x1: L.x, x2: L.x, peak: Math.abs(L.diff) }); }
    report.push({ band: [fy0, fy1], lines: merged });
  }
  return { w, h, report };
})('${b64}')`;

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
  await send('Page.navigate', { url: 'about:blank' }); await sleep(1500);
  const r = await (await send('Runtime.evaluate', { expression: anal, returnByValue: true, awaitPromise: true })).result.value;
  writeFileSync('D:/Share/Scripts/Explore/sphere/tools/gibs-scrseam-analysis.json', JSON.stringify(r, null, 2));
  console.log(JSON.stringify(r.report, null, 1));
  process.exit(0);
} finally { cleanup(); }
