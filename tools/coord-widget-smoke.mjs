/**
 * 左上角坐标控件端到端冒烟（headless Edge + CDP）
 * 验证（2026-10-17 从 demo v8 迁移到生产）：
 *   ① 旧读数行 #coordLive 已移除；placeholder 接管实时经纬度；海拔为只读 #coordAlt
 *   ② 鼠标在画布内移动 → placeholder 写「经度/纬度 xx.xx°」；海拔显数字或 —
 *   ③ 鼠标移出画布 → placeholder 回落为视点坐标（仍为实时格式）
 *   ④ 输入框宽度 124px；海拔与纬度间距紧凑（gap 4px）
 *   ⑤ 留空点「定位」→ 飞到 _lastCursor（状态栏提示「（光标处）」）
 *   ⑥ 填入有效经纬度点「定位」→ 相机移动到该处（状态栏「已飞到」）；输入框被清空
 *   ⑦ 负高程场景（0°,0° 大西洋 ~-4941m）→ 海拔显「🌊 -4,941 m」（负号保留，瓦片未就绪则宽容为 —）
 *   ⑧ 浏览历史：定位自动记入 → 列表倒序 → 点击条目回飞 → 可清空（localStorage 持久化）
 * 用法：先启动 app.py，再 node tools/coord-widget-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
const WS_PATH = 'C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js';
const { default: WebSocket } = await import(`file:///${WS_PATH}`);

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9378;
const URL = 'http://127.0.0.1:5008/';

const edge = spawn(EDGE, [
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
await sleep(20000);   // 等 viewer + 地形瓦片就绪（海拔读数需要）

const report = {};

// ① DOM 结构：旧读数行已移除，海拔只读 span 在位
try {
  report.dom = await evaluate(`(() => {
    const lon = document.getElementById('gotoLon'), lat = document.getElementById('gotoLat');
    const alt = document.getElementById('coordAlt');
    const cs = lon ? getComputedStyle(lon) : null;
    const inputs = document.querySelector('.coord-inputs');
    return {
      liveGone: !document.getElementById('coordLive'),
      hasAlt: !!alt,
      altInit: alt?.textContent || '',
      lonPlaceholder: lon?.placeholder || '',
      latPlaceholder: lat?.placeholder || '',
      inputWidth: cs ? Math.round(parseFloat(cs.width)) : 0,
      inputsGap: inputs ? getComputedStyle(inputs).gap : '',
    };
  })()`);
} catch (e) { report.domErr = String(e.message); }

// ②③ 光标进/出画布：placeholder 实时写入 + 海拔回显 + 回落视点
try {
  report.cursor = await evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const lon = document.getElementById('gotoLon'), lat = document.getElementById('gotoLat');
    const alt = document.getElementById('coordAlt');
    const canvas = window.viewer.scene.canvas;
    const r = canvas.getBoundingClientRect();
    const cx = Math.round(r.left + r.width * 0.5), cy = Math.round(r.top + r.height * 0.5);
    // 光标在球体上（画布中心附近多找几个点，命中椭球的概率更高）
    let onGlobePh = null;
    for (const [dx, dy] of [[0, 0], [-120, -60], [120, 60], [-60, 120]]) {
      document.dispatchEvent(new MouseEvent('mousemove', {
        clientX: cx + dx, clientY: cy + dy, bubbles: true,
      }));
      await wait(250);
      if (/^经度 -?[\\d.]+°$/.test(lon.placeholder) && /^纬度 -?[\\d.]+°$/.test(lat.placeholder)) {
        onGlobePh = { lon: lon.placeholder, lat: lat.placeholder };
        break;
      }
    }
    const altOnGlobe = alt.textContent;
    // 光标移到画布外（左上角面板区域）→ 回落视点坐标
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 5, clientY: 5, bubbles: true }));
    await wait(400);
    const offGlobe = { lon: lon.placeholder, lat: lat.placeholder, alt: alt.textContent };
    return { onGlobePh, altOnGlobe, offGlobe };
  })()`);
} catch (e) { report.cursorErr = String(e.message); }

// ⑤ 留空定位 = 飞到光标处（状态栏提示「（光标处）」）
try {
  report.gotoEmpty = await evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const before = window.viewer.camera.positionCartographic;
    const lonB = Cesium.Math.toDegrees(before.longitude), latB = Cesium.Math.toDegrees(before.latitude);
    document.getElementById('gotoLon').value = '';
    document.getElementById('gotoLat').value = '';
    document.getElementById('btnGoto').click();
    await wait(2600);   // flyTo duration 1.8s + 余量
    const after = window.viewer.camera.positionCartographic;
    return {
      status: document.getElementById('status')?.textContent || '',
      moved: Math.abs(Cesium.Math.toDegrees(after.longitude) - lonB) > 0.5
        || Math.abs(Cesium.Math.toDegrees(after.latitude) - latB) > 0.5,
      lon: Cesium.Math.toDegrees(after.longitude), lat: Cesium.Math.toDegrees(after.latitude),
    };
  })()`);
} catch (e) { report.gotoEmptyErr = String(e.message); }

// ⑥ 填入经纬度定位（并断言定位后输入框被清空，placeholder 恢复实时光标坐标）
try {
  report.gotoFilled = await evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    document.getElementById('gotoLon').value = '116.39';
    document.getElementById('gotoLat').value = '39.91';
    document.getElementById('btnGoto').click();
    await wait(2600);
    const p = window.viewer.camera.positionCartographic;
    return {
      status: document.getElementById('status')?.textContent || '',
      lon: Cesium.Math.toDegrees(p.longitude), lat: Cesium.Math.toDegrees(p.latitude),
      hit: Math.abs(Cesium.Math.toDegrees(p.longitude) - 116.39) < 1 && Math.abs(Cesium.Math.toDegrees(p.latitude) - 39.91) < 1,
      cleared: document.getElementById('gotoLon').value === '' && document.getElementById('gotoLat').value === '',
    };
  })()`);
} catch (e) { report.gotoFilledErr = String(e.message); }

// ⑦ 负高程：0°,0°（大西洋，terrarium 实测约 -4941m）→ 「🌊 -4,941 m」负号保留（瓦片未就绪宽容为 —）
try {
  report.negativeAlt = await evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    window.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(0, 0, 200000),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-55), roll: 0 },
      duration: 1.5,
    });
    await wait(3500);
    // 等几拍让高程采样跟上（高度由相机 changed 事件驱动的 refreshCoordUI 写入）
    for (let i = 0; i < 10; i++) {
      const t = document.getElementById('coordAlt').textContent;
      if (/🌊/.test(t) || /\\d/.test(t)) break;
      await wait(600);
    }
    const alt = document.getElementById('coordAlt');
    return {
      text: alt.textContent, title: alt.title,
      ocean: /🌊/.test(alt.textContent),
      signed: /🌊\\s*-[\\d,]+/.test(alt.textContent),   // 负号必须保留：🌊 -4,941 m
    };
  })()`);
} catch (e) { report.negativeAltErr = String(e.message); }

// ⑧ 浏览历史：清空旧记录 → 两次定位自动记入 → 展开列表（倒序）→ 点击回飞 → 清空
try {
  report.navHist = await evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    localStorage.removeItem('sphere-nav-history');
    const lon = document.getElementById('gotoLon'), lat = document.getElementById('gotoLat');
    lon.value = '116.39'; lat.value = '39.91';           // 先定位北京
    document.getElementById('btnGoto').click();
    await wait(2600);
    lon.value = '121.47'; lat.value = '31.23';           // 再定位上海（应置顶）
    document.getElementById('btnGoto').click();
    await wait(2600);
    document.getElementById('navHistToggle').click();    // 展开
    await wait(250);
    const items = [...document.querySelectorAll('.nav-hist-item')].map((b) => b.textContent);
    const clearBtnVisible = !document.getElementById('navHistClear').hidden;
    document.querySelector('.nav-hist-item').click();    // 点最上一条（上海）回飞
    await wait(2600);
    const p = window.viewer.camera.positionCartographic;
    document.getElementById('navHistClear').click();     // 清空
    await wait(250);
    return {
      count: items.length,
      firstIsNewest: items[0]?.startsWith('121.47°, 31.23°') || false,
      hasTime: /\\d{2}:\\d{2}/.test(items[0] || ''),
      clearBtnVisible,
      backHit: Math.abs(Cesium.Math.toDegrees(p.longitude) - 121.47) < 1
        && Math.abs(Cesium.Math.toDegrees(p.latitude) - 31.23) < 1,
      afterClear: {
        dom: document.querySelectorAll('.nav-hist-item').length,
        ls: localStorage.getItem('sphere-nav-history'),
        emptyTip: !!document.querySelector('.nav-hist-empty'),
      },
    };
  })()`);
} catch (e) { report.navHistErr = String(e.message); }

// 截图留档
try {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const { writeFileSync } = await import('node:fs');
  writeFileSync('tools/.coord-widget.png', Buffer.from(shot.data, 'base64'));
  report.screenshot = 'tools/.coord-widget.png';
} catch (e) { report.shotErr = String(e.message); }

report.errors = errors.slice(0, 6);
console.log(JSON.stringify(report, null, 2));
ws.close();
edge.kill();
process.exit(0);
