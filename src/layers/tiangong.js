// 坐标系: WGS84 (EPSG:4326)，十进制度，坐标顺序统一为 [经度 lon, 纬度 lat]。
//   渲染端由 Cesium.Cartesian3.fromDegrees(lon, lat) / fromDegreesArray 直接使用，无需额外转换。
// 数据性质: 教学示意级。城市/地点坐标为近似位置（精度约市级 ±1–5 km）；
//           历史疆域/路线为简化示意，非考据级边界，仅供空间认知。
// 来源: 编译自公开地理资料与通史常识，非测绘权威数据；用于科普与家庭教育。

export const LAYER = {
  "id": "tiangong",
  "name": "天宫空间站",
  "description": "中国空间站实时轨道（TLE 解算，约 400 km 高、92 分钟一圈）。勾选或点「📡 天宫轨道」加载，再点跟随飞行；取消勾选移除。",
  "icon": "🛰️",
  "defaultColor": "#ffd24a",
  "groups": []
};
