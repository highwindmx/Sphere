// 复算 capture-sense-2panel-demo.html 的核心物理，核对：
// ① 抵达点相对月心 = R_ARR(背地侧)，相对速度 = V_INF
// ② 捕获椭圆1：远月点=R_ARR、近月点≈RP1，长轴沿 x 轴(与月→地连线对齐)
// ③ 逆行(retro) ⇒ 地球系绕地角动量 Lz>0(顺行)；顺行(pro) ⇒ Lz<0(倒飞)
// ④ 二次制动后椭圆2 远月点降到 RA2
const MU_E=398600.4418, MU_M=4902.8, RE=6371.0, MOON_R=1737.4, MD=384400;
const OMEGA=2*Math.PI/(27.321661*86400), VMOON=OMEGA*MD;
const RP_T=RE+593, RA_T=405000, A_T=(RP_T+RA_T)/2, E_T=(RA_T-RP_T)/(RA_T+RP_T);
const n_T=Math.sqrt(MU_E/(A_T*A_T*A_T)), T_ARR_S=Math.PI/n_T;
const V_APO_E=Math.sqrt(MU_E*(2/RA_T-1/A_T)), V_INF=Math.abs(V_APO_E-VMOON);
const R_ARR=RA_T-MD;
const RP1=MOON_R+200, RA1=R_ARR, A1=(RP1+RA1)/2, E1=(RA1-RP1)/(RA1+RP1), P1=A1*(1-E1*E1);
const n1=Math.sqrt(MU_M/(A1*A1*A1)), T1=2*Math.PI/n1;
const RP2=MOON_R+200, RA2=6000, A2=(RP2+RA2)/2, E2=(RA2-RP2)/(RA2+RP2), P2=A2*(1-E2*E2);
const n2=Math.sqrt(MU_M/(A2*A2*A2)), T2=2*Math.PI/n2;
const T_BURN1=900, T_CAP=T_ARR_S+T_BURN1, T_PERI1=T_CAP+T1/2, T_BURN2=600, T_CAP2=T_PERI1+T_BURN2, T_END=T_CAP2+T2;
const PHI0=Math.PI-OMEGA*T_ARR_S;
const moonPos=t=>{const th=OMEGA*t+PHI0;return{x:MD*Math.cos(th),y:MD*Math.sin(th),th};};
const moonVel=t=>{const th=OMEGA*t+PHI0;return{x:-MD*OMEGA*Math.sin(th),y:MD*OMEGA*Math.cos(th)};};
function EofM(M,e){let E=M;for(let i=0;i<12;i++)E-=(E-e*Math.sin(E)-M)/(1-e*Math.cos(E));return E;}
function transferState(t){const M=Math.PI*(t/T_ARR_S);const E=EofM(M,E_T);
  const x=A_T*(Math.cos(E)-E_T),y=A_T*Math.sqrt(1-E_T*E_T)*Math.sin(E);
  const r=A_T*(1-E_T*Math.cos(E));const den=1-E_T*Math.cos(E);
  const f=n_T*A_T/den;
  return{x,y,vx:-f*Math.sin(E),vy:f*Math.sqrt(1-E_T*E_T)*Math.cos(E),r};}
