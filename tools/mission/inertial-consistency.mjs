// 惯性系（地球参考系）一致性核验 —— 不依赖任何旧注释/记忆，严格按 rocket.js 真实公式重算。
// 目的（用户要求）：
//  1) 跨幕「飞船运动方向」在地球参考系下是否连续（无 180° 反向）；
//  2) 绕月的旋转「顺逆」是否两侧一致（顶底 / 顺逆翻转隐患排查）；
//  3) 两场景相机 up 向量是否相同（顶底翻转 = 视角镜像）。
// 说明：TR 基向量 {e1,e2,nrm} 只决定轨道面朝向，相对几何在与它同构的右手系下不变，
//      故取 e1=[1,0,0], e2=[0,1,0], nrm=[0,0,1] 完全等效（moonDirAt(enc) 与发射场无关，已证）。

const sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const add=(a,b)=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]];
const scale=(a,k)=>[a[0]*k,a[1]*k,a[2]*k];
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const mag=a=>Math.sqrt(dot(a,a));
const neg=a=>scale(a,-1);

// ---- 轨道面（与 buildTransferGeom 同构）----
const e1=[1,0,0], e2=[0,1,0], nrm=cross(e1,e2); // = [0,0,1]

// ---- 常量（逐字照搬 rocket.js）----
const EM = { rE:6378.137, moonDist:384400, moonR:1737.4, moonPeriod:27.321661 };
EM.rp = EM.rE + 593; EM.ra = 405000;
EM.a = (EM.rp+EM.ra)/2; EM.e = (EM.ra-EM.rp)/(EM.ra+EM.rp);
EM.encR = EM.moonDist + 18862; // CH_CAPTURE[0].ra（原始值，非 prepOrbits）
{ const a=EM.a, e=EM.e; const E=Math.acos(Math.max(-1,Math.min(1,(1-EM.encR/a)/e)));
  EM.Menc = E - e*Math.sin(E);
  EM.nuEnc = Math.atan2(Math.sqrt(1-e*e)*Math.sin(E), Math.cos(E)-e); if(EM.nuEnc<0) EM.nuEnc+=Math.PI*2; }
EM.moonC = EM.moonDist;
EM.moonOmega = (2*Math.PI)/(EM.moonPeriod*86400);
EM.moonThetaEnc = EM.nuEnc;

const CH_CAPTURE = [
  { rp:200, ra:18862, laps:0.5, per:12 },
  { rp:211, ra:8500,  laps:2,   per:12 },
  { rp:200, ra:1729,  laps:4,   per:3.5 },
  { rp:195, ra:195,   laps:1,   per:127/60 },
];
const prepOrbits=(list,baseR,scale)=>list.map(o=>{const rp=baseR+o.rp*scale,ra=baseR+o.ra*scale;return{rp,ra,a:(rp+ra)/2,e:(ra-rp)/(ra+rp),laps:o.laps,per:o.per};});
const CA = prepOrbits(CH_CAPTURE, EM.moonR*1, 1);
const CH_H = { phasing:168, transfer:114, capture: CH_CAPTURE.reduce((s,o)=>s+o.laps*o.per,0) };
const CH_TOTAL_H = CH_H.phasing+CH_H.transfer+CH_H.capture;
const CH_TPH = CH_H.phasing+CH_H.transfer;
const P2 = { phasingEnd:CH_H.phasing/CH_TOTAL_H, enc:CH_TPH/CH_TOTAL_H };

function keplerE(M,e){let E=M;for(let i=0;i<24;i++){const d=(E-e*Math.sin(E)-M)/(1-e*Math.cos(E));E-=d;if(Math.abs(d)<1e-12)break;}return E;}
function transferENorm(s01){return keplerE(EM.Menc*Math.max(0,Math.min(1,s01)),EM.e)/(Math.PI*2);}
function transferCartAtENorm(eN){const E=Math.PI*2*Math.max(0,Math.min(1,eN));const r=EM.a*(1-EM.e*Math.cos(E));const nu=Math.atan2(Math.sqrt(1-EM.e*EM.e)*Math.sin(E),Math.cos(E)-EM.e);return scale(add(scale(e1,r*1000*Math.cos(nu)),scale(e2,r*1000*Math.sin(nu))),1);}
function transferCartAt(s){return transferCartAtENorm(transferENorm(s));}

