/**
 * 探月任务四幕剧 3D 化端到端冒烟（headless Edge + CDP）
 * 验证（src/rocket.js 3D 版）：
 *   ① 点击「🌕 探月」场景预设进入任务面板 → 地球侧模型（rocket/craft）异步加载就绪
 *   ② start 后 seek 0.05（第一幕）→ 截图 + 3D 火箭渲染证据
 *   ③ seek 0.95（第四幕巡视）→ 月球侧模型（loiCraft/lander/rover）就绪、
 *      rover 轮子动画激活（animOn）→ 截图
 *   ④ 全程无 JS 异常 / console 错误
 * 2026-10-17 六项用户反馈回归（本轮新增断言）：
 *   A. 暂停粘滞：暂停后按钮=播放，画布点击不恢复播放
 *   B. 发射前预览：进面板火箭即竖立（label 待发射）；换发射场镜头/火箭搬过去（酒泉）
 *   C. 分离相位文字：助推器窗口 phase=「第一幕 · 助推器分离（四散弹开）」（不被通用相位覆盖）
 *   D. 第一幕轨迹平滑：细采样位置转角 maxTurn<6° 且无突兀跳变（非折线）
 *   E. 第二幕轨道总览：#orbitOverview 可见且画布非空白
 *   F. LOI 赤道轨道：craft lat≈0、环月轨环 lat=0
 *   G. 下降段：纬度沿子午线推进（0<lat<site.lat）+ 相机 260 万 m
 *   H. 第四幕：玉兔驶离着陆器（行程≈26·s4）+ 车头朝向=行进方向（dot>0.95）
 *   I. 月面提亮（gamma 1.45/brightness 1.35）：第四幕中心像素亮度 >60（旧版 27）
 * 前置知识（避免重踩）：
 *   - camera.position 是 lookAt 局部坐标；世界距离用 positionWC（见 models-smoke.mjs 头注）
 *   - requestRenderMode 下快照必须 requestRender() + render(now) 双步
 *   - 月球 viewer 每次进入都会重建（viewer.destroy()），模型槽位随之换代——冒烟按「seek 后轮询
 *     debugState」而非假设一次加载永久有效
 *   - 播放中 CDP evaluate 开销大（SwiftShader 页面单次可达数秒），p 会漂移过界——
 *     seek 后先暂停再轮询，保证 eval 时 p 恒定（2026-10-17 实测教训）
 *   - WebGL canvas 不能直接 getContext('2d')（返回 null），取像素须中转 drawImage
 * 用法：先启动 app.py，再 node tools/mission-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';
const WS_PATH = 'C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js';
const { default: WebSocket } = await import(`file:///${WS_PATH}`);

const EDGE_BIN = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9383;
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
    // 合成 pointer 事件（无活动指针）触发 Cesium setPointerCapture 抛错——冒烟伪影，真实鼠标不会发生
    if (/setPointerCapture/.test(txt)) return;
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

const report = { errors, consoleErrors, steps: {}, checks: {} };

// 快照工具（requestRenderMode 双步；月球/地球 viewer 分别取）
await evaluate(`(() => {
  window.__t = {
    snap(viewer) {
      const v = viewer || window.viewer;
      v.scene.requestRender();
      v.scene.render(Cesium.JulianDate.now());
      return v.scene.canvas.toDataURL('image/png');
    },
    // 中心像素（WebGL canvas 不能直接 getContext('2d')，须中转 drawImage）
    centerPixel(viewer) {
      const v = viewer || window.viewer;
      const cv = v.scene.canvas;
      const c2 = document.createElement('canvas'); c2.width = cv.width; c2.height = cv.height;
      const x2 = c2.getContext('2d');
      for (let k = 0; k < 3; k++) { v.scene.requestRender(); v.scene.render(Cesium.JulianDate.now()); }
      x2.drawImage(cv, 0, 0);
      const px = x2.getImageData(Math.round(cv.width/2)-8, Math.round(cv.height/2)-8, 16, 16).data;
      let r=0,g=0,b=0; const n = px.length/4;
      for (let i=0;i<px.length;i+=4){ r+=px[i]; g+=px[i+1]; b+=px[i+2]; }
      return [Math.round(r/n), Math.round(g/n), Math.round(b/n)];
    },
  };
  return true;
})()`);

// ① 点「🌕 探月」场景预设 → 进入任务面板（同时预加载地球侧模型 + 发射前预览）
const entered = await evaluate(`(() => {
  const btn = [...document.querySelectorAll('#sceneButtons button')].find((b) => b.textContent.includes('探月'));
  if (!btn) return { ok: false, why: 'no scenario button' };
  btn.click();
  return { ok: !!window.__moonMission };
})()`);
report.steps.enter = entered;
await sleep(500);

// ② 预加载地球侧模型就绪（rocket/craft）
report.steps.earthModels = await evaluate(`(async () => {
  const m = window.__moonMission;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 120; i++) {
    const st = m.debugState().slots;
    const rocket = st.find((s) => s.key === 'rocket');
    const craft = st.find((s) => s.key === 'craft');
    if (rocket && craft && rocket.ready && craft.ready) return { ok: true, waitedMs: i * 250, rocket, craft };
    await sleep(250);
  }
  return { ok: false, slots: m.debugState().slots };
})()`);

// ②b 发射前预览（用户反馈 #2：未发射选场就应转镜头 + 竖火箭）
// 地形高程异步采样后相机贴地：文昌 ~10m → camHeight ~160；酒泉 ~1074m → ~1224
await sleep(2200);
report.steps.previewWenchang = await evaluate(`(() => {
  const v = window.viewer;
  const ent = v.entities.getById('moonMissionRocket');
  const cc = v.camera.positionCartographic;
  return {
    rocketShow: ent ? ent.show : null,
    label: ent && ent.label ? ent.label.text.getValue(Cesium.JulianDate.now()) : null,
    camHeight: Math.round(cc.height),
    camLat: +Cesium.Math.toDegrees(cc.latitude).toFixed(3),
    camLon: +Cesium.Math.toDegrees(cc.longitude).toFixed(3),
  };
})()`);
// 换场：火箭与镜头应搬到酒泉（label 变 + 相机纬度 ~40.96 + 高程贴地 ~1224）
// ⚠ SwiftShader 下瓦片解码+重采样可能超过 2.6s（曾固定等待误报 camHeight=150）：
//   轮询到 camHeight>1000（酒泉海拔 ~1074m 贴地）或超时（2026-10-17 修）
await evaluate(`window.__moonMission.setLaunchSite('jiuquan')`);
report.steps.previewJiuquan = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const v = window.viewer;
  const ent = v.entities.getById('moonMissionRocket');
  let last = null;
  for (let i = 0; i < 48; i++) {
    const cc = v.camera.positionCartographic;
    last = {
      site: window.__moonMission.getLaunchSite(),
      label: ent && ent.label ? ent.label.text.getValue(Cesium.JulianDate.now()) : null,
      camHeight: Math.round(cc.height),
      camLat: +Cesium.Math.toDegrees(cc.latitude).toFixed(3),
      camLon: +Cesium.Math.toDegrees(cc.longitude).toFixed(3),
    };
    if (last.camHeight > 1000) return { ...last, waitedMs: i * 500 };
    await sleep(500);
  }
  return { ...last, timedOut: true };
})()`);
await evaluate(`window.__moonMission.setLaunchSite('wenchang')`);
await sleep(2200);

// ③ 点火 + 第一幕截图（p=5%，上升段，分离尚未开始）
// 时间轴常量从 timeline() 读（2026-10-17：第一幕加长 + 幕内慢放，硬编码进度会失效）
const TL = await evaluate(`(() => {
  const t = window.__moonMission.timeline();
  return { ...t, pAct1: 0.05, pStage: (t.boosterSep + t.fairingSep) / 2,
           pTransfer: (t.card1End + t.transferEnd) / 2, pLoi: (t.card2End + t.loiEnd) / 2,
           pDescent: (t.loiEnd + t.touchEnd) / 2, pAct4: (t.touchEnd + 1) / 2 };
})()`);
report.steps.timeline = TL;
await evaluate(`window.__moonMission.start({ launchSite: 'wenchang', landingSite: 'imbrium' })`);
await sleep(1500);
// 立即暂停：之后所有 seek 都在暂停态测量。
// ⚠ 教训（2026-10-17）：播放态下 CDP evaluate 在 SwiftShader 单次可达数秒，p 漂移 +
//   实体位置读取与渲染帧错位，轨迹采样会采出 179° 假拐点（探针19 暂停态复测 maxTurn 3.4°）。
await evaluate(`(() => { const pb = document.getElementById('tourPause'); if (pb && pb.textContent === '暂停') pb.click(); return document.getElementById('tourPause').textContent; })()`);
await evaluate(`window.__moonMission.seek(${TL.pAct1})`);
await sleep(1200);
report.steps.act1 = await evaluate(`(() => {
  const m = window.__moonMission;
  const rocket = m.debugState().slots.find((s) => s.key === 'rocket');
  const v = window.viewer;
  // 相机应紧跟火箭（lookAt 参考系：position 是局部坐标，这里只看相机是否存在且距离合理）
  return {
    rocket,
    phase: document.getElementById('rocketPhase') ? document.getElementById('rocketPhase').textContent : '',
    progress: document.getElementById('tourProgressText') ? document.getElementById('tourProgressText').textContent : '',
    playing: m.isActive(),
  };
})()`);
const shot1 = await evaluate(`window.__t.snap(window.viewer)`);
writeFileSync('tools/.mission-act1.png', Buffer.from(shot1.split(',')[1], 'base64'));

// ③a 第一幕轨迹平滑性（用户反馈 #3：折线→曲线）：暂停态细采样实体位置算转角
// 平滑重力转弯：maxTurn<6°、相邻转角跳变<2.5°；旧折线会出现 >10° 突兀拐点
report.steps.trajSmooth = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const m = window.__moonMission;
  const ent = window.viewer.entities.getById('moonMissionRocket');
  const liftEnd = m.timeline().liftEnd;
  const N = 30;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    m.seek((i / N) * liftEnd * 0.995);
    await sleep(110);
    pts.push(ent.position.getValue(Cesium.JulianDate.now()));
  }
  const turns = [];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = Cesium.Cartesian3.subtract(pts[i], pts[i-1], new Cesium.Cartesian3());
    const b = Cesium.Cartesian3.subtract(pts[i+1], pts[i], new Cesium.Cartesian3());
    const la = Cesium.Cartesian3.magnitude(a), lb = Cesium.Cartesian3.magnitude(b);
    if (la < 1e-6 || lb < 1e-6) { turns.push(0); continue; }
    const cosv = Math.max(-1, Math.min(1, Cesium.Cartesian3.dot(a, b) / (la * lb)));
    turns.push(Cesium.Math.toDegrees(Math.acos(cosv)));
  }
  let maxJump = 0;
  for (let i = 1; i < turns.length; i++) maxJump = Math.max(maxJump, Math.abs(turns[i] - turns[i-1]));
  return {
    n: pts.length,
    maxTurn: +Math.max(...turns).toFixed(3),
    maxTurnJump: +maxJump.toFixed(3),
    segFirst: +Cesium.Cartesian3.distance(pts[0], pts[1]).toFixed(1),
    segLast: +Cesium.Cartesian3.distance(pts[pts.length-2], pts[pts.length-1]).toFixed(1),
  };
})()`);

// ③b 分离换模型 + 火焰特效 + 分离相位文字 + 暂停粘滞（用户反馈 #1/#3）
// 播放中 CDP evaluate 开销大（SwiftShader 页面单次可达数秒），p 会漂移过界——
// seek 后先暂停再轮询，保证 eval 时 p 恒定（2026-10-17 实测教训）。
// （任务在 ③ 已暂停，这里只条件式点击——多点一次会把 paused 切回 playing）
await evaluate(`window.__moonMission.seek(${TL.pStage}); (() => { const pb = document.getElementById('tourPause'); if (pb.textContent === '暂停') pb.click(); })()`);
await sleep(900);
report.steps.stageSwitch = await evaluate(`(() => {
  const st = window.__moonMission.debugState().slots;
  const pick = (k) => st.find((s) => s.key === k);
  const core = pick('rocketCore'), rocket = pick('rocket'), flame = pick('flame');
  return {
    atProgress: document.getElementById('tourProgressText')?.textContent || '',
    phase: document.getElementById('rocketPhase')?.textContent || '',
    pauseLabel: document.getElementById('tourPause')?.textContent || '',
    coreShown: core ? core.show === true : null,
    coreState: core || null,
    fullRocketHidden: rocket ? rocket.show === false : null,
    flameShown: flame ? flame.show === true : null,
    boosterSlots: st.filter((s) => s.key === 'booster').length,
    navLocked: window.__moonMission.navLocked(),   // 第一幕应为 false（保留右上角控件）
  };
})()`);
// 暂停粘滞：画布 pointerup 不应把播放切回来（2026-10-17 修 onTrackUp 误触发的回归）
report.steps.pauseSticky = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const canvas = window.viewer.scene.canvas;
  const r = canvas.getBoundingClientRect();
  const opt = (x) => ({ bubbles: true, pointerId: 9, clientX: x, clientY: r.top + r.height / 2 });
  canvas.dispatchEvent(new PointerEvent('pointerdown', opt(r.left + 200)));
  window.dispatchEvent(new PointerEvent('pointermove', opt(r.left + 400)));
  window.dispatchEvent(new PointerEvent('pointerup', opt(r.left + 400)));
  await sleep(400);
  const p1 = document.getElementById('tourProgressText').textContent;
  return {
    pauseLabel: document.getElementById('tourPause')?.textContent || '',
    progressAfterCanvasUp: p1,   // 暂停态应保持 pStage 百分比不变
  };
})()`);

// ③e 第二幕（pTransfer）：顶视转移 + 飞船上面级 + 压缩说明可见 + 轨道总览角标（用户反馈 #4）
//     校验：地月虚直线 / 未飞半段虚线 / 行径实线 三个实体都存在且有 ≥2 个点
await evaluate(`window.__moonMission.seek(${TL.pTransfer})`);
await sleep(900);
report.steps.transfer = await evaluate(`(() => {
  const st = window.__moonMission.debugState().slots;
  const craft = st.find((s) => s.key === 'craft');
  const ids = ['moonEmLine', 'moonTransferMirror', 'moonTransferPath', 'moonTransferTrail'];
  const ents = {};
  for (const id of ids) {
    const e = window.viewer.entities.getById(id);
    let n = 0;
    try { n = e.polyline.positions.getValue(Cesium.JulianDate.now()).length; } catch {}
    ents[id] = n;
  }
  // 轨道总览：可见 + 画布非空白
  const oo = document.getElementById('orbitOverview');
  let ooPixels = 0;
  try {
    const cv = document.getElementById('orbitOverviewCanvas');
    const x2 = cv.getContext('2d');
    const px = x2.getImageData(0, 0, cv.width, cv.height).data;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 0) ooPixels++;
  } catch {}
  return {
    craftShown: craft ? craft.show === true : null,
    phase: document.getElementById('rocketPhase')?.textContent || '',
    compressNoteVisible: !document.getElementById('compressNote')?.classList.contains('hidden'),
    entityPoints: ents,
    orbitOverviewVisible: oo ? !oo.classList.contains('hidden') : null,
    orbitOverviewPixels: ooPixels,
    navLocked: window.__moonMission.navLocked(),
  };
})()`);
const shotTransfer = await evaluate(`window.__t.snap(window.viewer)`);
writeFileSync('tools/.mission-act2.png', Buffer.from(shotTransfer.split(',')[1], 'base64'));

// ③c 相机接管：canvas 按下 → override=true；松手 → 静默期后 blend 回归启动
// ⚠ SwiftShader 下每帧渲染可达数秒，固定时长等待不可靠（曾因 4.4s 内 0 帧误报失败）：
//   改为轮询直到 blend>0（上限 40s），「回归启动」才是断言的本意（2026-10-17 修）。
report.steps.camOverride = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const canvas = window.viewer.scene.canvas;
  canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
  await sleep(150);
  const during = window.__moonMission.debugState().cam;
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
  await sleep(500);
  const hold = window.__moonMission.debugState().cam;   // 静默期：override=false、blend=0
  let after = hold, waitedMs = 0;
  for (let i = 0; i < 80 && after.blend <= 0; i++) {     // 轮询到 blend 起来（帧率极慢时给足 40s）
    await sleep(500); waitedMs += 500;
    after = window.__moonMission.debugState().cam;
  }
  return {
    duringOverride: during.override,
    afterOverride: hold.override,
    holdNoBlend: hold.blend === 0,
    blending: after.blend > 0,
    blendValue: after.blend,
    waitedMs,
  };
})()`);

// ③d 时间轴隔离：画布拖动不改进度；只有 #tourTrack 按下才 seek
// （任务在 ③b 已暂停，此处无需再点暂停——多点一次会把 paused 切回 playing）
report.steps.timelineIsolation = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const m = window.__moonMission;
  m.seek(0.05);
  await sleep(150);
  const canvas = window.viewer.scene.canvas;
  const r = canvas.getBoundingClientRect();
  const opts = (x) => ({ bubbles: true, pointerId: 2, clientX: x, clientY: r.top + r.height / 2 });
  canvas.dispatchEvent(new PointerEvent('pointerdown', opts(r.left + 100)));
  window.dispatchEvent(new PointerEvent('pointermove', opts(r.left + 700)));
  window.dispatchEvent(new PointerEvent('pointerup', opts(r.left + 700)));
  await sleep(200);
  const afterCanvasDrag = document.getElementById('tourProgressText').textContent;
  // 时间轴按下 → 应 seek 到按下位置（~50%）
  const track = document.getElementById('tourTrack');
  const tr = track.getBoundingClientRect();
  track.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 3, clientX: tr.left + tr.width * 0.5, clientY: tr.top + 4 }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 3 }));
  await sleep(200);
  const afterTrackDown = document.getElementById('tourProgressText').textContent;
  return { afterCanvasDrag, afterTrackDown, canvasDragNoSeek: afterCanvasDrag === '5%', trackSeeks: Math.abs(parseFloat(afterTrackDown) - 50) <= 2 };
})()`);


// ④ 跳环月制动（pLoi）→ 飞船上面级显示、着陆器隐藏 + 赤道轨道（用户反馈 #5）
await evaluate(`window.__moonMission.seek(${TL.pLoi})`);
await sleep(900);
report.steps.loi = await evaluate(`(() => {
  const st = window.__moonMission.debugState().slots;
  const pick = (k) => st.find((s) => s.key === k);
  const loi = pick('loiCraft'), lander = pick('lander');
  // 赤道轨道： craft lat≈0、环月轨环（moonLoiOrbit）lat=0
  let craftLat = null, ringLat = null;
  try {
    const mv = window.__getMoonViewer && window.__getMoonViewer();
    const mc = mv && mv.entities.getById('moonMissionCraft');
    const pos = mc && mc.position.getValue(Cesium.JulianDate.now());
    if (pos) craftLat = +Cesium.Math.toDegrees(Cesium.Cartographic.fromCartesian(pos, mv.scene.globe.ellipsoid).latitude).toFixed(3);
    const ring = mv && mv.entities.getById('moonLoiOrbit');
    const rp = ring && ring.polyline.positions.getValue(Cesium.JulianDate.now());
    if (rp && rp.length) ringLat = +Cesium.Math.toDegrees(Cesium.Cartographic.fromCartesian(rp[Math.floor(rp.length/2)], mv.scene.globe.ellipsoid).latitude).toFixed(3);
  } catch {}
  return {
    phase: document.getElementById('rocketPhase')?.textContent || '',
    loiCraftShown: loi ? loi.show === true : null,
    landerHidden: lander ? lander.show === false : null,
    craftLat, ringLat,
    navLocked: window.__moonMission.navLocked(),
  };
})()`);
// ④a 动力下降（pDescent）：纬度沿子午线推进 + 相机 260 万 m（用户反馈 #5）
await evaluate(`window.__moonMission.seek(${TL.pDescent})`);
await sleep(900);
report.steps.descent = await evaluate(`(() => {
  const st = window.__moonMission.debugState().slots;
  const pick = (k) => st.find((s) => s.key === k);
  const loi = pick('loiCraft'), lander = pick('lander');
  // flame 槽位按 viewer 各一份（earth/moon）；这里要的是月球 viewer 的（数组靠后的那个）
  const flames = st.filter((s) => s.key === 'flame').map((s) => s.show === true);
  let craftLat = null, craftLon = null, camRange = null;
  try {
    const mv = window.__getMoonViewer && window.__getMoonViewer();
    const mc = mv && mv.entities.getById('moonMissionCraft');
    const pos = mc && mc.position.getValue(Cesium.JulianDate.now());
    if (pos) {
      const o = Cesium.Cartographic.fromCartesian(pos, mv.scene.globe.ellipsoid);
      craftLat = +Cesium.Math.toDegrees(o.latitude).toFixed(2);
      craftLon = +Cesium.Math.toDegrees(o.longitude).toFixed(2);
      camRange = Math.round(Cesium.Cartesian3.distance(mv.camera.positionWC, pos));
    }
  } catch {}
  return {
    phase: document.getElementById('rocketPhase')?.textContent || '',
    landerShown: lander ? lander.show === true : null,
    loiCraftHidden: loi ? loi.show === false : null,
    landingFlameShown: flames.length > 1 ? flames[flames.length - 1] : flames[0] ?? null,
    flameSlots: flames,
    craftLat, craftLon, camRange,
  };
})()`);
report.steps.descentPixel = await evaluate(`window.__t.centerPixel(window.__getMoonViewer && window.__getMoonViewer())`);

// ④b 跳第四幕（p=0.95，巡视中段）→ 月球侧模型就绪 + rover 动画激活
// 兜底：p 会随播放推进到 1（约 6s），若模型就绪时 tick 已停（animOn 未置位），
//       再 seek 一次强制 render 补挂动画（seekTo 内部必跑 render）。
await evaluate(`window.__moonMission.seek(${TL.pAct4})`);
report.steps.act4 = await evaluate(`(async () => {
  const m = window.__moonMission;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pick = (st, k) => st.find((s) => s.key === k);
  for (let i = 0; i < 160; i++) {
    const st = m.debugState().slots;
    const lander = pick(st, 'lander'), rover = pick(st, 'rover');
    if (lander && rover && lander.ready && rover.ready) {
      if (rover.animOn) return { ok: true, waitedMs: i * 250, lander, rover };
      if (i > 24) { m.seek(${TL.pAct4} + 0.01); }   // 已就绪但动画没挂上：强制一次 render
    }
    await sleep(250);
  }
  return { ok: false, slots: m.debugState().slots };
})()`);
await sleep(800);
// ④c 玉兔路线：车辙点数随进度增长、行驶方向（航向）与「向东偏南」一致
report.steps.roverPath = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const m = window.__moonMission;
  const mv = window.__getMoonViewer && window.__getMoonViewer();
  const track = () => {
    const e = mv && mv.entities.getById('moonRoverTrack');
    try { return e.polyline.positions.getValue(Cesium.JulianDate.now()).length; } catch { return 0; }
  };
  m.seek(${TL.pAct4} - 0.02);
  await sleep(400);
  const n1 = track();
  m.seek(${TL.pAct4} + 0.03);
  await sleep(400);
  const n2 = track();
  // 行进方向：取月球车实体位置与落点的经纬度差
  const mc = mv && mv.entities.getById('moonMissionCraft');
  const pos = mc && mc.position.getValue(Cesium.JulianDate.now());
  const c = pos ? Cesium.Cartographic.fromCartesian(pos, new Cesium.Ellipsoid(1737400, 1737400, 1737400)) : null;
  return {
    trackGrew: n2 > n1, n1, n2,
    roverLon: c ? +Cesium.Math.toDegrees(c.longitude).toFixed(5) : null,
    roverLat: c ? +Cesium.Math.toDegrees(c.latitude).toFixed(5) : null,
  };
})()`);
// ④d 玉兔驶离着陆器 + 车头朝向=行进方向（用户反馈 #6：非螃蟹车）
// 行程 = 车辙首点→当前位置；朝向 = rover 模型 matrix 的 X 轴 vs 两个进度点的位移方向
report.steps.roverDrive = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const m = window.__moonMission;
  const mv = window.__getMoonViewer && window.__getMoonViewer();
  const mc = mv && mv.entities.getById('moonMissionCraft');
  const at = (f) => mc.position.getValue(Cesium.JulianDate.now());
  const startPt = () => {
    const e = mv.entities.getById('moonRoverTrack');
    const ps = e.polyline.positions.getValue(Cesium.JulianDate.now());
    return ps[0];
  };
  const tl = m.timeline();
  const fA = tl.touchEnd + (1 - tl.touchEnd) * 0.30;
  const fB = tl.touchEnd + (1 - tl.touchEnd) * 0.70;
  const fC = tl.touchEnd + (1 - tl.touchEnd) * 0.43;
  m.seek(fA); await sleep(500);
  const pA = at(fA);
  const p0 = startPt();
  m.seek(fB); await sleep(500);
  const pB = at(fB);
  m.seek(fC); await sleep(500);
  const pC = at(fC);
  const roverSlot = m.debugSlots().find((s) => s.key === 'rover');
  const mm = roverSlot && roverSlot.model && roverSlot.model.modelMatrix;
  const fwd = mm ? new Cesium.Cartesian3(mm[0], mm[1], mm[2]) : null;
  const travel = Cesium.Cartesian3.subtract(pB, pA, new Cesium.Cartesian3());
  Cesium.Cartesian3.normalize(travel, travel);
  const dot = fwd ? Cesium.Cartesian3.dot(Cesium.Cartesian3.normalize(fwd, new Cesium.Cartesian3()), travel) : null;
  const s4 = (fC - tl.touchEnd) / (1 - tl.touchEnd);
  return {
    roverReady: !!(roverSlot && roverSlot.ready),
    traveledM: +Cesium.Cartesian3.distance(pC, p0).toFixed(2),
    expectedTravel: +(26 * s4).toFixed(2),
    headingDot: dot === null ? null : +dot.toFixed(4),
  };
})()`);
report.steps.act4Phase = await evaluate(`(() => ({
  phase: document.getElementById('rocketPhase') ? document.getElementById('rocketPhase').textContent : '',
  progress: document.getElementById('tourProgressText') ? document.getElementById('tourProgressText').textContent : '',
}))()`);
report.steps.act4Pixel = await evaluate(`window.__t.centerPixel(window.__getMoonViewer && window.__getMoonViewer())`);
// 月球 viewer 截图：优先 moon viewer 画布（__getMoonViewer 钩子），失败退回整页 CDP 截图
let act4Shot = null;
try {
  act4Shot = await evaluate(`(() => {
    const mv = window.__getMoonViewer && window.__getMoonViewer();
    return mv ? window.__t.snap(mv) : null;
  })()`);
} catch { /* 忽略 */ }
if (act4Shot) {
  writeFileSync('tools/.mission-act4.png', Buffer.from(act4Shot.split(',')[1], 'base64'));
} else {
  try {
    // CDP 的返回值就是 {data} 本身（勿多取 .result——2026-10-17 踩坑）
    const pageShot = await send('Page.captureScreenshot', { format: 'png' });
    if (pageShot?.data) {
      writeFileSync('tools/.mission-act4.png', Buffer.from(pageShot.data, 'base64'));
    }
  } catch { /* 忽略 */ }
}

