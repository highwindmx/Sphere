import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
const { default: WebSocket } = await import(`file:///C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js`);
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9233', '--disable-gpu', '--no-first-run', '--user-data-dir=C:/Users/KaishengMao/AppData/Local/Temp/sphere-gibsfetch', 'about:blank'], { stdio: 'ignore', detached: false });
process.on('exit', () => { try { edge.kill(); } catch {} });
try {
  await sleep(2500);
  const list = await (await fetch('http://127.0.0.1:9233/json/list')).json();
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  const pending = new Map();
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = Math.floor(Math.random() * 1e9);
    pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
  await send('Runtime.enable');
  // 导航到站点（同源），再 fetch GIBS 瓦片
  await send('Page.navigate', { url: 'http://127.0.0.1:5008/' });
  await sleep(4000);
  const out = await evaluate(`(async () => {
    const urls = [
      'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/BlueMarble_NextGeneration/default/500m/7/79/80.jpeg',
      'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/BlueMarble_NextGeneration/default/500m/7/80/79.jpeg',
    ];
    const res = [];
    for (const u of urls) {
      try {
        const r = await fetch(u, { mode: 'cors' });
        const b = await r.blob();
        res.push({ u: u.slice(-18), status: r.status, type: r.type, size: b.size });
      } catch (e) { res.push({ u: u.slice(-18), err: String(e && e.message || e) }); }
    }
    return res;
  })()`);
  console.log(JSON.stringify(out, null, 2));
} finally { try { edge.kill(); } catch {} }
