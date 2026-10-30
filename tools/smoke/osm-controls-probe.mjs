/**
 * osm-controls-probe.mjs — 验证 OSM 场景右上角控件列改版（2026-10-30）：
 *   ① 数据来源控件挂进 MapLibre .maplibregl-ctrl-top-right（缩放 +/- 正下方、右缘对齐）
 *   ② 按钮文案「在线 / 本地」（不再是「离线(本地)」），无「接缝诊断」
 *   ③ 返回球体钮（.osm-nav-btn）也在控件列内、带 in-osm-col
 *   ④ 退出 OSM 后返回球体钮回到 #app 贴边位（top:304 right:48）
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const WS_PATH = 'C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js';
const { default: WebSocket } = await import(`file:///${WS_PATH}`);

const EDGE_BIN = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9399;
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
  if (r.exceptionDetails) return { __evalError: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r.result.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: URL });

const ready = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 160; i++) {
    if (window.Cesium && window.viewer) return { ok: true };
    await sleep(250);
  }
  return { ok: false };
})()`);
if (!ready.ok) { edge.kill(); throw new Error('页面未就绪'); }

// ---- 进入 OSM 场景：点右上角 🗺 钮 ----
await evaluate(`(async () => {
  const btn = document.querySelector('.osm-nav-btn');
  if (!btn) return { clicked: false };
  btn.click();
  return { clicked: true };
})()`);

// 等 OSM 场景初始化（MapLibre map + 控件）
const osmState = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 60; i++) {
    const trc = document.querySelector('#osmMap .maplibregl-ctrl-top-right');
    const ctl = document.querySelector('#osmMap .osm-mode-ctl');
    if (trc && ctl) {
      const zoomGroup = trc.querySelector('.maplibregl-ctrl-group');
      const navBtn = document.querySelector('.osm-nav-btn');
      const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: +r.top.toFixed(1), right: +(innerWidth - r.right).toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; };
      const toggle = ctl.querySelector('.osm-mode-toggle');
      return {
        inTrc: ctl.parentElement === trc,
        navBtnInTrc: navBtn ? navBtn.parentElement === trc : null,
        navBtnCls: navBtn ? navBtn.className : null,
        toggleText: toggle ? toggle.textContent.trim() : null,
        toggleTitle: toggle ? toggle.title : null,
        hasTilt: !!ctl.querySelector('.osm-mode-btn') || [...ctl.querySelectorAll('button')].some((b) => b.textContent.includes('立体视角')),
        zoom: rect(zoomGroup),
        ctl: rect(ctl),
        navBtn: rect(navBtn),
      };
    }
    await sleep(500);
  }
  return { timeout: true };
})()`);
console.log('[OSM 内]', JSON.stringify(osmState, null, 2));

// ---- 点 toggle 切数据来源，验证切换 + 状态着色 + 横幅（绿色=有本地覆盖） ----
await evaluate(`(async () => { const t = document.querySelector('.osm-mode-toggle'); if (t) t.click(); return 1; })()`);
await sleep(3500);
const toggleTest = await evaluate(`(() => {
  const t = document.querySelector('.osm-mode-toggle');
  const b = document.getElementById('osmBanner');
  return {
    toggleText: t ? t.textContent.trim() : null,
    toggleCls: t ? t.className : null,
    banner: b ? { text: b.textContent, bg: b.style.background, visible: b.style.display !== 'none' } : null,
    bannerMentionsOldUi: b ? /左上角|数据来源/.test(b.textContent) : null,
  };
})()`);
console.log('[toggle 切换后]', JSON.stringify(toggleTest, null, 2));

// ---- 跳到上海（离线覆盖城市）再点 toggle：验证「在线进入后 _city 为空也能切本地」的修复 ----
await evaluate(`(async () => {
  const m = window.__osmScene && window.__osmScene.getMap();
  if (!m) return { map: false };
  m.jumpTo({ center: [121.4737, 31.2304], zoom: 15 });
  return { map: true };
})()`);
await sleep(1200);
await evaluate(`(async () => { const t = document.querySelector('.osm-mode-toggle'); if (t) t.click(); return 1; })()`);
await sleep(3500);
const shTest = await evaluate(`(() => {
  const t = document.querySelector('.osm-mode-toggle');
  const b = document.getElementById('osmBanner');
  return {
    toggleText: t ? t.textContent.trim() : null,
    toggleCls: t ? t.className : null,
    bannerVisible: b ? b.style.display !== 'none' : null,
  };
})()`);
console.log('[上海切本地]', JSON.stringify(shTest, null, 2));

// ---- 退出 OSM：点返回球体钮，验证回到 #app 贴边位 ----
await evaluate(`(async () => {
  const btn = document.querySelector('.osm-nav-btn');
  if (btn) btn.click();
  return true;
})()`);
await sleep(2500);
const after = await evaluate(`(() => {
  const btn = document.querySelector('.osm-nav-btn');
  if (!btn) return { found: false };
  const r = btn.getBoundingClientRect();
  return {
    found: true,
    inApp: btn.parentElement && btn.parentElement.id === 'app',
    cls: btn.className,
    pos: { top: +r.top.toFixed(1), right: +(innerWidth - r.right).toFixed(1) },
    icon: btn.querySelector('.osm-nav-icon') ? btn.querySelector('.osm-nav-icon').textContent : null,
  };
})()`);
console.log('[退出后]', JSON.stringify(after, null, 2));

ws.close();
edge.kill();
