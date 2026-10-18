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
 *   E. 第二幕嫦娥三段轨道：调相/捕获轨道线 + 三段标注；旧轨道总览小窗已删（ooWidgetGone）
 *   F. LOI 子午线大圆：段中点 craft lat≈-55.88（site.lat-100）；环线经度恒定（过两极大圆）
 *   G. 下降段：同一大圆推进（段中点 lat≈24.12 = site.lat-20）+ 相机 260 万 m
 *   H. 第四幕：玉兔驶离着陆器（行程≈26·s4）+ 车头朝向=行进方向（debugSlotMatrix
 *      computed 第一列 dot>0.95——必须读 computed，读 modelMatrix 只验证了自己的公式）
 *   I. 月面提亮（gamma 1.45/brightness 1.35）：第四幕中心像素亮度 >60（旧版 27）
 * 2026-10-18 相机双模式：canvas 按下 → MANUAL 持久（blend 恒 0 不自动回归）；
 *   点 #tourCamMode → blend>0 平滑回 AUTO（camManualPersist / camResetOnAct 两断言）
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
    // 轨道线可见性扫描（2026-10-18 加）：画布降采样到 W×H，数「浅蓝轨道像素」(#9ec1ff)
    // 直接守护用户反馈「看不到一圈圈椭圆轨道」。navigation 库 DistanceLegend 在手动 render 时
    // 偶发 pickWorldCoordinates 抛错（探针伪影，画布已绘完），逐帧 try/catch 忽略；
    // 脆点：地球 viewer 隐藏时 canvas 会 0 尺寸，先 resize 兜底。
    scanOrbit(viewer) {
      const v = viewer || window.viewer;
      const cv = v.scene.canvas;
      if (cv.width === 0 || cv.height === 0) { try { v.cesiumWidget.resize(); } catch (e) {} }
      if (cv.width === 0 || cv.height === 0) return { zero: true, cvW: cv.width, cvH: cv.height };
      // ⚠ 关键：必须 1:1 取样（不可降采样）。轨道线只有 2.2px 宽，缩放到 400×250 会被
      // 与黑色背景混合冲淡到 #9ec1ff 亮度的 70%，绝对值阈值（b>180/g>150）全部失效
      // ——2026-10-19 真实轨道改大后踩到：轨道明明在画，扫描却报 0。
      const W = Math.min(800, cv.width), H = Math.min(500, cv.height);
      const c2 = document.createElement('canvas'); c2.width = W; c2.height = H;
      const x2 = c2.getContext('2d');
      for (let k = 0; k < 4; k++) {
        try { v.scene.requestRender(); v.scene.render(Cesium.JulianDate.now()); } catch (e) { /* 伪影 */ }
      }
      x2.drawImage(cv, (cv.width - W) / 2, (cv.height - H) / 2, W, H, 0, 0, W, H);
      const d = x2.getImageData(0, 0, W, H).data;
      let blue = 0, orange = 0, nonblack = 0;
      const total = W * H;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        if (r + g + b > 30) nonblack++;
        // 尺度无关判据：轨道/标注线色 #9ec1ff(158,193,255) 与 #bcd6ff(188,214,255) 的
        // 「蓝远高于红、次高于绿」关系，在与黑色按任意比例混合后仍成立（差值同比缩放）
        if (b > 120 && b - r > 45 && b - g > 25) blue++;
        if (r > 165 && g > 85 && g < 185 && b < 150 && (r - b) > 40) orange++;
      }
      return { zero: false, cvW: cv.width, cvH: cv.height, W, H, total, nonblack, blue, orange };
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

