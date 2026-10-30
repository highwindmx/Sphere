/**
 * 图源设置抽屉端到端冒烟（headless Edge + CDP）
 * 验证：① 面板打开且宽度 ≤40%（地球 ≥60%）② 侧栏控件已迁移（baseMode 进面板）
 *      ③ 优先级 ▲▼ 生效（manager.currentId 跟着变）④ 本地优先开关改变 provider URL
 *      ⑤ 分段下载经 /api/downloader 真实跑通并显示进度 ⑥ 无 JS 异常
 *      ⑩ 回归：按钮文案恒「下载」/ ▲▼ 位于 P 左侧 / 取消排队任务后可再次入队
 *      ⑪ 折叠头「▶ 下载中」实时提示（含地形行）亮绿色 / legend 精简一行
 * 用法：先启动 app.py，再 node tools/source-panel-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
const WS_PATH = 'C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js';
const { default: WebSocket } = await import(`file:///${WS_PATH}`);

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9377;
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
await sleep(22000);

const report = {};

// 开局清理：杀掉上一轮遗留的后台下载进程（node 对 CTRL_BREAK 响应慢时会跨轮残留，
// 占满并发槽导致本轮 ⑤/⑦ 启动即 409，污染全部下载断言）
try {
  await evaluate(`(async () => {
    for (let i = 0; i < 12; i++) {
      await fetch('/api/downloader/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      await new Promise((r) => setTimeout(r, 800));
      const s = await (await fetch('/api/downloader/state')).json();
      if (!(s.jobs || []).some((j) => j.running)) return;
    }
  })()`);
} catch { /* 忽略 */ }

// ① 打开面板
try {
  report.open = await evaluate(`(() => {
    const btn = document.getElementById('btnSourceSettings');
    if (!btn) return { err: 'no entry button' };
    btn.click();
    const p = document.getElementById('sourcePanel');
    const r = p.getBoundingClientRect();
    return {
      hidden: p.classList.contains('hidden'),
      panelW: Math.round(r.width), vw: innerWidth,
      panelPct: Math.round(r.width / innerWidth * 100),
      globePct: Math.round((innerWidth - r.width) / innerWidth * 100),
      rows: document.querySelectorAll('#spSrcList .sp-src').length,
      terrainRow: !!document.querySelector('#spTerrain .sp-src'),
    };
  })()`);
} catch (e) { report.openErr = String(e.message); }

// ② 旧控件已整块移除（2026-10-17）：baseMode/onlineSource/tiandituKey 不应存在
//    且面板顺序 = 影像源列表 → 地形源 → 下载任务
try {
  report.legacyRemoved = await evaluate(`(() => {
    const gone = !document.getElementById('baseMode') && !document.getElementById('onlineSource')
      && !document.getElementById('tiandituKey') && !document.getElementById('sourceControls');
    const body = document.getElementById('sourcePanelBody');
    const kids = [...body.children].map((el) => el.id || el.className);
    const iTerrain = kids.indexOf('spTerrain'), iTask = kids.indexOf('spTask');
    return { gone, terrainBeforeTask: iTerrain >= 0 && iTask >= 0 && iTerrain < iTask, kids };
  })()`);
} catch (e) { report.legacyErr = String(e.message); }

// ③ 优先级调整
try {
  report.reorder = await evaluate(`(() => {
    const before = window.__imagerySourceMgr.currentId;
    const rows = document.querySelectorAll('#spSrcList .sp-src');
    rows[1].querySelector('.btn-up').click();     // 把 P2 提到 P1
    const after = window.__imagerySourceMgr.currentId;
    return { before, after, order: window.__sourcePanel.order };
  })()`);
} catch (e) { report.reorderErr = String(e.message); }

// ④ 本地优先切换（关闭 P1 的本地优先 → URL 应变上游直连）
try {
  await sleep(3000);
  report.localFirst = await evaluate(`(() => {
    const row = document.querySelector('#spSrcList .sp-src');
    const cb = row.querySelector('.cb-local');
    const before = window.__imagerySourceMgr.onlineLayer?.imageryProvider?.url
      || window.__imagerySourceMgr.onlineLayer?._imageryProvider?.url || '';
    cb.checked = false; cb.dispatchEvent(new Event('change'));
    const p = window.__imagerySourceMgr.onlineLayer?.imageryProvider
      || window.__imagerySourceMgr.onlineLayer?._imageryProvider;
    const after = p?.url || '';
    cb.checked = true; cb.dispatchEvent(new Event('change'));
    return { before: String(before).slice(0, 60), after: String(after).slice(0, 60) };
  })()`);
} catch (e) { report.localFirstErr = String(e.message); }

