/**
 * 天地图覆盖层 + 资产搬移端到端验证（headless Edge + CDP）
 * 验证点：
 *  ① 开「中国高清」覆盖层后，中国区出现天地图真影像（不再是 403→透明兜底形成的黑块）
 *  ② 覆盖层瓦片经本地代理缓存落盘（public/tiles/tianditu/）
 *  ③ patch/bluemarble.jpg、lunar/* 搬移后无 404 / 加载异常
 *
 * 用法：先启动 app.py（http://127.0.0.1:5008），再
 *   node tools/tianditu-cache-smoke.mjs
 * ⚠️ SwiftShader 屏幕像素仅作辅助证据（曾出现 GPU 专有问题复现不出），
 *    本机 GPU 实机效果以用户刷新后为准。
 */
import { spawn } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { setTimeout as sleep } from 'node:timers/promises';
// ws 装在托管 workspace（本仓库无 node_modules 依赖），用绝对路径 import
const WS_PATH = 'C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js';
const { default: WebSocket } = await import(`file:///${WS_PATH}`);

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9341;
const URL = 'http://127.0.0.1:5008/';

const edge = spawn(EDGE, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--disable-dev-shm-usage',
  '--window-size=1280,800',
  'about:blank',
], { stdio: 'ignore' });

let wsUrl = null;
for (let i = 0; i < 40 && !wsUrl; i++) {
  await sleep(500);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) { wsUrl = page.webSocketDebuggerUrl; break; }
    const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL)}`, { method: 'PUT' });
    if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; }
  } catch { /* 还没起来 */ }
}
if (!wsUrl) { edge.kill(); throw new Error('无法连接 Edge 调试端口'); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

let id = 0;
const pending = new Map();
const logs = [];
const errors = [];
const failedReqs = [];
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    logs.push(msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    errors.push(msg.params.exceptionDetails?.text + ' ' + (msg.params.exceptionDetails?.exception?.description ?? ''));
  }
  // 网络层 404/失败（资产搬移是否漏改的最直接信号）
  if (msg.method === 'Network.loadingFailed') {
    failedReqs.push({ type: msg.params.type, err: msg.params.errorText, blocked: msg.params.blocked });
  }
});
function send(method, params = {}) {
  const i = ++id;
  ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise((res, rej) => pending.set(i, { res, rej }));
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval error');
  return r.result.value;
}

/** 8bit PNG 解码，返回中心 200×200 区域的亮度均值/方差（判断黑块 vs 真影像） */
function decodePngRegionStats(buf, half = 100) {
  let p = 8, w = 0, h = 0, ct = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = ct === 6 ? 4 : 3;
  const stride = w * bpp;
  const out = Buffer.alloc(stride * h);
  let q = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[q++];
    const line = raw.subarray(q, q + stride); q += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      cur[x] = v & 0xFF;
    }
  }
  const at = (x, y) => {
    const o = (y * w + x) * bpp;
    return [out[o], out[o + 1], out[o + 2]];
  };
  const cx = Math.floor(w / 2), cy = Math.floor(h / 2);
  const lum = [];
  for (let dy = -half; dy <= half; dy += 4) {
    for (let dx = -half; dx <= half; dx += 4) {
      const [r, g, b] = at(cx + dx, cy + dy);
      lum.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
    }
  }
  const mean = lum.reduce((s, v) => s + v, 0) / lum.length;
  const std = Math.sqrt(lum.reduce((s, v) => s + (v - mean) * (v - mean), 0) / lum.length);
  return { size: [w, h], centerPixel: at(cx, cy), mean: +mean.toFixed(1), std: +std.toFixed(1), samples: lum.length };
}

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable').catch(() => {});
await send('Log.enable').catch(() => {});
await send('Page.navigate', { url: URL });
await sleep(20000); // 等 Cesium 起来 + 底图 + 极冠合成 + 重校准

const report = {};

// ③ 资产搬移后无 404（patch/bluemarble、lunar/*）
try {
  report.assets = await evaluate(`(async () => {
    const out = {};
    for (const [k, u] of Object.entries({
      bluemarble: 'patch/bluemarble.jpg',
      lunarWac: 'lunar/lunar_wac.jpg',
      lunarDem: 'lunar/lunar_dem.png',
    })) {
      const r = await fetch(u, { method: 'GET' });
      out[k] = { status: r.status, type: r.headers.get('content-type'), bytes: (await r.arrayBuffer()).byteLength };
    }
    return out;
  })()`);
} catch (e) { report.assetsErr = String(e.message); }

// ① 开启天地图覆盖层（localStorage 置位 → 勾选 checkbox → setOverlay(true)）
try {
  await evaluate(`localStorage.setItem('sphere-tianditu-overlay', '1')`);
  await send('Page.navigate', { url: URL });
  await sleep(16000);
  await evaluate(`(() => {
    const cb = document.getElementById('tiandituOverlay');
    if (!cb) throw new Error('tiandituOverlay checkbox not found');
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
  })()`);
  report.overlayEnabled = await evaluate(`(() => {
    const mgr = window.__imagerySourceMgr;
    return !!mgr && !!mgr.overlayLayer;
  })()`);
} catch (e) { report.overlayErr = String(e.message); }

// 飞到中国中心（104°E, 35°N），等覆盖层瓦片
try {
  await evaluate(`(() => {
    viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(104, 33, 6500000), duration: 0 });
  })()`);
  await sleep(9000);
} catch (e) { report.camErr = String(e.message); }

// 覆盖层 provider 瓦片状态（READY=4 / texture）
try {
  report.overlayTiles = await evaluate(`(() => {
    const mgr = window.__imagerySourceMgr;
    const layer = mgr && mgr.overlayLayer;
    if (!layer) return null;
    const p = layer.imageryProvider;
    const img = p._tileCache ? [...p._tileCache.values()] : [];
    return {
      urlTemplate: String(p.url || '').slice(0, 60),
      cached: img.length,
      states: img.slice(0, 8).map((t) => t && t.state),
      hasTexture: img.filter((t) => t && t.texture).length,
    };
  })()`);
} catch (e) { report.overlayTilesErr = String(e.message); }

// 截图 + 区域亮度统计（黑块=低亮度低方差；真影像=高亮度有方差）
try {
  await sleep(4000);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(shot.data, 'base64');
  const { writeFileSync } = await import('node:fs');
  writeFileSync('tools/.tianditu-china.png', buf);
  report.screenshot = 'tools/.tianditu-china.png';
  report.regionStats = decodePngRegionStats(buf);
} catch (e) { report.shotErr = String(e.message); }

report.failedReqs = failedReqs.slice(0, 10);
report.errors = errors.slice(0, 8);
report.logs404 = logs.filter((l) => /404|Failed to obtain|加载失败/i.test(l)).slice(0, 8);

console.log(JSON.stringify(report, null, 2));
ws.close();
edge.kill();
process.exit(0);
