// 坐标系: WGS84 (EPSG:4326)，十进制度，坐标顺序统一为 [经度 lon, 纬度 lat]。
//   渲染端由 Cesium.Cartesian3.fromDegrees(lon, lat) / fromDegreesArray 直接使用，无需额外转换。
// 数据性质: 教学示意级。城市/地点坐标为近似位置（精度约市级 ±1–5 km）；
//           历史疆域/路线为简化示意，非考据级边界，仅供空间认知。
// 来源: 编译自公开地理资料与通史常识，非测绘权威数据；用于科普与家庭教育。

// 每个奇观使用专属缩略图标（marker → layer-renderer.js ICONS）
export const LAYER = {
  "id": "wonders",
  "name": "世界奇迹",
  "description": "古代七大奇迹 + 新七大奇迹，标注为奇观缩略形。",
  "icon": "★",
  "defaultColor": "#f1c40f",
  "groups": [
    {
      "id": "ancient",
      "name": "古代七大奇迹",
      "color": "#d4a04a",
      "marker": "wonder",
      "entities": [
        {
          "type": "point",
          "name": "吉萨大金字塔",
          "marker": "pyramid",
          "lon": 31.1,
          "lat": 29.9,
          "description": "唯一存世的古代七大奇迹，高 146m，建于前 2560 年。"
        },
        {
          "type": "point",
          "name": "巴比伦空中花园",
          "marker": "garden",
          "lon": 44.4,
          "lat": 32.5,
          "description": "传说尼布甲尼撒二世所建悬苑，疑已不存。"
        },
        {
          "type": "point",
          "name": "阿尔忒弥斯神庙",
          "marker": "temple",
          "lon": 27.4,
          "lat": 37.9,
          "description": "以弗所，献给狩猎女神，前 550 年建，毁于纵火。"
        },
        {
          "type": "point",
          "name": "宙斯巨像",
          "marker": "zeus",
          "lon": 21.6,
          "lat": 37.6,
          "description": "奥林匹亚，菲狄亚斯所雕 12m 高金象牙神像。"
        },
        {
          "type": "point",
          "name": "摩索拉斯陵墓",
          "marker": "mausoleum",
          "lon": 27.4,
          "lat": 37,
          "description": "哈利卡纳苏斯，波斯总督陵墓，高约 45m。"
        },
        {
          "type": "point",
          "name": "罗德岛太阳神巨像",
          "marker": "colossus",
          "lon": 28.2,
          "lat": 36.4,
          "description": "罗德港 33m 高铜像，前 280 年建，毁于地震。"
        },
        {
          "type": "point",
          "name": "亚历山大灯塔",
          "marker": "lighthouse",
          "lon": 29.9,
          "lat": 31.2,
          "description": "法罗斯岛灯塔，高约 120m，指引地中海航船千年。"
        }
      ]
    },
    {
      "id": "modern",
      "name": "新七大奇迹",
      "color": "#f1c40f",
      "marker": "wonder",
      "entities": [
        {
          "type": "point",
          "name": "万里长城",
          "marker": "greatwall",
          "lon": 116,
          "lat": 40.4,
          "description": "2007 年评选新七大奇迹之首，人类规模最大的防御工程。"
        },
        {
          "type": "point",
          "name": "佩特拉古城",
          "marker": "petra",
          "lon": 35.4,
          "lat": 30.3,
          "description": "约旦，纳巴泰玫瑰红岩都城，\"失落的玫瑰之城\"。"
        },
        {
          "type": "point",
          "name": "里约基督像",
          "marker": "christ",
          "lon": -43.2,
          "lat": -22.9,
          "description": "巴西里约科尔科瓦多山顶 38m 高基督像，张开双臂俯瞰城市。"
        },
        {
          "type": "point",
          "name": "马丘比丘",
          "marker": "machu",
          "lon": -72.5,
          "lat": -13.2,
          "description": "秘鲁，印加\"空中之城\"，海拔 2430m 的失落古城。"
        },
        {
          "type": "point",
          "name": "奇琴伊察",
          "marker": "chichen",
          "lon": -98,
          "lat": 20.7,
          "description": "墨西哥，玛雅库库尔坎金字塔，春分日影蛇神降世。"
        },
        {
          "type": "point",
          "name": "罗马斗兽场",
          "marker": "colosseum",
          "lon": 12.5,
          "lat": 41.9,
          "description": "永恒之城标志，弗拉维竞技场，可容 5 万观众。"
        },
        {
          "type": "point",
          "name": "泰姬陵",
          "marker": "taj",
          "lon": 78,
          "lat": 27.2,
          "description": "印度阿格拉，\"完美建筑\"，沙贾汗为爱妃所建大理石陵墓。"
        }
      ]
    }
  ]
};