// ⑤ 分段下载（骨架 z0–4，esri 已缓存应快速跳过）
try {
  await sleep(2000);
  report.download = await evaluate(`(async () => {
    const row = document.querySelector('#spSrcList .sp-src');
    row.querySelector('button[data-tier="skel"]').click();
    await new Promise((r) => setTimeout(r, 9000));
    const st = await (await fetch('/api/downloader/state')).json();
    return { label: st.label, running: st.running, exitCode: st.exitCode, progress: st.progress };
  })()`);
} catch (e) { report.downloadErr = String(e.message); }

// 面板内进度显示
try {
  report.panelTask = await evaluate(`(() => {
    const box = document.getElementById('spTask');
    return { visible: !box.hidden, txt: document.getElementById('spTaskTxt')?.textContent || '' };
  })()`);
} catch (e) { report.panelTaskErr = String(e.message); }

// ⑥ 高清段拆分：每源「高清（标注点）/ 高清（全部）」两行 + 半径选择器 + 精算张数 + 4×3 表结构
try {
  report.subsets = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#spSrcList .sp-src')];
    const tRow = document.querySelector('#spTerrain .sp-src');
    const all = [...rows, tRow].filter(Boolean);
    const pointsBtns = all.flatMap((r) => [...r.querySelectorAll('button[data-tier="high-p"]')]);
    const fullBtns = all.flatMap((r) => [...r.querySelectorAll('button[data-tier="high-f"]')]);
    const sel = document.getElementById('spRadius');
    return {
      rows: all.length,
      pointsBtns: pointsBtns.length,
      fullBtns: fullBtns.length,
      // 4×3 表：每源 4 行（骨架/低清/高清标注/高清全部）+ 3 列表头
      tierRows: all.reduce((a, r) => a + r.querySelectorAll('table.dl tbody tr').length, 0),
      headers: (all[0]?.querySelectorAll('table.dl thead th').length) || 0,
      // 折叠：默认收起；行内取消按钮存在
      defaultFolded: [...document.querySelectorAll('[data-dlwrap]')].every((w) => !w.classList.contains('open')),
      cancelBtns: document.querySelectorAll('.t-cancel').length,
      radius: sel ? sel.value : null,
      hint: document.getElementById('spPointsHint')?.textContent || '',
      sampleTitle: pointsBtns[0]?.title || '',
      sampleLabel: pointsBtns[0]?.textContent || '',
    };
  })()`);
} catch (e) { report.subsetsErr = String(e.message); }

// ⑦ 标注点子集真实下载（P1 源 z9，量级远小于「全部」）+ 队列防重复点击 + 行内取消
try {
  await sleep(2000);
  report.pointsDownload = await evaluate(`(async () => {
    const row = document.querySelector('#spSrcList .sp-src');
    const btn = row.querySelector('button[data-tier="high-p"]');
    row.querySelector('.act-dl').click();          // 展开该源的下载表
    btn.click();
    btn.click();               // 立刻重复点击 → 应被忽略（防重复）
    btn.click();
    await new Promise((r) => setTimeout(r, 4000));
    const st = await (await fetch('/api/downloader/state')).json();
    const key = btn.dataset.dlkey;                 // 动态 key（P1 可能被 reorder 换成别的源）
    const cell = row.querySelector('[data-act="' + key + '"]');
    return { key, label: st.label, running: st.running, total: st.progress?.total, done: st.progress?.done, fail: st.progress?.fail,
             queueLen: window.__sourcePanel.queueLen, btnTxt: btn.textContent, btnDisabled: btn.disabled,
             cellBusy: cell?.classList.contains('busy'), cellTxt: cell?.querySelector('.t-txt')?.textContent || '',
             cancelVisible: cell ? getComputedStyle(cell.querySelector('.t-cancel')).display !== 'none' : null };
  })()`);
  // 全量对比：z9 全球应为 262144 张，标注点子集必须显著更小
  report.pointsVsFull = { fullZ9: 262144, subset: report.pointsDownload?.total ?? null };
  // 冒烟不真跑完：用该档位行内 ✕ 取消（验证行内取消链路，而非面板级 cancel）
  await evaluate(`(async () => {
    const row = document.querySelector('#spSrcList .sp-src');
    const key = row.querySelector('button[data-tier="high-p"]').dataset.dlkey;
    row.querySelector('[data-cancel="' + key + '"]').click();
    await new Promise((r) => setTimeout(r, 2500));
    return 'cancelled ' + key;
  })()`);
  await sleep(2000);
  report.afterCancel = await evaluate(`(() => {
    const row = document.querySelector('#spSrcList .sp-src');
    const btn = row.querySelector('button[data-tier="high-p"]');
    const cell = row.querySelector('[data-act="' + btn.dataset.dlkey + '"]');
    return { running: window.__sourcePanel.queueLen, btnTxt: btn.textContent, btnDisabled: btn.disabled,
             cellBusy: cell?.classList.contains('busy') };
  })()`);
} catch (e) { report.pointsDownloadErr = String(e.message); }

// ⑧ 档位钳制：GIBS（z0–7）低清应钳成 z5–7 可下载，高清整档禁用
try {
  report.clamp = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#spSrcList .sp-src')];
    const gibs = rows.find((r) => r.dataset.id === 'gibs');
    const trs = [...gibs.querySelectorAll('table.dl tbody tr')];
    const low = trs.find((r) => r.dataset.tier === 'low');
    const high = trs.find((r) => r.dataset.tier === 'high-p');
    return {
      lowZ: low?.querySelector('.t-tier .z')?.textContent || '',
      lowDisabled: !!low?.querySelector('button')?.disabled,
      highZ: high?.querySelector('.t-tier .z')?.textContent || '',
      highDisabled: !!high?.querySelector('button')?.disabled,
      overCell: high?.querySelector('.t-cache')?.textContent || '',
    };
  })()`);
} catch (e) { report.clampErr = String(e.message); }

