/**
 * 偏移旋钮扫参实验 —— 人为滑动 GIBS 影像的纬度（/经度）对应关系，肉眼看效果。
 *
 * 每个 LAT_OFF / LON_OFF 值整页重新加载（URL 带 ?gibs-debug=1&gibs-latoff=），
 * 切到 gibs 源、相机压在赤道（lat0,lon0, 2.5e6m）使真·赤道参考线横穿画面中心，
 * 等瓦片后截图。画布上还画了固定「EQ lat0 / lon0」参考线（不随偏移滑动），
 * 内容（蓝=北→红=南 渐变）相对参考线滑多少 = 偏移量。
 *
 * 判定：off=0 时赤道参考线应落在绿色中段（=映射正确，无北移）；
 *       若 off=0 已对齐而真实影像仍北移 → 根因不在本 provider 映射，在别处。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';

const { default: WebSocket } = await import(`file:///C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js`);

const PORT = 5008;
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const UD = 'C:/Users/KaishengMao/AppData/Local/Temp/sphere-gibs-sweep';
const OUTDIR = 'D:/Share/Scripts/Explore/sphere/tools';

const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9235', '--disable-gpu', '--no-first-run', `--user-data-dir=${UD}`, 'about:blank'], { stdio: 'ignore', detached: false });
const cleanup = () => { try { edge.kill(); } catch { /* ignore */ } };
process.on('exit', cleanup);

// 切源 + 设赤道相机 + 等待瓦片。offset 已通过 URL 注入。
const evalProbe = `(async () => {
  try {
    const el = document.getElementById('onlineSource');
    el.value = 'gibs';
    el.dispatchEvent(new Event('change'));
    let mgr = null;
    for (let i = 0; i < 24; i++) { mgr = window.__imagerySourceMgr; if (mgr && mgr.currentId === 'gibs' && mgr.onlineLayer) break; await new Promise(r => setTimeout(r, 500)); }
    if (!mgr || mgr.currentId !== 'gibs' || !mgr.onlineLayer) return { err: 'switch failed' };
    const Cesium = window.Cesium, viewer = window.viewer;
    viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(0, 0, 2.5e6) });
    await new Promise(r => setTimeout(r, 7000));
    return { ok: true };
  } catch(e){ return { fatal: String((e&&e.stack)||e) }; }
})`;

const cases = [
  { kind: 'lat', v: 0, tag: 'lo0' },
  { kind: 'lat', v: 10, tag: 'lo+10' },
  { kind: 'lat', v: -10, tag: 'lo-10' },
  { kind: 'lat', v: 20, tag: 'lo+20' },
  { kind: 'lat', v: -20, tag: 'lo-20' },
  { kind: 'lon', v: 20, tag: 'lon+20' },
];

try {
  await sleep(2500);
  const list = await (await fetch('http://127.0.0.1:9235/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const send = (method, params = {}) => new Promise((res, rej) => { const id = Math.floor(Math.random() * 1e9); pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id, method, params })); });
  await send('Runtime.enable'); await send('Page.enable');

  const summary = [];
  for (const c of cases) {
    const param = c.kind === 'lat' ? `gibs-latoff=${c.v}` : `gibs-lonoff=${c.v}`;
    const url = `http://127.0.0.1:${PORT}/?gibs-debug=1&${param}`;
    await send('Page.navigate', { url });
    await sleep(9000); // 等页面+应用起来
    const st = await (await send('Runtime.evaluate', { expression: `(${evalProbe})()`, returnByValue: true, awaitPromise: true })).result.value;
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const fname = `gibs-sweep-${c.tag}.png`;
    writeFileSync(`${OUTDIR}/${fname}`, Buffer.from(shot.data, 'base64'));
    summary.push({ tag: c.tag, param, probe: st, file: fname });
    console.log(`done ${c.tag}: ${JSON.stringify(st)}`);
  }
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
} finally { cleanup(); }
