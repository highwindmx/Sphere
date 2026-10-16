// 坐标系: WGS84 (EPSG:4326)，十进制度，坐标顺序统一为 [经度 lon, 纬度 lat]。
//   渲染端由 Cesium.Cartesian3.fromDegrees(lon, lat) / fromDegreesArray 直接使用，无需额外转换。
// 数据性质: 教学示意级。城市/地点坐标为近似位置（精度约市级 ±1–5 km）；
//           历史疆域/路线为简化示意，非考据级边界，仅供空间认知。
// 来源: 编译自公开地理资料与通史常识，非测绘权威数据；用于科普与家庭教育。

export const LAYER = {
  "id": "moonmission",
  "name": "探月任务",
  "description": "中国航天发射场。勾选显示发射场标注；点「🚀 探月任务」发起三幕剧。",
  "icon": "🚀",
  "defaultColor": "#d4a04a",
  "groups": [
    {
      "id": "pads",
      "name": "发射场",
      "color": "#d4a04a",
      "marker": "pad",
      "entities": [
        {
          "type": "point",
          "name": "酒泉卫星发射中心",
          "lon": 100.298,
          "lat": 40.96,
          "description": "1958 年建，中国第一个航天发射场：东方红一号、神舟系列在此升空。"
        },
        {
          "type": "point",
          "name": "太原卫星发射中心",
          "lon": 111.608,
          "lat": 38.849,
          "description": "1967 年建，主要承担太阳同步轨道卫星（气象、资源遥感）发射。"
        },
        {
          "type": "point",
          "name": "西昌卫星发射中心",
          "lon": 102.028,
          "lat": 28.246,
          "description": "1970 年建，地球同步轨道与探月工程主场：嫦娥一号至四号在此出发。"
        },
        {
          "type": "point",
          "name": "文昌航天发射场",
          "lon": 110.951,
          "lat": 19.614,
          "description": "2016 年启用，纬度最低、海运直达：长征五号、天问一号、嫦娥五六号在此发射。"
        }
      ]
    }
  ]
};
