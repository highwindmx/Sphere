// 坐标系: WGS84 (EPSG:4326)，十进制度，坐标顺序统一为 [经度 lon, 纬度 lat]。
//   渲染端由 Cesium.Cartesian3.fromDegrees(lon, lat) / fromDegreesArray 直接使用，无需额外转换。
// 数据性质: 教学示意级。城市/地点坐标为近似位置（精度约市级 ±1–5 km）；
//           历史疆域/路线为简化示意，非考据级边界，仅供空间认知。
// 来源: 编译自公开地理资料与通史常识，非测绘权威数据；用于科普与家庭教育。

export const LAYER = {
  "id": "g318",
  "name": "G318 国道",
  "description": "上海—西藏樟木，约 5476 公里，从海平面到喜马拉雅南麓的景观大道。",
  "icon": "≈",
  "defaultColor": "#2e6fb8",
  "groups": [
    {
      "id": "route",
      "name": "G318 主线",
      "color": "#2e6fb8",
      "entities": [
        {
          "type": "polyline",
          "name": "G318 国道主线",
          "coords": [
            [
              121.47,
              31.23
            ],
            [
              120.62,
              31.32
            ],
            [
              120.1,
              30.87
            ],
            [
              118.76,
              30.95
            ],
            [
              117.49,
              30.66
            ],
            [
              117.06,
              30.54
            ],
            [
              114.87,
              30.45
            ],
            [
              114.31,
              30.59
            ],
            [
              112.24,
              30.33
            ],
            [
              111.29,
              30.7
            ],
            [
              109.49,
              30.27
            ],
            [
              108.57,
              30.3
            ],
            [
              108.78,
              29.53
            ],
            [
              107.76,
              29.33
            ],
            [
              106.55,
              29.56
            ],
            [
              105.59,
              30.53
            ],
            [
              104.07,
              30.57
            ],
            [
              103.04,
              29.98
            ],
            [
              102.03,
              30.05
            ],
            [
              100.27,
              30
            ],
            [
              99.11,
              30.86
            ],
            [
              98.6,
              29.68
            ],
            [
              97.84,
              29.67
            ],
            [
              96.17,
              29.8
            ],
            [
              95.77,
              29.86
            ],
            [
              94.36,
              29.65
            ],
            [
              91.13,
              29.65
            ],
            [
              88.88,
              29.27
            ],
            [
              87.08,
              28.64
            ],
            [
              85.98,
              28.16
            ],
            [
              85.98,
              28.02
            ]
          ],
          "description": "G318 国道，起点上海人民广场，终点西藏聂拉木樟木口岸，全长约 5476 公里，是中国最长的国道之一。"
        }
      ]
    },
    {
      "id": "cities",
      "name": "沿线节点",
      "color": "#5b9bd5",
      "marker": "city",
      "entities": [
        {
          "type": "point",
          "name": "上海",
          "lon": 121.47,
          "lat": 31.23,
          "description": "G318 起点，长江入海口，中国海拔基准点（0 m）。"
        },
        {
          "type": "point",
          "name": "苏州",
          "lon": 120.62,
          "lat": 31.32,
          "description": "京杭运河与 318 交汇，江南水乡代表。"
        },
        {
          "type": "point",
          "name": "湖州",
          "lon": 120.1,
          "lat": 30.87,
          "description": "太湖南岸，丝绸之府。"
        },
        {
          "type": "point",
          "name": "宣城",
          "lon": 118.76,
          "lat": 30.95,
          "description": "皖南宣纸产地，敬亭山下。"
        },
        {
          "type": "point",
          "name": "池州",
          "lon": 117.49,
          "lat": 30.66,
          "description": "九华山门户，长江南岸。"
        },
        {
          "type": "point",
          "name": "安庆",
          "lon": 117.06,
          "lat": 30.54,
          "description": "黄梅戏故乡，大别山门户。"
        },
        {
          "type": "point",
          "name": "黄冈",
          "lon": 114.87,
          "lat": 30.45,
          "description": "大别山南麓，东坡赤壁所在。"
        },
        {
          "type": "point",
          "name": "武汉",
          "lon": 114.31,
          "lat": 30.59,
          "description": "长江中游枢纽，九省通衢。"
        },
        {
          "type": "point",
          "name": "荆州",
          "lon": 112.24,
          "lat": 30.33,
          "description": "江汉平原，古楚都郢所在。"
        },
        {
          "type": "point",
          "name": "宜昌",
          "lon": 111.29,
          "lat": 30.7,
          "description": "长江三峡东口，葛洲坝与三峡工程所在。"
        },
        {
          "type": "point",
          "name": "恩施",
          "lon": 109.49,
          "lat": 30.27,
          "description": "武陵山区，土家族苗族自治州首府。"
        },
        {
          "type": "point",
          "name": "利川",
          "lon": 108.57,
          "lat": 30.3,
          "description": "齐岳山麓，鄂西入川咽喉。"
        },
        {
          "type": "point",
          "name": "黔江",
          "lon": 108.78,
          "lat": 29.53,
          "description": "武陵山腹地，渝东南门户。"
        },
        {
          "type": "point",
          "name": "武隆",
          "lon": 107.76,
          "lat": 29.33,
          "description": "喀斯特天生三桥、地缝所在地。"
        },
        {
          "type": "point",
          "name": "重庆",
          "lon": 106.55,
          "lat": 29.56,
          "description": "两江交汇的山城，318 与长江并行段。"
        },
        {
          "type": "point",
          "name": "遂宁",
          "lon": 105.59,
          "lat": 30.53,
          "description": "涪江中游，川中\"观音故里\"。"
        },
        {
          "type": "point",
          "name": "成都",
          "lon": 104.07,
          "lat": 30.57,
          "description": "川西平原，318 由平原入高原的转折点。"
        },
        {
          "type": "point",
          "name": "雅安",
          "lon": 103.04,
          "lat": 29.98,
          "description": "青衣江畔，\"雨城\"，进藏前最后一座大城市。"
        },
        {
          "type": "point",
          "name": "康定",
          "lon": 102.03,
          "lat": 30.05,
          "description": "折多河畔，\"跑马溜溜的山\"，汉藏分界。"
        },
        {
          "type": "point",
          "name": "理塘",
          "lon": 100.27,
          "lat": 30,
          "description": "世界高城，海拔约 4014 m，毛垭大草原。"
        },
        {
          "type": "point",
          "name": "巴塘",
          "lon": 99.11,
          "lat": 30.86,
          "description": "川藏南线出川口，金沙江大桥前哨。"
        },
        {
          "type": "point",
          "name": "芒康",
          "lon": 98.6,
          "lat": 29.68,
          "description": "藏东门户，滇藏线与 318 交汇处。"
        },
        {
          "type": "point",
          "name": "左贡",
          "lon": 97.84,
          "lat": 29.67,
          "description": "澜沧江畔，业拉山七十二拐下方。"
        },
        {
          "type": "point",
          "name": "八宿",
          "lon": 96.17,
          "lat": 29.8,
          "description": "怒江七十二拐另一端，然乌湖门户。"
        },
        {
          "type": "point",
          "name": "波密",
          "lon": 95.77,
          "lat": 29.86,
          "description": "帕隆藏布江畔，冰川之乡。"
        },
        {
          "type": "point",
          "name": "林芝",
          "lon": 94.36,
          "lat": 29.65,
          "description": "尼洋河与雅鲁藏布江交汇，\"西藏江南\"。"
        },
        {
          "type": "point",
          "name": "拉萨",
          "lon": 91.13,
          "lat": 29.65,
          "description": "布达拉宫所在，318 沿线文化中心。"
        },
        {
          "type": "point",
          "name": "日喀则",
          "lon": 88.88,
          "lat": 29.27,
          "description": "后藏中心，扎什伦布寺所在。"
        },
        {
          "type": "point",
          "name": "定日",
          "lon": 87.08,
          "lat": 28.64,
          "description": "珠峰北坡门户，绒布寺大本营方向。"
        },
        {
          "type": "point",
          "name": "聂拉木",
          "lon": 85.98,
          "lat": 28.16,
          "description": "喜马拉雅南坡，樟木口岸驻地。"
        },
        {
          "type": "point",
          "name": "樟木口岸",
          "lon": 85.98,
          "lat": 28.02,
          "description": "G318 终点，中尼边境友谊桥前哨。"
        }
      ]
    }
  ]
};
