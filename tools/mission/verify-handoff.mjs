// 独立复算：地月转移段末 与 捕获段初 在衔接点(会合点)的速度方向
// 用与 src/rocket.js 完全相同的公式，数值微分，不依赖任何记忆/注释结论。
// 基向量取最简右手系（夹角与旋转无关）：
const e1 = [1, 0, 0], e2 = [0, 1, 0], nrm = [0, 0, 1];

function sub(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function add(a, b) { return [a[0]+b[0], a[1]+b[1], a[2]+b[2]]; }
function scale(a, k) { return [a[0]*k, a[1]*k, a[2]*k]; }
function neg(a) { return [-a[0], -a[1], -a[2]]; }
function dot(a, b) { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
function cross(a, b) {
  return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
}
function len(a) { return Math.hypot(a[0],a[1],a[2]); }
function norm(a) { const l = len(a)||1; return [a[0]/l, a[1]/l, a[2]/l]; }

function keplerE(M, e) {
  let E = M;
  for (let i=0;i<200;i++){ const d=(E-e*Math.sin(E)-M)/(1-e*Math.cos(E)); E-=d; if(Math.abs(d)<1e-12) break; }
  return E;
}
function ellipseKM(aKm, eK, M) {
  const E = keplerE(M, eK);
  const r = aKm*(1-eK*Math.cos(E));
  const nu = Math.atan2(Math.sqrt(1-eK*eK)*Math.sin(E), Math.cos(E)-eK);
  return [r*Math.cos(nu), r*Math.sin(nu)]; // [沿 d1, 沿 d2]
}

// ---- 常量（与 rocket.js 一致）----
const EM = { rE:6378.137, moonDist:384400, moonR:1737.4, moonPeriod:27.321661 };
EM.rp = EM.rE + 593; EM.ra = 405000;
EM.a = (EM.rp+EM.ra)/2; EM.e = (EM.ra-EM.rp)/(EM.ra+EM.rp);
const CH_CAPTURE = [ {rp:200,ra:18862,laps:0.5,per:12}, {rp:211,ra:8500,laps:2,per:12}, {rp:200,ra:1729,laps:4,per:3.5}, {rp:195,ra:195,laps:1,per:127/60} ];
function prepOrbits(list, baseR, scale){
  return list.map(o=>{ const rp=baseR+o.rp*scale, ra=baseR+o.ra*scale; return {rp,ra,a:(rp+ra)/2,e:(ra-rp)/(ra+rp),laps:o.laps,per:o.per}; });
}
const CA = prepOrbits(CH_CAPTURE, EM.moonR, 1);
EM.encR = EM.moonDist + CA[0].ra;
{
  const E = Math.acos(Math.max(-1,Math.min(1,(1-EM.encR/EM.a)/EM.e)));
  EM.Menc = E - EM.e*Math.sin(E);
  EM.nuEnc = Math.atan2(Math.sqrt(1-EM.e*EM.e)*Math.sin(E), Math.cos(E)-EM.e);
  if (EM.nuEnc<0) EM.nuEnc += Math.PI*2;
}
const CH_H = { phasing:7*24, transfer:114, capture: CH_CAPTURE.reduce((s,o)=>s+o.laps*o.per,0) }; // 仅比例需要
const CH_TOTAL_H = CH_H.phasing+CH_H.transfer+CH_H.capture;
const CH_TPH = CH_H.phasing+CH_H.transfer;
const P2 = { phasingEnd: CH_H.phasing/CH_TOTAL_H, enc: CH_TPH/CH_TOTAL_H };
EM.moonC = EM.moonDist;
EM.moonOmega = (2*Math.PI)/(EM.moonPeriod*86400);
EM.moonThetaEnc = EM.nuEnc;

function moonDirAt(s){
  const ang = EM.moonThetaEnc + EM.moonOmega*(CH_TOTAL_H*Math.min(Math.max(s,0),1)-CH_TPH)*3600;
  // 绕 nrm 正角旋转 e1（右手系，与 Cesium fromAxisAngle 同义）
  const c=Math.cos(ang), si=Math.sin(ang);
  // 旋转轴 nrm=z：R(e1)= (cos*e1x - sin*e1y, sin*e1x + cos*e1y, e1z) = (cos, sin, 0)
  return [c, si, 0];
}
function moonCartAt(s){ return scale(moonDirAt(s), EM.moonC*1000); }

function transferENorm(s01){ return keplerE(EM.Menc*Math.min(Math.max(s01,0),1), EM.e)/(Math.PI*2); }
function transferCartAt(s){
  const eN = transferENorm(s);
  const E = Math.PI*2*eN;
  const r = EM.a*(1-EM.e*Math.cos(E));
  const nu = Math.atan2(Math.sqrt(1-EM.e*EM.e)*Math.sin(E), Math.cos(E)-EM.e);
  return add(scale(e1, r*1000*Math.cos(nu)), scale(e2, r*1000*Math.sin(nu)));
}

let CAP_FLIP_Y = 1;
function captureBasis(){
  const rhat = moonDirAt(P2.enc); // 单位向量
  let that = cross(rhat, nrm);
  that = norm(that);
  if (CAP_FLIP_Y<0) that = neg(that);
  return [norm(rhat), that];
}
function captureState(u){
  // 简化：仅取 u01 第一段 seg0
  const u01=Math.min(Math.max(u,0),1);
  const h=u01*CH_H.capture;
  let acc=0;
  for(let oi=0;oi<CH_CAPTURE.length;oi++){
    const o=CH_CAPTURE[oi]; const segH=o.laps*o.per;
    if(h<acc+segH || oi===CH_CAPTURE.length-1){
      const segU=Math.min(Math.max((h-acc)/segH,0),1);
      return {oi,segU};
    }
    acc+=segH;
  }
  return {oi:0,segU:1};
}
function captureCartAt(u, orbits=CA){
  const u01=Math.min(Math.max(u,0),1);
  const {oi,segU}=captureState(u01);
  const o=orbits[oi]; const seg=CH_CAPTURE[oi];
  const s=P2.enc+(1-P2.enc)*u01;
  const mc=moonCartAt(s);
  const [rhat,that]=captureBasis();
  const d1=neg(rhat), d2=neg(that);
  const M=(oi===0?Math.PI:0)+Math.PI*2*segU*seg.laps;
  const [px,py]=ellipseKM(o.a,o.e,M);
  return add(mc, add(scale(d1,px*1000), scale(d2,py*1000)));
}

function vel(fn, x, h=1e-6){
  const a=fn(x-h), b=fn(x+h);
  return norm(sub(b,a));
}
function angleBetween(a,b){
  const d=Math.max(-1,Math.min(1,dot(norm(a),norm(b))));
  return Math.acos(d)*180/Math.PI;
}

function report(label){
  const transV = vel(transferCartAt, 0.999);              // 转移段末（绝对，地心系）
  const capAbsV = vel((u)=>captureCartAt(u), 0.002);       // 捕获段初（绝对）
  // 捕获相对月球速度：去掉月心平移
  const capRelV = (()=>{ const f=(u)=>{ const c=captureCartAt(u); return sub(c, moonCartAt(P2.enc+(1-P2.enc)*u)); }; return vel(f,0.002); })();
  console.log(`\n=== CAP_FLIP_Y = ${CAP_FLIP_Y} (${label}) ===`);
  console.log('  转移末速度(绝对) dir =', transV.map(v=>v.toFixed(3)).join(', '));
  console.log('  捕获初速度(绝对) dir =', capAbsV.map(v=>v.toFixed(3)).join(', '));
  console.log('  捕获初速度(相对月球) dir =', capRelV.map(v=>v.toFixed(3)).join(', '));
  console.log('  夹角 |转移绝对 − 捕获绝对|      =', angleBetween(transV,capAbsV).toFixed(2), '°');
  console.log('  夹角 |转移绝对 − 捕获相对月球|  =', angleBetween(transV,capRelV).toFixed(2), '°');
  // that 方向
  const [rhat,that]=captureBasis();
  console.log('  rhat(会合方向) =', rhat.map(v=>v.toFixed(3)).join(', '), ' that =', that.map(v=>v.toFixed(3)).join(', '));
}

CAP_FLIP_Y = 1; report('当前默认');
CAP_FLIP_Y = -1; report('翻转版');

// 也打印记忆里提到的 9.7/170.6 可能对应的量：转移相对月球末速度 vs 捕获相对月球初速度
function transferRelCartAt(s){
  return sub(transferCartAt(s), moonCartAt(s));
}
CAP_FLIP_Y=1;
{
  const tRelV = vel(transferRelCartAt, 0.999);
  const cRelV = (()=>{ const f=(u)=>sub(captureCartAt(u), moonCartAt(P2.enc+(1-P2.enc)*u)); return vel(f,0.002); })();
  console.log('\n[对照] 转移段末(相对月球) dir =', tRelV.map(v=>v.toFixed(3)).join(', '));
  console.log('[对照] 转移相对末 − 捕获相对初 夹角 =', angleBetween(tRelV,cRelV).toFixed(2),'° (CAP_FLIP_Y=+1)');
}
CAP_FLIP_Y=-1;
{
  const cRelV = (()=>{ const f=(u)=>sub(captureCartAt(u), moonCartAt(P2.enc+(1-P2.enc)*u)); return vel(f,0.002); })();
  const tRelV = vel(transferRelCartAt, 0.999);
  console.log('[对照] 转移相对末 − 捕获相对初 夹角 =', angleBetween(tRelV,cRelV).toFixed(2),'° (CAP_FLIP_Y=-1)');
}

// 转移段各进度「相对月球速度」方向（屏幕坐标：x≈e1, up≈e2；屏幕 dy=−(e2分量)）
console.log('\n=== 转移段相对月球速度方向（uT, 相对速度[e1,e2]分量, 屏幕上下）===');
const phE = 0.2, en = 0.5023;
for (const p of [0.38,0.42,0.45,0.47,0.49,0.501]) {
  const uT = (p-phE)/(en-phE);
  const rv = (()=>{ const h=1e-4; const f=(x)=>sub(transferCartAt(x), moonCartAt(x)); return norm(sub(f(p+h),f(p-h))); })();
  const up = rv[1] > 0.1 ? '↑上' : rv[1] < -0.1 ? '↓下' : '·横';
  console.log(`  uT=${uT.toFixed(2)}  relVel=(${rv[0].toFixed(3)},${rv[1].toFixed(3)})  屏幕${up}`);
}
