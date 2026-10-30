// 4 格 demo 冒烟：语法检查 + headless Edge 载入，抓 console error / pageerror，
// 并校验表格、读数是否被真实填充（不是占位 '—'）。
// 用法：node tools/demo-4panel-smoke.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HTML = path.join(ROOT, 'demos', 'capture-sense-4panel-demo.html');
const src = fs.readFileSync(HTML, 'utf8');
const js = src.match(/<script>([\s\S]*?)<\/script>/)[1];

// ---------- 1) 语法 ----------
const tmpJs = path.join(os.tmpdir(), '_4panel_syntax.js');
fs.writeFileSync(tmpJs, js, 'utf8');
const node = process.execPath;
const chk = await new Promise((res) => {
  const p = spawn(node, ['--check', tmpJs], { stdio: ['ignore', 'pipe', 'pipe'] });
  let o = '', e = '';
  p.stdout.on('data', d => o += d); p.stderr.on('data', d => e += d);
  p.on('close', c => res({ code: c, o, e }));
});
fs.rmSync(tmpJs, { force: true });
console.log('SYNTAX ' + (chk.code === 0 ? 'OK' : 'FAIL\n' + chk.e));
if (chk.code !== 0) process.exit(1);

// ---------- 2) headless Edge ----------
const PORT = 9333;
const UDD = path.join(os.tmpdir(), '_4panel_profile_' + Date.now());
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
if (!fs.existsSync(EDGE)) { console.log('SKIP_BROWSER edge-not-found'); process.exit(0); }

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--user-data-dir=' + UDD, '--remote-debugging-port=' + PORT,
  '--allow-file-access-from-files', 'file:///' + HTML.replace(/\\/g, '/'),
], { stdio: 'ignore' });

async function waitPort(ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ok = await new Promise(r => {
      const s = net.connect(PORT, '127.0.0.1');
      s.on('connect', () => { s.destroy(); r(true); });
      s.on('error', () => r(false));
    });
    if (ok) return true;
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}
async function wsTargets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return await r.json();
}

