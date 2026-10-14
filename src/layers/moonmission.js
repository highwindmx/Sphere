// Auto-rebuilt from extracted-layers.json — DO NOT HAND-EDIT
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
