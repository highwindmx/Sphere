/**
 * glTF 模型加载与动画端到端冒烟（headless Edge + CDP）
 * 验证（探月任务 3D 化前置门）：
 *   ① longmarch5.glb（自研静态火箭）→ ready + 实际渲染出像素（包围球投影邻域 diff）
 *   ② spacecraft.glb / booster.glb / fairing.glb / moon_lander.glb（转移/分离件/着陆器）
 *   ③ yutu_rover.glb（自研 6 轮滚动节点动画）→ ready + 渲染 + 动画运行（双帧 diff）
 *   ④ CesiumMan.glb（官方样例，骨骼 skinning 行走动画）→ ready + 渲染 + 动画运行
 *      ④ 是「骨骼动画能否实施」的核心证据：Cesium Model 官方支持 glTF skinning
 * 方法：每个模型以 modelMatrix（ENU 固定帧）定位到北京上空 140m，相机 lookAt 同一点（26m）。
 *       渲染证据 = boundingSphere 中心投影点 60px 邻域像素差（有/无模型），小模型也灵敏；
 *       动画证据 = 双帧 diff 经噪声标定（隐藏模型的双帧 diff 为基线，animDiff > max(0.5, noise×3) 才算在跑）。
 * 坐标铁律：camera.position 是 lookAt 参考系下的局部坐标，世界距离必须用 camera.positionWC
 *           （2026-10-17 踩坑：误用 position 曾误判「lookAt 把相机打到原点」）。
 * 1.146 API：Model.fromGltfAsync({url, gltfCallback})；动画用 activeAnimations.add({index})（官方范式）。
 * 用法：先启动 app.py，再 node tools/models-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';
const WS_PATH = 'C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js';
const { default: WebSocket } = await import(`file:///${WS_PATH}`);

const EDGE_BIN = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9381;
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

// 等 viewer + Cesium 就绪（轮询，不盲等固定时长；前一模型卸载会拖慢后续加载）
const ready = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 160; i++) {
    if (window.Cesium && window.viewer) return { ok: true, waitedMs: i * 250 };
    await sleep(250);
  }
  return { ok: false };
})()`);
if (!ready.ok) { edge.kill(); throw new Error('页面 viewer 未就绪'); }

const report = { errors, consoleErrors, models: {} };

// 注入测试工具：快照 + 指定邻域像素差
// 注意：requestRenderMode 下 scene.render() 单独调用可能是 no-op（无 pending request 时跳过），
//       必须先 requestRender() 再 render()；时间参数用 now() 让动画自然推进。
await evaluate(`(() => {
  window.__t = {
    snap() {
      const v = window.viewer;
      v.scene.requestRender();
      v.scene.render(Cesium.JulianDate.now());
      return v.scene.canvas.toDataURL('image/png');
    },
    async diffAt(a, b, cx, cy, half) {
      const load = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = src; });
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      const c = document.createElement('canvas'); c.width = 2 * half; c.height = 2 * half;
      const ctx = c.getContext('2d');
      const W = ia.width, H = ia.height;
      const x = Math.max(0, Math.min(W - 2 * half, Math.round(cx - half)));
      const y = Math.max(0, Math.min(H - 2 * half, Math.round(cy - half)));
      ctx.drawImage(ia, x, y, 2 * half, 2 * half, 0, 0, 2 * half, 2 * half);
      const da = ctx.getImageData(0, 0, 2 * half, 2 * half).data;
      ctx.clearRect(0, 0, 2 * half, 2 * half);
      ctx.drawImage(ib, x, y, 2 * half, 2 * half, 0, 0, 2 * half, 2 * half);
      const db = ctx.getImageData(0, 0, 2 * half, 2 * half).data;
      let sum = 0;
      for (let i = 0; i < da.length; i += 4) {
        sum += Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
      }
      return sum / (da.length / 4 * 3);
    },
  };
  return true;
})()`);

// 彻底清场：remove + destroy 双保险（只 destroy 不 remove 会让集合累积占用，
// 且上一模型残留会遮挡/污染下一测试——2026-10-17 踩坑：longmarch5 二次实例
// 未清理，把 yutu/CesiumMan 包在火箭尾裙里导致可见性 diff 假阴性）
async function cleanupScene() {
  await evaluate(`(async () => {
    const v = window.viewer;
    const st = window.__m;
    if (st && st.model) {
      try { v.scene.primitives.remove(st.model); } catch { /* 已移除 */ }
      try { st.model.destroy(); } catch { /* 已销毁 */ }
      window.__m = null;
    }
    // 兜底：清掉我们可能残留的全部模型 primitive
    for (let i = v.scene.primitives.length - 1; i >= 0; i--) {
      const p = v.scene.primitives.get(i);
      if (p && p.constructor && p.constructor.name === 'Model') {
        v.scene.primitives.remove(p);
        try { p.destroy(); } catch { /* 忽略 */ }
      }
    }
    return v.scene.primitives.length;
  })()`);
}

async function testModel(name, file, opts = {}) {
  const r = {};
  await cleanupScene();   // 入场先清场，防上一模型残留
  // 模型定位 + 加载 + 动画挂载 + 相机就位，一个异步块内完成
  // 定位错开：每个模型经度 +0.002°（约 190m），避免同点定位互相遮挡
  const setup = () => evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const v = window.viewer;
    const pos = Cesium.Cartesian3.fromDegrees(116.391 + ${opts.lonOffset ?? 0}, 39.907, 140);
    let animCount = 0;
    // 1.146：gltfCallback 取 gltf.animations（Model 对象本身不再暴露 animations）
    const m = await Cesium.Model.fromGltfAsync({
      url: '/models/${file}', minimumPixelSize: 48,
      gltfCallback: (gltf) => { animCount = gltf.animations ? gltf.animations.length : 0; },
    });
    // 关键：模型必须用 ENU 固定帧定位到目标点，否则躺在原点(地球中心)永远不可见
    m.modelMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(pos, Cesium.Ellipsoid.WGS84);
    v.scene.primitives.add(m);
    window.__m = { model: m, pos };
    // 等 ready（多模型连续加载会变慢，放宽到 20s）
    for (let i = 0; i < 100 && !m.ready; i++) {
      v.scene.requestRender();
      await sleep(200);
    }
    if (!m.ready) return { ready: false, animCount, activeCount: -1, camDist: -1, bs: null };
    // 动画：官方范式 activeAnimations.add({index})（addAll 亦可，统一用 add）
    if (${opts.animate ? 'true' : 'false'} && animCount > 0) {
      m.activeAnimations.add({ index: 0, loop: Cesium.ModelAnimationLoop.REPEAT, multiplier: 1 });
    }
    // 相机 lookAt 同一点（range 26m）；断言必须用 positionWC（世界坐标）
    v.camera.lookAt(pos, new Cesium.HeadingPitchRange(0.4, -0.10, 26));
    await sleep(300);
    // 包围球中心 → 屏幕坐标，作为像素 diff 的取样中心（小模型也灵敏）
    const bs = m.boundingSphere;
    const win = Cesium.SceneTransforms.worldToWindowCoordinates(v.scene, bs.center);
    return {
      ready: true,
      animCount,
      activeCount: m.activeAnimations.length,
      camDist: Math.round(Cesium.Cartesian3.distance(v.camera.positionWC, pos)),
      bsRadius: Math.round(bs.radius * 100) / 100,
      bsScreen: win ? { x: Math.round(win.x), y: Math.round(win.y) } : null,
    };
  })()`);
  try {
    r.bytes = await evaluate(`(async () => (await (await fetch('/models/${file}')).arrayBuffer()).byteLength)()`);
    const first = await setup();
    Object.assign(r, first);
    await sleep(1200);   // 等模型纹理/着色器就绪 + 至少一帧

    const shot = await evaluate(`window.__t.snap()`);
    writeFileSync(`tools/.models-${name}.png`, Buffer.from(shot.split(',')[1], 'base64'));

    // 可见性：包围球投影点邻域，有模型 vs 无模型
    r.visibleDiff = await evaluate(`(async () => {
      const t = window.__t, v = window.viewer, st = window.__m;
      const a = t.snap();
      const m = st.model;
      if (m && m.destroy) m.destroy(); else v.scene.primitives.remove(m);
      window.__m.model = null;
      await new Promise((r2) => setTimeout(r2, 400));
      const b = t.snap();
      return t.diffAt(a, b, ${'{BSX}'}, ${'{BSY}'}, 60);
    })()`.replace('{BSX}', first.bsScreen ? first.bsScreen.x : 640).replace('{BSY}', first.bsScreen ? first.bsScreen.y : 400));

    // 动画：重新加回 → 相隔 0.21s 双帧 diff，并以「隐藏模型双帧 diff」为噪声基线
    // 步长铁律：0.21s 既非 yutu 周期(1s)也非 CesiumMan 周期(~1.33s)的整数倍——
    //           踩中整数倍时归一化动画位置恒等，双帧 diff 恒 0（2026-10-17 踩坑）。
    // 隔离铁律：测量期间隐藏 globe/skyBox/skyAtmosphere——错位定位会加载新瓦片，
    //           背景渐入会产生比动画还大的噪声（CesiumMan 实测 noise=22.9）。
    await setup();
    await sleep(300);
    if (opts.animate && first.animCount > 0) {
      await evaluate(`(() => { const s = window.viewer.scene; s.globe.show = false; s.skyAtmosphere.show = false; s.skyBox.show = false; return true; })()`);
      r.animNoise = await evaluate(`(async () => {
        const t = window.__t;
        const m = window.__m.model; m.show = false;
        await new Promise((r2) => setTimeout(r2, 300));
        const a = t.snap();
        await new Promise((r2) => setTimeout(r2, 210));
        const b = t.snap();
        m.show = true;
        return t.diffAt(a, b, ${'{BSX}'}, ${'{BSY}'}, 60);
      })()`.replace('{BSX}', first.bsScreen ? first.bsScreen.x : 640).replace('{BSY}', first.bsScreen ? first.bsScreen.y : 400));
      await sleep(500);   // 动画先跑一会
      r.animDiff = await evaluate(`(async () => {
        const t = window.__t;
        const a = t.snap();
        await new Promise((r2) => setTimeout(r2, 210));
        const b = t.snap();
        return t.diffAt(a, b, ${'{BSX}'}, ${'{BSY}'}, 60);
      })()`.replace('{BSX}', first.bsScreen ? first.bsScreen.x : 640).replace('{BSY}', first.bsScreen ? first.bsScreen.y : 400));
      await evaluate(`(() => { const s = window.viewer.scene; s.globe.show = true; s.skyAtmosphere.show = true; s.skyBox.show = true; return true; })()`);
      const noise = typeof r.animNoise === 'number' ? r.animNoise : 0;
      r.animRunning = r.animDiff > Math.max(0.5, noise * 3);
    } else {
      r.animDiff = 'n/a（静态模型）';
      r.animRunning = 'n/a';
    }
  } catch (e) { r.err = String(e.message); }
  report.models[name] = r;
}

await testModel('longmarch5', 'longmarch5.glb', { animate: false, lonOffset: 0 });
await testModel('yutu_rover', 'yutu_rover.glb', { animate: true, lonOffset: 0.002 });
await testModel('CesiumMan', 'CesiumMan.glb', { animate: true, lonOffset: 0.004 });
await testModel('spacecraft', 'spacecraft.glb', { animate: false, lonOffset: 0.006 });
await testModel('moon_lander', 'moon_lander.glb', { animate: false, lonOffset: 0.008 });
await testModel('booster', 'booster.glb', { animate: false, lonOffset: 0.010 });
await testModel('fairing', 'fairing.glb', { animate: false, lonOffset: 0.012 });

// 收尾：清场 + 复位相机 lookAt（页面随后即关闭）
await cleanupScene();
try {
  await evaluate(`(() => { try { window.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY); } catch {} return true; })()`);
} catch { /* 忽略 */ }

console.log(JSON.stringify(report, null, 1));
edge.kill();
process.exit(0);
