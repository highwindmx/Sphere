/**
 * 一次性探针：捕获段 Cesium「RangeError: Invalid array length」根因扫描。
 * 原理：该错误来自 createPotentiallyVisibleSet 的 frustum 分割 d.length=f，
 *   f=Math.ceil(Math.log(i/n)/Math.log(s)) → i(near)/n(far) 为负或 0 才 NaN
 *   ⇒ 场景包围盒含 NaN ⇒ 必有某个 primitive/实体坐标是 NaN。
 * 本探针逐段 seek，**遍历所有实体**检查 position / polyline.positions / 相机 near-far 的 NaN。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
const WS_PATH = 'C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js';
const { default: WebSocket } = await import(`file:///${WS_PATH}`);

const EDGE_BIN = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9396;
const URL = 'http://127.0.0.1:5008/';

const edge = spawn(EDGE_BIN, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  '--no-default-browser-check', '--disable-extensions', '--use-gl=angle',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage',
  '--window-size=1280,800', 'about:blank',
], { stdio: 'ignore' });
try {
  let wsUrl = null;
  for (let i = 0; i < 40 && !wsUrl; i++) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) wsUrl = page.webSocketDebuggerUrl;
    } catch { /* wait */ }
  }
  if (!wsUrl) throw new Error('no CDP');
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  let id = 0; const pending = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    }
  });
  const send = (m, p = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise((res, rej) => pending.set(i, { res, rej })); };
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval error');
    return r.result.value ?? r.result;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: URL });
  const ready = await evaluate(`(async()=>{const s=(ms)=>new Promise(r=>setTimeout(r,ms));
    for(let i=0;i<160;i++){ if(window.Cesium&&window.viewer) return true; await s(250);} return false;})()`);
  if (!ready) throw new Error('viewer not ready');

  const started = await evaluate(`(async () => {
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    const btn=[...document.querySelectorAll('button,[role=button]')].find(b=>/探月/.test(b.textContent||''));
    if(!btn) return {ok:false,why:'no button'};
    btn.click();
    for(let i=0;i<60;i++){ await sleep(500); if(window.__moonMission) break; }
    if(!window.__moonMission) return {ok:false,why:'no mission'};
    window.__moonMission.start();
    for(let i=0;i<40;i++){ await sleep(500); try{ if(window.__moonMission.debugState().running) break; }catch{} }
    try{ const ps=[...document.querySelectorAll('button')].find(b=>/^暂停$/.test(b.textContent||'')); if(ps) ps.click(); }catch{}
    return {ok:true};
  })()`);
  if (!started.ok) throw new Error('start fail ' + JSON.stringify(started));

  const T = await evaluate(`window.__moonMission.timeline()`);
  const SEGS = [
    ['transfer', [0.30, 0.45, 0.50]],
    ['card2', [0.51]],
    ['capture', [0.535, 0.56, 0.60, 0.63]],
    ['card3', [0.65]],
  ];
  for (const [tag, ps] of SEGS) {
    for (const pv of ps) {
      const r = await evaluate(`(async () => {
        const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
        window.__moonMission.seek(${pv});
        await sleep(260);
        const v = window.viewer, now = Cesium.JulianDate.now();
        const bad = [];
        const chk = (c, where, id) => {
          if (!c) { bad.push({ id, where, kind: 'null' }); return; }
          const vals = [c.x, c.y, c.z].filter((q) => q !== undefined);
          if (vals.length !== 3) { bad.push({ id, where, kind: 'notCartesian' }); return; }
          if (vals.some((q) => !Number.isFinite(q))) bad.push({ id, where, kind: 'NaN' });
        };
        for (const e of v.entities.values) {
          const id = e.id || '(anon)';
          if (e.show === false) continue;
          try {
            if (e.position) chk(e.position.getValue(now), 'position', id);
            if (e.polyline && e.polyline.positions) {
              const a = e.polyline.positions.getValue(now);
              if (!a) bad.push({ id, where: 'poly.positions', kind: 'null' });
              else {
                if (!Number.isFinite(a.length)) bad.push({ id, where: 'poly.length', kind: 'NaN' });
                let nb = 0, undef = 0;
                for (const q of a) { if (!q) { undef++; continue; } if (!Number.isFinite(q.x) || !Number.isFinite(q.y) || !Number.isFinite(q.z)) nb++; }
                if (nb || undef) bad.push({ id, where: 'poly.positions', kind: 'badPts', n: a.length, nan: nb, undef });
              }
            }
          } catch (err) { bad.push({ id, where: 'eval', kind: String(err && err.message || err) }); }
        }
        const moonE = v.entities.getById('moonTransferTarget');
        const emE = v.entities.getById('moonEmLine');
        const mp = moonE ? moonE.position.getValue(now) : null;
        const ep = emE ? (emE.position ? emE.position.getValue(now) : null) : null;
        const pp = emE && emE.polyline ? emE.polyline.positions.getValue(now) : null;
        const detail = {
          moonPos: mp ? [mp.x, mp.y, mp.z].map((q) => Math.round(q)) : null,
          emLinePos: ep ? [ep.x, ep.y, ep.z].map((q) => Math.round(q)) : null,
          emLinePoly: pp ? pp.map((q) => (q ? [q.x, q.y, q.z].map((w) => Math.round(w)) : null)) : null,
          emShow: emE ? !!emE.show : null,
        };
        return { p: +${pv}.toFixed(4), nEnt: v.entities.values.length, bad, detail,
          camNear: v.camera.frustum.near, camFar: v.camera.frustum.far,
          mode: v.scene.mode, mv: v.scene.mode === Cesium.SceneMode.MORPHING };
      })()`);
      const flag = r.bad.length ? '<<< BAD' : 'ok';
      console.log(`[${tag}] p=${r.p} ents=${r.nEnt} near=${r.camNear} far=${r.camFar} ${flag}`);
      for (const b of r.bad) console.log('     ', JSON.stringify(b));
      if (r.detail) console.log('      detail:', JSON.stringify(r.detail));
    }
  }
} finally {
  try { edge.kill(); } catch {}
}
