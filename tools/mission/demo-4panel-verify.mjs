// 从 demos/capture-sense-4panel-demo.html 原位抽取物理核心（常量 + rk4 + build），
// 在 node 里跑一遍，核对：语法、抵达运动学、顺逆旋向、地球系 v_θ 区间、Δv 预算。
// 用法：node tools/demo-4panel-verify.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HTML = path.join(ROOT, 'demos', 'capture-sense-4panel-demo.html');
const src = fs.readFileSync(HTML, 'utf8');

// 1) 抽出 <script> 内容
const m = src.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('NO_SCRIPT'); process.exit(1); }
const js = m[1];

// 2) 只取物理段：从 const MU_E 到 "const T_END=" 那一行结束
const i0 = js.indexOf('const MU_E=');
const iEnd = js.indexOf('const T_END=');
if (i0 < 0 || iEnd < 0) { console.error('PHYS_SECTION_NOT_FOUND'); process.exit(1); }
const endLine = js.indexOf('\n', iEnd);
const core = js.slice(i0, endLine);

// ③ 放大图的画布/比例参数（从 HTML 原位解析，注入 runner 做取景核对）
const Z_SZ = (js.match(/const sZ=([\d.]+)\/30000/) || [])[1];
const Z_ZK = (js.match(/const ZK=(\d+)/) || [])[1];
const Z_WW = (js.match(/const ZW=(\d+)/) || [])[1];
const Z_ZH = (js.match(/[,\s]ZH=(\d+)/) || [])[1];
const ZWW = +Z_WW, ZZH = +Z_ZH, ZHW = ZWW / 2, ZHH = ZZH / 2;
if (!Z_SZ || !Z_ZK || !Z_WW || !Z_ZH) { console.error('ZOOM_PARAMS_NOT_FOUND'); process.exit(1); }

// 3) 抽出 arrow()（括号计数，防正则跨函数误捕）
const aStart = js.indexOf('function arrow(');
if (aStart < 0) { console.error('ARROW_NOT_FOUND'); process.exit(1); }
let depth = 0, aEnd = -1;
for (let i = aStart; i < js.length; i++) {
  if (js[i] === '{') depth++;
  else if (js[i] === '}') { depth--; if (depth === 0) { aEnd = i + 1; break; } }
}
const arrowSrc = js.slice(aStart, aEnd);

