/**
 * GIBS 专用 provider 冒烟（headless Edge + CDP）
 *
 * 验证 gibs-provider.js 的「非二分网格 → 地理瓦片重采样」闭合性：
 *   ① 切源到 gibs 成功（不再被故障计数弹回 aws-s2）
 *   ② provider 对外 GeographicTilingScheme / maximumLevel 7
 *   ③ requestImage 输出画布 alpha 覆盖率 = 1.0（经纬映射闭合，无楔形缺块）
 *      ——这正是用户截图「角坐标不闭合」的量化判据
 *   ④ 画布非空内容（mean > 5，GIBS 不返回全黑）
 *   ⑤ 零 JS 错误
 *
 * 运行：node tools/gibs-provider-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const { default: WebSocket } = await import(`file:///C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js`);

const URL = 'http://127.0.0.1:5008/';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9230', '--disable-gpu', '--no-first-run', '--user-data-dir=C:/Users/KaishengMao/AppData/Local/Temp/sphere-gibs-profile', 'about:blank'], { stdio: 'ignore', detached: false });
const cleanup = () => { try { edge.kill(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

/** 页面内：切 gibs → 等生效 → 逐瓦片 requestImage 统计 alpha 覆盖率与亮度 */
const evalProbe = `(async () => {
  // 1. 切源到 gibs（UI change 事件，等价手动下拉）
  const el = document.getElementById('onlineSource');
  el.value = 'gibs';
  el.dispatchEvent(new Event('change'));
  // 等 mgr 生效（防抖/重建，最多 10s）
  let mgr = null;
  for (let i = 0; i < 20; i++) {
    mgr = window.__imagerySourceMgr;
    if (mgr && mgr.currentId === 'gibs' && mgr.onlineLayer) break;
    await new Promise(r => setTimeout(r, 500));
  }
  if (!mgr || mgr.currentId !== 'gibs' || !mgr.onlineLayer) {
    return { err: 'switch failed', currentId: mgr && mgr.currentId, debug: window.__imagerySourceMgr && window.__imagerySourceMgr.debug() };
  }
  const p = mgr.onlineLayer.imageryProvider;
  // 2. 逐瓦片 requestImage 检查闭合性
  const tiles = [
    [0, 0, 0], [1, 0, 0],      // z0 两列
    [3, 1, 2], [6, 3, 2],      // z2（GIBS L2=5×3，Cesium 8×4 → 映射错会露馅）
    [30, 15, 5],               // z5
    [100, 50, 7], [10, 20, 7], // z7
  ];
  const out = [];
  for (const [x, y, z] of tiles) {
    try {
      const cv = await p.requestImage(x, y, z);
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      const n = cv.width * cv.height;
      let opaque = 0, sum = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] === 255) opaque++;
      for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
      out.push({ t: [x, y, z], coverage: +(opaque / n).toFixed(4), mean: +(sum / n).toFixed(1) });
    } catch (e) {
      out.push({ t: [x, y, z], error: String((e && e.message) || e) });
    }
  }
  return {
    // minified build 类名是 jK 之类，不能比名字；用「北界=π/2」验证 ±90° 全极区覆盖
    rectNorth: p.tilingScheme.rectangle.north,
    maxLevel: p.maximumLevel,
    tileSize: [p.tileWidth, p.tileHeight],
    tiles: out,
  };
})()`;

try {
  await sleep(2500);
  const list = await (await fetch('http://127.0.0.1:9230/json/list')).json();
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
  const allClosed = tiles.length > 0 && tiles.every((t) => !t.error && t.coverage >= 0.999);
  const allMeaningful = tiles.every((t) => !t.error && t.mean > 5);
  const pass = !!report && !report.err
    && Math.abs((report.rectNorth ?? 0) - Math.PI / 2) < 1e-6  // 地理方案 ±90° 全极区
    && report.maxLevel === 7
    && allClosed && allMeaningful
    && errors.length === 0;
  console.log(JSON.stringify({ pass, report, errors }, null, 2));
  process.exit(pass ? 0 : 1);
} finally {
  cleanup();
}