function wsSend(ws, id, method, params) {
  return new Promise((res, rej) => {
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === id) { ws.removeEventListener('message', onMsg); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

let exitCode = 0;
try {
  if (!await waitPort()) { console.log('SKIP_BROWSER no-devtools-port'); process.exit(0); }
  await new Promise(r => setTimeout(r, 1500));
  const list = await wsTargets();
  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));

  const errs = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push('CONSOLE: ' + JSON.stringify(m.params.args.map(a => a.value ?? a.description)));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errs.push('LOG: ' + m.params.entry.text);
  });
  await wsSend(ws, 1, 'Runtime.enable', {});
  await wsSend(ws, 2, 'Log.enable', {});
  await new Promise(r => setTimeout(r, 2500));

  const probe = await wsSend(ws, 3, 'Runtime.evaluate', {
    expression: `(() => {
      const g=(id)=>document.getElementById(id)?.textContent?.trim()||'';
      return JSON.stringify({
        rows: document.querySelectorAll('#tb tr').length,
        seg0A: document.querySelectorAll('#tb tr')[0]?.children[1]?.textContent?.trim(),
        seg0B: document.querySelectorAll('#tb tr')[0]?.children[2]?.textContent?.trim(),
        negA: g('nA'), negB: g('nB'), dvA: g('dA'), dvB: g('dB'),
        vA: g('vA'), vB: g('vB'), rT: g('rT'), rR: g('rR'), thA: g('thA'), thB: g('thB'),
        energy: document.getElementById('energyBox')?.textContent?.trim()||'',
        canvasInk: (()=>{ const c=document.getElementById('eA'); const x=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
          let n=0; for(let i=0;i<x.length;i+=4){ if(x[i]>60||x[i+1]>60||x[i+2]>60) n++; } return n; })(),
        arcPix: (()=>{ const c=document.getElementById('eA'); const x=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
          let n=0; for(let i=0;i<x.length;i+=4){ const r=x[i],gg=x[i+1],b=x[i+2];
            if(r>95&&r<145&&gg>85&&gg<130&&b>55&&b<100&&gg>r-40) n++; } return n; })(),
        zoomInk: (()=>{ const c=document.getElementById('zA'); if(!c) return 'NO_CANVAS';
          const x=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
          let n=0; for(let i=0;i<x.length;i+=4){ if(x[i]>60||x[i+1]>60||x[i+2]>60) n++; } return n; })(),
        zoomDiff: (()=>{ try { const H=window.__demo4; H.setT(0.5); H.render();
          const grab=(id)=>{ const c=document.getElementById(id); return c.getContext('2d').getImageData(0,0,c.width,c.height).data; };
          const da=grab('zA'), db=grab('zB');
          let diff=0;
          for(let i=0;i<da.length;i+=4){
            if(Math.abs(da[i]-db[i])>25||Math.abs(da[i+1]-db[i+1])>25||Math.abs(da[i+2]-db[i+2])>25) diff++; }
          H.setT(0); H.render();
          return diff; } catch(e){ return 'ERR:'+e.message; } })(),
        vd: (()=>{ const c=document.getElementById('vdC'); if(!c) return 'NO_CANVAS';
          const x=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
          const n={blue:0,orange:0,red:0};
          for(let i=0;i<x.length;i+=4){ const r=x[i],g2=x[i+1],b=x[i+2];
            if(b>170&&g2>95&&g2<180&&r<140) n.blue++;
            else if(r>195&&g2>125&&b<105) n.orange++;
            else if(r>185&&g2>45&&g2<130&&b<105) n.red++; }
          return 'blue='+n.blue+' orange='+n.orange+' red='+n.red; })(),
        capPix: (()=>{ try { const H=window.__demo4;
          // capBar 单元验证：双曲线 0.841 > v_esc(20600)=0.690 → false；已捕获 0.202 < 0.690 → true
          const stub={fillStyle:'',strokeStyle:'',lineWidth:0,font:'',
            fillRect(){},strokeRect(){},beginPath(){},moveTo(){},lineTo(){},closePath(){},fill(){},stroke(){},
            save(){},restore(){},translate(){},rotate(){},fillText(){}};
          const r1=H.capBar(stub,0,0,10,{x:20600,y:0,vx:0,vy:-0.841});
          const r2=H.capBar(stub,0,0,10,{x:20600,y:0,vx:0,vy:-0.202});
          // 像素验证：t=0.3h（远月点火已完成，B[0].t=0）→ mA 底部判据条应为绿
          H.setT(0.3); H.render();
          const c=document.getElementById('mA');
          const d=c.getContext('2d').getImageData(0,c.height-16,c.width,8).data;
          let green=0,red=0;
          for(let i=0;i<d.length;i+=4){ const r=d[i],gg=d[i+1],b=d[i+2];
            if(gg>120&&r<90&&b<130) green++; else if(r>150&&gg<80&&b<80) red++; }
          H.setT(0); H.render();
          return 'hyp='+r1+' cap='+r2+' px='+green+'/'+red; } catch(e){ return 'ERR:'+e.message; } })(),
        autoSlow: (()=>{ try { const H=window.__demo4;
          H.setT(0.1); const atBurn=H.timeScale();      // 远月点火点(B[0].t=0)附近 → 应极慢
          H.setT(2);   const mid=H.timeScale();         // 滑行段 → 1
          H.setT(0); H.render();
          return 'burn='+atBurn+' mid='+mid+' on='+H.autoSlow; } catch(e){ return 'ERR:'+e.message; } })(),
        craftPix: (()=>{ try { const H=window.__demo4; H.setT(0.5); H.render();
          const c=document.getElementById('zA'); const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
          let n=0; for(let i=0;i<d.length;i+=4){ const r=d[i],g2=d[i+1],b=d[i+2];
            if(r>200&&g2>140&&b<110) n++; }   // 飞船填充色 #f0a02a/#c0392b 的暖像素
          H.setT(0); H.render();
          return n; } catch(e){ return 'ERR:'+e.message; } })(),
        zoomFixed: (()=>{ try { const H=window.__demo4; H.setZoomTrack(false); H.setT(6); H.render();
          const c=document.getElementById('zA'); const x=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
          let n=0; for(let i=0;i<x.length;i+=4){ if(x[i]>60||x[i+1]>60||x[i+2]>60) n++; }
          H.setZoomTrack(true); H.setT(0); H.render();
          return n; } catch(e){ return 'ERR:'+e.message; } })(),
        driftPix: (()=>{ try { const H=window.__demo4; H.setT(0.2);
          H.setShowDrift(false); H.render();
          const c=document.getElementById('zA'); const a=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
          H.setShowDrift(true); H.render();
          const b=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
          let n=0; for(let i=0;i<a.length;i+=4){ if(Math.abs(a[i]-b[i])>20||Math.abs(a[i+1]-b[i+1])>20||Math.abs(a[i+2]-b[i+2])>20) n++; }
          H.setT(0); H.render();
          return n; } catch(e){ return 'ERR:'+e.message; } })(),
        entryQ: (()=>{ try { const H=window.__demo4; H.setT(0); H.render();
          return H.lastEntryQ[1].toFixed(1); } catch(e){ return 'ERR:'+e.message; } })(),
      });
    })()`, returnByValue: true,
  });
  const R = JSON.parse(probe.result.value);
  console.log('--- DOM 读数 ---');
  for (const [k, v] of Object.entries(R)) console.log('  ' + k + ' = ' + v);
  console.log('--- 错误 ---');
  console.log(errs.length ? errs.join('\n') : '  (无)');

  const bad = [];
  if (errs.length) bad.push('页面有 JS 错误');
  if (R.rows !== 4) bad.push('表格行数 ' + R.rows + ' ≠ 4');
  if (!R.seg0A || R.seg0A.includes('—')) bad.push('表格未填充');
  if (R.canvasInk < 500) bad.push('eA 画布几乎空白 (ink=' + R.canvasInk + ')');
  if (R.arcPix < 60) bad.push('地球系面板未画出地月转移弧 (arcPix=' + R.arcPix + ')');
  if (!(R.zoomInk > 3000)) bad.push('③ 放大图 zA 画布几乎空白 (zoomInk=' + R.zoomInk + ')');
  const zdiff = parseInt(R.zoomDiff) || 0;
  if (zdiff < 200) bad.push('t=0.5h 时上下两格放大图未见分叉 (zoomDiff=' + zdiff + ')');
  if (String(R.zoomDiff).startsWith('ERR')) bad.push('放大图探针异常: ' + R.zoomDiff);
  const vd = String(R.vd || '');
  const vdn = (k) => parseInt((vd.match(new RegExp(k + '=(\\d+)')) || [])[1]) || 0;
  if (vdn('blue') < 20) bad.push('速度分解图缺少 v_moon 蓝色矢量 (' + vd + ')');
  if (vdn('orange') < 20) bad.push('速度分解图缺少 v_rel 橙色矢量 (' + vd + ')');
  if (vdn('red') < 5) bad.push('速度分解图缺少 v_earth 红色合成矢量 (' + vd + ')');
  if (!R.energy || !R.energy.includes('能量比')) bad.push('能量比框未填充');
  // 捕获判据条：capBar 单元验证（双曲线 false / 已捕获 true）+ t≥0 后像素为绿
  const capM = String(R.capPix || '').match(/hyp=(true|false) cap=(true|false) px=(\d+)\/(\d+)/);
  if (!capM) bad.push('捕获判据条探针异常: ' + R.capPix);
  else {
    if (capM[1] !== 'false') bad.push('双曲线态误判为已捕获 (v_rel=0.841 > v_esc=0.690)');
    if (capM[2] !== 'true') bad.push('已捕获态误判为双曲线 (v_rel=0.202 < v_esc=0.690)');
    if (+capM[3] < 20) bad.push('判据条绿色像素不足 (' + R.capPix + ')');
    if (+capM[4] > 0) bad.push('t=0.3h 判据条不应有红色 (' + R.capPix + ')');
  }
  // 自动慢放：点火点 0.12×，滑行段 1×
  const asM = String(R.autoSlow || '').match(/burn=([\d.]+) mid=([\d.]+) on=(true|false)/);
  if (!asM) bad.push('自动慢放探针异常: ' + R.autoSlow);
  else {
    if (!(+asM[1] < 0.2)) bad.push('远月点火点未极慢放 (timeScale=' + asM[1] + ')');
    if (+asM[2] !== 1) bad.push('滑行段被误慢放 (timeScale=' + asM[2] + ')');
    if (asM[3] !== 'true') bad.push('自动慢放默认未开启');
  }
  // 箭头形飞船（③ 放大图内暖色像素应显著多于实心圆点的 4px 半径≈50px）
  const cp = parseInt(R.craftPix) || 0;
  if (cp < 80) bad.push('③ 放大图内未见箭头形飞船 (craftPix=' + cp + ')');
  if (String(R.capPix).startsWith('ERR')) bad.push('捕获判据条异常: ' + R.capPix);
  // 固定镜头模式：切到「相机静止于 t=0 月心」后放大图仍有充足内容（月球轨迹线＋地球系轨迹）
  const zf = parseInt(R.zoomFixed) || 0;
  if (zf < 1500) bad.push('固定镜头模式放大图内容不足 (zoomFixed=' + R.zoomFixed + ')');
  if (String(R.zoomFixed).startsWith('ERR')) bad.push('固定镜头探针异常: ' + R.zoomFixed);
  // 屏幕位移虚箭头（对地−镜头）：开关切换必须产生可见差异
  const dp = parseInt(R.driftPix) || 0;
  if (dp < 60) bad.push('屏幕位移虚箭头未画出 (driftPix=' + R.driftPix + ')');
  if (String(R.driftPix).startsWith('ERR')) bad.push('虚箭头探针异常: ' + R.driftPix);
  // 入站弧起点必须落在圆心【下方】（用户质疑的「从上往下进入」回归判据，圆心 ZY=180）
  const eq = parseFloat(R.entryQ);
  if (!(eq > 190)) bad.push('入站弧起点未落在圆心下方（「从上往下进入」回归）(entryQ=' + R.entryQ + ')');
  console.log(bad.length ? 'SMOKE FAIL: ' + bad.join('; ') : 'SMOKE OK');
  if (bad.length) exitCode = 1;
  ws.close();
} catch (e) {
  console.log('SMOKE ERROR ' + e.message); exitCode = 1;
} finally {
  try { edge.kill(); } catch {}
  try { fs.rmSync(UDD, { recursive: true, force: true }); } catch {}
}
process.exit(exitCode);
