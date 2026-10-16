/**
 * 补丁图探针（headless Edge + CDP）：对候选极冠补丁图采样极带/赤道带均色，
 * 验证「月度图是否含海冰季节变化」「极带是否为实景内容」。
 * 自包含：直接注入当前应用页（同源，避免 file:// 污染画布），图片走 http URL。
 * 用法：node tools/patch-probe.mjs <图片URL或public相对路径...>
 *   例：node tools/patch-probe.mjs /patch/bluemarble.jpg /patch/bm-winter.jpg
 * 判定：RGB 均 >180 = 冰/雪(白)；B 明显高于 R 且整体偏暗 = 开放大洋(深)
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const WS_PATH = 'C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js';
const { default: WebSocket } = await import(`file:///${WS_PATH}`);

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9354;
const BASE = 'http://127.0.0.1:5008';
const INPUTS = process.argv.slice(2);
if (!INPUTS.length) { console.error('用法: node tools/patch-probe.mjs <图片URL或public相对路径...>'); process.exit(2); }
// Git Bash 会把 /xxx 参数改写成 /C:/... 绝对路径，这里还原
const norm = (p) => (/^\/[A-Za-z]:[\\/]/.test(p) ? p.slice(1) : p);
const IMGS = INPUTS.map((p) => {
  const v = norm(p);
  return v.startsWith('http') ? v : BASE + (v.startsWith('/') ? v : '/' + v);
});

const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  '--disable-extensions', '--use-gl=angle', '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader', '--window-size=1400,1000', 'about:blank',
], { stdio: 'ignore' });

let wsUrl = null;
for (let i = 0; i < 40 && !wsUrl; i++) {
  await sleep(500);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) wsUrl = page.webSocketDebuggerUrl;
  } catch { /* 还没起来 */ }
}
if (!wsUrl) { edge.kill(); throw new Error('无法连接 Edge 调试端口'); }

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

let id = 0;
const pending = new Map();
const errors = [];
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params.exceptionDetails?.text + ' ' + (m.params.exceptionDetails?.exception?.description ?? ''));
  }
});
const send = (method, params = {}) => {
  const i = ++id;
  ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise((res, rej) => pending.set(i, { res, rej }));
};
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''));
  return r.result.value;
};

// 探针函数：挂到当前页（同源 http，画布不被污染）
const PROBE_FN = `window.__probe = (src) => new Promise((res, rej) => {
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const band = (y0, y1) => {
      const d = ctx.getImageData(0, y0, c.width, Math.max(1, y1 - y0)).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i+1]; b += d[i+2]; n++; }
      return [Math.round(r/n), Math.round(g/n), Math.round(b/n)];
    };
    const bandPx = Math.round(5.04 * (img.naturalHeight / 180)); // 与项目 POLE_CAP_EDGE_DEG 一致
    const midY = Math.round(c.height / 2);
    const prof = [];
    const x0 = Math.round(c.width / 2);
    for (let y = c.height - bandPx * 2; y < c.height; y += 10) {
      const d = ctx.getImageData(x0, y, 1, 1).data;
      prof.push([y - c.height, d[0], d[1], d[2]]);
    }
    res({
      size: [img.naturalWidth, img.naturalHeight],
      northBand: band(0, bandPx), midBand: band(midY - 5, midY + 5),
      southBand: band(c.height - bandPx, c.height),
      southProfile: prof,
    });
  };
  img.onerror = () => rej(new Error('load fail: ' + src));
  img.src = src;
});`;

const judge = (b) => {
  if (!b) return '?';
  const [r1, g1, b1] = b;
  if (r1 > 180 && g1 > 180 && b1 > 180) return '冰/雪(白)';
  if (b1 > r1 + 15 && r1 + g1 + b1 < 380) return '开放大洋(深)';
  return `混合 [${r1},${g1},${b1}]`;
};

const report = {};
try {
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(4000);
  await evaluate(PROBE_FN);
  for (const url of IMGS) {
    const key = url.replace(BASE, '');
    try {
      report[key] = await evaluate(`window.__probe(${JSON.stringify(url)})`);
    } catch (e) { report[key] = String(e.message); }
  }
} finally {
  report.jsErrors = errors;
  edge.kill();
}

for (const [img, r] of Object.entries(report)) {
  if (img === 'jsErrors' || typeof r !== 'object' || !r || !r.size) { console.log(`${img}: ERR ${r}`); continue; }
  console.log(`${img} ${r.size.join('x')}  北极带=${JSON.stringify(r.northBand)} → ${judge(r.northBand)} | 南极带=${JSON.stringify(r.southBand)} → ${judge(r.southBand)} | 赤道=${JSON.stringify(r.midBand)}`);
  if (r.southProfile && r.southBand && r.southBand[0] < 100) {
    console.log('  南极剖面(距底px, RGB):', r.southProfile.filter((_, i) => i % 3 === 0).map((p) => `${p[0]}:[${p[1]},${p[2]},${p[3]}]`).join(' '));
  }
}
console.log('jsErrors:', JSON.stringify(errors));
process.exit(errors.length ? 1 : 0);
