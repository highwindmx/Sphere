/**
 * 世界城市图层 + 球背面剔除 + 屏幕边缘指示 + 标注避让 端到端冒烟（headless Edge + CDP）
 *
 * 验证项：
 *   ① 图层树出现「世界大城市」，8 个分组实体总数为 261，勾选后真实建实体
 *   ② Cesium 官方 RectangleCollisionChecker / EllipsoidalOccluder 在 1.146 vendored 版本可用
 *   ③ 背面剔除：相机对准中国时北美城市 _backface=true 且 show=false；对准美国时反转
 *   ④ 屏幕边缘指示：背面点的指示条真实绘制（svg 内可见 g 数 > 0），关闭开关后归零
 *   ⑤ 标注避让：RectangleCollisionChecker 生效后，密集区有标注被让位隐藏（label.show=false）且无异常
 *
 * 用法：先启动 app.py，再 node tools/layers-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';
const WS_PATH = 'C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js';
const { default: WebSocket } = await import(`file:///${WS_PATH}`);

const EDGE_BIN = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9382;
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
    errors.push(msg.params.exceptionDetails?.text + ' ' + (msg.params.exceptionDetails?.exception?.description ?? ''));
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval error');
  return r.result.value;
}

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: URL });

const ready = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 160; i++) {
    if (window.Cesium && window.viewer) return { ok: true, waitedMs: i * 250 };
    await sleep(250);
  }
  return { ok: false };
})()`);
if (!ready.ok) { edge.kill(); throw new Error('页面 viewer 未就绪'); }

const report = { errors, consoleErrors, steps: {} };

// ② 官方类可用性（这是「成熟方案」能否落地的前提，先验证再往下跑）
report.steps.apis = await evaluate(`(() => {
  const C = window.Cesium;
  const out = {};
  const R = (w, s, e, n) => new C.Rectangle(w, s, e, n);
  try {
    const chk = new C.RectangleCollisionChecker();
    chk.insert(R(0, 0, 10, 10), 1);          // ⚠ insert 必须有第二个参数 id
    out.insertOk = true;
    out.hitSame = chk.collides(R(5, 5, 15, 15));      // 期望 true（相交）
    out.missFar = chk.collides(R(11, 11, 20, 20));    // 期望 false（不相交）
    chk.insert(R(20, 20, 30, 30), 2);                 // west 更大（顺序插入）
    out.hitOrdered = chk.collides(R(25, 25, 35, 35));
    chk.insert(R(-30, -30, -20, -20), 3);             // west 更小（乱序插入）
    out.hitUnordered = chk.collides(R(-25, -25, -15, -15));
    // 关键假设验证：RectangleCollisionChecker 面向「地理尺度」矩形（经纬度弧度，
    // 纬度 |v| ≤ π/2）。屏幕像素值动辄数百，可能超出其内部假设而恒判不冲突。
    // ⚠ 实参顺序实测：minified 里 insert(e,t) → fromRectangleAndId(e,t,node)，
    //   而后者取 t.west / e.id —— 即真实顺序是 (id, rectangle)，与官方文档 (rectangle, id) 相反。
    //   传成 (rectangle, id) 不会抛错，只会静默恒判「不冲突」（所有标注都不避让）。
    const chkA = new C.RectangleCollisionChecker();
    chkA.insert(1, R(0, 0, 10, 10));                          // (id, rectangle)
    out.a_hit = chkA.collides(R(5, 5, 15, 15));               // 期望 true
    out.a_miss = chkA.collides(R(11, 11, 20, 20));            // 期望 false
    const chkB = new C.RectangleCollisionChecker();
    chkB.insert(R(0, 0, 10, 10), 1);                          // (rectangle, id) 对照
    out.b_hit = chkB.collides(R(5, 5, 15, 15));
    out.checkerOk = true;
  } catch (e) { out.error = String(e); }
  out.checkerOk = out.checkerOk === true;
  // 判定口径：只有 (id, rectangle) 顺序下碰撞检测才是真的在工作
  out.collidesOk = (out.a_hit === true && out.a_miss === false && out.b_hit === false);
  try {
    const occ = new C.EllipsoidalOccluder(C.Ellipsoid.WGS84, C.Cartesian3.fromDegrees(0, 0, 2e7));
    // 相机在 (0°,0°) 上空：对跖点 (180°,0°) 应为不可见，脚下点应可见
    const back = occ.isPointVisible(C.Cartesian3.fromDegrees(180, 0, 0));
    const front = occ.isPointVisible(C.Cartesian3.fromDegrees(0, 0, 0));
    out.occOk = (back === false && front === true);
    out.back = back; out.front = front;
    out.occApi = typeof occ.isPointVisible;
    return out;
  } catch (e) { out.occError = String(e); return out; }
})()`);

// ① 图层树与实体数
report.steps.layerTree = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('.layer-item')];
  const row = rows.find((r) => r.dataset.layerId === 'worldcities');
  if (!row) return { found: false, ids: rows.map((r) => r.dataset.layerId).slice(0, 60) };
  const title = row.textContent.slice(0, 40);
  const groups = [...row.querySelectorAll('input[id^="layer-worldcities-g-"]')].map((c) => c.id);
  return { found: true, title, groupCount: groups.length, groups };
})()`);

// 勾选全部 8 个分组 → 构建实体
report.steps.build = await evaluate(`(() => {
  const cbs = [...document.querySelectorAll('input[id^="layer-worldcities-g-"]')];
  for (const c of cbs) { if (!c.checked) { c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); } }
  return { checked: cbs.length };
})()`);
await sleep(1500);

report.steps.entityCount = await evaluate(`(() => {
  const m = window.renderer && window.renderer._groupEntityMap ? window.renderer._groupEntityMap.get('worldcities') : null;
  if (!m) return { error: 'worldcities 分组表不存在（renderer 未暴露？）' };
  const out = {};
  let total = 0;
  for (const [gid, st] of m) { out[gid] = { built: st.built, n: st.entities.length }; total += st.entities.length; }
  return { total, out };
})()`);

// ③ 背面剔除：相机飞到中国上空 → 美国城市应在背面
await evaluate(`window.viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(110, 30, 1.2e7), orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 }, duration: 0 })`);
await sleep(1200);
report.steps.occludeChinaView = await evaluate(`(() => {
  const m = window.renderer._groupEntityMap.get('worldcities');
  const pick = (gid, name) => {
    const st = m.get(gid);
    const ent = st.entities.find((e) => e.name === name);
    return ent ? { backface: !!ent._backface, show: ent.show } : null;
  };
  return {
    newYork: pick('na', '纽约'),
    losAngeles: pick('na', '洛杉矶'),
    tokyo: pick('jp', '东京'),
    london: pick('eu', '伦敦'),
    backfaceTotal: window.renderer.debugBackfaceCount(),
    edgeCount: window.__edge ? window.__edge.debugCount() : null,
  };
})()`);

// 相机飞到美国上空 → 反转：美国城市可见、中国周边在背面
await evaluate(`window.viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(-100, 40, 1.2e7), orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 }, duration: 0 })`);
await sleep(1200);
report.steps.occludeUsaView = await evaluate(`(() => {
  const m = window.renderer._groupEntityMap.get('worldcities');
  const pick = (gid, name) => {
    const st = m.get(gid);
    const ent = st.entities.find((e) => e.name === name);
    return ent ? { backface: !!ent._backface, show: ent.show } : null;
  };
  return {
    newYork: pick('na', '纽约'),
    hongKong: pick('asia', '香港'),
    backfaceTotal: window.renderer.debugBackfaceCount(),
  };
})()`);

// ④ 屏幕边缘指示器：svg 应存在且绘制了指示条；关闭开关后归零
report.steps.edgeIndicator = await evaluate(`(() => {
  const svg = document.querySelector('#cesiumContainer svg.offscreen-layer');
  if (!svg) return { svgFound: false };
  const gs = [...svg.querySelectorAll('g')].filter((g) => g.getAttribute('opacity') === '1');
  const sample = gs.slice(0, 3).map((g) => ({
    line: g.querySelector('line')?.getAttribute('x1'),
    text: g.querySelector('text')?.textContent,
    arrow: !!g.querySelector('polygon')?.getAttribute('points'),
  }));
  return { svgFound: true, visible: gs.length, sample, display: svg.style.display };
})()`);

report.steps.edgeOff = await evaluate(`(() => {
  const cb = document.getElementById('cbEdgeIndicator');
  cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true }));
  const svg = document.querySelector('#cesiumContainer svg.offscreen-layer');
  return { enabled: window.__edge ? window.__edge.isEnabled() : null, display: svg ? svg.style.display : null };
})()`);
await sleep(400);

// ⑤ 标注避让：勾多个密集图层（世界城市 + 首都 + 山峰），检查是否有标注被让位隐藏
report.steps.dodge = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 打开世界首都 + 山峰，制造屏幕空间密集
  for (const id of ['worldcapitals', 'peaks']) {
    for (const c of document.querySelectorAll('input[id^="layer-' + id + '-g-"]')) {
      if (!c.checked) { c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); }
    }
  }
  await sleep(1500);
  // 拉近到日本关东（36 城挤在几百公里内），制造真正的密集叠字场景
  window.viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(139, 36, 5.5e5), orientation: { heading: 0, pitch: Cesium.Math.toRadians(-60), roll: 0 }, duration: 0 });
  await sleep(2500);
  const m = window.renderer._groupEntityMap;
  let withLabel = 0, hidden = 0, offsetMoved = 0;
  const julian = Cesium.JulianDate.now();
  for (const gm of m.values()) {
    for (const st of gm.values()) {
      if (!st.built) continue;
      for (const e of st.entities) {
        if (!e.label) continue;
        if (e._groupShow === false || e._backface) continue;
        withLabel++;
        const showProp = e.label.show;
        const shown = (showProp && typeof showProp.getValue === 'function') ? showProp.getValue(julian) : showProp;
        if (shown === false) hidden++;
        const po = e.label.pixelOffset;
        const off = (po && typeof po.getValue === 'function') ? po.getValue(julian) : po;
        if (off && e._labelOffset0 && Math.abs(off.y - e._labelOffset0.y) > 1) offsetMoved++;
      }
    }
  }
  return { withLabel, hidden, offsetMoved };
})()`);

await sleep(600);
report.steps.afterAll = await evaluate(`(() => ({
  backfaceTotal: window.renderer.debugBackfaceCount(),
  occludeBack: window.renderer.isOccludeBack(),
}))()`);

// ⑥ 海底地形底图：瓦片代理可达 + 前端图层挂载 + 再点一次可卸载
// ⚠ 用 node:http 直连：Node 24 的 fetch 会读环境代理，127.0.0.1 也可能被沙箱代理拦掉，
//    之前因此误判成 404（服务端日志明明是 200）。
let oceanProxy = null;
try {
  const http = await import('node:http');
  oceanProxy = await new Promise((resolve) => {
    http.default.get({ host: '127.0.0.1', port: 5008, path: '/tiles/ocean/2/1/1', timeout: 20000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const b = Buffer.concat(chunks);
        resolve({ status: res.statusCode, bytes: b.length, jpeg: b[0] === 0xff && b[1] === 0xd8 });
      });
    }).on('error', (e) => resolve({ error: String(e) }));
  });
} catch (e) { oceanProxy = { error: String(e) }; }
report.steps.oceanProxy = oceanProxy;

report.steps.oceanLayer = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const L = window.viewer.imageryLayers;
  const before = L.length;
  document.getElementById('btnOceanBase').click();
  await sleep(1500);
  const mid = L.length;
  const top = L.get(mid - 1);
  const isOcean = !!(top && top.imageryProvider && String(top.imageryProvider.url || '').includes('ocean'));
  const btnActive = document.getElementById('btnOceanBase').classList.contains('active');
  document.getElementById('btnOceanBase').click();
  await sleep(600);
  return { before, mid, after: L.length, isOcean, btnActive };
})()`);

writeFileSync('tools/.layers-smoke.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
ws.close();
edge.kill();