// ③e 第二幕（pTransfer）：嫦娥三段轨道（2026-10-18 重做，参考嫦娥一号轨道图）
//     转移椭圆三线 / 调相段+捕获段轨道线 / 三段标注 / 旧轨道总览小窗已删
await evaluate(`window.__moonMission.seek(${TL.pTransfer})`);
await sleep(900);
report.steps.transfer = await evaluate(`(() => {
  const st = window.__moonMission.debugState().slots;
  const craft = st.find((s) => s.key === 'craft');
  const ids = ['moonEmLine', 'moonTransferMirror', 'moonTransferPath', 'moonPhasingOrbits', 'moonCaptureOrbits'];
  const ents = {};
  for (const id of ids) {
    const e = window.viewer.entities.getById(id);
    let n = 0, shown = null;
    try {
      n = e.polyline.positions.getValue(Cesium.JulianDate.now()).length;
      shown = e.show;
    } catch {}
    ents[id] = { n, shown };
  }
  // 三段轨道标注（嫦娥轨道图样式）
  const labels = ['moonPhaseLabel1', 'moonPhaseLabel2', 'moonPhaseLabel3']
    .map((id) => { const e = window.viewer.entities.getById(id); return e ? e.label.text.getValue(Cesium.JulianDate.now()) : null; });
  // 旧轨道总览小窗（用户反馈不喜欢，2026-10-18 删除）——DOM 应不存在
  const ooGone = !document.getElementById('orbitOverview');
  return {
    craftShown: craft ? craft.show === true : null,
    phase: document.getElementById('rocketPhase')?.textContent || '',
    compressNoteVisible: !document.getElementById('compressNote')?.classList.contains('hidden'),
    entityPoints: ents,
    phaseLabels: labels,
    ooWidgetGone: ooGone,
    navLocked: window.__moonMission.navLocked(),
  };
})()`);
const shotTransfer = await evaluate(`window.__t.snap(window.viewer)`);
writeFileSync('tools/.mission-act2.png', Buffer.from(shotTransfer.split(',')[1], 'base64'));

// ③e2 轨道椭圆可见性（用户反馈「看不到一圈圈」）：暂停态 seek 到调相(0.28)/转移(0.45)
// → 扫描画布浅蓝轨道像素；守护 depthFail + 相机距离 + 近地点抬升三项修复不退化。
// ⚠ 必须在 ③c 相机双模式测试之前（那时会进 MANUAL 改机位，取景不再框轨道）。
report.steps.orbitVisible = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const C = window.Cesium, v = window.viewer, m = window.__moonMission;
  // ⚠ SwiftShader 每帧渲染可达数秒，seek 后固定等待会读到「上一幕机位」的画面
  // （实测 900ms 时画布非黑像素只有 6.5k，轮询稳定后才是 23k）。必须轮询到相机静止。
  // ⚠ 两段式等待：① seek 后先强制等 2.6s（SwiftShader 一帧可达数秒，轮询会「假稳定」——
  //    帧没跑完时两次读数相等就误判静止，实测 900ms 时相机还停在上一幕机位）；
  //    ② 再轮询到相机静止。
  const settle = async () => {
    await sleep(2600);
    let prev = -1;
    for (let i = 0; i < 20; i++) {
      await sleep(350);
      const mag = C.Cartesian3.magnitude(v.camera.positionWC);
      if (prev > 0 && Math.abs(mag - prev) < prev * 0.004) return true;
      prev = mag;
    }
    return false;
  };
  const camRange = () => m.debugState().cam.act2RangeKm;
  const out = {};
  m.seek(0.28); out.phasingSettled = await settle();
  out.phasingRangeKm = camRange(); out.phasing = window.__t.scanOrbit(v);
  m.seek(0.45); out.transferSettled = await settle();
  out.transferRangeKm = camRange(); out.transfer = window.__t.scanOrbit(v);
  m.seek(0.56); out.captureSettled = await settle();
  out.captureRangeKm = camRange(); out.capture = window.__t.scanOrbit(v);
  // ⭐ 轨道面基向量必须正交归一（2026-10-19 根因级回归）：旧版 TR.e2 与共享暂存 _tTmp 是
  // 同一个对象，被就地缩放 → 椭圆 y 分量归零退化为直线，用户「看不到一圈圈椭圆」。
  out.basis = m.debugAct2().basis;
  out.e1e2 = m.debugAct2().e1e2;
  return out;
})()`);

// ③c 相机双模式（2026-10-18 重做）：canvas 按下 → override=true 进 MANUAL；
//     MANUAL 持久（blend 恒 0，不再自动回归）；点 #tourCamMode → blend>0 平滑回 AUTO。
// ⚠ SwiftShader 下每帧渲染可达数秒，blend 变化用轮询（上限 40s），勿固定等待。
report.steps.camOverride = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cam = () => window.__moonMission.debugState().cam;
  const canvas = window.viewer.scene.canvas;
  canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
  await sleep(150);
  const during = cam();                                   // override 应立即为 true
  // MANUAL 持久：轮询 ~4s 确认 blend 始终为 0（旧版此期间会自动 blend 回归）
  let persist = { override: during.override, noBlend: true };
  for (let i = 0; i < 8; i++) {
    await sleep(500);
    const c = cam();
    if (c.override !== true || c.blend !== 0) { persist = { override: c.override, noBlend: false, at: c }; break; }
  }
  // 点「🎯 推荐视角」→ 应启动 blend 回 AUTO
  const btn = document.getElementById('tourCamMode');
  btn.click();
  let after = cam(), waitedMs = 0;
  for (let i = 0; i < 80 && after.blend <= 0; i++) {
    await sleep(500); waitedMs += 500;
    after = cam();
  }
  return {
    duringOverride: during.override,
    manualPersist: persist.override === true && persist.noBlend === true,
    resetBlendStarted: after.blend > 0,
    resetOverrideCleared: after.override === false,
    blendValue: after.blend,
    waitedMs,
  };
})()`);

