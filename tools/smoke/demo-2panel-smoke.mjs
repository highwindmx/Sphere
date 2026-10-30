import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import net from 'node:net'; import { spawn } from 'node:child_process';
const ROOT = 'D:/Share/Scripts/Explore/sphere';
const HTML = path.join(ROOT, 'demos', 'capture-sense-2panel-demo.html');
const PORT = 9341, UDD = path.join(os.tmpdir(), '_smoke2_' + Date.now());
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const edge = spawn(EDGE, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
  '--user-data-dir='+UDD, '--remote-debugging-port='+PORT, '--allow-file-access-from-files',
  'file:///'+HTML.replace(/\\/g,'/')], { stdio:'ignore' });
async function waitPort(ms=20000){ const t0=Date.now();
  while(Date.now()-t0<ms){ const ok=await new Promise(r=>{ const s=net.connect(PORT,'127.0.0.1');
    s.on('connect',()=>{s.destroy();r(true);}); s.on('error',()=>r(false)); });
    if(ok) return true; await new Promise(r=>setTimeout(r,300)); } return false; }
function wsSend(ws,id,method,params){ return new Promise((res,rej)=>{ const onMsg=(ev)=>{ const m=JSON.parse(ev.data);
  if(m.id===id){ ws.removeEventListener('message',onMsg); m.error?rej(new Error(JSON.stringify(m.error))):res(m.result);} };
  ws.addEventListener('message',onMsg); ws.send(JSON.stringify({id,method,params})); }); }
try{
  if(!await waitPort()){ console.log('no port'); process.exit(1); }
  await new Promise(r=>setTimeout(r,1500));
  const list=await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page=list.find(t=>t.type==='page');
  const ws=new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  await wsSend(ws,1,'Runtime.enable',{});
  const r = await wsSend(ws,2,'Runtime.evaluate',{ expression:`(async()=>{
    const H=window.__demo2; if(!H) return 'NO_HOOK';
    const out={};
    // 入射分支：抵达前 2h，相对月球 y 应在“前侧(-y，因月球抵达时速度朝 -y)”
    H.orbitDir='retro'; H.t = H.T_ARR_S - 2*3600;
    const relBefore = H.relState(H.t);
    out.relBeforeY = relBefore.y;          // 期望 <0（前侧）
    out.relBeforeR = relBefore.r;
    // 地球系 Lz 符号
    function Lz(t){ const c=H.geoState(t); return c.x*c.vy - c.y*c.vx; }
    H.t = H.T_CAP + 3600;  out.Lz_retro_orbit1 = Lz(H.t);   // 期望 >0
    H.orbitDir='pro';  H.t = H.T_PERI1 - 600; out.Lz_pro_peri = Lz(H.t);  // 期望 <0（倒飞）
    H.orbitDir='retro';
    // 抵达点相对速度 / 距离
    H.t = H.T_ARR_S - 1; const a=H.relState(H.t);
    out.arrR = a.r; out.arrV = Math.hypot(a.vx,a.vy);
    // 月球贴图检查：把时间设到小椭圆近月点（月球在月心系画布上很大），
    // 等两帧让 rAF 用新 t 重绘，再采样画布中心区域灰度方差。
    // 纯色/纯渐变中心区方差≈0；程序化纹理（撞击坑+噪声+月海）方差明显更高。
    H.t = H.T_CAP2 + 1;
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    out.hudGeo = document.getElementById('hudGeo').innerText.slice(0,40);
    out.hudLun = document.getElementById('hudLun').innerText.slice(0,40);
    const cv=document.getElementById('lun'); const ctx=cv.getContext('2d');
    const w=cv.width,h=cv.height, cx=w/2|0, cy=h/2|0, rad=40;
    const img=ctx.getImageData(cx-rad,cy-rad,rad*2,rad*2).data;
    let s=0,s2=0,n=0;
    for(let i=0;i<img.length;i+=4){ const v=(img[i]+img[i+1]+img[i+2])/3; s+=v; s2+=v*v; n++; }
    out.moonVar = s2/n - (s/n)*(s/n);
    return JSON.stringify(out);
  })()`, returnByValue:true, awaitPromise:true });
  const out = JSON.parse(r.result.value);
  console.log('SMOKE RESULT:', out);
  const bad=[];
  if (out.relBeforeY >= 0) bad.push('入射分支未从前侧(-y)进入 (relBeforeY='+out.relBeforeY+')');
  if (!(out.Lz_retro_orbit1 > 0)) bad.push('retro 地球系未顺行 (Lz='+out.Lz_retro_orbit1+')');
  if (!(out.Lz_pro_peri < 0)) bad.push('pro 地球系近月点未倒飞 (Lz='+out.Lz_pro_peri+')');
  if (Math.abs(out.arrV - 0.841) > 0.02) bad.push('入射相对速度≠0.841 (='+out.arrV+')');
  if (!out.hudGeo || !out.hudLun) bad.push('HUD 未渲染');
  if (!(out.moonVar > 40)) bad.push('月球贴图未呈现表面纹理 (moonVar='+out.moonVar.toFixed(1)+')');
  console.log(bad.length ? 'SMOKE FAIL: '+bad.join('; ') : 'SMOKE OK');
  ws.close();
} catch(e){ console.log('ERR '+e.message); }
finally { try{edge.kill();}catch{} try{fs.rmSync(UDD,{recursive:true,force:true});}catch{} }
process.exit(0);