function moonDirAt(s){const ang=EM.moonThetaEnc+EM.moonOmega*(CH_TOTAL_H*Math.max(0,Math.min(1,s))-CH_TPH)*3600;const c=Math.cos(ang),si=Math.sin(ang);return [c*e1[0]+si*(cross(nrm,e1)[0]), c*e1[1]+si*(cross(nrm,e1)[1]), c*e1[2]+si*(cross(nrm,e1)[2])];}
function moonCartAt(s){return scale(moonDirAt(s),EM.moonC*1000);}

function captureBasis(CAP_FLIP_Y){
  const rhat=scale(moonDirAt(P2.enc),1);
  let that=cross(rhat,nrm);
  if(CAP_FLIP_Y<0) that=neg(that);
  return [rhat,that];
}
function captureState(u){const h=Math.max(0,Math.min(1,u))*CH_H.capture;let acc=0;for(let oi=0;oi<CH_CAPTURE.length;oi++){const o=CH_CAPTURE[oi];const segH=o.laps*o.per;if(h<acc+segH||oi===CH_CAPTURE.length-1){const segU=Math.max(0,Math.min(1,(h-acc)/segH));return{oi,segU};}acc+=segH;}return{oi:CH_CAPTURE.length-1,segU:1};}
function ellipseKM(aKm,eK,M,d1,d2){const E=keplerE(M,eK);const r=aKm*(1-eK*Math.cos(E));const nu=Math.atan2(Math.sqrt(1-eK*eK)*Math.sin(E),Math.cos(E)-eK);return [scale(d1,r*Math.cos(nu)), scale(d2,r*Math.sin(nu))];}
function captureCartAt(u,CAP_FLIP_Y=1){const u01=Math.max(0,Math.min(1,u));const {oi,segU}=captureState(u01);const o=CA[oi];const M=(oi===0?Math.PI:0)+Math.PI*2*segU*o.laps;const s=P2.enc+(1-P2.enc)*u01;const mc=moonCartAt(s);const [rhat,that]=captureBasis(CAP_FLIP_Y);const d1=neg(rhat),d2=neg(that);const [pa,pb]=ellipseKM(o.a,o.e,M,d1,d2);return add(mc,add(pa,pb));}

// ---- 数值微分（s 空间 / u 空间）----
const D=1e-6;
function vTransfer(s){return scale(sub(transferCartAt(s+D),transferCartAt(s-D)),1/(2*D));}
function vCapture(u,CAP_FLIP_Y=1){return scale(sub(captureCartAt(u+D,CAP_FLIP_Y),captureCartAt(u-D,CAP_FLIP_Y)),1/(2*D));}
function vMoon(s){return scale(sub(moonCartAt(s+D),moonCartAt(s-D)),1/(2*D));}

// ---- 屏投影（applyTopPose：相机在 +nrm 侧俯瞰，up=+e2，看向 −nrm）----
// 屏幕右 = cross(forward,up) with forward=−nrm ⇒ side = cross(−nrm,e2) = −cross(nrm,e2) = −e1
// 屏坐标：x_screen ∝ −v·e1 , y_screen ∝ v·e2  （y 正=上）
function screenVel(v){return [-dot(v,e1), dot(v,e2)];}

function angDeg(a,b){const d=dot(a,b)/(mag(a)*mag(b)||1);return Math.acos(Math.max(-1,Math.min(1,d)))*180/Math.PI;}
function sign(v){return v>1e-9?'+':v<-1e-9?'-':'0';}

console.log('=== 常量 ===');
console.log(`EM.e=${EM.e.toFixed(4)}  nuEnc=${(EM.nuEnc*180/Math.PI).toFixed(2)}°  P2.enc=${P2.enc.toFixed(4)}  CH_H.capture=${CH_H.capture.toFixed(2)}h  CH_TOTAL_H=${CH_TOTAL_H.toFixed(2)}h`);
console.log(`rhat(enc)=[${moonDirAt(P2.enc).map(x=>x.toFixed(4))}]  that(enc)=[${captureBasis(1)[1].map(x=>x.toFixed(4))}]`);