const runner = 'const ARROW_SRC = ' + JSON.stringify(arrowSrc) + ';\n' + core + `
// ---- 报告 ----
function rep(tag, D){
  const th = D.sgn<0 ? '逆行 CW' : '顺行 CCW';
  const burn = D.B.map(b=>b.label+' Δv='+b.dv.toFixed(3)).join(' | ');
  console.log('===== '+tag+' ('+th+') =====');
  console.log('  制动: '+burn);
  console.log('  总Δv='+D.dv.toFixed(3)+' km/s   时长='+D.tEnd.toFixed(2)+' h');
  const rs = D.S.map(s=>Math.hypot(s.x,s.y));
  console.log('  月心距 min='+Math.min(...rs).toFixed(0)+'  max='+Math.max(...rs).toFixed(0)+' km');
  for(let i=0;i<4;i++){
    const o=D.st[i];
    console.log('  ['+SEG_NAME[i]+']  v_θ ∈ ['+o.min.toFixed(3)+', '+o.max.toFixed(3)+']');
  }
  console.log('  宽轨道段(seg0-2) v_θ ∈ ['+D.wMin.toFixed(3)+', '+D.wMax.toFixed(3)+']   倒飞累计='+(D.negW/3600).toFixed(2)+' h  (全程 '+(D.negAll/3600).toFixed(2)+' h)');
  const s0 = D.S[0];
  const Lz = s0.x*s0.vy - s0.y*s0.vx;
  console.log('  绕月角动量 Lz='+Lz.toFixed(0)+' ('+(Lz<0?'顺时针 CW/逆行':'逆时针 CCW/顺行')+')');
}
console.log('常数检查: VMOON='+VMOON.toFixed(4)+' km/s  V_APO='+V_APO.toFixed(4)+'  V_APO-VMOON='+(V_APO-VMOON).toFixed(4)+'  R_ARR='+R_ARR);
console.log('入站双曲线 v_∞≈'+Math.abs(V_APO-VMOON).toFixed(3)+'  首段椭圆 a='+((20600+1937.4)/2).toFixed(1)
  +'  v_apo='+vOn(20600,(20600+1937.4)/2).toFixed(4)+'  v_peri='+vOn(1937.4,(20600+1937.4)/2).toFixed(4));
rep('A', A); rep('C', C);
console.log('T_END='+T_END.toFixed(2)+' h');
console.log('Δv 差 (顺行-逆行) = '+(C.dv-A.dv).toFixed(3)+' km/s');

// ---- 两行入站同一性核对：回答"抵达前到底有没有区别" ----
console.log('--- 两行入站同一性核对（抵达前有无区别）---');
{
  const n=Math.min(A.pre.length, C.pre.length);
  let dMax=0;
  for(let i=0;i<n;i++){ dMax=Math.max(dMax, Math.abs(A.pre[i].x-C.pre[i].x), Math.abs(A.pre[i].y-C.pre[i].y)); }
  console.log('  pre（入站来时路 '+A.pre.length+' 点）逐点最大偏差 = '+dMax.toExponential(2)+' km'
    +'  → '+(dMax<1e-6 ? '两行抵达前【完全相同】✓' : '有差异 ✗'));
  console.log('  t=0 状态: 位置=('+A.S[0].x.toFixed(0)+', '+A.S[0].y.toFixed(0)+') km'
    +'  月系速度=(0, '+(V_APO-VMOON).toFixed(3)+')  两行相同');
  console.log('  唯一分歧点 = 远月点那一次点火的方向:');
  console.log('    逆行: (0,-0.841) → (0,-0.202)  同向减速      Δv='+A.B[0].dv.toFixed(3));
  console.log('    顺行: (0,-0.841) → (0,+0.202)  【反向掉头】   Δv='+C.B[0].dv.toFixed(3));
  console.log('  点火后瞬间地球系速度: 逆行 '+(VMOON+A.S[0].vy).toFixed(3)+'   顺行 '+(VMOON+C.S[0].vy).toFixed(3)+'  km/s');
  // 低成本转移抵达必然比月球慢：固定远地点 405,000，扫近地点
  const vApo=(rp)=>Math.sqrt(MU_E*(2/RA_T-1/((rp+RA_T)/2)));
  let best=0, bestRp=0;
  for(let rp=6971; rp<RA_T; rp+=500){ const v=vApo(rp); if(v>best){ best=v; bestRp=rp; } }
  console.log('  为何入站必然 CW（相对月球后退）: 霍曼转移(rp=593km) 远地点速度仅 '+V_APO.toFixed(3)
    +' << 月球公转 '+VMOON.toFixed(3));
  console.log('    固定远地点 405,000 km 扫近地点，单脉冲转移远地点速度上限 = '+best.toFixed(3)
    +'（rp='+bestRp.toFixed(0)+' km，已接近圆轨道、失去转移意义）仍 < '+VMOON.toFixed(3));
}

// ---- 放大图相机代数核对：为何「地球系下弧」旧版在放大图里变成「从上往下进入」（2026-10-21 已修复） ----
console.log('--- 放大图相机代数核对（轨迹＝地球位置−相机位置；跟随 vs 固定）---');
{
  const ZX=180, ZY=180, sZ=${Z_SZ}/30000;
  // 屏幕落点＝地球位置 − 相机位置（跟随：相机=当前月心；固定：相机=t=0 月心 (MD,0)）
  const scrT=(x,y,tp,tsec)=>{ const ax=MD*Math.cos(OMEGA*tsec), ay=MD*Math.sin(OMEGA*tsec);
    return [ZX+(MD*Math.cos(OMEGA*tp)+x-ax)*sZ, ZY-(MD*Math.sin(OMEGA*tp)+y-ay)*sZ]; };
  const scrF=(x,y,tp)=>[ZX+(MD*Math.cos(OMEGA*tp)+x-MD)*sZ, ZY-(MD*Math.sin(OMEGA*tp)+y)*sZ];
  const p0=A.pre[0], pL=A.pre[A.pre.length-1];
  // ① t=0 速度分解（入站态：月系相对速度 = V_APO−VMOON = −0.841）
  const vEy=V_APO, sTy=V_APO-VMOON;
  console.log('  t=0 入站态：对地速度=+'+vEy.toFixed(3)+' ↑ · 镜头(跟随)=+'+VMOON.toFixed(3)+' ↑'
    +'  ⇒ 屏幕位移='+sTy.toFixed(3)+' ↓');
  console.log('  固定镜头：屏幕位移=对地速度本身=+'+vEy.toFixed(3)+' ↑（与左列地球系同向）');
  if(!(Math.abs(sTy+Math.abs(V_APO-VMOON))<0.01)){ console.log('CAMERA_ALGEBRA_ERROR'); process.exit(1); }
  // ② 入站弧起点在两种镜头下的屏幕方向（用户质疑的现象：必须从圆心【下方】进入）
  const qT=scrT(p0.x,p0.y,p0.t,0), qF=scrF(p0.x,p0.y,p0.t);
  const earthY0=MD*Math.sin(OMEGA*p0.t)+p0.y;
  console.log('  入站 '+(-p0.t/3600).toFixed(1)+' h 起点：对地 y='+earthY0.toFixed(0)+' km（<0＝中心下方）'
    +' · 月系 rel y=+'+p0.y.toFixed(0)+' km');
  console.log('  修复后：跟随镜头屏幕 y=ZY'+(qT[1]-ZY).toFixed(0)+' px · 固定镜头屏幕 y=ZY'+(qF[1]-ZY).toFixed(0)
    +' px（均 >0＝圆心下方 ⇒ 从下往上进入，与左列地球系一致 ✓）');
  if(!(qT[1]-ZY>10 && qF[1]-ZY>10)){ console.log('ZOOM_ENTRY_STILL_FROM_ABOVE'); process.exit(1); }
  if(!(earthY0<-1000)){ console.log('APPROACH_EARTH_RISE_ERROR'); process.exit(1); }
  // ③ 位移分解恒等式：飞船对地上升 + 相对月球下降 = 月球上升
  const moonRise=-MD*Math.sin(OMEGA*p0.t);
  const craftRise=pL.y-(MD*Math.sin(OMEGA*p0.t)+p0.y), relDesc=p0.y-pL.y;
  console.log('  入站 '+(-p0.t/3600).toFixed(1)+' h：月球上升 '+moonRise.toFixed(0)+' km · 飞船对地上升 '+craftRise.toFixed(0)
    +' km · 相对月球下降 '+relDesc.toFixed(0)+' km');
  if(Math.abs(craftRise+relDesc-moonRise)>50){ console.log('APPROACH_SUM_MISMATCH'); process.exit(1); }
  // ④ 对照：旧版（月系轮廓）会把入站起点放到圆心上方——正是用户看到的「从上往下进入」
  const oldY=p0.y*sZ;
  console.log('  对照旧版月系轮廓：屏幕 y=ZY'+(-oldY).toFixed(0)+' px（<0＝圆心上方 ⇒ 就是用户质疑的现象）');
  if(!(oldY>50)){ console.log('OLD_MOONFRAME_CONTOUR_REFERENCE_MISSING'); process.exit(1); }
}

// ---- 月系图（右列）重算核对：入站必须【从上方】进入（镜像于放大图地球系的【从下方】） ----
console.log('--- 月系图（右列）重算核对：入站从上往下（镜像于放大图地球系的从下往上）---');
{
  const C0=180, sM=(C0-26)/23000;
  // 月系：月球恒在圆心，轨迹＝相对位置 (s.x,s.y)；入站 pre 弧首点（t=−8h）应在圆心【上方】
  const p0=A.pre[0];
  const sy=C0 - p0.y*sM;
  console.log('  月系入站始点 月心距='+Math.hypot(p0.x,p0.y).toFixed(0)+' km · 月系相对 y=+'+p0.y.toFixed(0)+' km');
  console.log('  屏幕 y = C0'+((sy-C0)).toFixed(0)+' px（<0＝圆心上方 ⇒ 从上往下进入 ✓）');
  if(!(p0.y>20000)){ console.log('MOON_ENTRY_REL_Y_TOO_SMALL'); process.exit(1); }
  if(!(sy < C0-30)){ console.log('MOON_ENTRY_NOT_FROM_ABOVE'); process.exit(1); }
  // 镜像关系：放大图（地球系·跟随）入站始点落在圆心【下方】(qT[1]-ZY>10)，月系落在【上方】(sy<C0)
  console.log('  镜像关系：放大图(地球系)入站从【下】 · 月系入站从【上】 · 差着月球自身位移，非同一画面');
  console.log('  ⇒ 正是速度分解图 vdC 结论：同一运动在「地球系看从下往上、月系看从上往下」不矛盾');
  // 旋向核对：drawMoon 文案（逆行CW / 顺行CCW）必须与 t=0 角动量符号一致
  for(const [tag,D] of [['逆行CW',A],['顺行CCW',C]]){
    const s0=D.S[0]; const Lz=s0.x*s0.vy - s0.y*s0.vx;
    console.log('  '+tag+'：t=0 角动量 Lz='+Lz.toFixed(0)+' ⇒ '+(Lz<0?'顺时针 CW（逆行）✓':'逆时针 CCW（顺行）✓'));
    if(D.sgn<0 && !(Lz<0)){ console.log('MOON_CW_MISMATCH'); process.exit(1); }
    if(D.sgn>0 && !(Lz>0)){ console.log('MOON_CCW_MISMATCH'); process.exit(1); }
  }
}

// ---- 中列放大图取景核对：飞船（当前点）永远在窗口内；历史段在跟随模式下会随相机平移切边（跟踪相机的真实长相） ----
console.log('--- 中列放大图取景核对（窗口 ±30,000 km，画布 ${ZWW}×${ZZH} px，半宽 ${ZHW} / 半高 ${ZHH} px）---');
{
  const sZ=${Z_SZ}/30000, ZK=${Z_ZK};
  for(const [tag,D] of [['逆行 CW',A],['顺行 CCW',C]]){
    let rmax=0, vmax=0, reach=0;
    for(const p of D.pre){ rmax=Math.max(rmax, Math.hypot(p.x,p.y)); }
    for(const s of D.S){
      const r=Math.hypot(s.x,s.y);
      const vx=VMOON*(-Math.sin(OMEGA*s.t))+s.vx, vy=VMOON*Math.cos(OMEGA*s.t)+s.vy;
      rmax=Math.max(rmax,r); vmax=Math.max(vmax,Math.hypot(vx,vy));
      reach=Math.max(reach, r*sZ + Math.hypot(vx,vy)*ZK);
    }
    const rpx=rmax*sZ, vpx=vmax*ZK;
    console.log('  '+tag+': 最大月心距 '+rmax.toFixed(0)+' km → '+rpx.toFixed(0)+' px（半高 ${ZHH}）'
      +' · 最大对地速度 '+vmax.toFixed(3)+' km/s → 箭头 '+vpx.toFixed(0)+' px');
    console.log('    最坏组合（位置+箭头）≈ '+reach.toFixed(0)+' px（半宽 ${ZHW}）'+(reach<${ZHW}?'  ✓ 不出画':'  ✗ 会出画'));
    if(rpx>${ZHH} || reach>${ZHW}){ console.log('ZOOM_FRAMING_OVERFLOW'); process.exit(1); }
  }
}

// ---- 能量比 ----
const ve=3.08, dvA=A.dv, dvC=C.dv, dD=dvC-dvA;
const fA=1-Math.exp(-dvA/ve), fC=1-Math.exp(-dvC/ve), fr=fC/fA;
console.log('--- 减速能量比 ---');
console.log('  插入总Δv: 逆行 '+dvA.toFixed(3)+'  顺行 '+dvC.toFixed(3)+'  km/s  差 '+dD.toFixed(3));
console.log('  Isp 314 s, ve='+ve+' km/s');
console.log('  起始质量抛掉: 逆行 '+(fA*100).toFixed(1)+'%  顺行 '+(fC*100).toFixed(1)+'%');
console.log('  顺行推进剂比逆行多 '+((fr-1)*100).toFixed(1)+'%  => 减速能量比 '+fr.toFixed(3)+' : 1');
console.log('  两者共同需消除 v_∞='+Math.abs(V_APO-VMOON).toFixed(3)+' km/s（捕获比能相同）');
console.log('  转移轨道: 近地点 v='+Math.sqrt(MU_E*(2/RP_T-1/A_T)).toFixed(2)+' km/s, 远地点 v='+V_APO.toFixed(3)+' km/s');

// ---- 转移弧走向核对：上弧 vs 下弧，哪个与抵达速度一致 ----
const eTr2=(RA_T-RP_T)/(RA_T+RP_T);
const velAt=(E,signY)=>[A_T*Math.sin(E), signY*A_T*Math.sqrt(1-eTr2*eTr2)*Math.cos(E)]; // 参数速度(∝Edot>0)
console.log('--- 转移弧走向核对 ---');
console.log('  远地点=捕获起点 位置=('+RA_T+',0) [+x]；抵达地球系速度=(0,+'+V_APO.toFixed(3)+') → +y 向上');
const up=velAt(Math.PI,+1), lo=velAt(Math.PI,-1);
console.log('  上弧(y>0): 远地点速度 dy='+up[1].toFixed(0)+'（向下） Lz='+(RA_T*up[1]).toFixed(0)+' <0 逆行 ✗ 与抵达 +y 矛盾');
console.log('  下弧(y<0): 远地点速度 dy='+lo[1].toFixed(0)+'（向上） Lz='+(RA_T*lo[1]).toFixed(0)+' >0 顺行 ✓ 与抵达一致');
console.log('  结论：绕地顺行转移远地点在 +x ⇒ 必走【下弧】（TR_ARC 已用 y<0）');

// ---- 入站弧 pre 与转移弧衔接核对 ----
console.log('--- 入站弧 pre 衔接核对 ---');
const show=[0, Math.floor(A.pre.length/2), A.pre.length-1];
for(const k of show){ const p=A.pre[k], aa=OMEGA*p.t;
  console.log('  t='+(p.t/3600).toFixed(2)+'h  月系 rel=('+p.x.toFixed(0)+', '+p.y.toFixed(0)+')  地球系=('
    +(MD*Math.cos(aa)+p.x).toFixed(0)+', '+(MD*Math.sin(aa)+p.y).toFixed(0)+')'); }
console.log('  转移弧末端 (地球系): ('+TR_ARC[TR_ARC.length-2][0].toFixed(0)+', '+TR_ARC[TR_ARC.length-2][1].toFixed(0)+') → (405000, 0)');
console.log('  pre 地球系 t=0⁻ 速度=(0,+'+(VMOON+V_APO-VMOON).toFixed(3)+')  转移弧抵达速度=(0,+'+V_APO.toFixed(3)+')  → 同向 +y ✓ 平滑');

// ---- 箭头方向单元测试：数学坐标(y-up) 画到屏幕(y-down) 必须翻 y ----
console.log('--- arrow() 方向单元测试（防垂直镜像回归）---');
{
  const mkStub=()=>{ const ops=[]; return { ops, g:{ strokeStyle:'',fillStyle:'',lineWidth:0,
    beginPath(){}, moveTo(x,y){ops.push(['moveTo',x,y]);}, lineTo(x,y){ops.push(['lineTo',x,y]);},
    closePath(){}, fill(){}, stroke(){} } }; };
  const fn = eval('('+ARROW_SRC+')');
  const t=(vx,vy)=>{ const {g,ops}=mkStub(); fn(g,100,100,vx,vy,10,'#000');
    const to=ops.find(o=>o[0]==='lineTo'); return [to[1]-100, to[2]-100]; };
  const r1=t(0,1), r2=t(1,0), r3=t(0,-1);
  const ok1=r1[0]===0&&r1[1]<0, ok2=r2[0]>0&&r2[1]===0, ok3=r3[0]===0&&r3[1]>0;
  console.log('  v=(0,+1) → 屏幕('+r1[0]+','+r1[1]+') 期望(0,−)向上   '+(ok1?'✓':'✗ 垂直镜像!'));
  console.log('  v=(+1,0) → 屏幕('+r2[0]+','+r2[1]+') 期望(+,0)向右   '+(ok2?'✓':'✗'));
  console.log('  v=(0,−1) → 屏幕('+r3[0]+','+r3[1]+') 期望(0,+)向下   '+(ok3?'✓':'✗ 垂直镜像!'));
  if(!(ok1&&ok2&&ok3)){ console.log('ARROW_MIRROR_BUG'); process.exit(1); }
}

// ---- 箭头 vs 轨迹切向：两系各自点积必须为正 ----
console.log('--- 箭头与轨迹切向一致性（屏幕坐标）---');
{
  const C0=190, sM2=(C0-26)/23000, sE2=(C0-26)/MD;
  const PX=(sc,x,y)=>[C0+x*sc, C0-y*sc];
  const check=(tag,D)=>{
    let minDot=1e9, n=0;
    for(let i=0;i<D.S.length-1;i+=7){
      const a=D.S[i], b=D.S[i+1];
      const aa=OMEGA*a.t;
      // 月系：轨迹屏幕切向 vs 相对速度箭头屏幕方向
      const mTan=[PX(sM2,b.x,b.y)[0]-PX(sM2,a.x,a.y)[0], PX(sM2,b.x,b.y)[1]-PX(sM2,a.x,a.y)[1]];
      const mArr=[a.vx, -a.vy];
      const d1=(mTan[0]*mArr[0]+mTan[1]*mArr[1])/(Math.hypot(...mTan)*Math.hypot(...mArr));
      // 地球系：轨迹屏幕切向 vs 绝对速度箭头屏幕方向
      const eTan=[PX(sE2, MD*Math.cos(OMEGA*b.t)+b.x, MD*Math.sin(OMEGA*b.t)+b.y)[0]-PX(sE2, MD*Math.cos(aa)+a.x, MD*Math.sin(aa)+a.y)[0],
                  PX(sE2, MD*Math.cos(OMEGA*b.t)+b.x, MD*Math.sin(OMEGA*b.t)+b.y)[1]-PX(sE2, MD*Math.cos(aa)+a.x, MD*Math.sin(aa)+a.y)[1]];
      const thx=-Math.sin(aa), thy=Math.cos(aa);
      const eArr=[VMOON*thx+a.vx, -(VMOON*thy+a.vy)];
      const d2=(eTan[0]*eArr[0]+eTan[1]*eArr[1])/(Math.hypot(...eTan)*Math.hypot(...eArr));
      minDot=Math.min(minDot,d1,d2); n++;
    }
    console.log('  '+tag+': 采样 '+n+' 点，箭头/轨迹最小夹角余弦 = '+minDot.toFixed(3)+(minDot>0.9?'  ✓ 全部同向':'  ✗ 存在反向!'));
    return minDot;
  };
  const mA=check('逆行 CW',A), mC=check('顺行 CCW',C);
  if(Math.min(mA,mC)<=0.9){ console.log('ARROW_TRAJECTORY_MISMATCH'); process.exit(1); }
}
`;

