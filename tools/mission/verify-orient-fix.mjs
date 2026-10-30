// 数值验证 orientLvLH 修复：确认经 Cesium glTF Y→Z 校正后，
// 模型局部轴的世界朝向 = +X(帆板)→side 水平 / +Y(厚)→−Up 径向 / +Z(机头)→−fwdH。
// 纯数学复现，不依赖 Cesium。
//   ENU 基：E=(1,0,0) N=(0,1,0) U=(0,0,1)；ENU 矩阵把局部 (a,b,c)→aE+bN+cU。
//   R_corr（实测 probe23）：模型 (x,y,z)→(z,x,y)，即 +X→N, +Y→U, +Z→E。
//   page = ENU * R * R_corr * v_model。
function matVecCols(cols, v){ // cols=[c0,c1,c2]；返回 cols*v
  return [0,1,2].map(i=>cols[0][i]*v[0]+cols[1][i]*v[1]+cols[2][i]*v[2]);
}
function cross(a,b){return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];}
function dot(a,b){return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];}
function norm(a){const m=Math.hypot(...a)||1;return a.map(x=>x/m);}
function nameENU(v){ // 用 ENU 分量命名
  const [e,n,u]=v.map(x=>Math.abs(x)<1e-9?0:x);
  const parts=[];
  if(Math.abs(e)>0.5)parts.push((e>0?'+':'')+'East');
  if(Math.abs(n)>0.5)parts.push((n>0?'+':'')+'North');
  if(Math.abs(u)>0.5)parts.push((u>0?'+':'')+'Up');
  return parts.join(' ')||'~0';
}

for(const [label,fwdH] of [['fwdH=East(正东)',[1,0,0]],['fwdH=North-East',[Math.SQRT1_2,Math.SQRT1_2,0]]]){
 for(const nf of [false,true]){
  const E=[1,0,0],N=[0,1,0],U=[0,0,1];
  const fx=dot(fwdH,E),fy=dot(fwdH,N);
  const sgn=nf?1:-1;
  // 修复后 R 列：col0=sgn·fwdH, col1=side, col2=−Up
  const R=[
    [sgn*fx,sgn*fy,0],  // col0 = sgn·fwdH
    [-fy, fx,0],        // col1 = side = Up×fwdH
    [0,0,sgn],          // col2 = sgn·Up（与 col0 同号，保证 det=+1）
  ];
  // 校验 R 正交（det=+1）
  const det=dot(R[0],cross(R[1],R[2]));
  const side=cross(U,fwdH);
  const R_corr=(v)=>[v[2],v[0],v[1]]; // (x,y,z)→(z,x,y)
  const page=(v)=>matVecCols(R,R_corr(v)); // 已含 ENU（ENU 恒等映射到自身分量）
  const mX=page([1,0,0]),mY=page([0,1,0]),mZ=page([0,0,1]);
  const expectX=side, expectY=[0,0,sgn], expectZ=fwdH.map(x=>sgn*x);
  const ok=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2])<1e-9;
  const tag=nf?'nose-forward(顺行/第一~三幕)':'engine-forward(逆行制动/第四幕)';
  console.log(`\n== ${label}  [${tag}]  (det(R)=${det.toFixed(3)}) ==`);
  console.log(' model +X(帆板) →', nameENU(mX), '| 期望 side=', nameENU(expectX), ok(mX,expectX)?'✓':'✗');
  console.log(' model +Y(厚)   →', nameENU(mY), '| 期望 '+(nf?'+Up':'−Up')+'   ', ok(mY,expectY)?'✓':'✗');
  console.log(' model +Z(机头) →', nameENU(mZ), '| 期望 '+(nf?'+fwdH':'−fwdH')+' ', ok(mZ,expectZ)?'✓':'✗');
  const allok=ok(mX,expectX)&&ok(mY,expectY)&&ok(mZ,expectZ)&&Math.abs(det-1)<1e-9;
  console.log(' 结论:', allok?'命中预期 ✓✓':'有偏差 ✗');
 }
}
