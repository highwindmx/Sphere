/**
 * 阶段 A — provider「提供端」确定性实测（盯靶瓦片 L3,x=4,y=4 及一组低/中/高 level 对照）
 *
 * 目标：把「我们的函数喂给 Cesium 的画布」先钉死，回答用户元问题第一环：
 *   A1 画布是否 256×256 且铺满（无透明洞）？
 *   A2 函数实际请求了哪些 GIBS 瓦片（g,c,r）+ URL（真实模式抓）？
 *   A3 每块源瓦片 sx/sy/sw/sh 与 dx/dy/dw/dh 是否严丝合缝拼满（无重叠/留白）？
 *   A4 纬度朝向：北半球靶瓦片应是蓝(北)、南半球应是红(南) —— 直接验证「赤道北移」假说在 provider 层是否成立。
 *
 * 设计：
 *   相位1 = DEBUG 瓦片（确定性、零网络）：纬度色块（北蓝→南红），测朝向 + 覆盖 + live drawImage。
 *   相位2 = 真实模式：覆盖 window.Image 抓实际请求的 GIBS URL（答 A2），并量真实画布透明率。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const { default: WebSocket } = await import(`file:///C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js`);

const URL = 'http://127.0.0.1:5008/';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const UD = 'C:/Users/KaishengMao/AppData/Local/Temp/sphere-gibs-a';
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9234', '--disable-gpu', '--no-first-run', `--user-data-dir=${UD}`, 'about:blank'], { stdio: 'ignore', detached: false });
const cleanup = () => { try { edge.kill(); } catch { /* ignore */ } };
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
  await new Promise(r => setTimeout(r, 2500));

  // ── 相位1：DEBUG 瓦片（确定性）──
  if (window.__setGibsDebug) window.__setGibsDebug(true);

  const origDraw = CanvasRenderingContext2D.prototype.drawImage;
  const draws = [];
  CanvasRenderingContext2D.prototype.drawImage = function (img, ...a) {
    if (a.length === 8) draws.push({ sx:+a[0].toFixed(1), sy:+a[1].toFixed(1), sw:+a[2].toFixed(1), sh:+a[3].toFixed(1), dx:+a[4].toFixed(1), dy:+a[5].toFixed(1), dw:+a[6].toFixed(1), dh:+a[7].toFixed(1), srcW: img && img.width, srcH: img && img.height });
    return origDraw.apply(this, arguments);
  };

  // 靶瓦片 + 对照：低/中/高 level，覆盖赤道带南北两侧
  const targets = [
    { L:0, x:0, y:0, note:'整球 lat[-90,90] 单 GIBS 行（DEBUG 全蓝，验铺满/不翻）' },
    { L:1, x:0, y:0, note:'北半球 lat[0,90] 应蓝' },
    { L:1, x:0, y:1, note:'南半球 lat[-90,0] 应红' },
    { L:2, x:0, y:0, note:'北 lat[45,90] 深蓝' },
    { L:2, x:0, y:3, note:'南 lat[-90,-45] 深红' },
    { L:3, x:4, y:4, note:'用户原靶：lon[-90,-67.5] lat[-22.5,0] 南侧赤道带 应橙红' },
    { L:3, x:4, y:3, note:'北 lat[0,22.5] 应绿蓝（赤道带北侧）' },
    { L:5, x:16, y:8, note:'高 level 跨赤道带对照（赤道在 y=8 上沿）' },
  ];

  const phase1 = [];
  for (const t of targets) {
    draws.length = 0;
    const cv = await provider.requestImage(t.x, t.y, t.L);
    const W = cv.width, H = cv.height;
    const d = cv.getContext('2d').getImageData(0, 0, W, H).data;
    let transp = 0;
    for (let p = 0; p < W * H; p++) if (d[p * 4 + 3] < 128) transp++;
    // 垂直扫描中列：north 应蓝(B高R低)、south 应红(R高B低)
    const cx = (W / 2) | 0;
    const scan = [0, 0.25, 0.5, 0.75, 1].map(f => {
      const y = Math.min(H - 1, (f * H) | 0);
      const p = (y * W + cx) * 4;
      return { f, y, r: d[p], g: d[p + 1], b: d[p + 2], a: d[p + 3], blueMinusRed: d[p + 2] - d[p] };
    });
    phase1.push({ ...t, W, H, transparentPct: +(100 * transp / (W * H)).toFixed(2), drawCount: draws.length, draws: draws.slice(), scan });
  }

  // ── 相位2：真实模式，抓实际请求的 GIBS URL（答 A2）+ 真实透明率 ──
  if (window.__setGibsDebug) window.__setGibsDebug(false);
  const reqUrls = [];
  const OrigImage = window.Image;
  window.Image = class extends OrigImage {
    set src(v) { reqUrls.push(v); super.src = v; }
  };
  const realTargets = [
    { L:2, x:0, y:3, note:'南半球真实请求' },
    { L:3, x:4, y:4, note:'用户原靶真实请求' },
  ];
  const phase2 = [];
  for (const t of realTargets) {
    reqUrls.length = 0;
    let cv, err = null;
    try { cv = await provider.requestImage(t.x, t.y, t.L); } catch (e) { err = String(e && e.message || e); }
    let transp = null;
    if (cv) {
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let tr = 0; for (let p = 0; p < cv.width * cv.height; p++) if (d[p * 4 + 3] < 128) tr++;
      transp = +(100 * tr / (cv.width * cv.height)).toFixed(2);
    }
    phase2.push({ ...t, err, transparentPct: transp, requestedGibsUrls: reqUrls.slice() });
  }

  return { phase1, phase2, dbgNote: 'DEBUG 色块：north=蓝(210°HSL),south=红(0°HSL)，按 GIBS 行 t=r/(ROWS-1) 编码；scan.blueMinusRed 顶部应正(蓝)、底部应负(红)' };
})()`;

try {
  await sleep(2500);
  const list = await (await fetch('http://127.0.0.1:9234/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const send = (method, params = {}) => new Promise((res, rej) => { const id = Math.floor(Math.random() * 1e9); pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id, method, params })); });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: URL }); await sleep(9000);
  const report = await (await send('Runtime.evaluate', { expression: evalProbe, returnByValue: true, awaitPromise: true })).result.value;
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
} finally { cleanup(); }
