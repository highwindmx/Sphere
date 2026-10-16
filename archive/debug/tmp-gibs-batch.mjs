import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
const { default: WebSocket } = await import(`file:///C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js`);
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9235', '--disable-gpu', '--no-first-run', '--user-data-dir=C:/Users/KaishengMao/AppData/Local/Temp/sphere-gibsbatch', 'about:blank'], { stdio: 'ignore', detached: false });
process.on('exit', () => { try { edge.kill(); } catch {} });
try {
  await sleep(2500);
  const list = await (await fetch('http://127.0.0.1:9235/json/list')).json();
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
  await send('Page.navigate', { url: 'http://127.0.0.1:5008/' });
  await sleep(5000);
  const out = await evaluate(`(async () => {
    const p = new Cesium.UrlTemplateImageryProvider({
      url: 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/BlueMarble_NextGeneration/default/500m/{z}/{y}/{x}.jpeg',
      tilingScheme: new Cesium.GeographicTilingScheme(),
      maximumLevel: 7,
    });
    const cases = [];
    for (let z = 0; z <= 7; z++) {
      const nx = Math.pow(2, z + 1), ny = Math.pow(2, z);
      cases.push([z, 0, 0], [z, nx - 1, 0], [z, 0, ny - 1], [z, nx - 1, ny - 1], [z, nx >> 1, ny >> 1]);
    }
    const results = [];
    for (const [z, x, y] of cases) {
      try {
        const im = await p.requestImage(x, y, z);
        results.push({ z, x, y, ok: !!(im && im.width) });
      } catch (e) { results.push({ z, x, y, err: String(e && e.message || e).slice(0, 80) }); }
    }
    const fails = results.filter(r => !r.ok);
    return { total: results.length, failCount: fails.length, fails: fails.slice(0, 10) };
  })()`);
  console.log(JSON.stringify(out, null, 2));
} finally { try { edge.kill(); } catch {} }
