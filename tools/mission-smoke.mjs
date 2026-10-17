/**
 * 探月任务四幕剧 3D 化端到端冒烟（headless Edge + CDP）
 * 验证（src/rocket.js 3D 版）：
 *   ① 点击「🌕 探月」场景预设进入任务面板 → 地球侧模型（rocket/craft）异步加载就绪
 *   ② start 后 seek 0.05（第一幕）→ 截图 + 3D 火箭渲染证据
 *   ③ seek 0.95（第四幕巡视）→ 月球侧模型（loiCraft/lander/rover）就绪、
 *      rover 轮子动画激活（animOn）→ 截图
 *   ④ 全程无 JS 异常 / console 错误
 * 前置知识（避免重踩）：
 *   - camera.position 是 lookAt 局部坐标；世界距离用 positionWC（见 models-smoke.mjs 头注）
 *   - requestRenderMode 下快照必须 requestRender() + render(now) 双步
 *   - 月球 viewer 每次进入都会重建（viewer.destroy()），模型槽位随之换代——冒烟按「seek 后轮询
 *     debugState」而非假设一次加载永久有效
 *   - 动画双帧步长勿踩周期整数倍（rover 周期 1s / 1.2 倍率 → 0.83s；用 0.21s 安全）
 * 用法：先启动 app.py，再 node tools/mission-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';
const WS_PATH = 'C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js';
const { default: WebSocket } = await import(`file:///${WS_PATH}`);

const EDGE_BIN = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9382;
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

// 快照工具（requestRenderMode 双步；月球/地球 viewer 分别取）
await evaluate(`(() => {
  window.__t = {
    snap(viewer) {
      const v = viewer || window.viewer;
      v.scene.requestRender();
      v.scene.render(Cesium.JulianDate.now());
      return v.scene.canvas.toDataURL('image/png');
    },
  };
  return true;
})()`);

// ① 点「🌕 探月」场景预设 → 进入任务面板（同时预加载地球侧模型）
const entered = await evaluate(`(() => {
  const btn = [...document.querySelectorAll('#sceneButtons button')].find((b) => b.textContent.includes('探月'));
  if (!btn) return { ok: false, why: 'no scenario button' };
  btn.click();
  return { ok: !!window.__moonMission };
})()`);
report.steps.enter = entered;
await sleep(500);

// ② 预加载地球侧模型就绪（rocket/craft）
report.steps.earthModels = await evaluate(`(async () => {
  const m = window.__moonMission;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 120; i++) {
    const st = m.debugState().slots;
    const rocket = st.find((s) => s.key === 'rocket');
    const craft = st.find((s) => s.key === 'craft');
    if (rocket && craft && rocket.ready && craft.ready) return { ok: true, waitedMs: i * 250, rocket, craft };
    await sleep(250);
  }
  return { ok: false, slots: m.debugState().slots };
})()`);

// ③ 点火 + 第一幕截图（p=0.05，上升段，分离尚未开始）
await evaluate(`window.__moonMission.start({ launchSite: 'wenchang', landingSite: 'imbrium' })`);
await sleep(1500);
await evaluate(`window.__moonMission.seek(0.05)`);
await sleep(1200);
report.steps.act1 = await evaluate(`(() => {
  const m = window.__moonMission;
  const rocket = m.debugState().slots.find((s) => s.key === 'rocket');
  const v = window.viewer;
  // 相机应紧跟火箭（lookAt 参考系：position 是局部坐标，这里只看相机是否存在且距离合理）
  return {
    rocket,
    phase: document.getElementById('rocketPhase') ? document.getElementById('rocketPhase').textContent : '',
    progress: document.getElementById('tourProgressText') ? document.getElementById('tourProgressText').textContent : '',
    playing: m.isActive(),
  };
})()`);
const shot1 = await evaluate(`window.__t.snap(window.viewer)`);
writeFileSync('tools/.mission-act1.png', Buffer.from(shot1.split(',')[1], 'base64'));

// ④ 跳第四幕（p=0.95，巡视中段）→ 月球侧模型就绪 + rover 动画激活
// 兜底：p 会随播放推进到 1（约 6s），若模型就绪时 tick 已停（animOn 未置位），
//       再 seek 一次强制 render 补挂动画（seekTo 内部必跑 render）。
await evaluate(`window.__moonMission.seek(0.95)`);
report.steps.act4 = await evaluate(`(async () => {
  const m = window.__moonMission;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pick = (st, k) => st.find((s) => s.key === k);
  for (let i = 0; i < 160; i++) {
    const st = m.debugState().slots;
    const lander = pick(st, 'lander'), rover = pick(st, 'rover');
    if (lander && rover && lander.ready && rover.ready) {
      if (rover.animOn) return { ok: true, waitedMs: i * 250, lander, rover };
      if (i > 24) { m.seek(0.97); }   // 已就绪但动画没挂上：强制一次 render
    }
    await sleep(250);
  }
  return { ok: false, slots: m.debugState().slots };
})()`);
await sleep(800);
report.steps.act4Phase = await evaluate(`(() => ({
  phase: document.getElementById('rocketPhase') ? document.getElementById('rocketPhase').textContent : '',
  progress: document.getElementById('tourProgressText') ? document.getElementById('tourProgressText').textContent : '',
}))()`);
// 月球 viewer 截图：优先 moon viewer 画布（__getMoonViewer 钩子），失败退回整页 CDP 截图
let act4Shot = null;
try {
  act4Shot = await evaluate(`(() => {
    const mv = window.__getMoonViewer && window.__getMoonViewer();
    return mv ? window.__t.snap(mv) : null;
  })()`);
} catch { /* 忽略 */ }
if (act4Shot) {
  writeFileSync('tools/.mission-act4.png', Buffer.from(act4Shot.split(',')[1], 'base64'));
} else {
  try {
    // CDP 的返回值就是 {data} 本身（勿多取 .result——2026-10-17 踩坑）
    const pageShot = await send('Page.captureScreenshot', { format: 'png' });
    if (pageShot?.data) {
      writeFileSync('tools/.mission-act4.png', Buffer.from(pageShot.data, 'base64'));
    }
  } catch { /* 忽略 */ }
}

// ⑤ 收尾：停止任务（含模型销毁），复位
await evaluate(`(() => { try { window.__moonMission.stop(); } catch {} return true; })()`);
await sleep(500);
report.steps.afterStop = await evaluate(`(() => ({
  active: window.__moonMission.isActive(),
  slotsLeft: window.__moonMission.debugState().slots.length,
}))()`);

console.log(JSON.stringify(report, null, 1));
edge.kill();
process.exit(0);