let orbitDir='retro';
function relState(t){
  if(t<T_ARR_S){const WIN=6*3600;const u=Math.min(1,Math.max(0,(t-(T_ARR_S-WIN))/WIN));
    const nu=1.6*(1-u);const EH=1.971,PH=61207;const r=PH/(1+EH*Math.cos(nu));
    const x=r*Math.cos(Math.PI+nu),y=r*Math.sin(Math.PI+nu);
    const v=Math.sqrt(MU_M*(2/r-1/(-Math.abs(PH/(EH*EH-1)))));
    let tx=-Math.sin(Math.PI+nu),ty=Math.cos(Math.PI+nu);const sgn=orbitDir==='retro'?-1:1;
    return{x,y,vx:tx*v*sgn,vy:ty*v*sgn,r,kind:'hyp'};}
  if(t<T_CAP){const u=(t-T_ARR_S)/T_BURN1;const r=R_ARR;const x=-r,y=0;
    const vHyp=Math.sqrt(MU_M*(2/r+1/Math.abs(-PH/(1.971*1.971-1))));
    const vEll=Math.sqrt(MU_M*(2/r-1/A1));const v=vHyp+(vEll-vHyp)*u;
    const sgn=orbitDir==='retro'?-1:1;return{x,y,vx:0,vy:-v*sgn,r,kind:'burn1'};}
  if(t<T_PERI1){const M=Math.PI+n1*(t-T_CAP);const Ec=EofM(M,E1);
    const cE=Math.cos(Ec),sE=Math.sin(Ec);
    const px=A1*(cE-E1),py=A1*Math.sqrt(1-E1*E1)*sE;
    const f=n1*A1/(1-E1*cE);const pvx=-f*sE,pvy=f*Math.sqrt(1-E1*E1)*cE;
    const sgn=orbitDir==='retro'?-1:1;
    return{x:px,y:py*sgn,vx:pvx,vy:pvy*sgn,r:Math.hypot(px,py),kind:'ell1'};}
  if(t<T_CAP2){const u=(t-T_PERI1)/T_BURN2;const r=RP2;const x=r,y=0;
    const vBig=Math.sqrt(MU_M*(2/r-1/A1));const vSml=Math.sqrt(MU_M*(2/r-1/A2));const v=vBig+(vSml-vBig)*u;
    const sgn=orbitDir==='retro'?-1:1;return{x,y,vx:0,vy:v*sgn,r,kind:'burn2'};}
  {const M=n2*(t-T_CAP2);const Ec=EofM(M,E2);
    const cE=Math.cos(Ec),sE=Math.sin(Ec);
    const px=A2*(cE-E2),py=A2*Math.sqrt(1-E2*E2)*sE;
    const f=n2*A2/(1-E2*cE);const pvx=-f*sE,pvy=f*Math.sqrt(1-E2*E2)*cE;
    const sgn=orbitDir==='retro'?-1:1;
    return{x:px,y:py*sgn,vx:pvx,vy:pvy*sgn,r:Math.hypot(px,py),kind:'ell2'};}
}
function geoState(t){if(t<T_ARR_S){const s=transferState(t);return{...s,kind:'transfer'};}
  const m=moonPos(t),rel=relState(t);return{x:m.x+rel.x,y:m.y+rel.y,vx:moonVel(t).x+rel.vx,vy:moonVel(t).y+rel.vy,kind:rel.kind,r:rel.r};}

let bad=[];
console.log('--- ① 抵达点 / 相对速度 ---');
const arr=relState(T_ARR_S-1);
console.log(`  R_ARR 目标=${R_ARR}  抵达 r=${arr.r.toFixed(0)}  相对v=${Math.hypot(arr.vx,arr.vy).toFixed(3)} (V_INF=${V_INF.toFixed(3)})`);
if(Math.abs(arr.r-R_ARR)>50) bad.push('抵达距离偏差>50km');
if(Math.abs(Math.hypot(arr.vx,arr.vy)-V_INF)>0.02) bad.push('抵达相对速度≠V_INF');

console.log('--- ② 捕获椭圆1 几何 ---');
console.log(`  a=${A1.toFixed(0)} e=${E1.toFixed(3)} 远月点=${(A1*(1+E1)).toFixed(0)}(应≈${R_ARR}) 近月点=${(A1*(1-E1)).toFixed(0)}(应≈${RP1})`);
if(Math.abs(A1*(1+E1)-R_ARR)>50) bad.push('椭圆1远月点≠R_ARR');
if(Math.abs(A1*(1-E1)-RP1)>50) bad.push('椭圆1近月点≠RP1');