// ---- 新吸收特性静态断言：自动慢放 + 捕获判据条（必须基于真实数据，禁止视觉拟合常量）----
console.log('--- 自动慢放 / 捕获判据条 检查 ---');
{
  // timeScale 必须由 D.B（真实制动时刻表，t 为秒）驱动，窗口换算成小时与 T 比较
  const iTS = js.indexOf('function timeScale(');
  const iTSEnd = js.indexOf('let last=performance.now()', iTS);
  if (iTS < 0 || iTSEnd < 0) { console.error('TIMESCALE_BLOCK_NOT_FOUND'); process.exit(1); }
  const tsSrc = js.slice(iTS, iTSEnd);
  const drivenByB = tsSrc.includes('b.t/3600') && tsSrc.includes('for(const D of [A,C])');
  const gated = tsSrc.includes('autoSlow');
  const wired = js.includes('d*spd*3*timeScale()');
  console.log('  慢放窗口由真实制动时刻表 D.B 驱动（非硬编码） : ' + (drivenByB ? '✓' : '✗'));
  console.log('  受「自动慢放」复选框控制（可关）              : ' + (gated ? '✓' : '✗'));
  console.log('  已接入主循环（T += d*spd*3*timeScale()）      : ' + (wired ? '✓' : '✗'));
  if (!drivenByB || !gated || !wired) { console.error('TIMESCALE_NOT_DATA_DRIVEN'); process.exit(1); }
  // capBar 必须用真实 μ_M 与开普勒逃逸速度公式，阈值判定 v_rel < v_esc
  const iCB = js.indexOf('function capBar(');
  const iCBEnd = js.indexOf('function stateAt(', iCB);
  if (iCB < 0 || iCBEnd < 0) { console.error('CAPBAR_BLOCK_NOT_FOUND'); process.exit(1); }
  const cbSrc = js.slice(iCB, iCBEnd);
  const realMu = cbSrc.includes('2*MU_M/Math.max(r,1)');
  const realCmp = cbSrc.includes('vr<vesc');
  const usedMoon = (js.match(/capBar\(g,10,W-14,150,cur\)/g)||[]).length >= 1;
  const usedZoom = (js.match(/capBar\(g,10,ZH-\d+,170,cur\)/g)||[]).length >= 1;
  console.log('  v_esc = √(2μ_M/r)（真实月球引力参数）          : ' + (realMu ? '✓' : '✗'));
  console.log('  判定 v_rel < v_esc ⇒ 已被捕获                  : ' + (realCmp ? '✓' : '✗'));
  console.log('  右列月系两格 / 中列放大图均已挂载              : ' + ((usedMoon&&usedZoom)?'✓':'✗'));
  if (!realMu || !realCmp || !usedMoon || !usedZoom) { console.error('CAPBAR_NOT_PHYSICAL'); process.exit(1); }
}