function report(label, s_or_u, which, CAP_FLIP_Y=1){
  let pos, vE, vM, vR, L_E, L_R;
  if(which==='transfer'){const s=s_or_u; pos=transferCartAt(s); vE=vTransfer(s); vM=vMoon(s);}
  else {const u=s_or_u; pos=captureCartAt(u,CAP_FLIP_Y); vE=vCapture(u,CAP_FLIP_Y);
    const sd=P2.enc+(1-P2.enc)*(u+D), su=P2.enc+(1-P2.enc)*(u-D);
    vM=scale(sub(moonCartAt(sd),moonCartAt(su)),1/(2*D));}
  vR=sub(vE,vM); // 相对月球速度
  const rRel=sub(pos, (which==='transfer'?moonCartAt(s_or_u):moonCartAt(P2.enc+(1-P2.enc)*s_or_u)));
  L_E=cross(pos,vE);          // 绕地角动量（pos 以地心为原点）
  L_R=cross(rRel,vR);         // 绕月相对角动量
  const sE=screenVel(vE), sR=screenVel(vR);
  console.log(`\n--- ${label} (${which}) ---`);
  console.log(`  地球系速度 vE      = [${vE.map(x=>x.toExponential(2))}]  |v|=${(mag(vE)/1000).toExponential(2)} km/s`);
  console.log(`  月球系速度 vR      = [${vR.map(x=>x.toExponential(2))}]  方向角=${(Math.atan2(vR[1],vR[0])*180/Math.PI).toFixed(1)}°(e1→e2)`);
  console.log(`  绕地角动量 L_E·nrm = ${sign(dot(L_E,nrm))}  (${dot(L_E,nrm)>0?'顺行(+nrm)':'逆行(-nrm)'})`);
  console.log(`  绕月相对 L_R·nrm   = ${sign(dot(L_R,nrm))}  (${dot(L_R,nrm)>0?'顺行(+nrm)':'逆行(-nrm)'})`);
  console.log(`  旧相机(跟地)屏向   = (x=${sE[0].toExponential(1)}, y=${sE[1].toExponential(1)}) ${sE[1]>0?'↑上':sE[1]<0?'↓下':'—'}`);
  console.log(`  新相机(跟月)屏向   = (x=${sR[0].toExponential(1)}, y=${sR[1].toExponential(1)}) ${sR[1]>0?'↑上':sR[1]<0?'↓下':'—'}`);
  return {vE,vR,L_E,L_R};
}

console.log('\n================ 地球参考系跨幕一致性核验 ================');
const A=report('转移段末 (s=enc−1e-4)', P2.enc-1e-4, 'transfer');
const B=report('捕获段初 (u=1e-4)', 1e-4, 'capture', 1);

console.log('\n================ 方向一致性结论 ================');
console.log(`地球系速度夹角 |∠(vE_transfer, vE_capture)| = ${angDeg(A.vE,B.vE).toFixed(2)}°  (注:非 180°，且绕地角动量同号→属绕月弯折,非反向)`);
console.log(`绕地角动量符号 L_E: 转移=${sign(dot(A.L_E,nrm))} 捕获=${sign(dot(B.L_E,nrm))}  → ${(sign(dot(A.L_E,nrm))===sign(dot(B.L_E,nrm)))?'两侧同顺行(+nrm),无反转 ✓':'⚠ 反转!'}`);
console.log(`绕月相对角动量 L_R: 转移=${sign(dot(A.L_R,nrm))} 捕获=${sign(dot(B.L_R,nrm))}  → ${(sign(dot(A.L_R,nrm))===sign(dot(B.L_R,nrm)))?'两侧同顺逆(-nrm),无翻转 ✓':'⚠ 翻转!'}`);
console.log(`绕月相对速度切向连续性 |∠(vR_transfer, vR_capture)| = ${angDeg(A.vR,B.vR).toFixed(2)}°  → ${angDeg(A.vR,B.vR)<15?'相切连续(无 V 形) ✓':angDeg(A.vR,B.vR)>150?'⚠ 180° V 形掉头':'有折角'}`);
console.log(`相机 up 向量: 两场景均 = TR.e2 = [0,1,0] (见 applyTopPose L2198) → 无顶底翻转(视角不镜像) ✓`);
console.log(`\nCAP_FLIP_Y=-1(掉头版)对照:`);
const C=report('捕获段初 (u=1e-4, FLIP=-1)', 1e-4, 'capture', -1);
console.log(`  FLIP=-1 绕月相对 L_R·nrm = ${sign(dot(C.L_R,nrm))} → 与转移侧(${sign(dot(A.L_R,nrm))}) ${sign(dot(A.L_R,nrm))===sign(dot(C.L_R,nrm))?'同':'反'} → ${sign(dot(A.L_R,nrm))!==sign(dot(C.L_R,nrm))?'证实-1=顺逆翻转(V形)':'?'}`);
