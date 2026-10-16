/**
 * 终极验证（headless Edge + CDP）：两次独立页面加载，极冠模式从首页就定好，
 * 排除「运行时切换 + 异步重建」的时序假象。
 *   Load A: ?polar-debug=red → 飞北极/南极 → 中心像素应为纯红 [255,0,0,255]
 *   Load B: 正常模式（先清 localStorage）→ 飞北极/南极 → 北极深蓝、南极白冰
 * 用法：node tools/polar-final-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const WS_PATH = 'C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js';
const { default: WebSocket } = await import(`file:///${WS_PATH}`);

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9350;

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

const report = {};

await send('Runtime.enable');
await send('Page.enable');

// 等合成层 READY 后截屏幕中心 16×16 像素
async function polePixel(isNorth) {
  await evaluate(`__flyToPole(${isNorth})`);
  for (let i = 0; i < 25; i++) {
    await sleep(1000);
    const ready = await evaluate(`(() => {
      const surf = window.viewer.scene.globe._surface;
      for (const t of (surf._tilesToRender || [])) {
        for (const ti of ((t.data && t.data.imagery) || [])) {
          const im = ti.readyImagery || ti.loadingImagery || ti.imagery;
          if (im && im.imageryLayer && im.imageryLayer.imageryProvider instanceof Cesium.SingleTileImageryProvider) {
            return im.state === 4 && !!im.texture;
          }
        }
      }
      return false;
    })()`).catch(() => false);
    if (!ready) continue;
    await sleep(1500); // 等一帧渲染
    const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 692, y: 492, width: 16, height: 16, scale: 1 } });
    return await evaluate(`(async () => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,${shot.data}'; });
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const cx = c.getContext('2d');
      cx.drawImage(img, 0, 0);
      const d = cx.getImageData(8, 8, 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    })()`);
  }
  return null;
}

// ===== Load A：red 模式（URL 参数，首页即红）=====
await send('Page.navigate', { url: 'http://127.0.0.1:5008/?polar-debug=red' });
await sleep(15000);
report.loadA = {
  mode: await evaluate(`__polarDebug().polarDebug`).catch(() => null),
  north: await polePixel(true),
  south: await polePixel(false),
};

// ===== Load B：正常模式（先清 localStorage 再重载）=====
await evaluate(`localStorage.removeItem('sphere-polar-debug')`);
await send('Page.navigate', { url: 'http://127.0.0.1:5008/' });
await sleep(15000);
report.loadB = {
  mode: await evaluate(`__polarDebug().polarDebug`).catch(() => null),
  canvas: await evaluate(`(() => {
    const c = window.__polarComposite;
    const px = (x, y) => { const d = c.getContext('2d').getImageData(x, y, 1, 1).data; return [d[0], d[1], d[2], d[3]]; };
    return c ? { topBand: px(c.width >> 1, 30), bottomBand: px(c.width >> 1, c.height - 30) } : null;
  })()`).catch(() => null),
  north: await polePixel(true),
  south: await polePixel(false),
};

report.jsErrors = errors;
console.log(JSON.stringify(report, null, 1));
ws.close();
edge.kill();
process.exit(0);