// ---- ③ 放大图口径检查：轨迹必须是地球系轨迹（按「地球位置−相机位置」落屏）；速度箭头必须用绝对速度 ----
console.log('--- 放大图 drawZoom（地球系轨迹 ×20 + 跟随/固定两种镜头）口径检查 ---');
{
  const iZ = js.indexOf('function drawZoom(');
  const iZEnd = js.indexOf('// ---------- ② 速度分解图', iZ);
  if (iZ < 0 || iZEnd < 0) { console.error('ZOOM_BLOCK_NOT_FOUND'); process.exit(1); }
  const zSrc = js.slice(iZ, iZEnd);
  // 2026-10-21 修复（用户三轮质疑「地球系的下弧怎么到放大里就变成从上往下进入了」）：
  // 旧版把历史点按「当时的月心」逐点定位＝月系轮廓，跟踪相机看不到那个画面。
  // 现在每个历史点按「地球位置 − 相机位置」落屏 ⇒ 轮廓与左列地球系完全一致（×20）。
  const earthMinusCam = zSrc.includes('MD*Math.cos(OMEGA*tp)+x') && zSrc.includes('(ex-ax)*sZ');
  const posRel  = zSrc.includes('ZPt(cur.x,cur.y') && zSrc.includes('ZPt(s.x,s.y');
  const absVel  = zSrc.includes('VMOON*thx+cur.vx');
  const trackMode = zSrc.includes('zoomTrack') && zSrc.includes('track ? MD*Math.cos(a) : MD');
  const fixedMode = zSrc.includes('track ? MD*Math.sin(a) : 0');
  // 屏幕位移虚箭头：允许存在（解释屏幕上飞船为何下沉），但必须 ①复选框可控 ②虚线样式 ③文案标注相机代数
  const driftGated  = zSrc.includes('showDrift && track');
  const driftDashed = /setLineDash\(\[5,3\]\)/.test(zSrc);
  const driftLabel  = zSrc.includes('对地−镜头');
  // 镜头中心＝月心（跟随模式）：ZX=ZW/2, ZY=ZH/2 为原点（常量区定义），drawZoom 内所有坐标都过 ZPt
  const centered= /[,;\s]ZX=ZW\/2/.test(js) && /[,;\s]ZY=ZH\/2/.test(js) && zSrc.includes('ZPt(p.x,p.y');
  console.log('  轨迹按「地球位置−相机位置」落屏（＝左列地球系×20）: ' + (earthMinusCam ? '✓' : '✗ 【错】又退回月系轮廓了？'));
  console.log('  跟随模式：相机=当前月心（匀速平移，仍是惯性系）  : ' + (trackMode ? '✓' : '✗'));
  console.log('  固定模式：相机=t=0 月心 (MD,0)（静止于地球系）   : ' + (fixedMode ? '✓' : '✗'));
  console.log('  位置随月球平移（两种镜头都是地球系，仅相机不同）  : ' + (posRel ? '✓' : '✗'));
  console.log('  速度箭头用绝对速度 v_moon+v_rel（地球系口径）    : ' + (absVel ? '✓' : '✗ 【错】平移不改变矢量'));
  console.log('  屏幕位移虚箭头：可控 ' + (driftGated?'✓':'✗') + ' · 虚线区分 ' + (driftDashed?'✓':'✗') + ' · 标注「对地−镜头」 ' + (driftLabel?'✓':'✗'));
  if (!earthMinusCam || !posRel || !absVel || !trackMode || !fixedMode) { console.error('ZOOM_VELOCITY_FRAME_ERROR'); process.exit(1); }
  if (!driftGated || !driftDashed || !driftLabel) { console.error('ZOOM_DRIFT_ARROW_CONTRACT'); process.exit(1); }
  // 放大倍率核对：sZ / sE 应 ≈ 20（页面宣称 20×）
  const sZv = (js.match(/const sZ=([\d.]+)\/30000/)||[])[1];
  const sEsub = (js.match(/const sE=\(C0-(\d+)\)\/MD/)||[])[1];
  const MDv = (js.match(/, MD=(\d+),/)||[])[1];
  const Wv = (js.match(/const W=(\d+), C0=W\/2/)||[])[1];
  if (sZv && sEsub && MDv && Wv) {
    const ratio = (sZv/30000) / ((Wv/2 - sEsub)/MDv);
    console.log('  放大倍率 sZ/sE = ' + ratio.toFixed(1) + '×（页面宣称 20×）' + (ratio>18&&ratio<22?'  ✓':'  ✗'));
    if (!(ratio>18&&ratio<22)) { console.error('ZOOM_MAGNIFICATION_MISMATCH'); process.exit(1); }
  } else {
    console.log('  放大倍率无法解析 [sZ=' + (sZv||'?') + ' sE-' + (sEsub||'?') + ' MD=' + (MDv||'?') + ' W=' + (Wv||'?') + ']');
  }
}

