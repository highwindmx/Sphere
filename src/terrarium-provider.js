// src/terrarium-provider.js — 本地 Terrain Provider stub
// 原 dist 中无独立文件，地球地形使用默认 EllipsoidTerrainProvider + 极地补丁
// 月球地形有完整 LOLA DEM 实现（ba 类），此处提供一个简易 stub 接口

import * as Cesium from 'cesium';

/**
 * 简易本地 Terrain Provider
 * 尝试从 tiles/terrain/{z}/{x}/{y}.png 读取 heightmap PNG 并转 terrain mesh
 * 如果读取失败则 fallback 到空瓦片（Cesium 自动用椭球补）
 */
export class TerrariumTerrainProvider {
  constructor(options = {}) {
    this._tilingScheme = new Cesium.GeographicTilingScheme({
      numberOfLevelZeroTilesX: 1,
      numberOfLevelZeroTilesY: 1,
      ellipsoid: options.ellipsoid || Cesium.Ellipsoid.WGS84,
    });
    this._tileSize = options.tileSize || 65; // Cesium heightmap 标准：64+1
    this._maxLevel = options.maxLevel ?? 6;
    this._errorEvent = new Cesium.Event();
    this._ready = true;
  }

  get errorEvent() {
    return this._errorEvent;
  }
  get credit() {
    return undefined;
  }
  get tilingScheme() {
    return this._tilingScheme;
  }
  get ready() {
    return this._ready;
  }
  get readyPromise() {
    return Promise.resolve(true);
  }
  get hasWaterMask() {
    return false;
  }
  get hasVertexNormals() {
    return false;
  }

  getLevelMaximumGeometricError(level) {
    return 10000000 / Math.pow(2, level);
  }

  getTileDataAvailable(x, y, level) {
    return level <= this._maxLevel;
  }

  async requestTileGeometry(x, y, level) {
    try {
      const url = `tiles/terrain/${level}/${x}/${y}.png`;
      const resp = await fetch(url, { method: 'HEAD' });
      if (!resp.ok) return undefined;
      // 简化：直接返回 undefined 让 Cesium 用椭球替代
      // 完整实现需要用 Terrain.fromHeightmap()，本地瓦片稀疏时性能收益有限
      return undefined;
    } catch {
      return undefined;
    }
  }
}

export default TerrariumTerrainProvider;