// ⑤ 收尾：停止任务（含模型销毁），复位
await evaluate(`(() => { try { window.__moonMission.stop(); } catch {} return true; })()`);
await sleep(500);
report.steps.afterStop = await evaluate(`(() => ({
  active: window.__moonMission.isActive(),
  slotsLeft: window.__moonMission.debugState().slots.length,
}))()`);

// ===== 断言汇总（六项用户反馈的回归线）=====
const S = report.steps;
const lum = (px) => px ? (px[0] + px[1] + px[2]) / 3 : 0;
report.checks = {
  noJsErrors: errors.length === 0,
  noConsoleErrors: consoleErrors.length === 0,
  earthModelsReady: S.earthModels.ok === true,
  // A. 暂停粘滞（反馈 #1）
  pauseSticky: S.stageSwitch.pauseLabel === '播放'
    && S.pauseSticky.pauseLabel === '播放'
    && S.pauseSticky.progressAfterCanvasUp === S.stageSwitch.atProgress,
  // B. 发射前预览 + 换场（反馈 #2）
  previewWenchang: S.previewWenchang.rocketShow === true
    && /待发射（文昌）/.test(S.previewWenchang.label || '')
    && S.previewWenchang.camHeight > 100 && S.previewWenchang.camHeight < 300,
  previewJiuquan: /待发射（酒泉）/.test(S.previewJiuquan.label || '')
    && Math.abs(S.previewJiuquan.camLat - 40.96) < 0.2
    && S.previewJiuquan.camHeight > 1000,           // 酒泉海拔 ~1 km，相机必须贴地（不再地下）
  // C. 分离相位文字（反馈 #3）
  sepPhaseText: /四散弹开/.test(S.stageSwitch.phase || ''),
  sepBoostersShown: S.stageSwitch.boosterSlots >= 4,
  // D. 轨迹平滑（反馈 #3）
  trajSmooth: S.trajSmooth.maxTurn < 6 && S.trajSmooth.maxTurnJump < 2.5
    && S.trajSmooth.segLast > S.trajSmooth.segFirst,   // 加速上升
  // E. 轨道总览（反馈 #4）
  orbitOverview: S.transfer.orbitOverviewVisible === true && S.transfer.orbitOverviewPixels > 500,
  transferEntities: S.transfer.entityPoints.moonEmLine >= 2
    && S.transfer.entityPoints.moonTransferMirror >= 2
    && S.transfer.entityPoints.moonTransferPath >= 2,
  // F. LOI 赤道轨道（反馈 #5）
  loiEquator: Math.abs(S.loi.craftLat) < 0.5 && Math.abs(S.loi.ringLat) < 0.5,
  // G. 下降段子午线推进 + 260 万 m 机位（反馈 #5）
  descentMeridian: S.descent.craftLat > 0 && S.descent.craftLat < 44.12
    && Math.abs(S.descent.craftLon - (-19.51)) < 1,
  descentCamRange: S.descent.camRange > 2.4e6 && S.descent.camRange < 2.8e6,  // H. 玉兔驶离 + 朝向（反馈 #6）
  roverDrivesAway: S.roverDrive.traveledM > 5
    && Math.abs(S.roverDrive.traveledM - S.roverDrive.expectedTravel) < 1.5,
  roverHeadingDot: S.roverDrive.headingDot > 0.95,
  roverAnimOn: S.act4.ok === true,
  roverTrackGrows: S.roverPath.trackGrew,
  // I. 月面提亮（gamma 1.45 / brightness 1.35）
  moonBrightDescent: lum(S.descentPixel) > 60,
  moonBrightAct4: lum(S.act4Pixel) > 60,
  // 原有步骤回归
  camOverride: S.camOverride.duringOverride === true && S.camOverride.blending === true,
  timelineIsolation: S.timelineIsolation.canvasDragNoSeek === true && S.timelineIsolation.trackSeeks === true,
  stageSwitchModel: S.stageSwitch.coreShown === true && S.stageSwitch.fullRocketHidden === true,
  transferCraft: S.transfer.craftShown === true,
  loiLander: S.loi.loiCraftShown === true && S.loi.landerHidden !== false,   // null=着陆器槽位尚未创建（LOI 段正常），false 才是「显示了」
  descentLander: S.descent.landerShown === true && S.descent.loiCraftHidden === true,
  stopCleanup: S.afterStop.active === false && S.afterStop.slotsLeft === 0,
};

console.log(JSON.stringify(report, null, 1));
const failed = Object.entries(report.checks).filter(([, v]) => !v).map(([k]) => k);
console.log(failed.length ? `FAIL: ${failed.join(', ')}` : 'ALL CHECKS PASSED');
edge.kill();
process.exit(failed.length ? 1 : 0);