// ---- ④ 月系图（右列）口径检查：月球居中（纯平移，不旋转）、轨迹＝月系相对坐标、速度箭头＝相对月球速度 ----
console.log('--- 月系图 drawMoon 口径检查（右列：月球居中 + 相对月球速度）---');
{
  const iM = js.indexOf('function drawMoon(');
  const iMEnd = js.indexOf('// ---------- 中列放大图', iM);
  if (iM < 0 || iMEnd < 0) { console.error('MOON_BLOCK_NOT_FOUND'); process.exit(1); }
  const mSrc = js.slice(iM, iMEnd);
  // 月球恒在圆心：drawMoon 把月球画在 (C0,C0)，且地球方向随公转转动（纯平移，不旋转）
  const moonCentered = mSrc.includes('dot(g,C0,C0') && mSrc.includes("txt(g,'月球'");
  // 轨迹＝月系相对坐标 (sM,x,y)，速度箭头＝相对月球速度 (cur.vx,cur.vy)
  const relPos = mSrc.includes('PX(sM,cur.x,cur.y)') && mSrc.includes('PX(sM,s.x,s.y');
  const relVel = mSrc.includes('arrow(g,cq[0],cq[1],cur.vx,cur.vy');
  // 入站方向：月系相对速度向下（V_APO-VMOON = −0.841），drawMoon 用此画入站箭头（不是对地绝对速度）
  // 标注口径：旧「从上往下」已澄清为「从『前/上』方」（两个面板都不旋转，屏幕『上』＝月球前进方向＝前）
  const entryDown = mSrc.includes('V_APO-VMOON') && (mSrc.includes('从上往下') || mSrc.includes('前/上'));
  console.log('  月球居中（纯平移，不随公转旋转）        : ' + (moonCentered ? '✓' : '✗'));
  console.log('  轨迹位置＝月系相对坐标 (sM,s.x,s.y)    : ' + (relPos ? '✓' : '✗ 【错】又退回地球系？'));
  console.log('  速度箭头＝相对月球速度 (cur.vx,cur.vy)  : ' + (relVel ? '✓' : '✗ 【错】应是相对速度'));
  console.log('  入站标注＝从『前/上』方（−0.841，月系读数＝相对月球向下） : ' + (entryDown ? '✓' : '✗'));
  if (!moonCentered || !relPos || !relVel || !entryDown) { console.error('MOON_FRAME_FRAME_ERROR'); process.exit(1); }
}