// ⑨ 合计含高程（影像/高程分项）
try {
  await sleep(1500);
  report.totals = await evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    // 诊断：scan 是 refreshScan 的异步步骤（全盘 ~2.3s），先轮询等它就绪；
    // 同时手动 fetch 一次对比，区分「端点问题」与「页面内 fetch 时序/异常」
    let ready = null;
    for (let i = 0; i < 20; i++) {
      const t = document.getElementById('spTotalTiles')?.textContent || '';
      if (t && t !== '0 张') { ready = t; break; }
      await wait(500);
    }
    let manual = null;
    try {
      const r = await fetch('/api/downloader/scan');
      const txt = await r.text();
      manual = { status: r.status, len: txt.length, head: txt.slice(0, 40) };
    } catch (e) { manual = { err: String(e) }; }
    return {
      tiles: document.getElementById('spTotalTiles')?.textContent || '',
      bytes: document.getElementById('spTotalBytes')?.textContent || '',
      subTiles: document.getElementById('spTotalTilesSub')?.textContent || '',
      subBytes: document.getElementById('spTotalBytesSub')?.textContent || '',
      ready, manual,
    };
  })()`);
} catch (e) { report.totalsErr = String(e.message); }

// ⑩ 2026-10-17 回归：① 高清按钮文案恒「下载」（张数不堆按钮）② ▲▼ 位于 P 标记左侧
//    ③ 取消「排队中」任务后按钮可再次点击入队（修复前 _dlQueued 残留导致被「已在队列中」挡掉）
try {
  await sleep(1500);
  report.regress = await evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const byKey = (k) => document.querySelector('button[data-dlkey="' + k + '"]');
    const rows = [...document.querySelectorAll('#spSrcList .sp-src')];
    const out = {};
    // ① 高清（标注点）按钮文案恒为「下载」；张数在 ②列与悬停提示
    const pbtn = rows[0].querySelector('button[data-tier="high-p"]');
    out.plainLabel = pbtn ? pbtn.textContent : null;
    out.planTitleHas = /张/.test(pbtn?.title || '');
    // ② ▲▼ 在 .sp-top 内且位于 P 标记左侧（DOM 序）
    const top = rows[0].querySelector('.sp-top');
    const up = top.querySelector('.btn-up'), p = top.querySelector('.sp-order');
    out.upBeforeP = !!(up && p && (up.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING));
    out.upInOps = !!rows[0].querySelector('.sp-ops .btn-up');
    // ③ 各源（含地形行）点一次高清（标注点）→ 并发 2 在跑、多出的进前端队列
    const imgRows = [...document.querySelectorAll('#spSrcList .sp-src')];
    const allRows = [...imgRows, document.querySelector('#spTerrain .sp-src')].filter(Boolean);
    for (const r of allRows) {
      const b = r.querySelector('button[data-tier="high-p"]');
      if (b && !b.disabled) b.click();
    }
    await wait(1800);
    const qbtn = document.querySelector('button.tier.dl-queued');
    out.queuedSeen = !!qbtn;
    if (qbtn) {
      const key = qbtn.dataset.dlkey;
      const cell = document.querySelector('[data-act="' + key + '"]');
      cell?.querySelector('[data-cancel="' + key + '"]')?.click();   // 取消排队者
      await wait(900);
      const b1 = byKey(key);
      out.afterCancel = { disabled: b1?.disabled, txt: b1?.textContent, queued: b1?.classList.contains('dl-queued') };
      b1?.click();                                                   // 修复前：此点击被忽略
      await wait(900);
      const b2 = byKey(key);
      out.reclick = { queued: b2?.classList.contains('dl-queued'), active: b2?.classList.contains('dl-active'), disabled: b2?.disabled };
      // 诊断：若既非排队也非下载中，抓状态栏文案 + 后端任务列表，区分「点击没生效」与「起了又秒败」
      if (!out.reclick.queued && !out.reclick.active) {
        out.reclickDiag = {
          status: document.getElementById('status')?.textContent || '',
          queue: window.__sourcePanel.queue,
          jobs: (await (await fetch('/api/downloader/state')).json()).jobs
            .filter((j) => j.running || j.exitCode == null).map((j) => ({ id: j.id, key: j.key, running: j.running, exit: j.exitCode })),
        };
        await wait(1500);
        const b3 = byKey(key);
        out.reclickLate = { queued: b3?.classList.contains('dl-queued'), active: b3?.classList.contains('dl-active'), disabled: b3?.disabled };
      }
    }
    // 清理：行内取消全部 + 面板级兜底，并轮询等待后端任务真正退出
    for (const c of document.querySelectorAll('.t-cancel')) c.click();
    await wait(400);
    await fetch('/api/downloader/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    let still = -1;
    for (let i = 0; i < 10; i++) {
      await wait(1000);
      const s = await (await fetch('/api/downloader/state')).json();
      still = (s.jobs || []).filter((j) => j.running).length;
      if (!still) break;
    }
    // 后端退出 ≠ 前端按钮已复原：finishDl 由下一个轮询 tick（≤1s）驱动，再等一拍
    await wait(1600);
    out.leftover = document.querySelectorAll('button.tier.dl-queued, button.tier.dl-active').length;
    if (out.leftover) {
      out.leftoverDiag = [...document.querySelectorAll('button.tier.dl-queued, button.tier.dl-active')]
        .map((b) => ({ key: b.dataset.dlkey, txt: b.textContent }));
      out.leftoverQueue = window.__sourcePanel.queue;
    }
    out.stillRunning = still;
    return out;
  })()`);
} catch (e) { report.regressErr = String(e.message); }

