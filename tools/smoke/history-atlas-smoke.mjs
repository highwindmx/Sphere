/**
 * 历史时空端到端冒烟（headless Edge + CDP）
 *
 * 验证项：
 *   ① 面板挂载：年份轴（世界 54 档 + 中国 181 阶段起点）合并成功，滑块可用
 *   ② 勾选「启用历史时空」→ 世界国界 + 中国历代疆域两套数据都真的建出实体
 *   ③ 状态行报告要素数；悬停信息回调可用
 *   ④ 切年份到前 221 年（秦）→ 中国阶段正确切换，实体重建
 *   ⑤ 取消勾选 → 数据源清空，无残留实体
 *   ⑥ 全程零 console 异常
 *
 * 用法：先启动 app.py，再 node tools/smoke/history-atlas-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync, mkdirSync } from 'node:fs';

const WS_PATH = 'C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js';
const { default: WebSocket } = await import(`file:///${WS_PATH}`);

const EDGE_BIN = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9391;
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
    errors.push(msg.params.exceptionDetails?.text + ' ' + (msg.params.exceptionDetails?.exception?.description ?? ''));
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
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval error');
  return r.result.value;
}
async function shot(name, clip) {
  const r = await send('Page.captureScreenshot', { format: 'png', clip: { scale: 1, ...clip } });
  writeFileSync(`${SHOT_DIR}/${name}`, Buffer.from(r.data, 'base64'));
}

// ⚠ 截图前必须等影像瓦片全部落位。软渲染下瓦片细化极慢，抢在细化途中截图会拍到
//   "整块苍白薄膜"（未细化的粗瓦片/底色），看起来像渲染 bug，其实是采样时机问题。
async function settleGlobe() {
  await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 90; i++) {
      if (window.viewer?.scene?.globe?.tilesLoaded) break;
      await sleep(500);
    }
    await sleep(1500);
    window.viewer?.scene?.requestRender?.();
    return 1;
  })()`);
}

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: URL });

const ready = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 160; i++) {
    if (window.Cesium && window.viewer) return { ok: true, waitedMs: i * 250 };
    await sleep(250);
  }
  return { ok: false };
})()`);
if (!ready.ok) { edge.kill(); throw new Error('页面 viewer 未就绪'); }

const report = { errors, consoleErrors, steps: {} };

// ① 面板挂载 + 年份轴
report.steps.panel = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 60; i++) {
    if (window.historyTimeline && window.historyTimeline.length) break;
    await sleep(250);
  }
  const tl = window.historyTimeline || [];
  const sl = document.getElementById('histSlider');
  const withChina = tl.filter((t) => t.china).length;
  const withWorld = tl.filter((t) => t.world).length;
  return {
    mounted: !!document.getElementById('histEnable'),
    timelineLen: tl.length,
    withWorld, withChina,
    sliderMax: sl ? Number(sl.max) : null,
    sliderValue: sl ? Number(sl.value) : null,
    yearLabel: document.getElementById('histYear')?.textContent,
    eraLabel: document.getElementById('histEra')?.textContent?.slice(0, 60),
  };
})()`);

// ② 启用 → 建实体
const enableRes = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cb = document.getElementById('histEnable');
  cb.checked = true;
  cb.dispatchEvent(new Event('change', { bubbles: true }));
  // 等到状态行被写入 = rebuild 真正走完（只数实体会在异步渲染中途就满足）
  for (let i = 0; i < 120; i++) {
    if ((document.getElementById('histStatus')?.textContent || '').length > 0) break;
    await sleep(500);
  }
  await sleep(1500);
  const ds = window.viewer.dataSources.getByName('history-atlas')[0];
  const ents = ds ? ds.entities.values : [];
  const kinds = {};
  let polys = 0, points = 0, lines = 0, labels = 0;
  for (const e of ents) {
    const k = e._hist ? e._hist.kind : '?';
    kinds[k] = (kinds[k] || 0) + 1;
    if (e.polygon) polys++;
    if (e.point) points++;
    if (e.polyline) lines++;
    if (e.label) labels++;
  }
  return {
    entityCount: ents.length, polys, points, lines, labels, kinds,
    status: document.getElementById('histStatus')?.textContent,
    year: document.getElementById('histYear')?.textContent,
    era: document.getElementById('histEra')?.textContent?.slice(0, 60),
  };
})()`);
report.steps.enable = enableRes;
await settleGlobe();
await shot('history-1900.png', { x: 300, y: 120, width: 900, height: 600 });

// ③ 切年份：前 221 年（秦）
report.steps.qin = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.historyAtlas.setYear(-221);
  for (let i = 0; i < 120; i++) {
    if ((document.getElementById('histYear')?.textContent || '').includes('221')) break;
    await sleep(500);
  }
  await sleep(1500);
  const ds = window.viewer.dataSources.getByName('history-atlas')[0];
  const polities = ds.entities.values.filter((e) => e._hist && e._hist.kind === 'polity').map((e) => e._hist.name);
  return {
    entityCount: ds.entities.values.length,
    polityCount: polities.length,
    polities: polities.slice(0, 12),
    year: document.getElementById('histYear')?.textContent,
    era: document.getElementById('histEra')?.textContent?.slice(0, 80),
    status: document.getElementById('histStatus')?.textContent,
  };
})()`);
await settleGlobe();
await shot('history-qin.png', { x: 300, y: 120, width: 900, height: 600 });

// ④ 切到 1492（世界数据面数最多的一档，压力观察）
report.steps.y1492 = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const t0 = performance.now();
  window.historyAtlas.setYear(1492);
  for (let i = 0; i < 120; i++) {
    if ((document.getElementById('histYear')?.textContent || '').includes('1492')) break;
    await sleep(500);
  }
  await sleep(1500);
  const ds = window.viewer.dataSources.getByName('history-atlas')[0];
  return {
    ms: Math.round(performance.now() - t0),
    entityCount: ds.entities.values.length,
    status: document.getElementById('histStatus')?.textContent,
    era: document.getElementById('histEra')?.textContent?.slice(0, 60),
  };
})()`);

// ④b 打开「世界历史城市」层（2220 点的 places.json 按需加载）
report.steps.places = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const before = window.viewer.dataSources.getByName('history-atlas')[0].entities.values.length;
  window.historyAtlas.setLayer('places', true);
  for (let i = 0; i < 120; i++) {
    const ds = window.viewer.dataSources.getByName('history-atlas')[0];
    if (ds.entities.values.some((e) => e._hist && e._hist.kind === 'place')) break;
    await sleep(500);
  }
  await sleep(1500);
  const ds = window.viewer.dataSources.getByName('history-atlas')[0];
  const pl = ds.entities.values.filter((e) => e._hist && e._hist.kind === 'place');
  return {
    before, after: ds.entities.values.length, placeCount: pl.length,
    sample: pl.slice(0, 3).map((e) => e._hist.name),
    status: document.getElementById('histStatus')?.textContent,
  };
})()`);

// ⑤ 取消勾选 → 清空
report.steps.disable = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cb = document.getElementById('histEnable');
  cb.checked = false;
  cb.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(3000);
  const ds = window.viewer.dataSources.getByName('history-atlas')[0];
  return { entityCount: ds ? ds.entities.values.length : -1, show: ds ? ds.show : null };
})()`);

// ⑥ 数据源资产可达性（服务端静态）
const http = await import('node:http');
async function head(path) {
  return new Promise((resolve) => {
    http.default.get({ host: '127.0.0.1', port: 5008, path, timeout: 20000 }, (res) => {
      let n = 0;
      res.on('data', (c) => { n += c.length; });
      res.on('end', () => resolve({ status: res.statusCode, bytes: n }));
    }).on('error', (e) => resolve({ error: String(e) }));
  });
}
report.steps.assets = {
  worldIndex: await head('/data/history/world/index.json'),
  chinaIndex: await head('/data/history/china/index.json'),
  chinaBundle: await head('/data/history/china/atlas_snapshots.js'),
  w1900: await head('/data/history/world/w_1900.json'),
};

writeFileSync('tools/.history-atlas-smoke.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
ws.close();
edge.kill();
