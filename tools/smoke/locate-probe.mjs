/**
 * locate-probe.mjs — 实测检索「定位」后相机落点（经纬度 + 倾角）
 * 背景：用户反馈点 定位 后飞到错误经纬度且视角大倾角。
 * 用法：先保证 app.py 在 :5008 跑着，再 node tools/smoke/locate-probe.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const WS_PATH = 'C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js';
const { default: WebSocket } = await import(`file:///${WS_PATH}`);

const EDGE_BIN = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9398;
const URL = 'http://127.0.0.1:5008/';

const edge = spawn(EDGE_BIN, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  '--no-default-browser-check', '--disable-extensions', '--use-gl=angle',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage',
  '--window-size=1280,800', 'about:blank',
], { stdio: 'ignore' });

let wsUrl = null;
for (let i = 0; i < 40 && !wsUrl; i++) {
  await sleep(500);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) { wsUrl = page.webSocketDebuggerUrl; break; }
    const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL)}`, { method: 'PUT' });
    if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; }
  } catch { /* 还没起来 */ }
}
if (!wsUrl) { edge.kill(); throw new Error('无法连接 Edge 调试端口'); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let id = 0;
const pending = new Map();
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
  }
});
function send(method, params = {}) {
  const i = ++id;
  ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise((res, rej) => pending.set(i, { res, rej }));
}
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { __evalError: r.exceptionDetails.exception?.description };
  return r.result.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: URL });

const ready = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 160; i++) {
    if (window.Cesium && window.viewer && document.getElementById('unifiedSearch')) return { ok: true, waitedMs: i * 250 };
    await sleep(250);
  }
  return { ok: false };
})()`);
if (!ready.ok) { edge.kill(); throw new Error('页面未就绪'); }

const EXPECT = { '卢浮宫': { lon: 2.336, lat: 48.861 }, '故宫': { lon: 116.4, lat: 39.9 } };

async function locate(q) {
  const r = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const inp = document.getElementById('unifiedSearch');
    inp.focus(); inp.value = ${JSON.stringify(q)}; inp.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(250);
    const box = document.getElementById('searchResults');
    const btn = [...box.querySelectorAll('.sr-item')].find((b) => (b.querySelector('.sr-label')?.textContent || '').includes(${JSON.stringify(q)}));
    if (!btn) return { clicked: false, got: box.textContent.slice(0, 200) };
    btn.click();                       // 点整行 = 定位（非胶囊）
    await sleep(2200);                 // 等 flyTo 完成
    const v = window.viewer;
    const c = v.camera.positionCartographic;
    const lon = c ? +(c.longitude * 180 / Math.PI).toFixed(3) : null;
    const lat = c ? +(c.latitude * 180 / Math.PI).toFixed(3) : null;
    const h = c ? Math.round(c.height) : null;
    const pitch = +(v.camera.pitch * 180 / Math.PI).toFixed(1);
    return {
      clicked: true,
      label: btn.querySelector('.sr-label').textContent.trim(),
      status: document.getElementById('statusBar')?.textContent || document.getElementById('buildBar')?.textContent || '',
      cam: { lon, lat, h, pitch },
      isMoon: window.__getMoonViewer ? false : null,
      moonMode: document.getElementById('btnMoonMode')?.classList.contains('active'),
      marsMode: document.getElementById('btnMarsMode')?.classList.contains('active'),
    };
  })()`);
  return r;
}

const out = {};
for (const q of Object.keys(EXPECT)) {
  out[q] = await locate(q);
  // 复位相机回地球默认，避免上一处影响
  await evaluate(`(async () => { const v = window.viewer; if (v) v.camera.flyHome(0); await new Promise(r=>setTimeout(r,200)); return 1; })()`);
}

console.log(JSON.stringify({ EXPECT, out }, null, 2));
ws.close();
edge.kill();