// ⑪ 折叠头「▶ 下载中」实时提示（含地形行）+ 亮绿色 + legend 精简为一行
try {
  await sleep(1200);
  report.dlSum = await evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    // 起一个地形高清下载（验证地形行折叠头也有下载中提示）
    const tRow = document.querySelector('#spTerrain .sp-src');
    const tBtn = tRow.querySelector('button[data-tier="high-p"]');
    tRow.querySelector('.act-dl').click();
    tBtn.click();
    await wait(1600);
    const sums = [...document.querySelectorAll('[data-dlsum]')].map((el) => ({
      id: el.dataset.dlsum,
      run: el.querySelector('.run')?.textContent || '',
      color: el.querySelector('.run') ? getComputedStyle(el.querySelector('.run')).color : '',
      text: el.textContent,
    }));
    // terrain 任务的 label 应为「AWS Terrarium 高程…」（修复前误显示「Esri 卫星」）
    const st = await (await fetch('/api/downloader/state')).json();
    const tJob = (st.jobs || []).find((j) => j.key === 'terrain|high-p|points' && j.running);
    const terrainLabel = tJob?.label || '';
    // legend 精简：不得含 <br>，且足够短
    const legends = [...document.querySelectorAll('.sp-legend')].map((el) => el.textContent.trim());
    const note = document.querySelector('.sp-note')?.textContent.trim() || '';
    // 清理：行内取消全部 + 面板级兜底，并轮询等待后端任务真正退出（页面随后即关闭，
    // 取消请求若没等完会被卸载中断 → 遗留进程占并发槽，污染下一轮冒烟）
    for (const c of document.querySelectorAll('.t-cancel')) c.click();
    await wait(400);
    await fetch('/api/downloader/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    let stillRunning = -1;
    for (let i = 0; i < 10; i++) {
      await wait(1000);
      const s = await (await fetch('/api/downloader/state')).json();
      stillRunning = (s.jobs || []).filter((j) => j.running).length;
      if (!stillRunning) break;
    }
    return { sums, terrainLabel, legends, note, legendBr: document.querySelectorAll('.sp-legend br').length,
             noteBr: document.querySelectorAll('.sp-note br').length, stillRunning };
  })()`);
} catch (e) { report.dlSumErr = String(e.message); }

// 截图留档（面板打开状态）
try {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const { writeFileSync } = await import('node:fs');
  writeFileSync('tools/shots/ui/.source-panel.png', Buffer.from(shot.data, 'base64'));
  report.screenshot = 'tools/shots/ui/.source-panel.png';
} catch (e) { report.shotErr = String(e.message); }

report.errors = errors.slice(0, 6);
console.log(JSON.stringify(report, null, 2));
ws.close();
edge.kill();
process.exit(0);