// ---- 前/后 轴标核对：两个面板都不旋转，屏幕「上」＝月球前进方向(前/lead)，锁死「从上进入＝从前方进入」的澄清 ----
console.log('--- 前/后 轴标核对（上＝前/lead，两个面板朝向一致）---');
{
  const hasFn = js.includes('function leadAxis(');
  const callsMoon = js.includes('leadAxis(g,W,W)');
  const callsZoom = js.includes('leadAxis(g,ZW,ZH)');
  const label = js.includes("'前(lead)'");
  console.log('  leadAxis 函数定义        : ' + (hasFn ? '✓' : '✗'));
  console.log('  drawMoon 调用 leadAxis  : ' + (callsMoon ? '✓' : '✗'));
  console.log('  drawZoom 调用 leadAxis  : ' + (callsZoom ? '✓' : '✗'));
  console.log('  标注「前(lead)」存在     : ' + (label ? '✓' : '✗'));
  if (!hasFn || !callsMoon || !callsZoom || !label) { console.error('LEAD_AXIS_MISSING'); process.exit(1); }
}

const tmp = path.join(ROOT, 'tools', 'mission', '_4panel_core_run.mjs');
fs.writeFileSync(tmp, runner, 'utf8');
try {
  await import('file:///' + tmp.replace(/\\/g, '/'));
} finally {
  fs.rmSync(tmp, { force: true });
}
