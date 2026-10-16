/**
 * 真实 GIBS 模式下，南极最南瓦片 (z7 y=79 三列 / z5 y=19) 是否成功拉取并填充。
 *   - coverage<1 或 error → 源加载失败（CORS/网络）→ 南极洞在「源加载层」
 *   - coverage=1 且成功 → 源 OK → 南极洞只可能在 Cesium「渲染层」（globe 几何/级联）
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const { default: WebSocket } = await import(`file:///C:/Users/KaishengMao/.workbuddy/binaries/node/workspace/node_modules/ws/index.js`);

const URL = 'http://127.0.0.1:5008/';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9232', '--disable-gpu', '--no-first-run', '--user-data-dir=C:/Users/KaishengMao/AppData/Local/Temp/sphere-gibs-south-profile', 'about:blank'], { stdio: 'ignore', detached: false });
const cleanup = () => { try { edge.kill(); } catch { /* 忽略 */ } };
process.on('exit', cleanup);

const evalProbe = `(async () => {
  const el = document.getElementById('onlineSource');
  el.value = 'gibs';
  el.dispatchEvent(new Event('change'));
  let mgr = null;
  for (let i = 0; i < 24; i++) {
    mgr = window.__imagerySourceMgr;
    if (mgr && mgr.currentId === 'gibs' && mgr.onlineLayer) break;
    await new Promise(r => setTimeout(r, 500));
  }
  if (!mgr || mgr.currentId !== 'gibs' || !mgr.onlineLayer) return { err: 'switch failed', currentId: mgr && mgr.currentId };
  const p = mgr.onlineLayer.imageryProvider;
  const tiles = [[0,79,7],[80,79,7],[159,79,7],[0,19,5],[6,3,2]];
  const out = [];
  for (const [x,y,z] of tiles) {
    try {
      const cv = await p.requestImage(x, y, z);
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      const d = ctx.getImageData(0,0,cv.width,cv.height).data;
      const n = cv.width*cv.height; let opaque=0, sum=0;
      for (let i=0;i<d.length;i+=4){ if(d[i+3]===255){opaque++; sum+=(d[i]+d[i+1]+d[i+2])/3;} }
      out.push({ t:[x,y,z], coverage:+(opaque/n).toFixed(4), mean:+(sum/opaque).toFixed(1) });
    } catch (e) { out.push({ t:[x,y,z], error:String((e&&e.message)||e) }); }
  }
  return { tiles: out };
})()`;

try {
  await sleep(2500);
  const list = await (await fetch('http://127.0.0.1:9232/json/list')).json();
  const page = list.find((t)=>t.type==='page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending=new Map(); const errors=[];
  ws.on('message',(raw)=>{const m=JSON.parse(raw.toString()); if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);} if(m.method==='Runtime.exceptionThrown'){errors.push(m.params.exceptionDetails.text);}});
  await new Promise((res,rej)=>{ws.once('open',res);ws.once('error',rej);});
  const send=(method,params={})=>new Promise((res,rej)=>{const id=Math.floor(Math.random()*1e9);pending.set(id,(m)=>(m.error?rej(new Error(m.error.message)):res(m.result)));ws.send(JSON.stringify({id,method,params}));});
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate',{url:URL}); await sleep(11000);
  const report = await (await send('Runtime.evaluate',{expression:evalProbe,returnByValue:true,awaitPromise:true})).result.value;
  const tiles=(report&&report.tiles)||[];
  const allOk = tiles.length>0 && tiles.every(t=>!t.error && t.coverage>=0.999);
  console.log(JSON.stringify({ allOk, report, errors }, null, 2));
  process.exit(allOk?0:1);
} finally { cleanup(); }