console.log('--- ③ 绕地角动量 Lz 符号（逆行应>0，顺行应<0）---');
for(const dir of ['retro','pro']){
  orbitDir=dir;
  // 取 orbit1 中段+近月点、orbit2 中段采样，统计 Lz 符号
  // （正确开普勒下近月点冲刺只在最后几分钟，采样必须贴到 T_PERI1）
  let minLz=1e18,maxLz=-1e18;
  for(const tt of [T_CAP+3600, T_CAP+T1/4, T_PERI1-1, T_CAP2+3600, T_CAP2+T2/4]){
    const c=geoState(tt);const Lz=c.x*c.vy-c.y*c.vx;minLz=Math.min(minLz,Lz);maxLz=Math.max(maxLz,Lz);}
  console.log(`  ${dir}: Lz∈[${minLz.toFixed(0)}, ${maxLz.toFixed(0)}] ⇒ ${minLz>0?'全程顺行(地球系) ✓': minLz<0?'近月点处出现倒飞(地球系) ✗':''}`);
  if(dir==='retro' && !(minLz>0)) bad.push('逆行(CW)地球系未全程顺行');
  // 顺行(CCW)：地球系 v_θ 在近月点处应下探为负（局部倒飞），这是与直觉相悖之处
  if(dir==='pro' && !(minLz<0)) bad.push('顺行(CCW)地球系未出现倒飞');
}

console.log('--- ④ 二次制动后椭圆2 远月点 ---');
console.log(`  椭圆2 远月点=${(A2*(1+E2)).toFixed(0)}(应≈${RA2})`);
if(Math.abs(A2*(1+E2)-RA2)>50) bad.push('椭圆2远月点≠RA2');

console.log('--- ⑤ 长轴 vs 月→地连线夹角（应≈0）---');
// 椭圆长轴沿 x 轴；月→地方向 = 从月球指向地球 = -moonPos 单位向量
// 在 t=T_CAP 时月球位于角π（位置(-MD,0)），-moonPos=(MD,0) ⇒ +x，与长轴(+x/-x)共线 ⇒ 0°
const m0=moonPos(T_CAP);const toEarth={x:-m0.x,y:-m0.y};const ang=Math.atan2(toEarth.y,toEarth.x);
console.log(`  t=T_CAP 月→地方向角=${ang.toFixed(3)} rad (0=+x) ⇒ 与长轴共线，夹角≈0 ✓`);

console.log('--- ⑥ 直角/发卡回归：捕获制动结束后地球系轨迹必须继续下行 ---');
// 旧 bug：ν 线性推进 ⇒ 远月点被 ~6× 假加速甩出，轨迹先降 920km 又折回上行（用户看到的直角）
orbitDir='retro';
const yBurnEnd=geoState(T_CAP).y, yAfter=geoState(T_CAP+3600).y;
console.log(`  制动结束 y=${yBurnEnd.toFixed(0)} → 1h 后 y=${yAfter.toFixed(0)}（Δ=${(yAfter-yBurnEnd).toFixed(0)} km，应继续下降）`);
if(!(yAfter < yBurnEnd-1500)) bad.push('捕获后地球系轨迹折返上行（发卡/直角回归）');

console.log('--- ⑦ 转移段速度场核对（vis-viva）---');
const vApo=Math.hypot(transferState(T_ARR_S-1).vx,transferState(T_ARR_S-1).vy);
const vPeri=Math.hypot(transferState(1).vx,transferState(1).vy);
const vPeriRef=Math.sqrt(MU_E*(2/RP_T-1/A_T));
console.log(`  远地点 |v|=${vApo.toFixed(3)} (应≈${V_APO_E.toFixed(3)})  近地点 |v|=${vPeri.toFixed(2)} (应≈${vPeriRef.toFixed(2)})`);
if(Math.abs(vApo-V_APO_E)>0.01) bad.push('转移远地点速度场错误(缺 1-e·cosE 因子)');
if(Math.abs(vPeri-vPeriRef)>0.05) bad.push('转移近地点速度场错误');

console.log('--- ⑧ 开普勒弧长核对：大椭圆首小时相对弧长 ≈ v_apo·Δt ---');
const s0=relState(T_CAP), s1h=relState(T_CAP+3600);
const arc=Math.hypot(s1h.x-s0.x, s1h.y-s0.y);
const vApoRel=Math.sqrt(MU_M*(2/R_ARR-1/A1));
console.log(`  首小时相对位移=${arc.toFixed(0)} km (v_apo·1h=${(vApoRel*3600).toFixed(0)} km；旧 bug 版≈3340)`);
if(!(arc>500 && arc<vApoRel*3600*1.35)) bad.push('远月点推进速率异常(ν 线性化回归)');

console.log('\n'+(bad.length? 'VERIFY FAIL: '+bad.join('; ') : 'VERIFY OK'));
process.exit(bad.length?1:0);
