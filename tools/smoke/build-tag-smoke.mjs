/**
 * 版本号显式化验证（headless Edge + CDP）：
 *  ① 页面右上角 #buildTag 显示的 build == 服务端注入 index.html 的 ?v=（防旧缓存误判）
 *  ② window.__sphereBuild() 返回完整诊断 JSON（含 polar/imagiery 子对象）
 *  ③ ⧉ 复制诊断按钮存在且点击无 JS 错误
 * 用法：node tools/build-tag-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const WS_PATH = 'C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js';
const { default: WebSocket } = await import(`file:///${WS_PATH}`);

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9352;
const BASE = 'http://127.0.0.1:5008';

const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  '--disable-extensions', '--use-gl=angle', '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader', '--window-size=1400,1000', 'about:blank',
], { stdio: 'ignore' });

let wsUrl = null;
for (let i = 0; i < 40 && !wsUrl; i++) {
  await sleep(500);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) wsUrl = page.webSocketDebuggerUrl;
  } catch { /* 还没起来 */ }
}
if (!wsUrl) { edge.kill(); throw new Error('无法连接 Edge 调试端口'); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

let id = 0;
const pending = new Map();
const errors = [];
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params.exceptionDetails?.text + ' ' + (m.params.exceptionDetails?.exception?.description ?? ''));
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push('console.error: ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
  }
});
const send = (method, params = {}) => {
  const i = ++id;
  ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise((res, rej) => pending.set(i, { res, rej }));
};
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true });
  return r.result.value;
};

const report = {};
try {
  await send('Runtime.enable');
  await send('Page.enable');

  // 服务端当前 build（从 index.html 里 main.js 的 ?v= 提取，权威值）
  const html = await (await fetch(BASE + '/')).text();
  const m = html.match(/src="\/src\/main\.js\?v=([^"]+)"/);
  report.serverBuild = m ? m[1] : null;

  await send('Page.navigate', { url: BASE + '/' });
  await sleep(7000); // 等 main.js 初始化完

  report.buildTagText = await evaluate(`document.getElementById('buildTag') && document.getElementById('buildTag').textContent`).catch((e) => String(e.message));
  report.buildMatch = report.serverBuild && report.buildTagText && report.buildTagText.includes(report.serverBuild);

  report.copyBtn = await evaluate(`(() => {
    const b = document.getElementById('btnCopyDiag');
    return b ? { text: b.textContent.trim(), title: b.title.slice(0, 30) } : null;
  })()`).catch((e) => String(e.message));

  // __sphereBuild() 诊断对象
  report.diag = await evaluate(`(() => {
    const d = window.__sphereBuild && window.__sphereBuild();
    if (!d) return null;
    return { build: d.build, hasPolar: !!d.polar, hasImagery: !!d.imagery, globeScheme: d.polar ? d.polar.globeScheme : null, keys: Object.keys(d) };
  })()`).catch((e) => String(e.message));

  // 点一下复制按钮：先 stub 掉 clipboard/prompt（headless 无剪贴板权限会弹 prompt 卡死渲染进程）
  await evaluate(`window.prompt = () => null; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { window.__copied = t; } }, configurable: true });`);
  await evaluate(`document.getElementById('btnCopyDiag').click()`).catch(() => {});
  await sleep(500);
  report.afterClickStatus = await evaluate(`document.getElementById('status').textContent`).catch(() => '');
  report.copiedPayloadOk = await evaluate(`(() => {
    try { const d = JSON.parse(window.__copied || ''); return d && d.build === ${JSON.stringify(report.serverBuild)} && !!d.polar; }
    catch { return false; }
  })()`).catch(() => false);
} finally {
  report.jsErrors = errors;
  edge.kill();
}

console.log(JSON.stringify(report, null, 2));
const pass = report.buildMatch === true
  && report.copyBtn && report.diag && report.diag.hasPolar === true
  && report.copiedPayloadOk === true
  && (errors || []).length === 0;
console.log(pass ? 'BUILD-TAG-SMOKE: PASS' : 'BUILD-TAG-SMOKE: FAIL');
process.exit(pass ? 0 : 1);
