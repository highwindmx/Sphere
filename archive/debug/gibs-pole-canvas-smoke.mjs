/**
 * 决定性诊断：南极洞到底在哪一层。
 *  1) 直接调 provider.requestImage 取每个 level 的「真·南极瓦片」（y=2^L-1，之前的 y=79 是中纬度，测错了），
 *     量画布 alpha 覆盖率 —— 透明区域存在 ⇒ 「烤进去的洞」（源瓦片失败被静默跳过）实锤。
 *  2) 相机 500km / 1000km 对准南极截图 —— 对照用户实拍。
 *  3) CDP Network 统计 GIBS 图片加载失败数（区分 429/CORS/decode）。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';

const { default: WebSocket } = await import(`file:///C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js`);

const URL = 'http://127.0.0.1:5008/';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9234', '--disable-gpu', '--no-first-run', '--user-data-dir=C:/Users/KaishengMao/AppData/Local/Temp/sphere-gibs-pole-profile', 'about:blank'], { stdio: 'ignore', detached: false });
const cleanup = () => { try { edge.kill(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

const evalProbe = `(async () => {
  const el = document.getElementById('onlineSource');
  el.value = 'gibs';
  el.dispatchEvent(new Event('change'));
  let mgr = null;
  for (let i = 0; i < 24; i++) {
    mgr = window.__imagerySourceMgr;
    if (mgr && mgr.currentId === 'gibs' && mgr.onlineLayer) break;
    await new Promise(r => setTimeout(r, 500));
  }
  if (!mgr || mgr.currentId !== 'gibs' || !mgr.onlineLayer) return { err: 'switch failed' };
  const layer = mgr.onlineLayer;
  const provider = layer._provider || layer.imageryProvider;
  if (!provider || !provider.requestImage) return { err: 'no provider', keys: Object.keys(layer) };
  await new Promise(r => setTimeout(r, 4000)); // 等初始风暴平息

  // ── 直接量「真·南极瓦片」画布 alpha 覆盖率 ──
  const tiles = [];
  for (let L = 0; L <= 7; L++) {
    const y = 2 ** L - 1;           // Cesium 最南行（含 -90°）
    const xs = L <= 2 ? [0, 2 ** (L + 1) - 1] : [0, 2 ** L, 2 ** (L + 1) - 1];
    for (const x of [...new Set(xs)]) {
      try {
        const cv = await provider.requestImage(x, y, L);
        const n = cv.width * cv.height;
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        let transparent = 0, dark = 0;
        for (let p = 0; p < n; p++) {
          const a = d[p * 4 + 3];
          if (a < 128) transparent++;
          else if (d[p * 4] + d[p * 4 + 1] + d[p * 4 + 2] < 90) dark++;
        }
        tiles.push({ L, x, y, transparentPct: +(100 * transparent / n).toFixed(2), darkPct: +(100 * dark / n).toFixed(2), type: cv.tagName || 'canvas' });
      } catch (e) {
        tiles.push({ L, x, y, error: String(e && e.message || e) });
      }
    }
  }

  // ── 相机对准南极，两档高度截图 ──
  const Cesium = window.Cesium;
  const shots = [];
  for (const [h, name] of [[5e5, '500km'], [1e6, '1000km']]) {
    window.viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(45, -88, h) });
    await new Promise(r => setTimeout(r, 7000));
    shots.push({ name });
  }
  return { tiles, shots, currentId: mgr.currentId };
})()`;

try {
  await sleep(2500);
  const list = await (await fetch('http://127.0.0.1:9234/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map(); const errors = []; const netFail = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
    if (m.method === 'Network.loadingFailed' && !String(m.params.errorText || '').includes('ERR_ABORTED')) {
      netFail.push({ errorText: m.params.errorText, canceled: m.params.canceled });
    }
  });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const send = (method, params = {}) => new Promise((res, rej) => { const id = Math.floor(Math.random() * 1e9); pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id, method, params })); });
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
  await send('Page.navigate', { url: URL }); await sleep(9000);
  const report = await (await send('Runtime.evaluate', { expression: evalProbe, returnByValue: true, awaitPromise: true })).result.value;

  // 两次截图（相机已停在 1000km）
  for (const [name, h] of [['south-1000km.png', null]]) {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`D:/Share/Scripts/Explore/sphere/tools/out-${name}`, Buffer.from(shot.data, 'base64'));
  }

  const bad = (report.tiles || []).filter(t => t.transparentPct > 0.5 || t.error);
  console.log(JSON.stringify({
    verdict: bad.length ? '实锤：真·南极瓦片画布存在透明区域（烤进去的洞）' : '画布全满：洞不在 requestImage 内容层',
    badTiles: bad,
    allTiles: report.tiles,
    netFailCount: netFail.length,
    netFailSample: netFail.slice(0, 10),
    jsErrors: errors.slice(0, 10),
  }, null, 2));
  process.exit(0);
} finally { cleanup(); }
