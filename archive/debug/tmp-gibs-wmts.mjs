import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
const { default: WebSocket } = await import(`file:///C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js`);
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9236', '--disable-gpu', '--no-first-run', '--user-data-dir=C:/Users/KaishengMao/AppData/Local/Temp/sphere-gibswmts', 'about:blank'], { stdio: 'ignore', detached: false });
process.on('exit', () => { try { edge.kill(); } catch {} });
try {
  await sleep(2500);
  const list = await (await fetch('http://127.0.0.1:9236/json/list')).json();
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
    const errs = [];
    const p = new Cesium.WebMapTileServiceImageryProvider({
      url: 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/1.0.0/WMTSCapabilities.xml',
      layer: 'BlueMarble_NextGeneration', style: 'default', tileMatrixSetID: '500m',
      format: 'image/jpeg', maximumLevel: 7,
    });
    p.errorEvent.addEventListener((e) => errs.push(String(e && e.message || e).slice(0, 60)));
    let ready = false;
    try { await Promise.race([p.readyPromise, new Promise((_, rej) => setTimeout(() => rej(new Error('ready timeout 25s')), 25000))]); ready = true; } catch (e) { return { ready: false, err: String(e.message) }; }
    const scheme = p.tilingScheme;
    const info = {
      ready,
      schemeCtor: scheme && scheme.constructor.name,
      rect: scheme && scheme.rectangle ? [+scheme.rectangle.west.toFixed(3), +scheme.rectangle.south.toFixed(3), +scheme.rectangle.east.toFixed(3), +scheme.rectangle.north.toFixed(3)] : null,
      maxLevel: p.maximumLevel,
      tileWidth: p.tileWidth,
    };
    // 批量请求：北极/南极/赤道/中国/日期线附近
    const cases = [
      [0, 0, 0], [1, 0, 0], [2, 4, 2], [3, 8, 4], [4, 16, 8], [5, 32, 16], [6, 64, 32], [7, 100, 50], [7, 128, 64], [7, 0, 0], [7, 255, 127],
    ];
    const results = [];
    for (const [z, x, y] of cases) {
      try { const im = await p.requestImage(x, y, z); results.push({ z, x, y, ok: !!(im && im.width) }); }
      catch (e) { results.push({ z, x, y, err: String(e && e.message || e).slice(0, 60) }); }
    }
    return { ...info, total: results.length, fails: results.filter(r => !r.ok), errs: errs.slice(0, 3) };
  })()`);
  console.log(JSON.stringify(out, null, 2));
} finally { try { edge.kill(); } catch {} }
