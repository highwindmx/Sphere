/**
 * 图源设置 Demo v6 冒烟（headless Edge + CDP）
 * 验证三点需求：
 *  ① 凭证配置：需凭证的源行内 🔑 按钮 + 区块标题「＋ 添加」下拉（Cesium ion / 天地图 / 自定义）
 *  ② 合计含高程：总计含影像+高程，悬停 title 与展开分项列出每个源
 *  ③ 每源独立：已缓存明细按 z 分层列表 + 下载进度条在各自源行内（队列 ⏳/▶/✓）
 * 用法：先起 app.py，再 node tools/demo-v6-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
const WS_PATH = 'C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js';
const { default: WebSocket } = await import(`file:///${WS_PATH}`);

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9381;
const URL = 'http://127.0.0.1:5008/source-settings-demo-v6.html';
const SHOT = 'tools/.demo-v6.png';

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

// ① 源行与凭证按钮
try {
  report.creds = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#src-list .src')];
    const keyBtns = [...document.querySelectorAll('#src-list .act-key')];
    const tiandituRow = document.querySelector('#src-list .src[data-id="tianditu"]');
    const tdBtn = tiandituRow?.querySelector('.act-key');
    const credBefore = tiandituRow?.querySelector('.cred')?.classList.contains('open');
    tdBtn?.click();
    const credAfter = tiandituRow?.querySelector('.cred')?.classList.contains('open');
    return {
      rows: rows.length,
      keyBtnCount: keyBtns.length,
      keyBtnTexts: keyBtns.map((b) => b.textContent.trim()),
      credToggle: { before: credBefore, after: credAfter },
      hasInput: !!tiandituRow?.querySelector('.cred-input'),
    };
  })()`);
} catch (e) { report.credsErr = String(e.message); }

// ①b 「＋ 添加」下拉：加入 Cesium ion（需 token）
try {
  report.addMenu = await evaluate(`(() => {
    document.getElementById('addBtn').click();
    const menu = document.getElementById('addMenu');
    const items = [...menu.querySelectorAll('[data-add]')].map((i) => i.dataset.add);
    const open = menu.classList.contains('open');
    menu.querySelector('[data-add="ion"]').click();
    const row = document.querySelector('#src-list .src[data-id="ion"]');
    return {
      items, menuOpen: open,
      ionAdded: !!row,
      ionCredOpen: !!row?.querySelector('.cred')?.classList.contains('open'),
      ionKeyBtn: row?.querySelector('.act-key')?.textContent.trim() || null,
      rowsAfter: document.querySelectorAll('#src-list .src').length,
    };
  })()`);
} catch (e) { report.addMenuErr = String(e.message); }

// ①c 凭证保存后按钮回显掩码
try {
  report.credSave = await evaluate(`(() => {
    const row = document.querySelector('#src-list .src[data-id="ion"]');
    row.querySelector('.cred-input').value = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9TEST';
    row.querySelector('.cred-save').click();
    const row2 = document.querySelector('#src-list .src[data-id="ion"]');
    return {
      btn: row2?.querySelector('.act-key')?.textContent.trim() || null,
      stored: (localStorage.getItem('sphere-ion-token') || '').slice(-4),
    };
  })()`);
} catch (e) { report.credSaveErr = String(e.message); }

// ② 合计含高程 + hover 明细
try {
  report.totals = await evaluate(`(() => {
    const t = document.getElementById('total-tiles'), b = document.getElementById('total-bytes');
    document.getElementById('totalRow').click();
    const brk = document.getElementById('totalBreak');
    return {
      tiles: t.textContent, bytes: b.textContent,
      sub1: document.getElementById('total-tiles-sub').textContent,
      sub2: document.getElementById('total-bytes-sub').textContent,
      tipHasTerrain: (document.getElementById('boxTiles').title || '').includes('高程'),
      tipLines: (document.getElementById('boxTiles').title || '').split('\\n').filter(Boolean).slice(0, 6),
      breakdownOpen: brk.classList.contains('open'),
      breakdownRows: [...brk.querySelectorAll('.tb')].map((r) => r.textContent.replace(/\\s+/g, ' ').trim()).slice(0, 6),
    };
  })()`);
} catch (e) { report.totalsErr = String(e.message); }

// ③ 每源：按精度缓存明细
try {
  report.levels = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#src-list .src')];
    rows.forEach((r) => r.querySelector('.act-lv').click());   // 全部展开
    const esri = document.querySelector('#src-list .src[data-id="esri"]');
    const lv = [...esri.querySelectorAll('.lv')].map((d) => d.textContent.replace(/\\s+/g, ' ').trim());
    const terrain = document.querySelector('#terrain-list .src');
    terrain.querySelector('.act-lv').click();
    const tlv = [...terrain.querySelectorAll('.lv')].map((d) => d.textContent.replace(/\\s+/g, ' ').trim());
    const cacheChip = esri.querySelector('.chip.cache');
    return {
      esriLevels: lv.slice(0, 6), esriLevelCount: lv.length,
      terrainLevels: tlv.slice(0, 6), terrainLevelCount: tlv.length,
      chipTitle: (cacheChip?.title || '').split('\\n').slice(0, 4),
    };
  })()`);
} catch (e) { report.levelsErr = String(e.message); }

// ③b 每源独立下载进度 + 队列（两个源各点一次）
try {
  report.queue = await evaluate(`(async () => {
    const esri = document.querySelector('#src-list .src[data-id="esri"]');
    const eox = document.querySelector('#src-list .src[data-id="eox"]');
    esri.querySelector('[data-dlkey="esri|skel|full"]').click();
    eox.querySelector('[data-dlkey="eox|low|full"]').click();
    await new Promise((r) => setTimeout(r, 1200));
    const snap = () => ({
      esriBtn: esri.querySelector('[data-dlkey="esri|skel|full"]').textContent.trim(),
      eoxBtn: eox.querySelector('[data-dlkey="eox|low|full"]').textContent.trim(),
      esriProg: esri.querySelector('.prog').classList.contains('on'),
      eoxProg: eox.querySelector('.prog').classList.contains('on'),
      esriTxt: esri.querySelector('.prog-txt').textContent,
      eoxTxt: eox.querySelector('.prog-txt').textContent,
    });
    const s1 = snap();
    // 重复点击同任务：按钮已禁用，点击不产生新队列项
    const dupBtn = esri.querySelector('[data-dlkey="esri|skel|full"]');
    dupBtn.click();
    const dup = { disabled: dupBtn.disabled, text: dupBtn.textContent.trim() };
    return { s1, dup };
  })()`);
} catch (e) { report.queueErr = String(e.message); }

const shot = await send('Page.captureScreenshot', { format: 'png' });
const { writeFileSync } = await import('node:fs');
writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));

report.errors = errors;
console.log(JSON.stringify(report, null, 2));
edge.kill();
process.exit(0);
