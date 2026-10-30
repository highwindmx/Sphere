/**
 * 极冠纯红 debug 冒烟（headless Edge + CDP）
 * 验证：?polar-debug=red → 合成画布极带 [255,0,0,255]、中带透明、层 READY；
 *       __setPolarDebug('') 恢复正常；'fullred' → 中带也全红。
 * 用法：先起 app.py，再 node tools/polar-debug-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const WS_PATH = 'C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js';
const { default: WebSocket } = await import(`file:///${WS_PATH}`);

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9341;
const URL = 'http://127.0.0.1:5008/?polar-debug=red';

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
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval error');
  return r.result.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: URL });
await sleep(12000); // 等极冠合成层就绪

const report = {};

// 合成画布三点采样（red 模式期望：上下极带全红不透明、中带全透明）
const sampleCanvas = `(() => {
  const c = window.__polarComposite;
  if (!c) return null;
  const ctx = c.getContext('2d');
  const px = (x, y) => [...ctx.getImageData(x, y, 1, 1).data];
  return {
    size: [c.width, c.height],
    topBand: px(c.width >> 1, 50),
    equator: px(c.width >> 1, c.height >> 1),
    bottomBand: px(c.width >> 1, c.height - 50),
  };
})()`;

// 合成层探针（READY=4 + texture 尺寸）
const probeLayer = `(() => {
  const L = window.__polarCompositeLayer;
  if (!L) return null;
  return { index: viewer.imageryLayers.indexOf(L), isBase: L.isBaseLayer(), providerUrl: String(L.imageryProvider.url || '').slice(0, 30) };
})()`;

try { report.redMode = await evaluate(`({ debug: __polarDebug().polarDebug, canvas: ${sampleCanvas}, layer: ${probeLayer} })`); }
catch (e) { report.redModeErr = String(e.message); }

// 关闭 → 恢复（极带应恢复为实景色即非纯红、中带仍透明）
try {
  report.off = await evaluate(`(() => { __setPolarDebug(''); return { debug: __polarDebug().polarDebug }; })()`);
  await sleep(4000);
  report.offCanvas = await evaluate(sampleCanvas);
} catch (e) { report.offErr = String(e.message); }

// fullred → 中带也应全红
try {
  report.full = await evaluate(`(() => { __setPolarDebug('fullred'); return { debug: __polarDebug().polarDebug }; })()`);
  await sleep(4000);
  report.fullCanvas = await evaluate(sampleCanvas);
} catch (e) { report.fullErr = String(e.message); }

report.jsErrors = errors;
console.log(JSON.stringify(report, null, 1));
ws.close();
edge.kill();
process.exit(0);
