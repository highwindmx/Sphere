/**
 * 极冠合成层冒烟检查（headless Edge + CDP）
 * 用途：只验证「JS 无异常 + 图层顺序正确 + 合成画布像素正确」。
 * ⚠️ SwiftShader 下屏幕像素不可信（曾出现纯红 SingleTile 整盘不出图），
 *    视觉结果请以本机 GPU 实机为准。
 *
 * 用法：先启动 app.py（http://127.0.0.1:5008），再
 *   node tools/polar-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { setTimeout as sleep } from 'node:timers/promises';
// ws 装在托管 workspace（本仓库无 node_modules 依赖），用绝对路径 import
const WS_PATH = 'C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js';
const { default: WebSocket } = await import(`file:///${WS_PATH}`);

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9333;
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

// 注意：/json/version 给的是「浏览器级」target，不支持 Runtime 域，
// 必须取 type === 'page' 的 tab target，或用 /json/new 新建（PUT）。
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

/** 8bit PNG（colorType 2/6）解码，返回中心及偏移像素（r,g,b） */
function decodePngCenter(buf) {
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
  return { size: [w, h], center: at(cx, cy), up: at(cx, cy - 40), left: at(cx - 40, cy) };
}

await send('Runtime.enable');
await send('Page.enable');
await send('Log.enable').catch(() => {});
await send('Page.navigate', { url: URL });
await sleep(22000); // 等 Cesium 起来 + 底图 + 极冠合成 + 重校准

const report = {};
try { report.debug = await evaluate('__polarDebug()'); } catch (e) { report.debugErr = String(e.message); }
try { report.probeErr; } catch {}
// 深挖：极区渲染瓦片的 imagery 骨架（TileImagery）状态
try {
  report.tiles = await evaluate(`(() => {
    const prim = viewer.scene.globe._surface;
    // 直接看本帧实际渲染的瓦片（_tilesToRender）里纬度最高的几个
    const rendered = (prim._tilesToRender || [])
      .map((t) => ({
        level: t.level, x: t.x, y: t.y,
        rect: t.rectangle ? [+t.rectangle.south.toFixed(3), +t.rectangle.north.toFixed(3)] : null,
        tileState: t.state,
        imagery: ((t.data && t.data.imagery) || []).map((ti) => {
          const im = ti.readyImagery || ti.loadingImagery || ti.imagery;
          const pp = im && im.imageryLayer && im.imageryLayer.imageryProvider;
          return {
            provider: pp ? (String(pp.url || '').startsWith('data:') ? 'composite(dataURL)' : (pp.constructor && pp.constructor.name) || 'other') : null,
            state: im ? im.state : null,
            hasTexture: !!(im && im.texture),
            texSize: im && im.texture ? [im.texture.width, im.texture.height] : null,
          };
        }),
      }))
      .sort((a, b) => (b.rect ? b.rect[0] : -9) - (a.rect ? a.rect[0] : -9))
      .slice(0, 6);
    return { renderedCount: (prim._tilesToRender || []).length, rendered };
  })()`);
} catch (e) { report.tilesErr = String(e.message); }
try {
  report.probe = await evaluate(`(() => {
    const L = window.__polarCompositeLayer;
    if (!L) return null;
    const P = L.imageryProvider;
    return {
      layerReady: L.ready,
      imgLoaded: !!P._image,
      imgType: P._image ? (P._image.tagName || typeof P._image) : null,
      imgSize: P._image ? [P._image.width, P._image.height] : null,
      texCreated: !!P._texture,
      requestImageError: P._hasError || null,
      urlLen: (P._resource && P._resource.url || '').length,
    };
  })()`);
} catch (e) { report.probeErr = String(e.message); }
try {
  report.canvas = await evaluate(`(() => {
    const c = window.__polarComposite;
    if (!c) return null;
    const ctx = c.getContext('2d');
    const px = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
    return {
      size: [c.width, c.height],
      topBand: px(Math.round(c.width / 2), 8),
      equator: px(Math.round(c.width / 2), Math.round(c.height / 2)),
      bottomBand: px(Math.round(c.width / 2), c.height - 8),
    };
  })()`);
} catch (e) { report.canvasErr = String(e.message); }

// 飞到北极俯视并截图（CDP 合成器捕获，headless WebGL 也能抓到），
// 用像素判断极区到底有没有东西（黑洞 = 近纯黑且无纹理）。
try {
  await evaluate('__flyToPole(true, 2200000)');
  await sleep(6000);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(shot.data, 'base64');
  const { writeFileSync } = await import('node:fs');
  const out = 'tools/.polar-north.png';
  writeFileSync(out, buf);
  report.screenshot = out;
  report.shotBytes = buf.length;
  // 极简 PNG 解码（8bit RGB/RGBA）→ 取画面中心像素（俯视极点时极心就在中心）
  const px = decodePngCenter(buf);
  report.centerPixel = px;
} catch (e) { report.shotErr = String(e.message); }

report.polarLogs = logs.filter((l) => l.includes('[polar]'));
report.errors = errors.slice(0, 8);

console.log(JSON.stringify(report, null, 2));
ws.close();
edge.kill();
process.exit(0);
