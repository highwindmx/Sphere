/**
 * 确定性探针：直接调 provider.requestImage 拿南/北极瓦片画布，测 alpha 透明覆盖率。
 * 目的：判定「南极洞」到底是 provider 输出本身透明（映射/源瓦片问题），
 *       还是 Cesium 渲染层的事。扫 LAT_OFF ∈ {0,-15,-30} × level 1..4。
 * 不靠截图、不靠肉眼，纯画布像素测量。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const { default: WebSocket } = await import(`file:///C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js`);

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const UD = 'C:/Users/KaishengMao/AppData/Local/Temp/sphere-gibs-po';
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9236', '--disable-gpu', '--no-first-run', `--user-data-dir=${UD}`, 'about:blank'], { stdio: 'ignore', detached: false });
const cleanup = () => { try { edge.kill(); } catch { /* ignore */ } };
process.on('exit', cleanup);

const evalProbe = `(async (args) => {
  try {
    const el = document.getElementById('onlineSource');
    el.value = 'gibs'; el.dispatchEvent(new Event('change'));
    let mgr = null;
    for (let i = 0; i < 24; i++) { mgr = window.__imagerySourceMgr; if (mgr && mgr.currentId === 'gibs' && mgr.onlineLayer) break; await new Promise(r => setTimeout(r, 500)); }
    if (!mgr) return { err: 'no mgr' };
    let prov = mgr.onlineLayer && (mgr.onlineLayer._imageryProvider || mgr.onlineLayer.imeryProvider || mgr.onlineLayer.imageryProvider);
    if (!prov || !prov.requestImage) return { err: 'no prov', keys: mgr.onlineLayer ? Object.keys(mgr.onlineLayer).filter(k=>/prov/i.test(k)) : null };
    const results = [];
    for (const off of args.offsets) {
      window.__setGibsLatOff(off);
      for (const level of args.levels) {
        const n = 1 << level;
        for (const [name, y] of [['S', n - 1], ['N', 0]]) {
          const t0 = Date.now();
          const canvas = await prov.requestImage(0, y, level);
          const ctx = canvas.getContext('2d');
          const { width, height } = canvas;
          const data = ctx.getImageData(0, 0, width, height).data;
          let trans = 0, tot = 0;
          for (let i = 3; i < data.length; i += 4) { tot++; if (data[i] < 255) trans++; }
          results.push({ off, level, name, transparentPct: +(100 * trans / tot).toFixed(1), ms: Date.now() - t0 });
        }
      }
    }
    return results;
  } catch (e) { return { fatal: String((e && e.stack) || e) }; }
})`;

try {
  await sleep(2500);
  const list = await (await fetch('http://127.0.0.1:9236/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const send = (method, params = {}) => new Promise((res, rej) => { const id = Math.floor(Math.random() * 1e9); pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id, method, params })); });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:5008/' });
  await sleep(9000);
  const res = await (await send('Runtime.evaluate', { expression: `(${evalProbe})(${JSON.stringify({ offsets: [0, -15, -30], levels: [1, 2, 3, 4] })})`, returnByValue: true, awaitPromise: true })).result.value;
  console.log(JSON.stringify(res, null, 2));
  process.exit(0);
} finally { cleanup(); }
