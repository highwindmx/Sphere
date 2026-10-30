/**
 * 播放态连续采样（不暂停）：第三幕末段 3-6→4-1 边界细粒度取证。
 * 输出：p / blend / override / 相机到各焦点的距离与视线夹角 / 屏幕坐标 / 当前 key。
 * 用法：node tools/tmp-boundary.mjs（app.py 需已在 5008 运行）
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
const WS_PATH = 'C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js';
const { default: WebSocket } = await import(`file:///${WS_PATH}`);
const EDGE_BIN = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9394;
const URL = 'http://127.0.0.1:5008/';
const edge = spawn(EDGE_BIN, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--disable-dev-shm-usage', '--window-size=1280,800', URL,
], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 40 && !wsUrl; i++) {
  await sleep(500);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) { wsUrl = page.webSocketDebuggerUrl; break; }
  } catch { /* wait */ }
}
if (!wsUrl) { edge.kill(); throw new Error('Edge 未就绪'); }
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
let id = 0; const pending = new Map(); const errors = [];
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id); pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result); return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const t = msg.params.exceptionDetails?.text + ' ' + (msg.params.exceptionDetails?.exception?.description ?? '');
    if (!/setPointerCapture/.test(t)) errors.push(t.slice(0, 300));
  }
});
function send(method, params = {}) {
  const i = ++id; ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise((res, rej) => pending.set(i, { res, rej }));
}
async function ev(e) {
  const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval error');
  return r.result.value;
}
await send('Runtime.enable'); await send('Page.enable');
await sleep(3500);
await ev(`(async () => { const s=(ms)=>new Promise(r=>setTimeout(r,ms));
  for (let i=0;i<160;i++){ if (window.Cesium && window.viewer) return true; await s(250);} return false; })()`);
await ev(`(async () => { const s=(ms)=>new Promise(r=>setTimeout(r,ms));
  const b = Array.from(document.querySelectorAll('button')).find(x=>(x.textContent||'').includes('探月'));
  if (b) b.click();
  for (let i=0;i<80;i++){ if (window.__moonMission) return true; await s(250);} return false; })()`);
await sleep(1500);
await ev(`(function(){ if (window.__moonMission.start) window.__moonMission.start(); return 1; })()`);
await sleep(2500);

const trace = await ev(`(async function () {
  const s = (ms) => new Promise((r) => setTimeout(r, ms));
  const C = Cesium, M = window.__moonMission;
  M.seek(0.935);
  const pb = document.getElementById('tourPause');
  if (pb && pb.textContent !== '暂停') pb.click();
  const rows = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    await s(80);
    const d = M.debugState();
    const p = d.p;
    if (p > 0.972) break;
    if (p < 0.936) continue;
    const v = (d.views && d.views.moon);
    const fw = (d.views && d.views.focusW) || {};
    const fs = d.focusScreen || {};
    if (!v) { rows.push([p, 'no-cam']); continue; }
    const cp = new C.Cartesian3(v.pos[0], v.pos[1], v.pos[2]);
    const cd = new C.Cartesian3(v.dir[0], v.dir[1], v.dir[2]);
    const one = (k) => {
      const a = fw[k]; if (!a) return null;
      const sp = new C.Cartesian3(a[0], a[1], a[2]);
      const to = C.Cartesian3.subtract(sp, cp, new C.Cartesian3());
      const dist = C.Cartesian3.magnitude(to);
      C.Cartesian3.normalize(to, to);
      const ang = Math.acos(Math.max(-1, Math.min(1, C.Cartesian3.dot(cd, to)))) * 180 / Math.PI;
      const sc = (fs[k] && fs[k].scr) || null;
      return [+dist.toFixed(0), +ang.toFixed(1), sc ? sc[0] : null, sc ? sc[1] : null];
    };
    rows.push([p, d.cam.override ? 1 : 0, d.cam.blend, one('craft'), one('lander'), one('rover')]);
  }
  return rows;
})()`);
console.log('p, man, blend, craft[d,ang,x,y], lander[d,ang,x,y], rover[d,ang,x,y]');
for (const r of trace) console.log(JSON.stringify(r));
console.log('\nerrors=', errors.slice(0, 6));
edge.kill();
