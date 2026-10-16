/**
 * GIBS debug 瓦片校验（headless Edge + CDP）
 *
 * 目的：验证「经线方向瓦片拼接是否从北极(蓝)连续覆盖到南极(红)且到 -90°」。
 *   - 导航到 ?gibs-debug=1 → gibs-provider 进入 debug 模式（生成带 L/r/c 标注 +
 *     纬度渐变底色 + 贯穿网格线的调试瓦片，复用同一套经纬度映射）。
 *   - 切源到 gibs，对南北极代表性瓦片 requestImage，统计：
 *       coverage（alpha 覆盖率，debug 全填充应 =1.0）
 *       mean 与 主导色相（north 应偏蓝、south 应偏红 —— 验证纬度编码到极区）
 *   - 这等价于用户提议的「球体经线长度 vs 瓦片拼起来经线长度是否匹配」的可视化量化：
 *     若 debug 瓦片沿经线无缝且南极其 coverage=1.0、色相=红，说明坐标映射正确，
 *     真实南极洞只能来自源加载/Cesium 渲染层；若 debug 南极其也 coverage<1，则映射本身有 bug。
 *
 * 运行：node tools/gibs-debug-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const { default: WebSocket } = await import(`file:///C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js`);

const URL = 'http://127.0.0.1:5008/?gibs-debug=1';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9231', '--disable-gpu', '--no-first-run', '--user-data-dir=C:/Users/KaishengMao/AppData/Local/Temp/sphere-gibs-debug-profile', 'about:blank'], { stdio: 'ignore', detached: false });
const cleanup = () => { try { edge.kill(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

const evalProbe = `(async () => {
  const el = document.getElementById('onlineSource');
  el.value = 'gibs';
  el.dispatchEvent(new Event('change'));
  let mgr = null;
  for (let i = 0; i < 20; i++) {
    mgr = window.__imagerySourceMgr;
    if (mgr && mgr.currentId === 'gibs' && mgr.onlineLayer) break;
    await new Promise(r => setTimeout(r, 500));
  }
  if (!mgr || mgr.currentId !== 'gibs' || !mgr.onlineLayer) {
    return { err: 'switch failed', currentId: mgr && mgr.currentId };
  }
  const p = mgr.onlineLayer.imageryProvider;
  // 代表性瓦片：北极附近 / 赤道 / 南极最南行（z7 y=79）
  const tiles = [
    [0, 0, 0],
    [100, 0, 7],                 // 北极附近（y=0）
    [100, 40, 7],                // 赤道附近（y=40）
    [0, 79, 7], [80, 79, 7], [159, 79, 7], // 南极最南行（y=79）三列
    [0, 19, 5],                  // z5 南极附近
    [6, 3, 2],                   // z2 最南
  ];
  const out = [];
  for (const [x, y, z] of tiles) {
    try {
      const cv = await p.requestImage(x, y, z);
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      const n = cv.width * cv.height;
      let opaque = 0, rs = 0, gs = 0, bs = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 255) {
          opaque++; rs += d[i]; gs += d[i + 1]; bs += d[i + 2];
        }
      }
      const mean = opaque ? (rs + gs + bs) / (3 * opaque) : 0;
      // 主导色相（粗略）：红多=南极，蓝多=北极
      const hue = opaque ? (bs > rs ? 'blue-ish' : (rs > bs ? 'red-ish' : 'green-ish')) : 'empty';
      out.push({ t: [x, y, z], coverage: +(opaque / n).toFixed(4), mean: +mean.toFixed(1), hue });
    } catch (e) {
      out.push({ t: [x, y, z], error: String((e && e.message) || e) });
    }
  }
  return { rectNorth: p.tilingScheme.rectangle.north, maxLevel: p.maximumLevel, tiles: out };
})()`;

try {
  await sleep(2500);
  const list = await (await fetch('http://127.0.0.1:9231/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  const errors = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description || ''));
    }
  });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = Math.floor(Math.random() * 1e9);
    pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: URL });
  await sleep(9000);

  const report = await (await send('Runtime.evaluate', {
    expression: evalProbe, returnByValue: true, awaitPromise: true,
  })).result.value;

  const tiles = (report && report.tiles) || [];
  const southTiles = tiles.filter((t) => Array.isArray(t.t) && t.t[1] >= 79);
  const northTiles = tiles.filter((t) => Array.isArray(t.t) && t.t[1] === 0);
  const southClosed = southTiles.length > 0 && southTiles.every((t) => !t.error && t.coverage >= 0.999 && t.hue === 'red-ish');
  const northOk = northTiles.length > 0 && northTiles.every((t) => !t.error && t.coverage >= 0.999 && t.hue === 'blue-ish');
  const pass = !!report && !report.err
    && Math.abs((report.rectNorth ?? 0) - Math.PI / 2) < 1e-6
    && southClosed && northOk && errors.length === 0;
  console.log(JSON.stringify({ pass, southClosed, northOk, report, errors }, null, 2));
  process.exit(pass ? 0 : 1);
} finally {
  cleanup();
}
