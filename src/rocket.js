// src/rocket.js — 探月三幕剧动画
// 三幕结构：
//   第一幕 · 点火起飞   （地球 Viewer：发射段上升 + 助推器/整流罩分离动效 + 发射轨迹线）
//   第二幕 · 月地转移   （地球 Viewer 内「局部太阳系顶视图」：压缩距离示意，
//                         规划航线虚线 + 已飞轨迹亮线 + 示意月球，飞船沿航线飞行）
//   第三幕 · 月球着陆   （月球 Viewer：环月制动 LOI 俯视机位 → 动力下降，
//                         末端按真实月面 DEM 接地，换着陆器图标）
// 幕间用文字幕卡过渡。复用底部巡游面板：播放/暂停/倍率/进度条拖拽/幕节点跳转/重播。
// 崩溃防护：camera.lookAt 只接受 Cartesian3 —— 禁止把 entity.position（Property）直接传入，
//           否则相机矩阵为 NaN → createPotentiallyVisibleSet 抛 RangeError: invalid array length。

import * as Cesium from 'cesium';
import { MOON_ELLIPSOID, MOON_LANDING_SITES, sampleMoonHeight } from './lunar.js';
import { LANDER_ICON, SPACECRAFT_ICON, descentAltitude } from './moon-landing.js';
import {
  FULL_ROCKET_ICON,
  STAGE1_ICON,
  BOOSTER_ICON,
  FAIRING_LEFT_ICON,
  FAIRING_RIGHT_ICON,
  MOON_ICON,
} from './icons.js';
import { isRouteTourActive } from './route-tour.js';

const MOON_R = 1737400;
const SPEED_STEPS = [0.5, 1, 2, 4, 8];
const BASE_DURATION = 120; // 1× 全程秒数

// 四个发射场中用于探月任务的低纬两个（数据与 moonmission 图层一致）
export const LAUNCH_SITES = {
  jiuquan: { lon: 100.298, lat: 40.96, name: '酒泉' },
  wenchang: { lon: 110.951, lat: 19.614, name: '文昌' },
};

// 幕时间边界（归一化 0..1）
const T = {
  liftEnd: 0.14,      // 第一幕结束（入轨 ~200km）
  card1End: 0.17,     // 幕卡 1 结束
  transferEnd: 0.56,  // 第二幕结束（抵达月球影响球）
  card2End: 0.60,     // 幕卡 2 结束
  loiEnd: 0.80,       // 环月制动段结束
};
// 幕节点（进度条跳转锚点）
const ACTS = [
  { f: 0, name: '点火' },
  { f: T.card1End, name: '转移' },
  { f: T.card2End, name: '入月轨' },
  { f: T.loiEnd, name: '着陆' },
];
// 第一幕内的分离事件时刻
const BOOSTER_SEP = T.liftEnd * 0.45;  // 助推器分离
const FAIRING_SEP = T.liftEnd * 0.78;  // 整流罩分离

function $(id) { return document.getElementById(id); }
function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function easeIn(t) { return t * t; }

function samplePath(points, s) {
  const s01 = clamp01(s);
  const n = points.length - 1;
  const x = s01 * n;
  const i = Math.min(n - 1, Math.floor(x));
  const f = x - i;
  const a = points[i], b = points[i + 1];
  return [lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f)];
}

function wrapLon(lon) { return ((lon + 180) % 360 + 360) % 360 - 180; }

/**
 * 创建探月任务控制器
 * @param {object} opts
 *   earthViewer  地球 Viewer
 *   env          { showMoon(), showEarth(), getMoonViewer(), onStatus() }
 */
