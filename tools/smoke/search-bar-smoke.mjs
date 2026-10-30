/**
 * 统一检索栏 v2 端到端冒烟（headless Edge + CDP）
 *
 * 覆盖 2026-10-29 第二轮用户反馈的三件事：
 *   ① 侧栏只剩检索栏 + 显示图层 + 头部三块（面板不再通栏，左下露出地球）
 *   ② 点巡礼站点**瞬移**落点，不再从头把路径飞一遍
 *   ③ 检索另一结果时，原来的巡礼/历史**必须停**并把列表行置灰（面板独占）
 *
 * 用法：先启动 app.py（:5008），再 node tools/smoke/search-bar-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync, mkdirSync } from 'node:fs';

const WS_PATH = 'C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js';
const { default: WebSocket } = await import(`file:///${WS_PATH}`);

const EDGE_BIN = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9397;
const URL = 'http://127.0.0.1:5008/';
const SHOT_DIR = 'tools/shots/earth';
mkdirSync(SHOT_DIR, { recursive: true });

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
const errors = [];
const consoleErrors = [];
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    errors.push((msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || '').slice(0, 500));
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const t = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
    if (/error|Error|失败|异常/i.test(t)) consoleErrors.push(t.slice(0, 300));
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
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${SHOT_DIR}/${name}`, Buffer.from(r.data, 'base64'));
}

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

const report = { errors, consoleErrors, waitedMs: ready.waitedMs, steps: {} };

// ① 版面：面板不再通栏；地球铺满全宽
report.steps.layout = await evaluate(`(() => {
  const p = document.getElementById('panel').getBoundingClientRect();
  const c = document.getElementById('cesiumContainer').getBoundingClientRect();
  return {
    vw: innerWidth, vh: innerHeight,
    panel: { w: Math.round(p.width), h: Math.round(p.height), bottom: Math.round(p.bottom) },
    canvas: { w: Math.round(c.width), h: Math.round(c.height), left: Math.round(c.left) },
    panelRelative: getComputedStyle(document.getElementById('panel')).position,
    hasLayersSectionVisible: !!document.getElementById('layersSection')?.offsetParent,
    hasHistorySectionVisible: !!document.getElementById('historySection')?.offsetParent,
    shownBlock: !!document.getElementById('shownLayers'),
    // 2026-10-29 第三轮：检索框必须在「显示图层」正上方；面板不得出滚动条（毛玻璃曾把 fixed 下拉
    // 变成面板内部元素，撑出滚动条还把球体按钮挤成两行）
    order: [...document.getElementById('panel').querySelectorAll(':scope > *, .panel-head > *')]
      .map((e) => e.id || e.className),
    searchAboveShown: (() => {
      const a = document.getElementById('searchBar').getBoundingClientRect();
      const b = document.getElementById('shownSection').getBoundingClientRect();
      return a.bottom <= b.top + 1;
    })(),
    panelScrolls: (() => { const p = document.getElementById('panel'); return p.scrollHeight > p.clientHeight + 1; })(),
    exagLabel: document.getElementById('exagBtn')?.textContent.replace(/\s+/g, ' ').trim(),
  };
})()`);

// ② 空查询 → 图层目录
report.steps.catalog = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const inp = document.getElementById('unifiedSearch');
  inp.focus(); inp.value = ''; inp.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(200);
  const box = document.getElementById('searchResults');
  const groups = [...box.querySelectorAll('.sr-group-title')].map((g) => g.textContent.trim());
  const items = box.querySelectorAll('.sr-item').length;
  const r = box.getBoundingClientRect(), p = document.getElementById('panel').getBoundingClientRect();
  return {
    hidden: box.classList.contains('hidden'),
    groups, items,
    clipped: r.bottom > innerHeight - 1 || r.right > innerWidth - 1 || r.top < -1,
    firstItems: [...box.querySelectorAll('.sr-item .sr-label')].slice(0, 3).map((n) => n.textContent.trim()),
  };
})()`);

const clickResult = (q, hintLike) => evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const inp = document.getElementById('unifiedSearch');
  inp.focus(); inp.value = ${JSON.stringify(q)}; inp.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(200);
  const box = document.getElementById('searchResults');
  const btn = [...box.querySelectorAll('.sr-item')].find((b) => (b.querySelector('.sr-hint')?.textContent || '').includes(${JSON.stringify(hintLike)}));
  if (!btn) return { clicked: false, got: box.textContent.slice(0, 160) };
  const label = btn.querySelector('.sr-label').textContent.trim();
  btn.click();
  await sleep(150);
  return { clicked: true, label, rows: [...document.querySelectorAll('#shownLayers .sl-row')].map((r) => ({ name: r.querySelector('.sl-name').textContent.trim(), on: r.classList.contains('on') })) };
})()`);

// ③ 腊子口：瞬移落点（1.2 秒内应到 87%，不是从 0 慢慢走）
report.steps.lazikou = await (async () => {
  const c = await clickResult('腊子口', '跳到节点');
  await sleep(1200);
  const state = await evaluate(`(() => ({
    title: document.getElementById('tourTitle')?.textContent,
    prog: document.getElementById('tourProgressText')?.textContent,
    clock: document.getElementById('tourClock')?.textContent,
    card: (document.getElementById('poemCard')?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
    panelHidden: document.getElementById('tourPanel')?.classList.contains('hidden'),
  }))()`);
  return { ...c, ...state };
})();

// ④ 再点历史 → 长征必须停、列表里长征行置灰、面板切成「历史时间轴」
report.steps.switchToHistory = await (async () => {
  const c = await clickResult('唐朝', '历史巡礼');
  let title = '';
  for (let i = 0; i < 80; i++) {
    title = await evaluate(`document.getElementById('tourTitle')?.textContent || ''`);
    if (title.includes('历史时间轴')) break;
    await sleep(250);
  }
  await sleep(1200);
  const s1 = await evaluate(`(() => ({
    title: document.getElementById('tourTitle')?.textContent,
    clock: document.getElementById('tourClock')?.textContent,
    prog: document.getElementById('tourProgressText')?.textContent,
    panelHidden: document.getElementById('tourPanel')?.classList.contains('hidden'),
    rows: [...document.querySelectorAll('#shownLayers .sl-row')].map((r) => ({ name: r.querySelector('.sl-name').textContent.trim(), on: r.classList.contains('on') })),
    tourStillActive: !!(window.__probeTourActive && window.__probeTourActive()),
  }))()`);
  await sleep(1400);
  const s2 = await evaluate(`document.getElementById('tourClock')?.textContent || ''`);
  return { ...c, ...s1, clock2: s2 };
})();

// ④b 历史时间轴截图（面板年份条 + 里程碑解说）
await evaluate(`(async () => {
  document.getElementById('unifiedSearch').blur();
  document.getElementById('searchResults')?.classList.add('hidden');
  await new Promise((r) => setTimeout(r, 700));
  return 1;
})()`);
await shot('search-v2-era.png');

// ⑤ 手动叠回：点亮长征行（灰 → 亮），历史行应被面板独占逻辑置灰
report.steps.reEnable = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rows = [...document.querySelectorAll('#shownLayers .sl-row')];
  const tourRow = rows.find((r) => r.textContent.includes('长征'));
  if (!tourRow) return { found: false };
  tourRow.click();
  await sleep(1500);
  return {
    found: true,
    rows: [...document.querySelectorAll('#shownLayers .sl-row')].map((r) => ({ name: r.querySelector('.sl-name').textContent.trim(), on: r.classList.contains('on') })),
    title: document.getElementById('tourTitle')?.textContent,
    prog: document.getElementById('tourProgressText')?.textContent,
  };
})()`);

// ⑥ 天宫接管（用户第 3 号问题：点了天宫，长征巡礼还在、时间轴没切）
//    离线/无 TLE 时天宫本体可能加载失败，但"先停别人的面板"这一步必须无条件成立。
report.steps.tiangong = await (async () => {
  const c = await clickResult('天宫', '显示');
  await sleep(2500);
  const s = await evaluate(`({
    title: document.getElementById('tourTitle')?.textContent || '',
    panelHidden: document.getElementById('tourPanel')?.classList.contains('hidden'),
    tourProg: document.getElementById('tourProgressText')?.textContent || '',
    rows: [...document.querySelectorAll('#shownLayers .sl-row')].map((r) => (r.classList.contains('on') ? '+' : '-') + r.querySelector('.sl-name').textContent.trim()),
  })`);
  return { ...c, ...s };
})();

// ⑦ ✕ 删除一行
report.steps.removeRow = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const before = document.querySelectorAll('#shownLayers .sl-row').length;
  document.querySelector('#shownLayers .sl-x')?.click();
  await sleep(400);
  return { before, after: document.querySelectorAll('#shownLayers .sl-row').length };
})()`);

// ⑧ 行星标注（2026-10-29）：搜「静海」应切到月球并定位；搜「奥林匹斯」切火星；再搜「北京」自动切回地球
report.steps.bodyJump = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rows = () => [...document.querySelectorAll('#shownLayers .sl-row')]
    .map((r) => (r.classList.contains('on') ? '+' : '-') + r.querySelector('.sl-name').textContent.trim());
  const pick = async (q) => {
    const inp = document.getElementById('unifiedSearch');
    inp.focus(); inp.value = q; inp.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(450);
    return [...document.querySelectorAll('#searchResults .sr-item')];
  };
  const cam2 = (v) => {
    const c = v?.camera.positionCartographic;
    return c ? { lon: +(c.longitude * 180 / Math.PI).toFixed(2), lat: +(c.latitude * 180 / Math.PI).toFixed(2), h: Math.round(c.height) } : null;
  };
  const out = {};
  const m1 = await pick('静海');
  out.moonItems = m1.map((i) => i.textContent.trim());
  m1[0]?.click();
  await sleep(4500);
  out.moon = {
    active: document.getElementById('btnMoonMode').classList.contains('active'),
    // 2026-10-30：侧栏「月面标注」区块已删除，改判右侧导航列按球体出现的按钮
    navBodyHomeGone: document.getElementById('btnBodyHome') === null,
    navMoonHiRes: !document.getElementById('btnMoonHiRes').classList.contains('hidden'),
    navMarsHill: document.getElementById('btnMarsHillshade').classList.contains('hidden'),
    groupChecked: [...document.querySelectorAll('#moonGroups input')].filter((c) => c.checked).map((c) => c.dataset.group),
    cam: cam2(window.__getMoonViewer?.()),
    rows: rows(),
  };
  const m2 = await pick('奥林匹斯');
  out.marsItems = m2.map((i) => i.textContent.trim());
  m2[0]?.click();
  await sleep(4500);
  out.mars = {
    active: document.getElementById('btnMarsMode').classList.contains('active'),
    groupChecked: [...document.querySelectorAll('#marsGroups input')].filter((c) => c.checked).map((c) => c.dataset.group),
    cam: cam2(window.__getMarsViewer?.()),
    rows: rows(),
  };
  // 火星模式下点地球地点 → 应自动切回地球（不再是"只弹提示"）
  const m3 = await pick('北京');
  m3.find((i) => (i.querySelector('.sr-hint')?.textContent || '').includes('定位'))?.click();
  await sleep(3200);
  out.backToEarth = {
    earthActive: document.getElementById('btnEarthMode').classList.contains('active'),
    canvasVisible: !document.getElementById('cesiumContainer').classList.contains('hidden'),
    rows: rows(),
  };
  return out;
})()`);

// ⑦ 首次访问的默认态（截图用）：清空列表 + 收面板
await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  document.getElementById('tourStop')?.click();
  document.getElementById('unifiedSearch').blur();
  document.getElementById('searchResults')?.classList.add('hidden');
  await sleep(600);
  return 1;
})()`);
await shot('search-v3-idle.png');
await evaluate(`(async () => {
  document.getElementById('unifiedSearch').focus();
  document.getElementById('unifiedSearch').dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));
  return 1;
})()`);
await shot('search-v3-catalog.png');

writeFileSync('tools/shots/earth/search-v3-report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
ws.close();
edge.kill();
