/**
 * 延伸探针：LAT_OFF=0 下，扫描南极极点行(y=n-1)与其上一行(y=n-2)的所有 x，
 * 测 provider 输出透明率。目的：确认「南极楔形缺块」是否来自 provider 内容缺失
 *（某些 x 的瓦片透明），还是纯 Cesium 渲染层。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const { default: WebSocket } = await import(`file:///C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js`);

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const UD = 'C:/Users/KaishengMao/AppData/Local/Temp/sphere-gibs-sw';
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9237', '--disable-gpu', '--no-first-run', `--user-data-dir=${UD}`, 'about:blank'], { stdio: 'ignore', detached: false });
const cleanup = () => { try { edge.kill(); } catch { /* ignore */ } };
process.on('exit', cleanup);

const evalProbe = `(async (args) => {
  try {
    const el = document.getElementById('onlineSource');
    el.value = 'gibs'; el.dispatchEvent(new Event('change'));
    let mgr = null;
    for (let i = 0; i < 24; i++) { mgr = window.__imagerySourceMgr; if (mgr && mgr.currentId === 'gibs' && mgr.onlineLayer) break; await new Promise(r => setTimeout(r, 500)); }
    if (!mgr) return { err: 'no mgr' };
    let prov = mgr.onlineLayer && (mgr.onlineLayer._imageryProvider || mgr.onlineLayer.imageryProvider);
    if (!prov) return { err: 'no prov' };
    window.__setGibsLatOff(0);
    const out = [];
    for (const level of args.levels) {
      const n = 1 << level;
      for (const dy of [0, 1]) {            // 0=极点行, 1=上一行
        const y = n - 1 - dy;
        for (let x = 0; x < n; x++) {
          const canvas = await prov.requestImage(x, y, level);
          const ctx = canvas.getContext('2d');
          const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          let trans = 0, tot = 0;
          for (let i = 3; i < data.length; i += 4) { tot++; if (data[i] < 255) trans++; }
          const pct = +(100 * trans / tot).toFixed(1);
          if (pct > 0) out.push({ level, y, x, transparentPct: pct });
        }
      }
    }
    return { holes: out, scanned: 'south pole row + row above, all x' };
  } catch (e) { return { fatal: String((e && e.stack) || e) }; }
})`;

try {
  await sleep(2500);
  const list = await (await fetch('http://127.0.0.1:9237/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const send = (method, params = {}) => new Promise((res, rej) => { const id = Math.floor(Math.random() * 1e9); pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id, method, params })); });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:5008/' });
  await sleep(9000);
  const res = await (await send('Runtime.evaluate', { expression: `(${evalProbe})(${JSON.stringify({ levels: [2, 3, 4] })})`, returnByValue: true, awaitPromise: true })).result.value;
  console.log(JSON.stringify(res, null, 2));
  process.exit(0);
} finally { cleanup(); }
