// 冒烟：.env 注入的天地图 key 在页面侧可用 + 补丁图可达 + 无 JS 错误
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

// ESM 不认 NODE_PATH，ws 走绝对路径 file:/// import（与 polar-final-smoke.mjs 一致）
const { default: WebSocket } = await import(`file:///C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js`);

const URL = 'http://127.0.0.1:5008/';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';


const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9226', '--disable-gpu', '--no-first-run', '--user-data-dir=C:/Users/KaishengMao/AppData/Local/Temp/sphere-envtest', 'about:blank'], { stdio: 'ignore', detached: false });
const cleanup = () => { try { edge.kill(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

try {
  await sleep(2500);
  const list = await (await fetch('http://127.0.0.1:9226/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = Math.floor(Math.random() * 1e9);
    pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r.result.value;
  };

  const errors = [];
  await send('Runtime.enable');
  await send('Page.enable');
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description || ''));
  });
  await send('Page.navigate', { url: URL });
  await sleep(6000);

  const report = {
    windowKey: await evaluate(`(window.TIANDITU_KEY || '').slice(0, 6)`).catch((e) => `ERR ${e.message}`),
    windowKeyLen: await evaluate(`(window.TIANDITU_KEY || '').length`).catch(() => -1),
    // 动态 import 模块验证 getTiandituKey()（localStorage 无手动值时回落注入值）
    getKey: await evaluate(`import('/src/imagery-sources.js').then(m => { const k = m.getTiandituKey(); return k.slice(0,6) + '|len=' + k.length; })`).catch((e) => `ERR ${e.message}`),
    // 补丁图可达（Flask 静态路由）
    patchEsri: await evaluate(`fetch('patch/esri.jpg', { method: 'HEAD' }).then(r => r.status)`).catch((e) => `ERR ${e.message}`),
    patchEox: await evaluate(`fetch('patch/eox.jpg', { method: 'HEAD' }).then(r => r.status)`).catch((e) => `ERR ${e.message}`),
  };

  const pass = report.windowKey === '2a3f96' && report.windowKeyLen === 32
    && String(report.getKey).startsWith('2a3f96|len=32')
    && report.patchEsri === 200 && report.patchEox === 200
    && errors.length === 0;
  console.log(JSON.stringify({ pass, ...report, errors }, null, 2));
  process.exit(pass ? 0 : 1);
} finally {
  cleanup();
}
