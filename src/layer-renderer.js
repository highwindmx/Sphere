// src/layer-renderer.js — 图层渲染器
// 从 dist index--AIpTfEu.js 提取的 xa 函数完整逻辑

import * as Cesium from 'cesium';

const POINT_PIXEL_SIZE = 12;
const POINT_OUTLINE_WIDTH = 2;
// 标注字号：13px 中文字形在球面上偏小、笔画糊成一团（用户反馈"粗糙"）。
// 提到 17px 并加粗字重（bold 会让笔画更实），描边由 3 收窄到 2 —— 小字配粗描边会糊。
const LABEL_FONT = 'bold 17px "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif';
// 路线站点标注（stops）比主标注低一级
const STOP_LABEL_FONT = 'bold 15px "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif';
const LABEL_OUTLINE_WIDTH = 2;

// 从 dist 提取的 SVG icon data URL map
const ICONS = {
  landmark: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2L2 7v10l10 5 10-5V7L12 2zm0 2.2L19 8v8l-7 3.5L5 16V8l7-3.8z" fill="#ffd24a"/><circle cx="12" cy="11" r="2" fill="#ff6b6b"/></svg>`,
  rocket: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2c2 4 2 8 0 12l-2-6 2-6zm0 0c-2 4-2 8 0 12l-2-6 2-6zM8 14c-2 2-2 4-2 6 2 0 4 0 6-2l-4-4zm8 0l-4 4c2 2 4 2 6 2 0-2 0-4-2-6z" fill="#d4a04a"/><path d="M12 12l2 8h-4l2-8z" fill="#ff6b6b"/></svg>`,
  crater: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="#8b98b8" stroke="#c2cde6" stroke-width="1.5"/><ellipse cx="12" cy="12" rx="5" ry="3" fill="#4a5578"/></svg>`,
  mare: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><ellipse cx="12" cy="12" rx="10" ry="6" fill="#3a4a6a" stroke="#6b7a9e" stroke-width="1.5"/><ellipse cx="10" cy="11" rx="5" ry="3" fill="#4a5a7a"/></svg>`,
  pad: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="8" y="2" width="8" height="16" fill="#b8492e"/><rect x="6" y="18" width="12" height="4" fill="#444"/><path d="M10 22h4l-2-3-2 3z" fill="#ffd24a"/></svg>`,
  fairing: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M8 2c2 3 2 6 0 9l-2-4 2-5zm8 0c-2 3-2 6 0 9l2-4-2-5z" fill="#6b7a9e"/><path d="M8 11h8l-2 9h-4l-2-9z" fill="#d4a04a"/></svg>`,
  rocketFull: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2c-2 3-2 6 0 9l-2-4 2-5zm0 0c2 3 2 6 0 9l2-4-2-5z" fill="#d4a04a"/><rect x="10" y="11" width="4" height="8" fill="#4a5578"/><path d="M8 19h8l-2 3h-4l-2-3z" fill="#ff6b6b"/><path d="M6 13l-4 6 4-2v-4zm12 0l4 6-4-2v-4z" fill="#6b7a9e"/></svg>`,
  rocketBare: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 3c-2 3-2 5 0 8l-2-3 2-5zm0 0c2 3 2 5 0 8l2-3-2-5z" fill="#6b7a9e"/><rect x="10" y="11" width="4" height="7" fill="#4a5578"/><path d="M8 18h8l-2 3h-4l-2-3z" fill="#ff6b6b"/></svg>`,
  booster: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M6 6c-2 3-2 5 0 8l-2-4 2-4z" fill="#c2cde6"/><rect x="5" y="12" width="2" height="6" fill="#6b7a9e"/><path d="M4 18h4l-1 2H5l-1-2z" fill="#ff6b6b"/></svg>`,
  moon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 10 10A8 8 0 0 1 12 2z" fill="#e7ecf7"/></svg>`,
  rover: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="6" y="10" width="12" height="6" fill="#d4a04a" rx="1"/><circle cx="8" cy="17" r="2" fill="#444"/><circle cx="16" cy="17" r="2" fill="#444"/><rect x="10" y="5" width="4" height="6" fill="#8b98b8"/><rect x="11" y="3" width="2" height="3" fill="#c2cde6"/></svg>`,
  pole: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><polygon points="12,2 10,20 14,20" fill="#bdecf8"/><rect x="11" y="14" width="2" height="8" fill="#8b98b8"/></svg>`,
  // 城门楼（关隘）：立体城墙 + 拱门洞 + 双层飞檐楼阁（右侧暗面营造立体感）
  gate: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><polygon points="3,21 3,14 21,14 21,21" fill="#9aa0ac"/><polygon points="15,14 21,14 21,21 15,21" fill="#7c8290"/><path d="M10 21v-4a2 2 0 0 1 4 0v4z" fill="#3a3f4a"/><polygon points="4,14 12,10.5 20,14" fill="#b04a3a"/><rect x="7" y="6.5" width="10" height="4.5" fill="#c9ced8"/><rect x="15" y="6.5" width="2" height="4.5" fill="#a8adba"/><polygon points="5,6.5 12,3.5 19,6.5" fill="#b04a3a"/><polygon points="19,6.5 12,3.5 12,6.5" fill="#8a382c"/><rect x="10.6" y="8" width="2.8" height="3" fill="#4a3a30"/></svg>`,
  // 大坝（水利工程）：弧形坝体 + 上游水面 + 坝顶道路
  dam: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M3 20c6-1 12-1 18 0v-3c-6-1-12-1-18 0z" fill="#4a8eb8"/><path d="M4 17c1.5-6 4-10 8-13 4 3 6.5 7 8 13z" fill="#c9ced8"/><path d="M12 17c2.5-5 4.5-9 8-13-4 3-6.5 7-8 13z" fill="#a8adba" opacity="0.7"/><rect x="11" y="4" width="2" height="13" fill="#e7ecf7"/></svg>`,
  // ====== 世界奇迹缩略形 ======
  pyramid: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><polygon points="12,3 22,20 2,20" fill="#d9b36c"/><polygon points="12,3 22,20 12,20" fill="#b8934f"/><rect x="9" y="16" width="6" height="4" fill="#8a6d38"/></svg>`,
  garden: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><polygon points="4,20 8,15 16,15 20,20" fill="#b8a888"/><rect x="6" y="12" width="12" height="3" fill="#c9ba9a"/><circle cx="7.5" cy="10.5" r="2" fill="#6a9a4a"/><circle cx="12" cy="9.5" r="2.3" fill="#7cb342"/><circle cx="16.5" cy="10.5" r="2" fill="#6a9a4a"/></svg>`,
  temple: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><polygon points="3,9 12,4 21,9" fill="#c9ba9a"/><rect x="4" y="9" width="16" height="1.5" fill="#b0a280"/><rect x="5" y="10.5" width="2.2" height="9" fill="#ddd4c0"/><rect x="8.6" y="10.5" width="2.2" height="9" fill="#ddd4c0"/><rect x="12.2" y="10.5" width="2.2" height="9" fill="#ddd4c0"/><rect x="15.8" y="10.5" width="2.2" height="9" fill="#ddd4c0"/><rect x="3" y="19.5" width="18" height="1.5" fill="#b0a280"/></svg>`,
  zeus: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="10" cy="5" r="2.5" fill="#d4a04a"/><path d="M8 8h4l2 5-2 1 2 6h-3l-1-5-1 5H6l2-6-1.5-1z" fill="#d4a04a"/><polygon points="17,3 14.5,10 16.5,10 14,17 20,8.5 17.8,8.5 20,3" fill="#ffd24a"/></svg>`,
  mausoleum: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><polygon points="2,20 5,20 5,17 8,17 8,14 12,14 12,11 16,11 16,14 20,14 20,17 22,17 22,20" fill="#c2a878"/><polygon points="9,11 12,7 15,11" fill="#a88d5c"/><rect x="2" y="20" width="20" height="1.5" fill="#8a7045"/></svg>`,
  colossus: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="4.5" r="2.2" fill="#a67c3d"/><path d="M10 7h4v8h-4z" fill="#a67c3d"/><path d="M10 7L4 10v2l6-2zm4 0l6 3v2l-6-2z" fill="#a67c3d"/><path d="M9 15h6l1 6h-2l-1-4-1 4h-2l-1-6z" fill="#8a6428"/><rect x="11" y="2" width="2" height="1.5" fill="#ffd24a"/></svg>`,
  lighthouse: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><polygon points="9,21 10,8 14,8 15,21" fill="#c9ced8"/><rect x="9" y="5.5" width="6" height="2.5" fill="#b04a3a"/><circle cx="12" cy="4" r="1.8" fill="#ffd24a"/><path d="M9 4L5 2v4zm6 0l4-2v4z" fill="#ffd24a" opacity="0.6"/><polygon points="8,21 16,21 15,19 9,19" fill="#a8adba"/></svg>`,
  greatwall: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 20l5-3 5 3 5-3 5 3v-3l-5-3-5 3-5-3-5 3z" fill="#9aa0ac"/><rect x="9" y="8" width="5" height="9" fill="#b8beca"/><polygon points="8.5,8 11.5,5 14.5,8" fill="#b04a3a"/><rect x="10.7" y="10" width="1.6" height="3" fill="#3a3f4a"/></svg>`,
  petra: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><polygon points="2,21 4,10 20,10 22,21" fill="#c98a6b"/><polygon points="9,21 9,12 12,9 15,12 15,21" fill="#e8b394"/><rect x="10.8" y="15" width="2.4" height="6" fill="#7a4a30"/><rect x="9" y="12" width="6" height="2" fill="#d49a78"/><polygon points="4,10 12,4 20,10" fill="#b8765a"/></svg>`,
  christ: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="4" r="2" fill="#c9ced8"/><path d="M11 6h2v6h6v2h-6v9h-2v-9H5v-2h6z" fill="#c9ced8"/></svg>`,
  machu: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><polygon points="3,20 21,20 21,6 3,6" fill="#6a9a4a"/><path d="M3 20v-3h4v3zm4 0v-4h4v4zm4 0v-5h4v5zm4 0v-4h4v4z" fill="#7cb342"/><path d="M5 13h14v1.5H5zM7 10h10v1.5H7z" fill="#8a6d38"/><polygon points="3,6 12,2 21,6" fill="#5a7d3a"/></svg>`,
  chichen: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><polygon points="2,20 6,20 6,17 9,17 9,14 12,14 12,11 15,11 15,8 18,8 18,20 22,20" fill="#c9ba9a"/><polygon points="9,14 12,14 12,11 15,11 15,8 12,8 12,11 9,11" fill="#ddd4c0" opacity="0.5"/><rect x="11" y="16.5" width="2" height="3.5" fill="#3a3f4a"/></svg>`,
  colosseum: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><ellipse cx="12" cy="13" rx="10" ry="7" fill="#c9ba9a"/><ellipse cx="12" cy="12" rx="10" ry="7" fill="#ddd4c0"/><ellipse cx="12" cy="12" rx="6" ry="3.8" fill="#8a8272"/><path d="M4 10.5c2-1.5 5-2.5 8-2.5s6 1 8 2.5l-1 2c-1.8-1.3-4.3-2-7-2s-5.2.7-7 2z" fill="#b0a280"/><path d="M6 12.5c1.8-1 4-1.5 6-1.5s4.2.5 6 1.5v2c-1.8-1-4-1.5-6-1.5s-4.2.5-6 1.5z" fill="#8a8272"/></svg>`,
  taj: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><ellipse cx="12" cy="13" rx="5" ry="6" fill="#e7ecf7"/><path d="M8 13a4 4 0 0 1 8 0z" fill="#c9ced8"/><circle cx="12" cy="6.5" r="1.5" fill="#c9ced8"/><rect x="12" y="3" width="1" height="2.5" fill="#d4a04a"/><rect x="4" y="10" width="2" height="10" fill="#ddd4c0"/><rect x="18" y="10" width="2" height="10" fill="#ddd4c0"/><circle cx="5" cy="9" r="1" fill="#ddd4c0"/><circle cx="19" cy="9" r="1" fill="#ddd4c0"/><rect x="3" y="19" width="18" height="1.5" fill="#c9ba9a"/></svg>`,
  // 城市（世界大城市/首都）：三栋高低错落的楼体 + 窗格，剪影感强、26px 下可辨
  city: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="2.5" y="11" width="6.5" height="11" fill="#9fb4d8"/><rect x="10" y="6" width="5.5" height="16" fill="#c2cde6"/><rect x="16.5" y="13.5" width="5" height="8.5" fill="#8b98b8"/><rect x="4" y="13" width="1.4" height="1.6" fill="#3d4a66"/><rect x="6.5" y="13" width="1.4" height="1.6" fill="#3d4a66"/><rect x="4" y="16" width="1.4" height="1.6" fill="#3d4a66"/><rect x="6.5" y="16" width="1.4" height="1.6" fill="#3d4a66"/><rect x="11.4" y="8" width="1.5" height="1.7" fill="#3d4a66"/><rect x="13.6" y="8" width="1.5" height="1.7" fill="#3d4a66"/><rect x="11.4" y="11.4" width="1.5" height="1.7" fill="#3d4a66"/><rect x="13.6" y="11.4" width="1.5" height="1.7" fill="#3d4a66"/><rect x="11.4" y="14.8" width="1.5" height="1.7" fill="#3d4a66"/><rect x="13.6" y="14.8" width="1.5" height="1.7" fill="#3d4a66"/><rect x="18" y="15.4" width="1.4" height="1.6" fill="#3d4a66"/><rect x="19.8" y="15.4" width="1.4" height="1.6" fill="#3d4a66"/><rect x="18" y="18.2" width="1.4" height="1.6" fill="#3d4a66"/><rect x="19.8" y="18.2" width="1.4" height="1.6" fill="#3d4a66"/></svg>`,
};

const iconCache = new Map();

function getIcon(name) {
  if (!name || !ICONS[name]) return null;
  if (iconCache.has(name)) return iconCache.get(name);
  const url = `data:image/svg+xml,${encodeURIComponent(ICONS[name].trim())}`;
  iconCache.set(name, url);
  return url;
}

/**
 * 创建图层渲染器工厂
 * @param {Cesium.Viewer} viewer
 * @param {Cesium.Globe} globe
 */
export function createLayerRenderer(viewer, globe) {
  const layerMap = new Map();       // layerId → LAYER 对象
  const groupEntityMap = new Map(); // layerId → Map<groupId, Entity[]>
  let onClickCallback = null;
  let onStatusCallback = null;
  let offscreen = null;      // 屏幕边缘指示器（背面标记的折线引出，由 main.js 注入）

  // ====== 背面虚影：按「标注点朝向 vs 相机方向」平滑淡化背面实体 ======
  // disableDepthTestDistance=∞ 使背面点原本完全实心地透过地球显示；
  // 现在用 CallbackProperty 每帧计算朝向余弦，d≈1 正对相机(不透明)，d<0 背面(残影)。
  const GHOST_MIN_ALPHA = 0.15;
  const _camScratch = new Cesium.Cartesian3();

  function fadeColor(posCartesian, baseColor, baseAlpha = 1) {
    const unit = Cesium.Cartesian3.normalize(
      posCartesian,
      new Cesium.Cartesian3()
    );
    return new Cesium.CallbackProperty(() => {
      Cesium.Cartesian3.normalize(viewer.camera.positionWC, _camScratch);
      const d = Cesium.Cartesian3.dot(unit, _camScratch);
      const t = Math.min(1, Math.max(0, (d - 0.05) / 0.30)); // 0.05~0.35 平滑过渡带
      return baseColor.withAlpha(baseAlpha * (GHOST_MIN_ALPHA + (1 - GHOST_MIN_ALPHA) * t));
    }, false);
  }

  function createEntity(entityData, options) {
    const { color, marker } = options;
    const common = {
      name: entityData.name,
      description: entityData.description ?? undefined,
    };

    if (entityData.type === 'point') {
      const pos = Cesium.Cartesian3.fromDegrees(entityData.lon, entityData.lat);
      const fade = (base, a) => fadeColor(pos, base, a);
      const markerKey = entityData.marker ?? marker;
      const iconUrl = markerKey ? getIcon(markerKey) : null;
      const labelDef = {
        text: entityData.name,
        font: LABEL_FONT,
        fillColor: fade(Cesium.Color.WHITE),
        outlineColor: fade(Cesium.Color.BLACK),
        outlineWidth: LABEL_OUTLINE_WIDTH,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -22), // 字号变大后同步抬高，避免压住图标
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        showBackground: true,
        backgroundColor: fade(new Cesium.Color(0.05, 0.08, 0.18), 0.65),
        backgroundPadding: new Cesium.Cartesian2(6, 4),
      };

      let ent;
      if (iconUrl) {
        ent = viewer.entities.add({
          ...common,
          position: pos,
          billboard: {
            image: iconUrl,
            width: 26,
            height: 26,
            color: fade(Cesium.Color.WHITE),
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            scaleByDistance: new Cesium.NearFarScalar(2e5, 1.5, 8e6, 0.55),
          },
          label: labelDef,
        });
      } else {
        ent = viewer.entities.add({
          ...common,
          position: pos,
          point: {
            pixelSize: POINT_PIXEL_SIZE,
            color: fade(color),
            outlineColor: fade(Cesium.Color.fromCssColorString('#1a1a1a')),
            outlineWidth: POINT_OUTLINE_WIDTH,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: labelDef,
        });
      }
      if (entityData.viewpoint) ent._viewpoint = entityData.viewpoint;
      return ent;
    }

    if (entityData.type === 'polyline') {
      const flat = [];
      for (const [lon, lat] of entityData.coords) {
        flat.push(lon, lat);
      }
      const out = [
        viewer.entities.add({
          ...common,
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray(flat),
            width: entityData.width ?? 3,
            arcType: entityData.rhumb
              ? Cesium.ArcType.RHUMB
              : Cesium.ArcType.GEODESIC,
            material: entityData.dashed
              ? new Cesium.PolylineDashMaterialProperty({ color: color })
              : color,
            clampToGround: true,
          },
        }),
      ];
      // 路线节点名称标注（stops：[{lon,lat,name}]，与折线同组显隐）
      if (Array.isArray(entityData.stops)) {
        for (const st of entityData.stops) {
          if (typeof st.lon !== 'number' || typeof st.lat !== 'number') continue;
          const spos = Cesium.Cartesian3.fromDegrees(st.lon, st.lat);
          const stEnt = viewer.entities.add({
            name: st.name || '',
            description: st.description ?? undefined,
            position: spos,
            point: {
              pixelSize: 7,
              color: fadeColor(spos, color),
              outlineColor: fadeColor(spos, Cesium.Color.fromCssColorString('#1a1a1a')),
              outlineWidth: 1.5,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
            label: {
              text: st.name || '',
              font: STOP_LABEL_FONT,
              fillColor: fadeColor(spos, Cesium.Color.WHITE),
              outlineColor: fadeColor(spos, Cesium.Color.BLACK),
              outlineWidth: LABEL_OUTLINE_WIDTH,
              style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
              pixelOffset: new Cesium.Cartesian2(0, -12),
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              showBackground: true,
              backgroundColor: fadeColor(spos, new Cesium.Color(0.05, 0.08, 0.18), 0.65),
              backgroundPadding: new Cesium.Cartesian2(5, 3),
            },
          });
          out.push(stEnt);
        }
      }
      return out.length === 1 ? out[0] : out;
    }

    if (entityData.type === 'polygon') {
      const flat = [];
      for (const [lon, lat] of entityData.coords) {
        flat.push(lon, lat);
      }
      return viewer.entities.add({
        ...common,
        polygon: {
          hierarchy: Cesium.Cartesian3.fromDegreesArray(flat),
          material: color.withAlpha(0.3),
          outline: true,
          outlineColor: color,
          perPositionHeight: false,
        },
      });
    }

    if (entityData.type === 'label') {
      const pos = Cesium.Cartesian3.fromDegrees(entityData.lon, entityData.lat);
      return viewer.entities.add({
        ...common,
        position: pos,
        label: {
          text: entityData.text ?? entityData.name,
          font: LABEL_FONT,
          fillColor: fadeColor(pos, color),
          outlineColor: fadeColor(pos, Cesium.Color.BLACK),
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          // 底色衬托（与点标注一致），否则在复杂底图上看不清
          showBackground: true,
          backgroundColor: fadeColor(pos, new Cesium.Color(0.05, 0.08, 0.18), 0.65),
          backgroundPadding: new Cesium.Cartesian2(6, 4),
        },
      });
    }

    return null;
  }

  // ====== 球背面剔除：Cesium 官方 EllipsoidalOccluder（地平线遮挡判定）======
  // 背景：point/billboard/label 都设了 disableDepthTestDistance=∞（否则整点会被地形吃掉），
  // 代价是球背面的标记也会「透视」显示在球面上。官方成熟解法不是自己算点积，而是
  // EllipsoidalOccluder —— Cesium 内部做瓦片地平线剔除用的就是它，对任意椭球都成立。
  // 判定结果落到 ent.show（与分组显隐意图 _groupShow 取与），背面标记彻底不出现在球体上。
  let occludeBack = true;
  const _occluder = new Cesium.EllipsoidalOccluder(
    (viewer.scene && viewer.scene.globe && viewer.scene.globe.ellipsoid) || Cesium.Ellipsoid.WGS84,
    viewer.camera.positionWC
  );

  function isFrontFacing(cartesian) {
    try {
      _occluder.cameraPosition = viewer.camera.positionWC;
      return _occluder.isPointVisible(cartesian);
    } catch {
      return true;   // 判定失败时保守显示，绝不让标记凭空消失
    }
  }

  /** 逐实体更新正/背面显隐；返回本帧被判为背面的标记项（供屏幕边缘指示器使用） */
  function updateOcclusion() {
    const backItems = [];
    const julian = Cesium.JulianDate.now();
    for (const [layerId, groupMap] of groupEntityMap) {
      for (const [groupId, st] of groupMap) {
        if (!st.built) continue;
        const layer = layerMap.get(layerId);
        for (const ent of st.entities) {
          const intent = ent._groupShow !== false;
          if (!occludeBack || !ent.position) {
            ent.show = intent;
            ent._backface = false;
            continue;
          }
          let pos = null;
          try { pos = ent.position.getValue(julian); } catch { /* 非恒定位置 */ }
          if (!pos) { ent.show = intent; continue; }
          const front = isFrontFacing(pos);
          ent._backface = !front;
          ent.show = intent && front;
          if (!front && intent && ent.label) {
            let text = '';
            try { text = ent.label.text.getValue(julian) || ent.name || ''; } catch { text = ent.name || ''; }
            if (text) {
              backItems.push({
                name: text,
                position: Cesium.Cartesian3.clone(pos),
                layerId,
                groupId,
                color: layer && layer.groups.find((g) => g.id === groupId)
                  ? layer.groups.find((g) => g.id === groupId).color
                  : (layer ? layer.defaultColor : '#ffd24a'),
              });
            }
          }
        }
      }
    }
    if (offscreen) { offscreen.setItems(backItems); offscreen.update(); }
    return backItems;
  }

  // ====== 标注避让（dodge）：Cesium 官方 RectangleCollisionChecker，屏幕空间矩形碰撞 ======
  // 旧方案按「经纬度阈值」判断是否叠字——与屏幕像素距离不对应：低空时相距数百像素也被
  // 强制错开（文字飘离标注点），高空时真正叠字了阈值却不够。
  // 官方成熟解法：LabelCollection 内部就是用 RectangleCollisionChecker 记录已占用的屏幕
  // 矩形，新标签先 collides() 查询，冲突则让位（偏移）或让出（隐藏）。这里对 entity.label
  // 复现同一策略：投影到窗口坐标 → 估算包围盒 → 依次试偏移档位 → 全冲突则隐藏本条。
  const DODGE_MAX_ENTITIES = 420;          // 单帧参与避让的标注上限（其余保持原样，防卡顿）
  const DODGE_Y_STEPS = [0, -20, 20, -40, 40];  // 相对基线的候选偏移（优先向上抬）
  const DODGE_PAD = 2;                     // 包围盒外扩，避免文字贴边算作不冲突

  function labelText(ent) {
    if (!ent.label || !ent.label.text) return '';
    let t = '';
    try {
      const v = ent.label.text;
      t = typeof v.getValue === 'function' ? v.getValue(Cesium.JulianDate.now()) : v;
    } catch { t = ''; }
    return String(t || '');
  }

  /** 包围盒宽度估算：CJK 近似方字（1em），拉丁/数字约 0.55em */
  function estimateTextWidth(text, fontPx) {
    let em = 0;
    for (const ch of text) {
      const c = ch.codePointAt(0);
      em += c > 0x2e80 ? 1.0 : 0.55;
    }
    return em * fontPx + 12;   // +12：showBackground 的左右 padding
  }

  function labelFontPx(ent) {
    const f = ent.label && ent.label.font;
    if (!f) return 17;
    let s = '';
    try {
      s = typeof f.getValue === 'function' ? f.getValue(Cesium.JulianDate.now()) : f;
    } catch { s = ''; }
    const m = /(\d+(?:\.\d+)?)px/.exec(String(s));
    return m ? parseFloat(m[1]) : 17;
  }

  function applyDodges() {
    const scene = viewer.scene;
    const canvas = scene && scene.canvas;
    if (!canvas) return;
    const W = canvas.clientWidth || canvas.width || 0;
    const H = canvas.clientHeight || canvas.height || 0;
    const julian = Cesium.JulianDate.now();
    const cands = [];

    for (const groupMap of groupEntityMap.values()) {
      for (const st of groupMap.values()) {
        if (!st.built) continue;
        for (const ent of st.entities) {
          if (!ent.label || !ent.position) continue;
          if (ent._groupShow === false || ent._backface) continue;   // 隐藏/背面不参与占位
          let pos = null;
          try { pos = ent.position.getValue(julian); } catch { continue; }
          if (!pos) continue;
          let win = null;
          try { win = Cesium.SceneTransforms.worldToWindowCoordinates(scene, pos); } catch { win = null; }
          if (!win) continue;
          // 屏外（含余量）不参与避让，也不该被隐藏——交给边缘指示器处理
          if (win.x < -160 || win.y < -160 || win.x > W + 160 || win.y > H + 160) continue;
          const fontPx = labelFontPx(ent);
          cands.push({
            ent,
            wx: win.x,
            wy: win.y,
            w: estimateTextWidth(labelText(ent), fontPx),
            h: fontPx * 1.4 + 8,
            dist: Cesium.Cartesian3.distance(pos, viewer.camera.positionWC),
          });
        }
      }
    }

    // 近处标注优先占位（更符合「先看近的」的直觉）
    cands.sort((a, b) => a.dist - b.dist);
    if (cands.length > DODGE_MAX_ENTITIES) cands.length = DODGE_MAX_ENTITIES;

    let checker = null;
    try { checker = new Cesium.RectangleCollisionChecker(); } catch { checker = null; }
    if (!checker) return;   // 官方类缺失时保持原样，不做半吊子避让

    let _insertId = 0;
    for (const c of cands) {
      const ent = c.ent;
      // 基线偏移：第一次记录，之后每帧从基线重算（避免逐帧累加漂移）
      if (!ent._labelOffset0) {
        let cur = null;
        try {
          const po = ent.label.pixelOffset;
          cur = po && typeof po.getValue === 'function' ? po.getValue(julian) : po;
        } catch { cur = null; }
        ent._labelOffset0 = cur
          ? new Cesium.Cartesian2(cur.x, cur.y)
          : new Cesium.Cartesian2(0, -22);
      }
      const bx = ent._labelOffset0.x;
      const by = ent._labelOffset0.y;

      let placed = false;
      for (const dy of DODGE_Y_STEPS) {
        const cx = c.wx + bx;
        const bottom = c.wy + by + dy;      // verticalOrigin=BOTTOM：包围盒底边贴锚点上方
        // ⚠ 坑（2026-10-17 冒烟实测）：insert 的实参顺序是 **(id, rectangle)** ——
        //    minified 里 insert(e,t) → fromRectangleAndId(e,t,node)，后者取 t.west、e.id，
        //    与官方文档写的 (rectangle, id) 相反。传反了不报错，只会静默恒判「不冲突」，
        //    表现为所有标注照旧叠在一起；只传一个参数则会抛
        //    "Cannot read properties of undefined (reading 'west')"，异常穿出 tick
        //    会直接让 Cesium 停止渲染（Rendering has stopped）。
        const rect = new Cesium.Rectangle(
          cx - c.w / 2 - DODGE_PAD,
          bottom - c.h - DODGE_PAD,
          cx + c.w / 2 + DODGE_PAD,
          bottom + DODGE_PAD
        );
        if (!checker.collides(rect)) {
          checker.insert(++_insertId, rect);
          ent.label.pixelOffset = new Cesium.Cartesian2(bx, by + dy);
          ent.label.show = true;
          placed = true;
          break;
        }
      }
      if (!placed) {
        // 五档全冲突：让位隐藏（官方 demo 的取舍——宁缺毋乱）
        ent.label.show = false;
      }
    }
    // 未参与本帧避让的标注（背面/屏外/超上限）恢复显示，避免被上一帧的结论误伤
    const inFrame = new Set(cands.map((c) => c.ent));
    for (const groupMap of groupEntityMap.values()) {
      for (const st of groupMap.values()) {
        if (!st.built) continue;
        for (const ent of st.entities) {
          if (!ent.label || !ent.position) continue;
          if (inFrame.has(ent)) continue;
          if (ent._groupShow !== false && !ent._backface) ent.label.show = true;
        }
      }
    }
  }

  // 相机变化时节流重算（背面剔除 + 标注避让）
  let _camTimer = 0;
  viewer.camera.changed.addEventListener(() => {
    const now = Date.now();
    if (now - _camTimer < 200) return;
    _camTimer = now;
    updateOcclusion();
    applyDodges();
  });

  /**
   * 添加图层（懒加载：仅登记元数据，不立即建实体；首次 setGroupVisible(true) 时才构建）
   * 大幅降低启动开销——30+ 图层上千实体不再一次性创建。
   */
  function addLayer(layer) {
    if (layerMap.has(layer.id)) return;
    layerMap.set(layer.id, layer);

    const groupMap = new Map();
    for (const group of layer.groups) {
      groupMap.set(group.id, {
        group,          // 原始 group 定义（含 entities/color/marker）
        built: false,   // 是否已构建实体
        entities: [],   // 构建后的实体数组（未构建时为空）
        visible: false, // 当前显隐意图
      });
    }
    groupEntityMap.set(layer.id, groupMap);
  }

  /**
   * 去重：同位置（≈11m）+ 同文字的标注只保留一个。
   * 典型场景：罗马大道两条线路都以罗马为起点，stops 里各有一个"罗马" → 球面上叠字。
   * 只在本分组内去重，不同图层间互不影响。
   */
  function dedupeLabels(entities) {
    const seen = new Set();
    const kept = [];
    for (const ent of entities) {
      const text = ent.label && ent.label.text ? ent.label.text.getValue(Cesium.JulianDate.now()) : null;
      let key = null;
      if (text && ent.position) {
        const c = Cesium.Cartographic.fromCartesian(ent.position.getValue(Cesium.JulianDate.now()));
        if (c) key = `${text}|${c.longitude.toFixed(6)},${c.latitude.toFixed(6)}`;
      }
      if (key && seen.has(key)) { viewer.entities.remove(ent); continue; }
      if (key) seen.add(key);
      kept.push(ent);
    }
    return kept;
  }

  /**
   * 构建某个分组的实体（首次启用时调用）
   */
  function buildGroup(layer, st) {
    const group = st.group;
    const color = Cesium.Color.fromCssColorString(
      group.color ?? layer.defaultColor ?? '#ffffff'
    );
    const marker = group.marker ?? layer.marker ?? null;
    const entities = group.entities
      .map((entData) => createEntity(entData, { color, marker }))
      .flat(Infinity)
      .filter(Boolean);

    // 标记 layerId / groupId
    for (const ent of entities) {
      ent._layerId = layer.id;
      ent._groupId = group.id;
      ent._groupShow = st.visible;   // 分组显隐「意图」（背面剔除在此基础上再取与）
      ent.show = st.visible;
    }
    st.entities = dedupeLabels(entities);
    st.built = true;

    // 首次构建：立刻按当前相机做一次背面剔除 + 屏幕空间避让（否则背面件会先闪一帧）
    updateOcclusion();
    applyDodges();
  }

  /**
   * 移除图层（删除所有实体）
   */
  function removeLayer(layerId) {
    const groupMap = groupEntityMap.get(layerId);
    if (groupMap) {
      for (const st of groupMap.values()) {
        for (const ent of st.entities) {
          viewer.entities.remove(ent);
        }
      }
      groupEntityMap.delete(layerId);
    }
    layerMap.delete(layerId);
  }

  /**
   * 设置图层整体显隐（懒加载：visible=true 且未构建时才建实体）
   */
  function setLayerVisible(layerId, visible) {
    const groupMap = groupEntityMap.get(layerId);
    if (!groupMap) return;
    const layer = layerMap.get(layerId);
    for (const st of groupMap.values()) {
      st.visible = visible;
      if (visible && !st.built) {
        buildGroup(layer, st);
        continue;
      }
      if (st.built) {
        for (const ent of st.entities) {
          ent._groupShow = visible;
          ent.show = visible;
        }
      }
    }
    updateOcclusion();
    applyDodges();
    viewer.scene.requestRender();
  }

  /**
   * 设置特定分组显隐（懒加载核心）
   */
  function setGroupVisible(layerId, groupId, visible) {
    const groupMap = groupEntityMap.get(layerId);
    if (!groupMap) return;
    const st = groupMap.get(groupId);
    if (!st) return;
    st.visible = visible;
    // 仅当要显示且尚未构建时才建实体；隐藏未构建的图层不触发任何构建
    if (visible && !st.built) {
      buildGroup(layerMap.get(layerId), st);
      return;
    }
    if (st.built) {
      for (const ent of st.entities) {
        ent._groupShow = visible;
        ent.show = visible;
      }
    }
    updateOcclusion();
    applyDodges();
    viewer.scene.requestRender();
  }

  /**
   * 隐藏所有图层
   */
  function hideAll() {
    for (const layerId of layerMap.keys()) {
      setLayerVisible(layerId, false);
    }
  }

  /**
   * 点击处理：从 viewer.screenSpaceEventHandler 调用
   */
  function handleScreenClick(screenPos) {
    const picked = viewer.scene.pick(screenPos);
    if (!picked || !Cesium.defined(picked.id)) return;
    const ent = picked.id;
    if (!ent._layerId) return;

    const layer = layerMap.get(ent._layerId);
    let group = null;
    if (layer && ent._groupId) {
      group = layer.groups.find((g) => g.id === ent._groupId);
    }

    // 如果有 viewpoint 则 flyTo
    if (ent._viewpoint) {
      const vp = ent._viewpoint;
      if (vp.exaggeration !== undefined && globe) {
        globe.terrainExaggeration = vp.exaggeration;
      }
      // 从 entity position（polyline 取第一个点）飞到 viewpoint
      let dest;
      if (ent.position) {
        dest = ent.position.getValue(Cesium.JulianDate.now());
      } else if (ent.polyline) {
        const posProp = ent.polyline.positions;
        if (posProp && posProp.getValue) {
          const arr = posProp.getValue(Cesium.JulianDate.now());
          if (arr && arr.length) dest = arr[Math.floor(arr.length / 2)];
        }
      }
      if (dest) {
        // 上升到指定高度
        const carto = Cesium.Cartographic.fromCartesian(dest);
        dest = Cesium.Cartesian3.fromDegrees(
          Cesium.Math.toDegrees(carto.longitude),
          Cesium.Math.toDegrees(carto.latitude),
          vp.height ?? 1e5
        );
      }
      if (dest) {
        viewer.camera.flyTo({
          destination: dest,
          orientation: {
            heading: Cesium.Math.toRadians(vp.heading ?? 0),
            pitch: Cesium.Math.toRadians(vp.pitch ?? -35),
            roll: 0,
          },
          duration: 1.5,
        });
      }
    } else if (ent.position) {
      // 普通点：放大到 entity 位置
      const pos = ent.position.getValue
        ? ent.position.getValue(Cesium.JulianDate.now())
        : ent.position;
      if (pos) {
        viewer.camera.flyTo({
          destination: pos,
          orientation: {
            heading: 0,
            pitch: Cesium.Math.toRadians(-45),
            roll: 0,
          },
          duration: 1.2,
        });
      }
    }

    if (onClickCallback) {
      onClickCallback({ entity: ent, layer, group });
    }
  }

  function onClick(cb) {
    onClickCallback = cb;
  }

  function onStatus(cb) {
    onStatusCallback = cb;
  }

  function getLayer(layerId) {
    return layerMap.get(layerId);
  }

  function getAllLayers() {
    return Array.from(layerMap.values());
  }

  return {
    addLayer,
    removeLayer,
    setLayerVisible,
    setGroupVisible,
    hideAll,
    handleScreenClick,
    onClick,
    onStatus,
    getLayer,
    getAllLayers,
    // ====== 背面标记 / 标注避让（2026-10-17）======
    attachOffscreen: (ind) => { offscreen = ind; },
    /** 是否启用「球背面标记不显示」；关闭则回退到旧的半透明虚影行为 */
    setOccludeBack: (on) => {
      occludeBack = !!on;
      if (!occludeBack && offscreen) { offscreen.setItems([]); offscreen.update(); }
      updateOcclusion();
      applyDodges();
      viewer.scene.requestRender();
    },
    isOccludeBack: () => occludeBack,
    /** 冒烟/调试：当前被判为背面的标记数量 */
    debugBackfaceCount: () => {
      let n = 0;
      for (const groupMap of groupEntityMap.values()) {
        for (const st of groupMap.values()) {
          if (!st.built) continue;
          for (const ent of st.entities) if (ent._backface) n++;
        }
      }
      return n;
    },
    // 暴露 groupEntityMap 供外部（如 main.js 构建树）查询分组实体
    _groupEntityMap: groupEntityMap,
  };
}
