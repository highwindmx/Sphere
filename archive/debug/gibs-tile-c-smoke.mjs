/**
 * 阶段 C — 上屏渲染实测（按用户三档高度 1000/500/300km 对准南极出图 + 赤道对照）
 *
 * 阶段 A/B 已证明：provider 内容满、影像请求铺到 -90、globe 几何铺到 -90。
 * 本阶段直接截图上屏像素，肉眼 + 量化确认「南极洞 / 赤道北移」是否在渲染结果里出现。
 * 同时保存 PNG 供人工核对。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';

const { default: WebSocket } = await import(`file:///C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js`);

const URL = 'http://127.0.0.1:5008/';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const UD = 'C:/Users/KaishengMao/AppData/Local/Temp/sphere-gibs-c';
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9234', '--disable-gpu', '--no-first-run', `--user-data-dir=${UD}`, 'about:blank'], { stdio: 'ignore', detached: false });
const cleanup = () => { try { edge.kill(); } catch { /* ignore */ } };
process.on('exit', cleanup);

const OUTDIR = 'D:/Share/Scripts/Explore/sphere/tools';

const evalProbe = `(async (cam) => {
  try {
    const el = document.getElementById('onlineSource');
    el.value = 'gibs';
    el.dispatchEvent(new Event('change'));
    let mgr = null;
    for (let i = 0; i < 24; i++) { mgr = window.__imagerySourceMgr; if (mgr && mgr.currentId === 'gibs' && mgr.onlineLayer) break; await new Promise(r => setTimeout(r, 500)); }
    if (!mgr || mgr.currentId !== 'gibs' || !mgr.onlineLayer) return { err: 'switch failed' };
    const Cesium = window.Cesium, viewer = window.viewer;
    viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(cam.lon, cam.lat, cam.h) });
    await new Promise(r => setTimeout(r, 6000));
    // 中央区域像素统计（极点应对准屏幕中心）
    const cv = viewer.scene.canvas;
    const gl = cv.getContext('webgl2') || cv.getContext('webgl');
    const W = cv.width, H = cv.height;
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const bx0 = (W/2 - W*0.12)|0, bx1 = (W/2 + W*0.12)|0, by0 = (H/2 - H*0.12)|0, by1 = (H/2 + H*0.12)|0;
    let n=0, rSum=0,gSum=0,bSum=0, nearBlack=0, nearWhite=0;
    for (let y=by0;y<by1;y++) for (let x=bx0;x<bx1;x++){ const p=(y*W+x)*4; const r=px[p],g=px[p+1],b=px[p+2]; rSum+=r;gSum+=g;bSum+=b;n++; if(r+g+b<40)nearBlack++; if(r>235&&g>235&&b>235)nearWhite++; }
    return { cam: cam.tag, W, H, centerMean: { r:(rSum/n)|0, g:(gSum/n)|0, b:(bSum/n)|0 }, nearBlackPct: +(100*nearBlack/n).toFixed(1), nearWhitePct: +(100*nearWhite/n).toFixed(1) };
  } catch(e){ return { fatal: String((e&&e.stack)||e) }; }
})`;

try {
  await sleep(2500);
  const list = await (await fetch('http://127.0.0.1:9234/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  const shots = [];
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const send = (method, params = {}) => new Promise((res, rej) => { const id = Math.floor(Math.random() * 1e9); pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id, method, params })); });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: URL }); await sleep(9000);

  const cams = [
    { lon: 0, lat: -88, h: 1e6, tag: 'south-1000km' },
    { lon: 0, lat: -88, h: 5e5, tag: 'south-500km' },
    { lon: 0, lat: -88, h: 3e5, tag: 'south-300km' },
    { lon: 0, lat: 0, h: 1e6, tag: 'equator-1000km' },
  ];
  const stats = [];
  for (const cam of cams) {
    const st = await (await send('Runtime.evaluate', { expression: `${evalProbe}(${JSON.stringify(cam)})`, returnByValue: true, awaitPromise: true })).result.value;
    stats.push(st);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(`${OUTDIR}/gibs-${cam.tag}.png`, Buffer.from(shot.data, 'base64'));
  }
  console.log(JSON.stringify(stats, null, 2));
  process.exit(0);
} finally { cleanup(); }
