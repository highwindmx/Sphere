/**
 * 图源设置 Demo v8 冒烟：
 *  ① 下载表默认折叠、可展开（4 行档位）；入队自动展开
 *  ② 行内 ✕ 取消（排队移出重排 / 下载中止）
 *  ③ GIBS 档位钳制：低清 z5–7 可下载，高清禁用
 *  ④ 标注点档位走 /api/downloader/plan 精算，半径切换重算
 *  ⑤ 坐标控件 placeholder = 光标实时经纬度，空值定位到光标
 *  ⑥ 无 JS 异常
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
const WS_PATH = 'C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js';
const { default: WebSocket } = await import(`file:///${WS_PATH}`);

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9385;
const URL = 'http://127.0.0.1:5008/source-settings-demo-v8.html';
const SHOT = 'tools/.demo-v8.png';

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
await sleep(16000);   // 等地球 + scan + plan 精算

const report = {};

// ① 折叠结构与 GIBS 钳制
try {
  report.structure = await evaluate(`(() => {
    const esri = document.querySelector('#src-list .src[data-id="esri"]');
    const wrap = esri.querySelector('.dl-wrap');
    const collapsedByDefault = !wrap.classList.contains('open');
    wrap.querySelector('.act-dl').click();
    const openAfterClick = wrap.classList.contains('open');
    const rows = [...esri.querySelectorAll('table.dl tbody tr')];
    const gibs = document.querySelector('#src-list .src[data-id="gibs"]');
    gibs.querySelector('.act-dl').click();
    const gibsRows = [...gibs.querySelectorAll('table.dl tbody tr')].map((r) => ({
      tier: r.querySelector('.t-tier').textContent.replace(/\\s+/g, ' ').trim(),
      btn: r.querySelector('.act-tier').textContent.trim(),
      disabled: r.querySelector('.act-tier').disabled,
    }));
    const terrainWrap = document.querySelector('#terrain-list .dl-wrap');
    return { collapsedByDefault, openAfterClick, esriRowCount: rows.length,
      terrainCollapsed: !terrainWrap.classList.contains('open'), gibsRows };
  })()`);
} catch (e) { report.structureErr = String(e.message); }

// ② 并发 2 + 队列提示 + 行内取消（取消排队 / 中止下载中）
try {
  report.cancel = await evaluate(`(async () => {
    const esri = document.querySelector('#src-list .src[data-id="esri"]');
    const eox = document.querySelector('#src-list .src[data-id="eox"]');
    const gibs = document.querySelector('#src-list .src[data-id="gibs"]');
    esri.querySelector('[data-dlkey="esri|skel"]').click();
    eox.querySelector('[data-dlkey="eox|low"]').click();
    await new Promise((r) => setTimeout(r, 400));
    const bothActive = ['esri|skel', 'eox|low'].map((k) =>
      document.querySelector('[data-dlkey="' + k + '"]').textContent.trim());
    // 第三个入队 → 应显示 ⏳ 第3位 + 单元格「队列中」提示
    gibs.querySelector('[data-dlkey="gibs|skel"]').click();
    await new Promise((r) => setTimeout(r, 300));
    const queuedBtn = gibs.querySelector('[data-dlkey="gibs|skel"]').textContent.trim();
    const queuedCell = gibs.querySelector('[data-act="gibs|skel"] .t-txt').textContent.trim();
    const autoOpened = esri.querySelector('.dl-wrap').classList.contains('open');
    // 取消排队 → 自动补位开跑
    gibs.querySelector('[data-cancel="gibs|skel"]').click();
    await new Promise((r) => setTimeout(r, 400));
    const afterCancel = gibs.querySelector('[data-dlkey="gibs|skel"]').textContent.trim();
    // 中止一个下载中的
    eox.querySelector('[data-cancel="eox|low"]').click();
    await new Promise((r) => setTimeout(r, 200));
    const afterStop = eox.querySelector('[data-dlkey="eox|low"]').textContent.trim();
    return { bothActive, queuedBtn, queuedCell, autoOpened, afterCancel, afterStop,
      toast: document.getElementById('toast').textContent };
  })()`);
} catch (e) { report.cancelErr = String(e.message); }

// ③ 标注点精算（plan 接口）
try {
  await sleep(4000);   // 等 plan 返回
  report.plan = await evaluate(`(() => {
    const cell = document.querySelector('#src-list .src[data-id="esri"] [data-cache-tier="esri|high-p"]');
    return { text: cell.textContent.replace(/\\s+/g, ' ').trim(), precise: cell.textContent.includes('精算') };
  })()`);
} catch (e) { report.planErr = String(e.message); }

// ④ 半径切换 → 精算重算
try {
  report.radius = await evaluate(`(async () => {
    const sel = document.getElementById('radiusSel');
    const before = document.querySelector('#src-list .src[data-id="esri"] [data-cache-tier="esri|high-p"]').textContent.replace(/\\s+/g, ' ').trim();
    sel.value = '50'; sel.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 6000));
    const after = document.querySelector('#src-list .src[data-id="esri"] [data-cache-tier="esri|high-p"]').textContent.replace(/\\s+/g, ' ').trim();
    return { before, after, changed: before !== after, stored: localStorage.getItem('sphere.tileRadiusKm') };
  })()`);
} catch (e) { report.radiusErr = String(e.message); }

// ⑤ 坐标控件：placeholder 跟随光标 + 定位
try {
  report.coord = await evaluate(`(async () => {
    const canvas = document.querySelector('#globe canvas');
    const r = canvas.getBoundingClientRect();
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
    await new Promise((res) => setTimeout(res, 300));
    const lonIn = document.getElementById('coordLon'), latIn = document.getElementById('coordLat');
    const altEl = document.getElementById('coordAlt');
    const ph = { lon: lonIn.placeholder, lat: latIn.placeholder };
    const w = { lon: Math.round(lonIn.getBoundingClientRect().width), lat: Math.round(latIn.getBoundingClientRect().width) };
    const altOnGlobe = altEl.textContent.trim();
    const altW = Math.round(altEl.getBoundingClientRect().width);
    // 移到画布外 → 应回落为「视点」且海拔仍在回显
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 5, clientY: 5 }));
    await new Promise((res) => setTimeout(res, 300));
    const phOutside = lonIn.placeholder;
    const altOutside = altEl.textContent.trim();
    lonIn.value = '105'; latIn.value = '33';
    document.getElementById('btnCoordGoto').click();
    await new Promise((res) => setTimeout(res, 500));
    return { ph, inputWidth: w, altOnGlobe, altW, altOutside, phOutside,
      outsideIsView: document.getElementById('coordBar').title.startsWith('📍 视点'),
      toast: document.getElementById('toast').textContent,
      title: document.getElementById('coordBar').title.slice(0, 60) };
  })()`);
} catch (e) { report.coordErr = String(e.message); }

const shot = await send('Page.captureScreenshot', { format: 'png' });
const { writeFileSync } = await import('node:fs');
writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));

report.errors = errors;
console.log(JSON.stringify(report, null, 2));
edge.kill();
process.exit(0);
