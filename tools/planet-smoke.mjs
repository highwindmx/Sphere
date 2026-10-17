/**
 * 月球/火星图层端到端冒烟（headless Edge + CDP）
 * 验证（2026-10-18 本轮）：
 *   ① 火星模式：点「🔴 火星」→ viewer 创建、MDIM 底图层（maximumLevel 7、火星椭球）
 *      → 瓦片真正上屏（中心区域像素方差 > 阈值，非纯 baseColor）→ 截图
 *   ② 火星地形晕渲：勾选 → imageryLayers=2；取消 → 1
 *   ③ 火星标注分组：勾选「巨型地貌」→ entities show > 0
 *   ④ 月球模式：点「🌙 月球」→ DEM 采样按 Terrarium 正确解码
 *      （雨海 < -2500m、背面 SPA < -6000m；旧灰度解码曾把雨海读成 +312m）
 *   ⑤ 月面高清瓦片代理：/tiles/lunar/0/0/0.jpg 返回真 JPEG（>20KB；透明兜底仅 ~70B）
 *   ⑥ 全程无 JS 异常 / console 错误
 * 前置知识（避免重踩）：
 *   - WebGL canvas 不能直接 getContext('2d')（返回 null），取像素须中转 drawImage
 *   - 火星/月球 viewer 每次进入都重建，钩子 window.__getMarsViewer / __getMoonViewer 取当前句柄
 *   - MDIM 底图与 globe.baseColor 都是锈红色，判「瓦片上屏」用**区域方差**（纯色 std≈0）
 * 用法：先启动 app.py，再 node tools/planet-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';
const WS_PATH = 'C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js';
const { default: WebSocket } = await import(`file:///${WS_PATH}`);

const EDGE_BIN = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9385;
const URL = 'http://127.0.0.1:5008/';

const edge = spawn(EDGE_BIN, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--no-first-run',
  '--no-default-browser-check', '--disable-extensions', '--use-gl=angle',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage',
  '--window-size=1280,800', 'about:blank',
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
const errors = [];
const consoleErrors = [];
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const txt = msg.params.exceptionDetails?.text + ' ' + (msg.params.exceptionDetails?.exception?.description ?? '');
    if (/setPointerCapture/.test(txt)) return;   // 合成 pointer 事件的冒烟伪影
    errors.push(txt);
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const t = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
    if (/error|Error|失败|异常/i.test(t)) consoleErrors.push(t.slice(0, 300));
  }
});
function send(method, params = {}) {
  const i = ++id;
  ws.send(JSON.stringify({ id: i, method, params }));
  return new Promise((res, rej) => pending.set(i, { res, rej }));
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error('eval 异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result.value;
}

// 确保落在目标页（CDP 可能连到 about:blank 空 target）
await send('Page.enable');
await send('Page.navigate', { url: URL });
await sleep(2500);

const report = { steps: {} };
const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));

// 页面就绪：等 app 初始化（build 钩子 + 图层树）
for (let i = 0; i < 60; i++) {
  const ok = await evaluate(`(() => !!document.getElementById('layersTree') && document.getElementById('layersTree').children.length > 0)()`).catch(() => false);
  if (ok) break;
  await sleep2(500);
}

// 像素工具（WebGL canvas 取像素须中转 drawImage）
await evaluate(`(() => {
  window.__t = {
    snap(viewer) {
      const v = viewer || window.viewer;
      v.scene.requestRender();
      v.scene.render(Cesium.JulianDate.now());
      return v.scene.canvas.toDataURL('image/png');
    },
    // 中心 64×64 区域的均值 + 标准差（判「瓦片上屏」：纯 baseColor std≈0）
    regionStats(viewer) {
      const v = viewer || window.viewer;
      const cv = v.scene.canvas;
      const c2 = document.createElement('canvas'); c2.width = cv.width; c2.height = cv.height;
      const x2 = c2.getContext('2d');
      for (let k = 0; k < 3; k++) { v.scene.requestRender(); v.scene.render(Cesium.JulianDate.now()); }
      x2.drawImage(cv, 0, 0);
      const s = 64;
      const px = x2.getImageData(Math.round(cv.width/2)-s/2, Math.round(cv.height/2)-s/2, s, s).data;
      let r=0,g=0,b=0; const n = px.length/4;
      for (let i=0;i<px.length;i+=4){ r+=px[i]; g+=px[i+1]; b+=px[i+2]; }
      r/=n; g/=n; b/=n;
      let varr=0;
      for (let i=0;i<px.length;i+=4){ const l=(px[i]+px[i+1]+px[i+2])/3; varr += (l-(r+g+b)/3)**2; }
      return { mean: [Math.round(r), Math.round(g), Math.round(b)], std: +Math.sqrt(varr/n).toFixed(2) };
    },
  };
  return true;
})()`);

// ===== ① 火星模式 =====
report.steps.enterMars = await evaluate(`(() => {
  const btn = document.getElementById('btnMarsMode');
  if (!btn) return { ok: false, why: 'no btnMarsMode' };
  btn.click();
  return { ok: true };
})()`);
// 轮询 viewer 就绪
report.steps.marsViewer = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 60; i++) {
    const mv = window.__getMarsViewer && window.__getMarsViewer();
    if (mv && !mv.isDestroyed()) {
      const L = mv.imageryLayers;
      const layer = L.length ? L.get(0) : null;
      const p = layer && layer.imageryProvider;
      return {
        ok: true, waitedMs: i * 500,
        containerHidden: document.getElementById('marsContainer').classList.contains('hidden'),
        layers: L.length,
        providerUrl: p && p.url ? String(p.url) : null,
        maxLevel: p ? p.maximumLevel : null,
        ellipsoidR: p && p.tilingScheme ? Math.round(p.tilingScheme.ellipsoid.radii.x) : null,
        baseColor: mv.scene.globe.baseColor ? mv.scene.globe.baseColor.toCssColorString() : null,
        credit: layer && layer.credit ? layer.credit.html : '',
      };
    }
    await sleep(500);
  }
  return { ok: false };
})()`);
// 等瓦片上屏（SwiftShader 下渲染慢，轮询区域方差）
report.steps.marsImagery = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const mv = window.__getMarsViewer && window.__getMarsViewer();
  if (!mv) return { ok: false, why: 'no viewer' };
  let last = null;
  for (let i = 0; i < 40; i++) {
    last = window.__t.regionStats(mv);
    if (last.std > 4) return { ...last, ok: true, waitedMs: i * 1000 };
    await sleep(1000);
  }
  return { ...last, ok: false };
})()`);
const marsShot = await evaluate(`(() => { const mv = window.__getMarsViewer && window.__getMarsViewer(); return mv ? window.__t.snap(mv) : null; })()`);
if (marsShot) writeFileSync('tools/.planet-mars.png', Buffer.from(marsShot.split(',')[1], 'base64'));

// ===== ② 地形晕渲切换 =====
report.steps.marsHill = await evaluate(`(() => {
  const mv = window.__getMarsViewer && window.__getMarsViewer();
  const cb = document.getElementById('marsHillshade');
  if (!mv || !cb) return { ok: false };
  const before = mv.imageryLayers.length;
  cb.checked = true; cb.dispatchEvent(new Event('change'));
  const on = mv.imageryLayers.length;
  const hillProvider = on > 1 ? mv.imageryLayers.get(on - 1).imageryProvider : null;
  const hillUrl = hillProvider && hillProvider.url ? hillProvider.url : '';
  cb.checked = false; cb.dispatchEvent(new Event('change'));
  return { ok: true, before, on, off: mv.imageryLayers.length, hillIsMarshill: /marshill/.test(hillUrl) };
})()`);

// ===== ③ 标注分组 =====
report.steps.marsGroups = await evaluate(`(() => {
  const mv = window.__getMarsViewer && window.__getMarsViewer();
  const wrap = document.getElementById('marsGroups');
  if (!mv || !wrap) return { ok: false };
  const cbs = [...wrap.querySelectorAll('input[type=checkbox]')];
  const labels = [...wrap.querySelectorAll('span')].map((s) => s.textContent);
  cbs[0].checked = true; cbs[0].dispatchEvent(new Event('change'));
  const shown = mv.entities.values.filter((e) => e.show).length;
  cbs[0].checked = false; cbs[0].dispatchEvent(new Event('change'));
  return { ok: true, groupCount: cbs.length, labels, entitiesShown: shown };
})()`);

// ===== ④ 月球模式 + DEM 解码 =====
report.steps.enterMoon = await evaluate(`(() => { document.getElementById('btnMoonMode').click(); return { ok: true }; })()`);
report.steps.moonDem = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 40; i++) {
    if (window.__isMoonTerrainReady && window.__isMoonTerrainReady()) break;
    await sleep(500);
  }
  const s = window.__sampleMoonHeight;
  if (!s) return { ok: false, why: 'no __sampleMoonHeight' };
  const pts = {
    imbriumCenter: s(-16.0, 32.8),
    tranquillity: s(23.47, 0.67),
    farsideSpa: s(180, -50),
    tycho: s(-11.4, -43.3),
  };
  return { ok: window.__isMoonTerrainReady(), points: Object.fromEntries(Object.entries(pts).map(([k, v]) => [k, Math.round(v)])) };
})()`);

// ===== ⑤ 月面高清瓦片代理（真 JPEG，非透明兜底）=====
report.steps.lunarHiResTile = await evaluate(`(async () => {
  try {
    const r = await fetch('/tiles/lunar/0/0/0.jpg', { cache: 'no-store' });
    const buf = await r.arrayBuffer();
    const u8 = new Uint8Array(buf);
    return { ok: r.ok, status: r.status, bytes: u8.length, isJpeg: u8[0] === 0xff && u8[1] === 0xd8, type: r.headers.get('content-type') };
  } catch (e) { return { ok: false, err: String(e) }; }
})()`);

const moonShot = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const mv = window.__getMoonViewer && window.__getMoonViewer();
  if (!mv) return null;
  // 等本地底图（lunar_wac.jpg 10MB）解码上屏再截图（SwiftShader 下可能要数秒）
  for (let i = 0; i < 40; i++) {
    const st = window.__t.regionStats(mv);
    if (st.std > 4) break;
    await sleep(1000);
  }
  return window.__t.snap(mv);
})()`);
if (moonShot) writeFileSync('tools/.planet-moon.png', Buffer.from(moonShot.split(',')[1], 'base64'));

// ===== 断言汇总 =====
const S = report.steps;
report.checks = {
  noJsErrors: errors.length === 0,
  noConsoleErrors: consoleErrors.length === 0,
  // ① 火星 viewer + 底图层（provider 类名在打包后会被 minify，用 URL 判源）
  marsViewerOk: S.marsViewer.ok === true
    && S.marsViewer.containerHidden === false
    && S.marsViewer.layers === 1
    && /\/tiles\/mars\/\{z\}\/\{x\}\/\{y\}\.jpg/.test(S.marsViewer.providerUrl || '')
    && S.marsViewer.maxLevel === 7
    && Math.abs(S.marsViewer.ellipsoidR - 3396190) < 1,
  // ①b 瓦片真正上屏（区域方差）
  marsImageryLoaded: S.marsImagery.ok === true && S.marsImagery.std > 4,
  // ② 晕渲切换
  marsHillToggle: S.marsHill.ok === true && S.marsHill.before === 1
    && S.marsHill.on === 2 && S.marsHill.off === 1 && S.marsHill.hillIsMarshill === true,
  // ③ 标注分组
  marsGroups: S.marsGroups.ok === true && S.marsGroups.groupCount === 3 && S.marsGroups.entitiesShown > 0,
  // ④ DEM Terrarium 解码（旧灰度解码雨海 = +312m，必为负且 < -2500）
  moonDemTerrarium: S.moonDem.ok === true
    && S.moonDem.points.imbriumCenter < -2500
    && S.moonDem.points.tranquillity < -2000
    && S.moonDem.points.farsideSpa < -6000,
  // ⑤ 高清瓦片真图
  lunarHiResJpeg: S.lunarHiResTile.ok === true && S.lunarHiResTile.isJpeg === true && S.lunarHiResTile.bytes > 20000,
};

console.log(JSON.stringify(report, null, 1));
const failed = Object.entries(report.checks).filter(([, v]) => !v).map(([k]) => k);
console.log(failed.length ? `\nFAIL: ${failed.join(', ')}` : '\nALL CHECKS PASSED');

edge.kill();
ws.close();
process.exit(failed.length ? 1 : 0);