export function createMoonMission(opts) {
  const { earthViewer, env } = opts;

  let raf = 0, last = 0;
  let p = 0, playing = false, mult = 1;
  let launchSiteKey = 'wenchang';
  let landingSiteKey = 'imbrium';
  let inMoon = false;
  let _wasPlaying = false;  // 拖拽进度条前的播放态（松手恢复）

  // 路径数据（start/seekTo 时生成）
  let earthPath = [];      // 第一幕上升段 [lon,lat,alt]
  let transferPts = [];    // 第二幕转移航线 [lon,lat,alt]
  let transferCarts = [];  // 转移航线 Cartesian3（画线用）
  let transferMid = null;  // 航线中点 Cartesian3（顶视相机锚点）
  let launchCarts = [];    // 已飞发射轨迹 Cartesian3（逐帧追加）
  let trailCarts = [];     // 已飞转移轨迹 Cartesian3（每帧取前缀）
  let lastLaunch = null;   // 发射轨迹上一次追加点（节流）

  // 实体
  let earthRocket = null;
  let launchTrailEnt = null;   // 发射轨迹线
  let transferFullEnt = null;  // 转移规划航线（虚线）
  let transferTrailEnt = null; // 已飞转移轨迹（亮线）
  let moonIconEnt = null;      // 示意月球
  let moonRing = null;
  let moonCraft = null;
  // 分离件（第一幕临时实体）
  let boosters = [];    // [{ent, dir}]
  let fairings = [];    // [{ent, dir}]

  // 事件绑定引用
  let onPause = null, onStop = null, onSlower = null, onFaster = null;
  let onTrackDown = null, onTrackMove = null, onTrackUp = null;

  function makeEarthPath(pad) {
    return [
      [pad.lon, pad.lat, 0],
      [pad.lon, pad.lat, 3000],
      [pad.lon + 0.25, pad.lat + 0.12, 22000],
      [pad.lon + 0.8, pad.lat + 0.4, 80000],
      [pad.lon + 2.2, pad.lat + 1.05, 200000], // 入轨 ~200 km
    ];
  }

  // 转移航线：起点 = 入轨点；经度向东南太平洋推进、纬度中段上拱成弧、高度加速抬升。
  // 终点高度 13500 km（真实月距 384000 km 的约 1/28 压缩示意）。
  function makeTransferPath(pad, liftEndPos) {
    const pts = [];
    const lon1 = pad.lon + 38, lat1 = pad.lat + 8, alt1 = 13500000;
    const N = 120;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      pts.push([
        lerp(liftEndPos[0], lon1, t),
        lerp(liftEndPos[1], lat1, t) + Math.sin(t * Math.PI) * 4,
        lerp(liftEndPos[2], alt1, t * t),
      ]);
    }
    return pts;
  }

  function buildPathData() {
    const pad = LAUNCH_SITES[launchSiteKey];
    earthPath = makeEarthPath(pad);
    transferPts = makeTransferPath(pad, earthPath[earthPath.length - 1]);
    transferCarts = transferPts.map((q) => Cesium.Cartesian3.fromDegrees(q[0], q[1], q[2]));
    const mid = transferPts[Math.floor(transferPts.length / 2)];
    transferMid = Cesium.Cartesian3.fromDegrees(mid[0], mid[1], mid[2]);
    launchCarts = [];
    lastLaunch = null;
    trailCarts = transferCarts.slice(0, 1);
  }

  // ---- 地球火箭（billboard 沿飞行方向旋转，形态随分离阶段切换）----
  function ensureEarthRocket() {
    if (earthRocket) return;
    const pad = LAUNCH_SITES[launchSiteKey];
    earthRocket = earthViewer.entities.add({
      id: 'moonMissionRocket',
      position: Cesium.Cartesian3.fromDegrees(pad.lon, pad.lat, 0),
      billboard: {
        image: FULL_ROCKET_ICON,
        width: 34,
        height: 34,
        rotation: 0,
        alignedAxis: Cesium.Cartesian3.UNIT_Z,
        heightReference: Cesium.HeightReference.NONE,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: '长征五号 · 点火升空',
        font: '12px "Microsoft YaHei", sans-serif',
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -26),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        showBackground: true,
        backgroundColor: new Cesium.Color(0.05, 0.08, 0.18, 0.7),
        backgroundPadding: new Cesium.Cartesian2(6, 4),
      },
    });
  }

  // ---- 轨迹与示意月球（地球侧，幂等创建，stop 时统一清理）----
  function ensureTransferScene() {
    if (!transferCarts.length) buildPathData();

    if (!launchTrailEnt) {
      launchTrailEnt = earthViewer.entities.add({
        id: 'moonLaunchTrail',
        polyline: {
          positions: new Cesium.CallbackProperty(() => launchCarts, false),
          width: 3,
          material: Cesium.Color.fromCssColorString('#ff8a5c'),
          arcType: Cesium.ArcType.NONE,
          depthFailMaterial: Cesium.Color.fromCssColorString('#ff8a5c').withAlpha(0.4),
        },
      });
    }
    if (!transferFullEnt) {
      const flat = [];
      for (const q of transferPts) flat.push(q[0], q[1], q[2]);
      transferFullEnt = earthViewer.entities.add({
        id: 'moonTransferPath',
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArrayHeights(flat),
          width: 2,
          material: new Cesium.PolylineDashMaterialProperty({
            color: Cesium.Color.fromCssColorString('#8fa8c8').withAlpha(0.55),
            dashLength: 16,
          }),
          arcType: Cesium.ArcType.NONE,
        },
      });
    }
    if (!transferTrailEnt) {
      transferTrailEnt = earthViewer.entities.add({
        id: 'moonTransferTrail',
        polyline: {
          positions: new Cesium.CallbackProperty(() => trailCarts, false),
          width: 3,
          material: Cesium.Color.fromCssColorString('#ffd24a'),
          arcType: Cesium.ArcType.NONE,
          depthFailMaterial: Cesium.Color.fromCssColorString('#ffd24a').withAlpha(0.4),
        },
      });
    }
    if (!moonIconEnt) {
      const end = transferPts[transferPts.length - 1];
      moonIconEnt = earthViewer.entities.add({
        id: 'moonTransferTarget',
        position: Cesium.Cartesian3.fromDegrees(end[0], end[1], end[2]),
        billboard: {
          image: MOON_ICON,
          width: 46,
          height: 46,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: '月球（示意 · 距离已压缩）',
          font: '12px "Microsoft YaHei", sans-serif',
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -34),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          showBackground: true,
          backgroundColor: new Cesium.Color(0.05, 0.08, 0.18, 0.7),
          backgroundPadding: new Cesium.Cartesian2(6, 4),
        },
      });
    }
  }

  // 主箭位置（第一、二幕内确定）
  function rocketPosAt(pp) {
    if (pp < T.liftEnd) {
      // 上升段：easeIn 加速爬升
      return samplePath(earthPath, easeIn(clamp01(pp / T.liftEnd)) * 0.999);
    }
    if (pp < T.transferEnd) {
      return samplePath(transferPts, clamp01((pp - T.card1End) / (T.transferEnd - T.card1End)));
    }
    return transferPts[transferPts.length - 1];
  }

  // 飞行方向角（屏幕旋转角）：上升段竖直、转移段沿轨迹切线
  function flightRotation(pp) {
    if (pp < T.liftEnd) return 0;
    const s = clamp01((pp - T.card1End) / (T.transferEnd - T.card1End));
    const a = rocketPosAt(T.card1End + (T.transferEnd - T.card1End) * Math.max(0, s - 0.01));
    const b = rocketPosAt(T.card1End + (T.transferEnd - T.card1End) * Math.min(1, s + 0.01));
    return -Math.atan2(b[0] - a[0], b[1] - a[1]);
  }

  // 发射轨迹逐帧追加（节流：水平累计 >0.05° 或高度变化 >5 km 才记一点）
  function pushLaunchTrail(pos) {
    if (!lastLaunch) {
      launchCarts.push(Cesium.Cartesian3.fromDegrees(pos[0], pos[1], pos[2]));
      lastLaunch = pos.slice();
      return;
    }
    const dh = Math.abs(pos[2] - lastLaunch[2]);
    const dl = Math.abs(pos[0] - lastLaunch[0]) + Math.abs(pos[1] - lastLaunch[1]);
    if (dh > 5000 || dl > 0.05) {
      launchCarts.push(Cesium.Cartesian3.fromDegrees(pos[0], pos[1], pos[2]));
      lastLaunch = pos.slice();
    }
  }

  // 转移已飞轨迹 = 规划航线前缀
  function updateTransferTrail(s) {
    const idx = Math.max(1, Math.round(clamp01(s) * (transferCarts.length - 1)));
    trailCarts = transferCarts.slice(0, idx + 1);
  }

  // ---- 分离件：助推器 ×4（斜向弹开 + 翻滚 + 下坠），整流罩 ×2（两侧抛离 + 自转）----
  function clearSeparators() {
    for (const b of boosters) earthViewer.entities.remove(b.ent);
    for (const f of fairings) earthViewer.entities.remove(f.ent);
    boosters = [];
    fairings = [];
  }

  function spawnSeparators(kind) {
    const base = rocketPosAt(kind === 'booster' ? BOOSTER_SEP : FAIRING_SEP);
    if (kind === 'booster') {
      // 4 枚助推器：东北/东南/西北/西南 斜向弹开，各自反向翻滚
      const dirs = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]];
      for (const [dlon, dlat, spin] of dirs) {
        boosters.push({
          dir: [dlon, dlat, spin],
          ent: earthViewer.entities.add({
            position: Cesium.Cartesian3.fromDegrees(base[0], base[1], base[2] - 300),
            billboard: {
              image: BOOSTER_ICON,
              width: 26,
              height: 26,
              rotation: 0,
              alignedAxis: Cesium.Cartesian3.UNIT_Z,
              heightReference: Cesium.HeightReference.NONE,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
            label: {
              text: '助推器分离',
              font: '11px "Microsoft YaHei", sans-serif',
              fillColor: Cesium.Color.fromCssColorString('#ffd24a'),
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 3,
              style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              pixelOffset: new Cesium.Cartesian2(0, -20),
              verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          }),
        });
      }
    } else {
      // 整流罩左右两瓣：向两侧水平抛离并自转
      const defs = [
        { dir: -1, icon: FAIRING_LEFT_ICON, text: '整流罩分离' },
        { dir: 1, icon: FAIRING_RIGHT_ICON, text: '整流罩分离' },
      ];
      for (const d of defs) {
        fairings.push({
          dir: d.dir,
          ent: earthViewer.entities.add({
            position: Cesium.Cartesian3.fromDegrees(base[0], base[1], base[2] + 200),
            billboard: {
              image: d.icon,
              width: 24,
              height: 24,
              rotation: 0,
              alignedAxis: Cesium.Cartesian3.UNIT_Z,
              heightReference: Cesium.HeightReference.NONE,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
            label: {
              text: d.text,
              font: '11px "Microsoft YaHei", sans-serif',
              fillColor: Cesium.Color.fromCssColorString('#ffd24a'),
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 3,
              style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              pixelOffset: new Cesium.Cartesian2(0, -18),
              verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          }),
        });
      }
    }
  }

  // 逐帧更新分离件（从分离时刻起的弹开/翻滚/下坠动画，结束后销毁）
  function updateSeparators() {
    const D = BASE_DURATION;
    // 助推器
    if (p >= BOOSTER_SEP && boosters.length === 0 && p < BOOSTER_SEP + 0.055) {
      spawnSeparators('booster');
    }
    if (boosters.length) {
      const dt = (p - BOOSTER_SEP) * D;
      if (dt > 8) {
        for (const b of boosters) earthViewer.entities.remove(b.ent);
        boosters = [];
      } else if (dt >= 0) {
        const base = rocketPosAt(BOOSTER_SEP);
        for (const b of boosters) {
          const [dlon, dlat, spin] = b.dir;
          b.ent.position = Cesium.Cartesian3.fromDegrees(
            base[0] + dlon * 0.05 * dt,
            base[1] + dlat * 0.03 * dt,
            Math.max(0, base[2] - 300 + 900 * dt - 130 * dt * dt)
          );
          b.ent.billboard.rotation = spin * dt * 1.7;
        }
      }
    }
    // 整流罩
    if (p >= FAIRING_SEP && fairings.length === 0 && p < FAIRING_SEP + 0.045) {
      spawnSeparators('fairing');
    }
    if (fairings.length) {
      const dt = (p - FAIRING_SEP) * D;
      if (dt > 6.5) {
        for (const f of fairings) earthViewer.entities.remove(f.ent);
        fairings = [];
      } else if (dt >= 0) {
        const base = rocketPosAt(FAIRING_SEP);
        for (const f of fairings) {
          f.ent.position = Cesium.Cartesian3.fromDegrees(
            base[0] + f.dir * 0.09 * dt,
            base[1],
            Math.max(0, base[2] + 200 + 250 * dt - 110 * dt * dt)
          );
          f.ent.billboard.rotation = f.dir * dt * 0.9;
        }
      }
    }
  }

  // ---- 月球场景（第三幕）----
  function clearMoonEntities() {
    const mv = env.getMoonViewer();
    if (mv) {
      if (moonRing) { mv.entities.remove(moonRing); moonRing = null; }
      if (moonCraft) { mv.entities.remove(moonCraft); moonCraft = null; }
      try { mv.camera.lookAtTransform(Cesium.Matrix4.IDENTITY); } catch { /* 忽略 */ }
    }
  }

  function ensureMoonScene() {
    if (inMoon && moonCraft) return;
    const mv = env.showMoon();
    inMoon = true;
    if (!mv) return;
    const site = MOON_LANDING_SITES[landingSiteKey];

    // 环月轨迹（闭环，即环月段轨迹描绘）
    const flat = [];
    for (let i = 0; i <= 120; i++) {
      flat.push(wrapLon((i / 120) * 360), site.lat, 200000);
    }
    moonRing = mv.entities.add({
      id: 'moonLoiOrbit',
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArrayHeights(flat, MOON_ELLIPSOID),
        width: 2,
        material: Cesium.Color.fromCssColorString('#7fc4ff'),
        depthFailMaterial: Cesium.Color.fromCssColorString('#7fc4ff').withAlpha(0.35),
        arcType: Cesium.ArcType.NONE,
      },
    });

    // 航天器 / 着陆器（同一实体，末段换图标）
    moonCraft = mv.entities.add({
      id: 'moonMissionCraft',
      position: Cesium.Cartesian3.fromDegrees(site.lon, site.lat, 800000, MOON_ELLIPSOID),
      billboard: {
        image: SPACECRAFT_ICON,
        width: 32,
        height: 32,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: '探月飞船',
        font: '12px "Microsoft YaHei", sans-serif',
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -24),
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        showBackground: true,
        backgroundColor: new Cesium.Color(0.05, 0.08, 0.18, 0.7),
        backgroundPadding: new Cesium.Cartesian2(6, 4),
      },
    });
  }

  function showCard(text) {
    const c = $('actCard');
    if (!c) return;
    $('actCardText').textContent = text;
    c.classList.remove('hidden');
    c.classList.add('show');
  }
  function hideCard() {
    const c = $('actCard');
    if (!c) return;
    c.classList.remove('show');
    c.classList.add('hidden');
  }
  function setPhase(text) {
    const el = $('rocketPhase');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('hidden');
  }
  function noteOn(on) {
    $('compressNote')?.classList.toggle('hidden', !on);
  }

  // 第二幕顶视相机：俯瞰整条转移航线（局部太阳系顶视图）
  function lookAtTransfer() {
    if (!transferMid) return;
    earthViewer.camera.lookAt(
      transferMid,
      new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-83), 28000000)
    );
  }

  function focusEarth(alt, wide) {
    const range = wide ? 3.0e7 : Math.max(6000, alt * 2.2);
    const pos = earthRocket ? earthRocket.position.getValue(Cesium.JulianDate.now()) : null;
    if (!pos) return;
    earthViewer.camera.lookAt(
      pos,
      new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-38), range)
    );
  }

  // ---- 逐帧渲染 ----
  function render() {
    // —— 地球侧（第一幕 / 幕卡 1 / 第二幕 / 幕卡 2）——
    if (p < T.card2End) {
      if (inMoon) {
        clearMoonEntities();
        env.showEarth();
        inMoon = false;
      }
      ensureEarthRocket();
      ensureTransferScene();
      hideCard();

      if (p < T.liftEnd) {
        // 第一幕：点火起飞（上升 + 分离动效 + 发射轨迹）
        earthRocket.show = true;
        noteOn(false);
        const pos = rocketPosAt(p);
        earthRocket.position = Cesium.Cartesian3.fromDegrees(pos[0], pos[1], pos[2]);
        earthRocket.billboard.rotation = 0;
        if (p >= FAIRING_SEP) {
          earthRocket.billboard.image = STAGE1_ICON;
          earthRocket.label.text = '长征五号 · 整流罩分离';
        } else if (p >= BOOSTER_SEP) {
          earthRocket.billboard.image = STAGE1_ICON;
          earthRocket.label.text = '长征五号 · 助推器分离';
        } else {
          earthRocket.billboard.image = FULL_ROCKET_ICON;
          earthRocket.label.text = '长征五号 · 点火升空';
        }
        pushLaunchTrail(pos);
        updateSeparators();
        setPhase('第一幕 · 点火起飞');
        focusEarth(pos[2]);
      } else if (p < T.card1End) {
        // 幕卡 1：点火起飞 → 月地转移
        clearSeparators();
        earthRocket.show = false;
        noteOn(false);
        showCard('第一幕 · 点火起飞完成\n「进入地月转移轨道」');
        setPhase('幕间');
        focusEarth(200000);
      } else if (p < T.transferEnd) {
        // 第二幕：月地转移（局部太阳系顶视图）
        earthRocket.show = true;
        noteOn(true);
        const s = clamp01((p - T.card1End) / (T.transferEnd - T.card1End));
        const pos = rocketPosAt(p);
        earthRocket.position = Cesium.Cartesian3.fromDegrees(pos[0], pos[1], pos[2]);
        earthRocket.billboard.rotation = flightRotation(p);
        earthRocket.billboard.image = SPACECRAFT_ICON;
        earthRocket.label.text = '探月飞船 · 地月转移';
        updateTransferTrail(s);
        setPhase('第二幕 · 月地转移（距离已压缩 · 示意）');
        lookAtTransfer();
      } else {
        // 幕卡 2：转移 → 环月/着陆
        clearSeparators();
        earthRocket.show = false;
        showCard('第二幕 · 抵达月球影响球\n「准备环月制动与着陆」');
        setPhase('幕间');
        lookAtTransfer();
      }
      return;
    }

    // —— 月球侧（第三幕：环月制动 → 动力下降着陆）——
    hideCard();
    noteOn(false);
    if (earthRocket) earthRocket.show = false;
    clearSeparators();
    ensureMoonScene();
    const mv = env.getMoonViewer();
    if (!mv || !moonCraft) return;
    const site = MOON_LANDING_SITES[landingSiteKey];

    if (p < T.loiEnd) {
      // 环月制动 LOI：沿环月轨迹半圈降轨，俯视机位便于观察轨道
      const s = clamp01((p - T.card2End) / (T.loiEnd - T.card2End));
      const lon = wrapLon(site.lon - 180 + 180 * s);
      const alt = lerp(800000, 200000, s);
      const craftPos = Cesium.Cartesian3.fromDegrees(lon, site.lat, alt, MOON_ELLIPSOID);
      moonCraft.position = craftPos;
      moonCraft.billboard.image = SPACECRAFT_ICON;
      moonCraft.label.text = '环月制动 · LOI';
      setPhase('第三幕 · 环月制动（LOI）');
      mv.camera.lookAt(
        Cesium.Cartesian3.ZERO,
        new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-62), MOON_R * 2.9)
      );
    } else {
      // 动力下降着陆（末端按 DEM 真实地形高接地，避免沉入月面）
      const s = clamp01((p - T.loiEnd) / (1 - T.loiEnd));
      const ground = sampleMoonHeight(site.lon, site.lat);
      let alt = ground + Math.max(0, descentAltitude(s));
      if (!isFinite(alt)) alt = Math.max(0, descentAltitude(s));
      const craftPos = Cesium.Cartesian3.fromDegrees(site.lon, site.lat, alt, MOON_ELLIPSOID);
      moonCraft.position = craftPos;
      moonCraft.billboard.image = LANDER_ICON;
      moonCraft.label.text = site.name + ' · 动力下降';
      setPhase(s >= 1 ? '第三幕 · 月面着陆完成' : '第三幕 · 月面着陆');
      // 关键：必须传 Cartesian3 本体；传 Property 会得到 NaN 相机 → 渲染崩溃
      mv.camera.lookAt(
        craftPos,
        new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-22), Math.max(1600, (alt - ground) * 2.4))
      );
    }
  }

  // ---- 进度跳转：跨幕时同步补建/清理场景与实体 ----
  function seekTo(f) {
    p = clamp01(f);
    if (!transferCarts.length) buildPathData();
    if (p < T.card2End) {
      // 地球侧：若在月球段则切回
      if (inMoon) {
        clearMoonEntities();
        env.showEarth();
        inMoon = false;
      }
      ensureEarthRocket();
      ensureTransferScene();
      earthRocket.show = true;
    } else {
      // 月球侧：藏地球火箭、清分离件、补建月球场景
      if (earthRocket) earthRocket.show = false;
      clearSeparators();
      ensureTransferScene();
      ensureMoonScene();
    }
    if (p >= 1) { playing = false; const b = $('tourPause'); if (b) b.textContent = '重播'; }
    render();
    const bar = $('tourBar');
    if (bar) bar.style.width = (p * 100).toFixed(2) + '%';
    const txt = $('tourProgressText');
    if (txt) txt.textContent = Math.round(p * 100) + '%';
  }

  function tick(now) {
    if (!playing && p >= 1) { raf = 0; return; }
    const dt = last ? (now - last) / 1000 : 0;
    last = now;
    if (playing) {
      p += (dt / BASE_DURATION) * mult;
      if (p >= 1) {
        p = 1;
        playing = false;
        const pb = $('tourPause');
        if (pb) pb.textContent = '重播';
      }
    }
    render();
    // requestRenderMode 下必须主动请求渲染，否则静态相机帧里火箭/飞船不重绘（画面冻住）
    earthViewer.scene.requestRender();
    const mv = env.getMoonViewer();
    if (mv) mv.scene.requestRender();
    const bar = $('tourBar');
    if (bar) bar.style.width = (p * 100).toFixed(2) + '%';
    const txt = $('tourProgressText');
    if (txt) txt.textContent = Math.round(p * 100) + '%';
    raf = requestAnimationFrame(tick);
  }

  function bindPanel() {
    const pb = $('tourPause');
    if (pb) {
      pb.classList.remove('hidden');
      pb.textContent = '暂停';
    }
    // 播完后再按 = 从头重播（完整复位：回地球、重建火箭、清分离件与月球实体）
    onPause = () => {
      if (p >= 1) seekTo(0);
      playing = !playing;
      const b = $('tourPause');
      if (b) b.textContent = playing ? '暂停' : '播放';
      if (playing && !raf) { last = 0; raf = requestAnimationFrame(tick); }
    };
    onStop = () => { if (!isRouteTourActive()) stop(); };
    const step = (dir) => {
      if (isRouteTourActive()) return;
      const cur = SPEED_STEPS.indexOf(mult);
      const idx = cur >= 0 ? cur : 1;
      mult = SPEED_STEPS[Math.max(0, Math.min(SPEED_STEPS.length - 1, idx + dir))];
      const l = $('timeSpeedLabel');
      if (l) l.textContent = mult + '×';
    };
    onSlower = () => step(-1);
    onFaster = () => step(1);
    pb?.addEventListener('click', onPause);
    $('tourStop')?.addEventListener('click', onStop);
    $('timeSlower')?.addEventListener('click', onSlower);
    $('timeFaster')?.addEventListener('click', onFaster);
    const l = $('timeSpeedLabel');
    if (l) l.textContent = mult + '×';

    // 进度条拖拽 seek（拖动期间暂停，松手恢复原播放态）
    const track = $('tourTrack');
    if (track) {
      track.style.position = 'relative';
      const seekFromEvent = (e) => {
        const rect = track.getBoundingClientRect();
        seekTo((e.clientX - rect.left) / rect.width);
      };
      onTrackDown = (e) => {
        _wasPlaying = playing;
        playing = false;
        seekFromEvent(e);
      };
      onTrackMove = (e) => { if (e.buttons & 1) seekFromEvent(e); };
      onTrackUp = () => {
        if (_wasPlaying && p < 1) playing = true;
        const b = $('tourPause');
        if (b) b.textContent = playing ? '暂停' : '播放';
        if (playing && !raf) { last = 0; raf = requestAnimationFrame(tick); }
      };
      track.addEventListener('pointerdown', onTrackDown);
      window.addEventListener('pointermove', onTrackMove);
      window.addEventListener('pointerup', onTrackUp);
    }
  }

  function unbindPanel() {
    $('tourPause')?.removeEventListener('click', onPause);
    $('tourStop')?.removeEventListener('click', onStop);
    $('timeSlower')?.removeEventListener('click', onSlower);
    $('timeFaster')?.removeEventListener('click', onFaster);
    const track = $('tourTrack');
    if (track && onTrackDown) track.removeEventListener('pointerdown', onTrackDown);
    if (onTrackMove) window.removeEventListener('pointermove', onTrackMove);
    if (onTrackUp) window.removeEventListener('pointerup', onTrackUp);
    onPause = onStop = onSlower = onFaster = null;
    onTrackDown = onTrackMove = onTrackUp = null;
  }

  function buildTicks() {
    const wrap = $('tourTicks');
    if (!wrap) return;
    wrap.innerHTML = '';
    for (const a of ACTS) {
      const dot = document.createElement('span');
      dot.className = 'fly-tick';
      dot.style.left = (a.f * 100).toFixed(2) + '%';
      dot.style.pointerEvents = 'auto';
      dot.style.cursor = 'pointer';
      dot.title = a.name;
      dot.addEventListener('pointerdown', (e) => e.stopPropagation());
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        seekTo(a.f);
      });
      wrap.appendChild(dot);
    }
  }

  function start(sel = {}) {
    if (raf) return;
    if (sel.launchSite && LAUNCH_SITES[sel.launchSite]) launchSiteKey = sel.launchSite;
    if (sel.landingSite && MOON_LANDING_SITES[sel.landingSite]) landingSiteKey = sel.landingSite;

    buildPathData();
    p = 0; mult = 1; playing = true; last = 0;
    inMoon = false;
    clearSeparators();
    ensureEarthRocket();
    ensureTransferScene();
    earthRocket.show = true;

    const panel = $('tourPanel');
    panel?.classList.remove('hidden');
    $('tourTitle').textContent = '探月任务 · 三幕剧';
    $('flyControls')?.classList.add('hidden');
    $('rocketControls')?.classList.add('hidden');
    $('btnLaunch')?.classList.add('hidden');
    buildTicks();

    env.onStatus?.('探月任务开始：点火升空…', 'ok');
    bindPanel();
    render();
    raf = requestAnimationFrame(tick);
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0; playing = false;
    clearSeparators();
    if (earthRocket) { earthViewer.entities.remove(earthRocket); earthRocket = null; }
    if (launchTrailEnt) { earthViewer.entities.remove(launchTrailEnt); launchTrailEnt = null; }
    if (transferFullEnt) { earthViewer.entities.remove(transferFullEnt); transferFullEnt = null; }
    if (transferTrailEnt) { earthViewer.entities.remove(transferTrailEnt); transferTrailEnt = null; }
    if (moonIconEnt) { earthViewer.entities.remove(moonIconEnt); moonIconEnt = null; }
    clearMoonEntities();
    try { earthViewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY); } catch { /* 忽略 */ }
    unbindPanel();
    hideCard();
    noteOn(false);
    inMoon = false;
    $('rocketPhase')?.classList.add('hidden');
    $('tourPanel')?.classList.add('hidden');
    $('tourPause')?.classList.add('hidden');
    $('tourTicks').innerHTML = '';
    env.onStatus?.('探月任务已停止', '');
  }

  return {
    start,
    stop,
    isActive: () => !!raf,
    setLaunchSite: (k) => { launchSiteKey = k; },
    setLandingSite: (k) => { landingSiteKey = k; },
    getLaunchSite: () => launchSiteKey,
    getLandingSite: () => landingSiteKey,
  };
}

export default createMoonMission;
