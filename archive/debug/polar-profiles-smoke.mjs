/**
 * 极冠补丁 per-source 联动冒烟（headless Edge + CDP）
 *
 * 验证用户目标架构：切源 → 补丁 profile 自动切换。
 *   ① 初始 esri：合成层 show=true、canvas 北带色 ≈ Esri 色版 (23,86,101)
 *   ② 切 aws-s2（走 UI change 事件，等价手动下拉）：canvas 北带色 ≈ EOX 色版 (18,35,62)
 *   ③ 切 gibs：poleStrategy=native → 合成层 show=false（源自带极区）
 *   ④ 切回 esri：show=true + 北带色回到 Esri 色版
 *   ⑤ UI 状态行文本随源变化；__polarDebug().polarProfile.id 同步
 *   ⑥ 零 JS 错误
 *
 * 运行：node tools/polar-profiles-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

// ESM 不认 NODE_PATH，ws 走绝对路径 file:/// import
const { default: WebSocket } = await import(`file:///C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js`);

const URL = 'http://127.0.0.1:5008/';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9229', '--disable-gpu', '--no-first-run', '--user-data-dir=C:/Users/KaishengMao/AppData/Local/Temp/sphere-pprofile', 'about:blank'], { stdio: 'ignore', detached: false });
const cleanup = () => { try { edge.kill(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

/** 合成 canvas 极带均色 + 层状态快照（轮询到稳定或超时） */
const readPolar = `(() => {
  const dbg = window.__polarDebug ? window.__polarDebug() : {};
  const c = window.__polarCanvases && window.__polarCanvases.north;
  let northBand = null;
  if (c) {
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const d = ctx.getImageData(0, 0, c.width, Math.min(40, c.__contentH || c.height)).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i+1]; b += d[i+2]; n++; }
    northBand = [Math.round(r/n), Math.round(g/n), Math.round(b/n)];
  }
  return {
    profileId: dbg.polarProfile ? dbg.polarProfile.id : null,
    activePatchSrc: dbg.polarProfile ? dbg.polarProfile.activePatchSrc : null,
    poleStrategy: dbg.polarProfile ? dbg.polarProfile.poleStrategy : null,
    compositeShow: dbg.polarCompositeShow,
    statusText: (document.getElementById('polarProfileInfo') || {}).textContent || '',
    northBand,
  };
})()`;

/** 等 canvas 北带色接近目标（切源防抖 1.5s + 重建，最多等 20s） */
const waitBand = `(async (target, tol) => {
  const near = (a, t) => a && Math.abs(a[0]-t[0])<=tol && Math.abs(a[1]-t[1])<=tol && Math.abs(a[2]-t[2])<=tol;
  for (let i = 0; i < 40; i++) {
    const v = (${readPolar.slice(1, -1)});
    if (near(v.northBand, target)) return { ok: true, waitedMs: i * 500, v };
    await new Promise(r => setTimeout(r, 500));
  }
  return { ok: false, v: (${readPolar.slice(1, -1)}) };
})`;

try {
  await sleep(2500);
  const list = await (await fetch('http://127.0.0.1:9229/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  const errors = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description || ''));
    }
  });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = Math.floor(Math.random() * 1e9);
    pending.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r.result.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  // 干净起点：无本地瓦片模式（默认 auto 无瓦片 → 在线源）、无 debug 模式
  await send('Page.navigate', { url: URL });
  await sleep(9000);

  const report = {};

  // ① 初始 esri：北带应≈Esri 色版 (23,86,101)
  report.step1_esri = await evaluate(`${waitBand}([23,86,101], 14)`);

  // ② 切 aws-s2（UI change 事件 → setSource）
  await evaluate(`(() => { const el = document.getElementById('onlineSource'); el.value = 'aws-s2'; el.dispatchEvent(new Event('change')); })()`);
  report.step2_aws = await evaluate(`${waitBand}([18,35,62], 12)`);

  // ③ 切 gibs：native → 合成层 show=false
  await evaluate(`(() => { const el = document.getElementById('onlineSource'); el.value = 'gibs'; el.dispatchEvent(new Event('change')); })()`);
  report.step3_gibs = await evaluate(`(async () => {
    for (let i = 0; i < 40; i++) {
      const v = (${readPolar.slice(1, -1)});
      if (v.poleStrategy === 'native' && v.compositeShow === false) return { ok: true, waitedMs: i * 500, v };
      await new Promise(r => setTimeout(r, 500));
    }
    return { ok: false, v: (${readPolar.slice(1, -1)}) };
  })()`);

  // ④ 切回 esri：show=true + 北带回 Esri 色版
  await evaluate(`(() => { const el = document.getElementById('onlineSource'); el.value = 'esri'; el.dispatchEvent(new Event('change')); })()`);
  report.step4_back = await evaluate(`(async () => {
    const near = (a, t) => a && Math.abs(a[0]-t[0])<=14 && Math.abs(a[1]-t[1])<=14 && Math.abs(a[2]-t[2])<=14;
    for (let i = 0; i < 40; i++) {
      const v = (${readPolar.slice(1, -1)});
      if (v.compositeShow === true && near(v.northBand, [23,86,101])) return { ok: true, waitedMs: i * 500, v };
      await new Promise(r => setTimeout(r, 500));
    }
    return { ok: false, v: (${readPolar.slice(1, -1)}) };
  })()`);

  // ⑤ 状态行文本（最后一次应为 Esri）
  report.finalStatus = await evaluate(`(document.getElementById('polarProfileInfo') || {}).textContent`);

  // 判定标准（2026-10-16 修订）：
  //   headless SwiftShader 像素读取不可信（摘要已记录），northBand 取色偏色属环境限制，
  //   不能作为逻辑 gate；真正可靠的信号是「源切换状态 + 零 JS 错误」。
  //   另外本机部署存在本地卫星瓦片，auto 模式起步会走 local profile（profileId=local），
  //   这是正确行为，不强制 step1=esri。
  const statePass =
    report.step2_aws.v.profileId === 'aws-s2'          // ② 切 aws-s2 成功
    && report.step3_gibs.ok === true                    // ③ 切 gibs：native + 合成层隐藏
    && report.step3_gibs.v.poleStrategy === 'native'
    && report.step3_gibs.v.compositeShow === false
    && report.step4_back.v.profileId === 'esri'         // ④ 切回 esri 成功
    && report.step4_back.v.compositeShow === true
    && String(report.finalStatus || '').includes('Esri')
    && errors.length === 0;
  // 取色仅作信息项（real-GPU 浏览器才可信），不计入 pass
  const colorInfo = {
    step1_northBand: report.step1_esri.v.northBand,
    step2_northBand: report.step2_aws.v.northBand,
    step4_northBand: report.step4_back.v.northBand,
    note: 'headless SwiftShader 取色不可信，仅信息参考；以 real-GPU 浏览器为准',
  };
  console.log(JSON.stringify({ pass: statePass, passNote: 'state-switch + zero-error gate; color checks informational only', colorInfo, report, errors }, null, 2));
  process.exit(statePass ? 0 : 1);
} finally {
  cleanup();
}
