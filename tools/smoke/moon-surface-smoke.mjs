/**
 * 第二幕月球表面材质冒烟（headless Edge + CDP）
 * 验证 src/rocket.js 的「程序化月面 MoonSurfaceMaterialProperty + 真实照片自检回退」：
 *   ① 页面加载 / 进入探月任务无 JS 异常、无 console 错误（着色器编译错误会落在这里）
 *   ② debugState().moonTexMode 初始应为 'proc'（程序化月面默认）
 *   ③ 自检循环跑 ~14s 后 moonTexAuto 应为 ok（照片上屏）或 reverted-to-proc(...)（白球回退，仍可见）
 *      —— 二者都代表「用户看到了带表面的月球」；err:/卡在 wait 才是异常
 *   ④ 捕获幕截图存档 tools/shots/mission/.moon-surface.png 供肉眼核对月面
 * 前置：先启动 app.py（.venv/Scripts/python.exe app.py → 127.0.0.1:5008），再 node tools/moon-surface-smoke.mjs
 * 注意：headless 对纹理外观永远「假绿」，无法判定真实照片是否真上屏；本脚本只守「无报错 +
 *       自检结论健康」。最终外观以你实机 Ctrl+F5 为准（__moonMission.debugState().moonTex*）。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';
const WS_PATH = 'C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js';
const { default: WebSocket } = await import(`file:///${WS_PATH}`);

const EDGE_BIN = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9395;
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
    const txt = msg.params.exceptionDetails?.text + ' ' + (msg.params.exceptionDetails?.exception?.description ?? '');
    if (/setPointerCapture/.test(txt)) return;
    errors.push(txt);
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const t = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
    if (/error|Error|失败|异常|shader|Shader/i.test(t)) consoleErrors.push(t.slice(0, 300));
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
    if (window.Cesium && window.viewer && window.__moonMission) return { ok: true, waitedMs: i * 250 };
    await sleep(250);
  }
  return { ok: false };
})()`);
if (!ready.ok) { edge.kill(); throw new Error('页面 viewer/__moonMission 未就绪'); }

// 进入探月任务面板（触发 moonEnt 创建 + 材质注册 + 自检循环启动）
const entered = await evaluate(`(() => {
  const btn = [...document.querySelectorAll('#toolButtons button')].find((b) => b.textContent.includes('探月任务'));
  if (!btn) return { ok: false, why: 'no scenario button' };
  btn.click();
  return { ok: !!window.__moonMission };
})()`);
await sleep(800);

// 立即读取默认材质模式
const mode0 = await evaluate(`(() => {
  const m = window.__moonMission;
  return m ? m.debugState().moonTexMode : null;
})()`);

// 让自检循环跑一会儿（首次尝试挂照片在 moonEnt 就绪后，间隔 6s；这里等 14s 足够看到结论）
await sleep(14000);
const diag = await evaluate(`(() => {
  const m = window.__moonMission;
  const d = m.debugState();
  return { moonTexMode: d.moonTexMode, moonTexAuto: d.moonTexAuto, moonTex: d.moonTex, moonTexReady: d.moonTexReady };
})()`);

// 跳到捕获幕（真实比例月球居中）截图存盘
await evaluate(`(() => { const m = window.__moonMission; const tl = m.timeline(); m.seek(tl.card2End + (tl.loiEnd - tl.card2End) * 0.5); return true; })()`);
await sleep(2500);
try {
  const shot = await evaluate(`(() => {
    const v = window.viewer;
    v.scene.requestRender(); v.scene.render(Cesium.JulianDate.now());
    return v.scene.canvas.toDataURL('image/png');
  })`);
  writeFileSync('tools/shots/mission/.moon-surface.png', Buffer.from(shot.split(',')[1], 'base64'));
} catch (e) { /* 截图失败不阻断 */ }

const healthy = ['ok', 'reverted-to-proc'].some((p) => (diag.moonTexAuto || '').startsWith(p));
console.log(JSON.stringify({ entered, mode0, diag, errors, consoleErrors }, null, 1));
const bad = [];
if (!entered.ok) bad.push('未能进入探月任务');
if (mode0 !== 'proc') bad.push('默认材质非 proc（=' + mode0 + '）');
if (errors.length) bad.push('JS 异常: ' + errors.slice(0, 3).join(' | '));
if (consoleErrors.length) bad.push('console 错误: ' + consoleErrors.slice(0, 3).join(' | '));
if (!healthy) bad.push('自检结论异常: ' + diag.moonTexAuto);
console.log(bad.length ? 'MOON SURFACE FAIL: ' + bad.join('; ') : 'MOON SURFACE OK');
edge.kill();
process.exit(bad.length ? 1 : 0);