// ③c-2 导航控件绕巡游物（2026-10-18 用户反馈）：第一幕相机 lookAt(火箭)，右上角指南针/缩放的
//   焦点必须是火箭(参考系原点)而非球体表面拾取点。验证 getCameraFocus 返回点高于地表。
//   自包含：先 seek 到第一幕并暂停、等待稳定（无 blend → transform 必为 lookAt(craft)），
//   避开「🎯 推荐视角」重置后的 blend 过渡期（其间 transform 临时置单位阵）。
// ③c-2 导航控件绕巡游物（2026-10-18 用户反馈）：右上角指南针/缩放焦点须为「相机 lookAt 参考系
//   原点(巡游物)」而非球体表面拾取点。headless SwiftShader 下 BLEND_SEC 过渡按帧推进极慢，任务相机
//   常卡在 blend 残留的 IDENTITY，故这里**隔离测试补丁的 lookAt 分支本身**：直接对地球相机设一个
//   高空(500km) lookAt 参考系，调 getCameraFocus 验证返回该原点(而非球面子拾取)，并验证指南针
//   rotateFrame==相机 transform(即绕该点)。测完还原 transform 不污染后续步骤。
report.steps.navFocus = await evaluate(`(async () => {
  const C = window.Cesium; const v = window.viewer;
  const U = (await import('/vendor/cesium-navigation/core/Utils.js')).default;
  const EARTH_R = 6378137;
  // 高空测试点（500km 海拔）：globe.pick 的视线会越过它，若仍返回此点=证明走 lookAt 分支
  const testPt = C.Cartesian3.fromDegrees(10, 20, 500000);
  v.camera.lookAt(testPt, new C.HeadingPitchRange(0, C.Math.toRadians(-30), 2.0e6));
  const focusW = U.getCameraFocus({ scene: v.scene }, true, new C.Cartesian3());
  const out = { focusDefined: !!focusW };
  if (focusW) {
    out.focusMag = +C.Cartesian3.magnitude(focusW).toFixed(1);
    out.distToTest = +C.Cartesian3.distance(focusW, testPt).toFixed(1);
    out.aboveSurface = out.focusMag > EARTH_R + 1000;
    out.returnsOrigin = out.distToTest < 2000;   // 返回 lookAt 原点(巡游物)而非球面子拾取
    const rf = C.Transforms.eastNorthUpToFixedFrame(focusW, v.scene.globe.ellipsoid, new C.Matrix4());
    out.rotateFrameEq = C.Matrix4.equalsEpsilon(rf, v.camera.transform, 1e-6); // 指南针绕该点
  }
  v.camera.lookAtTransform(C.Matrix4.IDENTITY);  // 还原，避免污染后续步骤
  return out;
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


// ④ 跳环月制动（pLoi）→ 飞船上面级显示、着陆器隐藏 + 子午线大圆轨道（2026-10-18 定稿）
//     LOI 段中点 s=0.5：latT = site.lat + lerp(-120,-40,easeIn(0.5)) = 44.12 - 100 = -55.88°
await evaluate(`window.__moonMission.seek(${TL.pLoi})`);
await sleep(900);
report.steps.loi = await evaluate(`(() => {
  const st = window.__moonMission.debugState().slots;
  const pick = (k) => st.find((s) => s.key === k);
  const loi = pick('loiCraft'), lander = pick('lander');
  // 子午线大圆：craft lat≈-55.88、lon≈site.lon(-19.51)；环线所有点 lon ∈ {site.lon, site.lon+180}
  let craftLat = null, craftLon = null, ringLons = null;
  try {
    const mv = window.__getMoonViewer && window.__getMoonViewer();
    const mc = mv && mv.entities.getById('moonMissionCraft');
    const pos = mc && mc.position.getValue(Cesium.JulianDate.now());
    if (pos) {
      const o = Cesium.Cartographic.fromCartesian(pos, mv.scene.globe.ellipsoid);
      craftLat = +Cesium.Math.toDegrees(o.latitude).toFixed(3);
      craftLon = +Cesium.Math.toDegrees(o.longitude).toFixed(3);
    }
    const ring = mv && mv.entities.getById('moonLoiOrbit');
    const rp = ring && ring.polyline.positions.getValue(Cesium.JulianDate.now());
    if (rp && rp.length) {
      ringLons = [];
      for (let i = 0; i < rp.length; i += 24) {
        const c = Cesium.Cartographic.fromCartesian(rp[i], mv.scene.globe.ellipsoid);
        ringLons.push(+Cesium.Math.toDegrees(c.longitude).toFixed(2));
      }
    }
  } catch {}
  // 大圆经度校验：每个采样 lon 都应等于 site.lon(-19.51) 或其背面 wrap(160.49)
  let ringMeridian = null;
  if (ringLons && ringLons.length) {
    ringMeridian = ringLons.every((lon) => Math.abs(lon - (-19.51)) < 0.5 || Math.abs(lon - 160.49) < 0.5);
  }
  return {
    phase: document.getElementById('rocketPhase')?.textContent || '',
    loiCraftShown: loi ? loi.show === true : null,
    landerHidden: lander ? lander.show === false : null,
    craftLat, craftLon,
    ringMeridian, ringLonSamples: ringLons ? ringLons.length : null,
    navLocked: window.__moonMission.navLocked(),
  };
})()`);
// ④a 动力下降（pDescent）：纬度沿同一子午线大圆推进 + 相机 260 万 m（2026-10-18 定稿）
//     下降段中点 s=0.5：latT = site.lat + lerp(-40,0,0.5) = 44.12 - 20 = 24.12°
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
// 下降段中心像素：轮询到提亮生效（lum>60）或超时。
// ⚠ 教训（2026-10-18）：单次采样偶发 <60——seek 后地形/影像还在流式加载，
//   且真实太阳角随日期变化；轮询比固定单次稳（2026-10-17 全绿运行的复现要求）。
report.steps.descentPixel = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const mv = window.__getMoonViewer && window.__getMoonViewer();
  if (!mv) return null;
  let last = null;
  for (let i = 0; i < 24; i++) {
    last = window.__t.centerPixel(mv);
    const lum = (last[0] + last[1] + last[2]) / 3;
    if (lum > 60) return { px: last, lum: +lum.toFixed(1), waitedMs: i * 1000 };
    await sleep(1000);
  }
  return { px: last, lum: +((last[0] + last[1] + last[2]) / 3).toFixed(1), timedOut: true };
})()`);

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
// 行程 = 车辙首点→当前位置；朝向 = rover **computed** 矩阵（modelMatrix×axisCorrection）
// 的第一列（模型 +X=车头 世界朝向）vs 两进度点的位移方向。
// ⚠ 必须读 computed——读 modelMatrix 只验证了自己的公式、没验证 Cesium 轴校正（2026-10-18 教训）。
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
  const mat = m.debugSlotMatrix(/^rover/);
  const computed = mat && mat.computed;
  const fwd = computed ? new Cesium.Cartesian3(computed[0], computed[1], computed[2]) : null;
  const travel = Cesium.Cartesian3.subtract(pB, pA, new Cesium.Cartesian3());
  Cesium.Cartesian3.normalize(travel, travel);
  const dot = fwd ? Cesium.Cartesian3.dot(Cesium.Cartesian3.normalize(fwd, new Cesium.Cartesian3()), travel) : null;
  const s4 = (fC - tl.touchEnd) / (1 - tl.touchEnd);
  return {
    roverReady: !!(mat && mat.ready),
    traveledM: +Cesium.Cartesian3.distance(pC, p0).toFixed(2),
    expectedTravel: +(26 * s4).toFixed(2),
    headingDot: dot === null ? null : +dot.toFixed(4),
  };
})()`);
report.steps.act4Phase = await evaluate(`(() => ({
  phase: document.getElementById('rocketPhase') ? document.getElementById('rocketPhase').textContent : '',
  progress: document.getElementById('tourProgressText') ? document.getElementById('tourProgressText').textContent : '',
}))()`);
// 第四幕中心像素：同样轮询（ rover 行进中相机 blend + 影像流式加载，单次采样偶发低亮度）
report.steps.act4Pixel = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const mv = window.__getMoonViewer && window.__getMoonViewer();
  if (!mv) return null;
  let last = null;
  for (let i = 0; i < 24; i++) {
    last = window.__t.centerPixel(mv);
    const lum = (last[0] + last[1] + last[2]) / 3;
    if (lum > 60) return { px: last, lum: +lum.toFixed(1), waitedMs: i * 1000 };
    await sleep(1000);
  }
  return { px: last, lum: +((last[0] + last[1] + last[2]) / 3).toFixed(1), timedOut: true };
})()`);
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
  // E. 第二幕嫦娥三段轨道 + 旧总览小窗已删（2026-10-18 重做）
  transferPhases: S.transfer.entityPoints.moonPhasingOrbits.n >= 2
    && S.transfer.entityPoints.moonCaptureOrbits.n >= 2
    && S.transfer.entityPoints.moonPhasingOrbits.shown === true
    && S.transfer.entityPoints.moonCaptureOrbits.shown === true
    && /调相段/.test(S.transfer.phaseLabels[0] || '')
    && /地月转移段/.test(S.transfer.phaseLabels[1] || '')
    && /月球捕获段/.test(S.transfer.phaseLabels[2] || ''),
  ooWidgetGone: S.transfer.ooWidgetGone === true,
  // J. 第二幕轨道椭圆可见性（用户反馈「看不到一圈圈」）：调相/转移段画布应出现浅蓝轨道像素
  orbitRingsVisible: !!(S.orbitVisible && S.orbitVisible.phasing && S.orbitVisible.transfer)
    && S.orbitVisible.phasingSettled === true && S.orbitVisible.transferSettled === true
    && S.orbitVisible.phasing.zero !== true && S.orbitVisible.transfer.zero !== true
    // 阈值按「真实椭圆」标定（退化成直线时只有 ~1400 px，真实三椭圆 ~9400 px）
    && S.orbitVisible.phasing.blue > 4000 && S.orbitVisible.transfer.blue > 700
    && S.orbitVisible.capture.blue > 900,
  // J2. 第二幕取景距离（直接断言轨道在画面内，比像素扫描更能定位问题）：
  //     调相 131e3（框三条椭圆）· 转移 393~606e3（框地月）· 捕获 138→60e3（随制动收紧）
  act2Framing: S.orbitVisible.phasingRangeKm >= 100000 && S.orbitVisible.phasingRangeKm <= 200000
    && S.orbitVisible.transferRangeKm >= 330000 && S.orbitVisible.transferRangeKm <= 700000
    && S.orbitVisible.captureRangeKm >= 50000 && S.orbitVisible.captureRangeKm <= 160000,
  // J3. ⭐ 轨道面基向量正交归一（根因守卫）：TR.e2 曾被共享暂存就地缩放，椭圆退化成直线。
  //     这是唯一能挡住该类 bug 复发的断言——像素扫描在退化态下也能通过（直线也有蓝色像素）。
  trBasisUnit: !!S.orbitVisible.basis
    && S.orbitVisible.basis.every((m) => Math.abs(m - 1) < 1e-3)
    && Math.abs(S.orbitVisible.e1e2) < 1e-3,
  transferEntities: S.transfer.entityPoints.moonEmLine.n >= 2
    && S.transfer.entityPoints.moonTransferMirror.n >= 2
    && S.transfer.entityPoints.moonTransferPath.n >= 2,
  // F. LOI 子午线大圆（2026-10-18 定稿）：段中点 latT = 44.12 + lerp(-120,-40,0.25) = -55.88°
  loiMeridian: S.loi.craftLat !== null && Math.abs(S.loi.craftLat - (-55.88)) < 2
    && Math.abs(S.loi.craftLon - (-19.51)) < 0.5,
  ringMeridian: S.loi.ringMeridian === true,
  // G. 下降段同一大圆推进 + 260 万 m 机位：段中点 latT = 44.12 - 20 = 24.12°
  descentMeridian: S.descent.craftLat !== null && Math.abs(S.descent.craftLat - 24.12) < 2
    && Math.abs(S.descent.craftLon - (-19.51)) < 0.5,
  descentCamRange: S.descent.camRange > 2.4e6 && S.descent.camRange < 2.8e6,
  // H. 玉兔驶离 + 朝向（反馈 #6）
  roverDrivesAway: S.roverDrive.traveledM > 5
    && Math.abs(S.roverDrive.traveledM - S.roverDrive.expectedTravel) < 1.5,
  roverHeadingDot: S.roverDrive.headingDot > 0.95,
  roverAnimOn: S.act4.ok === true,
  roverTrackGrows: S.roverPath.trackGrew,
  // I. 月面提亮（gamma 1.45 / brightness 1.35）
  moonBrightDescent: S.descentPixel && S.descentPixel.lum > 60,
  moonBrightAct4: S.act4Pixel && S.act4Pixel.lum > 60,
  // 原有步骤回归
  camManualPersist: S.camOverride.duringOverride === true && S.camOverride.manualPersist === true,
  camResetOnAct: S.camOverride.resetBlendStarted === true && S.camOverride.resetOverrideCleared === true,
  // 导航控件绕巡游物（用户反馈：右上角控件应绕火箭而非球体）：隔离验证 getCameraFocus 在
  // lookAt 参考系下返回原点(巡游物)、指南针 rotateFrame==相机 transform
  navFocusOnCraft: S.navFocus && S.navFocus.focusDefined === true
    && S.navFocus.returnsOrigin === true
    && S.navFocus.rotateFrameEq === true,
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
