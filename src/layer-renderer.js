// src/layer-renderer.js — 图层渲染器
// 从 dist index--AIpTfEu.js 提取的 xa 函数完整逻辑

import * as Cesium from 'cesium';

const POINT_PIXEL_SIZE = 12;
const POINT_OUTLINE_WIDTH = 2;
const LABEL_FONT = '13px "Microsoft YaHei", "PingFang SC", sans-serif';

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

  function createEntity(entityData, options) {
    const { color, marker } = options;
    const common = {
      name: entityData.name,
      description: entityData.description ?? undefined,
    };

    if (entityData.type === 'point') {
      const pos = Cesium.Cartesian3.fromDegrees(entityData.lon, entityData.lat);
      const markerKey = entityData.marker ?? marker;
      const iconUrl = markerKey ? getIcon(markerKey) : null;
      const labelDef = {
        text: entityData.name,
        font: LABEL_FONT,
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.fromCssColorString('#000'),
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -18),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        showBackground: true,
        backgroundColor: new Cesium.Color(0.05, 0.08, 0.18, 0.65),
        backgroundPadding: new Cesium.Cartesian2(6, 4),
      };

      let ent;
      if (iconUrl) {
        ent = viewer.entities.add({
          ...common,
          position: pos,
          billboard: {
            image: iconUrl,
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
            color: color,
            outlineColor: Cesium.Color.fromCssColorString('#1a1a1a'),
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
      return viewer.entities.add({
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
      });
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
      return viewer.entities.add({
        ...common,
        position: Cesium.Cartesian3.fromDegrees(entityData.lon, entityData.lat),
        label: {
          text: entityData.text ?? entityData.name,
          font: LABEL_FONT,
          fillColor: color,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }

    return null;
  }

  /**
   * 添加图层
   * @param {object} layer LAYER 对象（含 id, name, defaultColor, groups[]）
   */
  function addLayer(layer) {
    if (layerMap.has(layer.id)) return;
    layerMap.set(layer.id, layer);

    const groupMap = new Map();
    for (const group of layer.groups) {
      const color = Cesium.Color.fromCssColorString(
        group.color ?? layer.defaultColor ?? '#ffffff'
      );
      const marker = group.marker ?? layer.marker ?? null;
      const entities = group.entities
        .map((entData) => createEntity(entData, { color, marker }))
        .filter(Boolean);

      // 标记 layerId / groupId
      for (const ent of entities) {
        ent._layerId = layer.id;
        ent._groupId = group.id;
        ent.show = false;
      }
      groupMap.set(group.id, entities);
    }
    groupEntityMap.set(layer.id, groupMap);
  }

  /**
   * 移除图层（删除所有实体）
   */
  function removeLayer(layerId) {
    const groupMap = groupEntityMap.get(layerId);
    if (groupMap) {
      for (const entities of groupMap.values()) {
        for (const ent of entities) {
          viewer.entities.remove(ent);
        }
      }
      groupEntityMap.delete(layerId);
    }
    layerMap.delete(layerId);
  }

  /**
   * 设置图层整体显隐
   */
  function setLayerVisible(layerId, visible) {
    const groupMap = groupEntityMap.get(layerId);
    if (!groupMap) return;
    for (const entities of groupMap.values()) {
      for (const ent of entities) {
        ent.show = visible;
      }
    }
  }

  /**
   * 设置特定分组显隐
   */
  function setGroupVisible(layerId, groupId, visible) {
    const groupMap = groupEntityMap.get(layerId);
    if (!groupMap) return;
    const entities = groupMap.get(groupId);
    if (entities) {
      for (const ent of entities) {
        ent.show = visible;
      }
    }
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
    // 暴露 groupEntityMap 供外部（如 main.js 构建树）查询分组实体
    _groupEntityMap: groupEntityMap,
  };
}
