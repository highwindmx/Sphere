/**
 * flyto-diag.mjs — 直接在页面上下文测试 flyToCoords 用的 HeadingPitchRange API，
 * 并把异常原样报回来，定位"点定位后相机不动"的根因。
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

// 直接测试 HeadingPitchRange + headingPitchRangeToCartesian 是否存在、能否调用
const api = await evaluate(`(async () => {
  const C = window.Cesium;
  const out = { hasHPR: typeof C.HeadingPitchRange, hasTransforms: typeof C.Transforms, hasFn: C.Transforms && typeof C.Transforms.headingPitchRangeToCartesian };
  try {
    const ellipsoid = C.Ellipsoid.WGS84;
    const H = 600000;
    const pitch = C.Math.toRadians(-40);
    const target = C.Cartesian3.fromDegrees(2.336, 48.861, 0, ellipsoid);
    const range = H / Math.sin(Math.abs(pitch));
    const hpr = new C.HeadingPitchRange(0, pitch, range);
    const dest = C.Transforms.headingPitchRangeToCartesian(target, hpr, ellipsoid);
    out.destOk = C.Cartesian3 && isFinite(dest.x) && isFinite(dest.y) && isFinite(dest.z);
    out.dest = { x: Math.round(dest.x), y: Math.round(dest.y), z: Math.round(dest.z) };
  } catch (e) { out.error = String(e) + '\\n' + (e && e.stack ? e.stack : ''); }
  return out;
})()`);
console.log(JSON.stringify({ api }, null, 2));

// 再测：用 camera.flyToBoundingSphere(sphere, { offset: HeadingPitchRange }) 这是 1.146 可用的官方路径
const fly = await evaluate(`(async () => {
  const C = window.Cesium; const v = window.viewer;
  try {
    const ellipsoid = C.Ellipsoid.WGS84;
    const H = 600000; const pitch = C.Math.toRadians(-40);
    const target = C.Cartesian3.fromDegrees(2.336, 48.861, 0, ellipsoid);
    const range = H / Math.sin(Math.abs(pitch));
    const hpr = new C.HeadingPitchRange(0, pitch, range);
    const sphere = new C.BoundingSphere(target, 0);
    v.camera.flyToBoundingSphere(sphere, { offset: hpr, duration: 0.5 });
    await new Promise(r => setTimeout(r, 1400));
    const c = v.camera.positionCartographic;
    const look = (() => {
      const ray = new C.Ray(v.camera.position.clone(), v.camera.direction.clone());
      const i = C.IntersectionTests.rayEllipsoid(ray, C.Ellipsoid.WGS84);
      if (!i) return null;
      const pt = C.Ray.getPoint(ray, i.start);
      const ct = C.Cartographic.fromCartesian(pt);
      return { lon:+(ct.longitude*180/Math.PI).toFixed(3), lat:+(ct.latitude*180/Math.PI).toFixed(3) };
    })();
    return { ok: true, cam: { lon:+(c.longitude*180/Math.PI).toFixed(3), lat:+(c.latitude*180/Math.PI).toFixed(3), h:Math.round(c.height), pitch:+(v.camera.pitch*180/Math.PI).toFixed(1) }, look };
  } catch (e) { return { ok: false, error: String(e) }; }
})()`);
console.log(JSON.stringify({ fly }, null, 2));

ws.close();
edge.kill();
