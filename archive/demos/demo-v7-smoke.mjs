/**
 * 图源设置 Demo v7 冒烟：每源 4×3 下载表（清晰度 / 已缓存 / 下载进度）
 * 断言：① 每源一张表、4 行档位 ② 第 2 列按档位聚合真实缓存（含 ✓已下满）
 *      ③ 第 3 列按钮点击后进度出现在同一行 ④ 跨源排队 ⑤ 地形源同结构 ⑥ 无 JS 异常
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
const WS_PATH = 'C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js';
const { default: WebSocket } = await import(`file:///${WS_PATH}`);

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9383;
const URL = 'http://127.0.0.1:5008/source-settings-demo-v7.html';
const SHOT = 'tools/.demo-v7.png';

const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  '--no-default-browser-check', '--disable-extensions', '--use-gl=angle',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage',
  '--no-proxy-server', '--window-size=1280,800', 'about:blank',
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
const errors = [];
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    errors.push((msg.params.exceptionDetails?.text || '') + ' ' + (msg.params.exceptionDetails?.exception?.description ?? ''));
  }
});
function send(method, params = {}) {
  const i = ++id;
  ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise((res, rej) => pending.set(i, { res, rej }));
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval error');
  return r.result.value;
}

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: URL });
await sleep(14000);

const report = {};

// ① 表结构
try {
  report.structure = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('#src-list .src')];
    const esri = document.querySelector('#src-list .src[data-id="esri"]');
    const rows = [...esri.querySelectorAll('table.dl tbody tr')];
    const terrain = document.querySelector('#terrain-list .src');
    return {
      cards: cards.length,
      perCardTables: cards.map((c) => (c.querySelector('table.dl') ? c.querySelectorAll('table.dl tbody tr').length : 0)),
      headers: [...esri.querySelectorAll('table.dl th')].map((t) => t.textContent.trim()),
      tierLabels: rows.map((r) => r.querySelector('.t-tier').textContent.replace(/\\s+/g, ' ').trim()),
      terrainRows: terrain.querySelectorAll('table.dl tbody tr').length,
    };
  })()`);
} catch (e) { report.structureErr = String(e.message); }

// ② 第 2 列：按档位聚合的真实缓存
try {
  report.cacheCols = await evaluate(`(() => {
    const grab = (sel) => [...document.querySelectorAll(sel + ' table.dl tbody tr')].map((r) => ({
      tier: r.querySelector('.t-tier').textContent.replace(/\\s+/g, ' ').trim(),
      cache: r.querySelector('.t-cache').textContent.replace(/\\s+/g, ' ').trim(),
      barW: r.querySelector('.t-cache .bar > i')?.style.width || null,
    }));
    return { esri: grab('#src-list .src[data-id="esri"]'), terrain: grab('#terrain-list .src') };
  })()`);
} catch (e) { report.cacheColsErr = String(e.message); }

// ③ 第 3 列：点击后进度出现在同一行 + 跨源排队
try {
  report.download = await evaluate(`(async () => {
    const esriBtn = document.querySelector('[data-dlkey="esri|skel"]');
    const eoxBtn = document.querySelector('[data-dlkey="eox|high-p"]');
    esriBtn.click();
    eoxBtn.click();
    await new Promise((r) => setTimeout(r, 1000));
    const cell = document.querySelector('[data-act="esri|skel"]');
    return {
      esriBtn: esriBtn.textContent.trim(),
      eoxBtn: eoxBtn.textContent.trim(),
      esriProgOn: cell.querySelector('.t-prog').classList.contains('on'),
      esriBarW: cell.querySelector('.t-prog > i').style.width,
      esriTxt: cell.querySelector('.t-txt').textContent,
      dupClickDisabled: esriBtn.disabled,
      queueOrder: [esriBtn.textContent.trim(), eoxBtn.textContent.trim()],
    };
  })()`);
} catch (e) { report.downloadErr = String(e.message); }

// ④ 半径切换后标注点档位重算
try {
  report.radius = await evaluate(`(() => {
    const before = document.querySelector('#src-list .src[data-id="esri"] tr[data-tier="high-p"] .t-cache').textContent.replace(/\\s+/g, ' ').trim();
    const sel = document.getElementById('radiusSel');
    sel.value = '50'; sel.dispatchEvent(new Event('change'));
    const after = document.querySelector('#src-list .src[data-id="esri"] tr[data-tier="high-p"] .t-cache').textContent.replace(/\\s+/g, ' ').trim();
    const label = document.querySelector('#src-list .src[data-id="esri"] tr[data-tier="high-p"] .t-tier').textContent.replace(/\\s+/g, ' ').trim();
    return { before, after, label, stored: localStorage.getItem('sphere.tileRadiusKm') };
  })()`);
} catch (e) { report.radiusErr = String(e.message); }

const shot = await send('Page.captureScreenshot', { format: 'png' });
const { writeFileSync } = await import('node:fs');
writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));

report.errors = errors;
console.log(JSON.stringify(report, null, 2));
edge.kill();
process.exit(0);
