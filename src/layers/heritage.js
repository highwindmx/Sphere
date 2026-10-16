// 坐标系: WGS84 (EPSG:4326)，十进制度，坐标顺序统一为 [经度 lon, 纬度 lat]。
//   渲染端由 Cesium.Cartesian3.fromDegrees(lon, lat) / fromDegreesArray 直接使用，无需额外转换。
// 数据性质: 教学示意级。城市/地点坐标为近似位置（精度约市级 ±1–5 km）；
//           历史疆域/路线为简化示意，非考据级边界，仅供空间认知。
// 来源: 编译自公开地理资料与通史常识，非测绘权威数据；用于科普与家庭教育。

export const LAYER = {
  "id": "heritage",
  "name": "世界遗产",
  "description": "全球约 25 处代表性世界遗产分布。",
  "icon": "◈",
  "defaultColor": "#5d8f5d",
  "groups": [
    {
      "id": "main",
      "name": "遗产名录",
      "color": "#5d8f5d",
      "marker": "heritage",
      "entities": [
        {
          "type": "point",
          "name": "长城（八达岭）",
          "lon": 116,
          "lat": 40.4,
          "description": "万里长城，1987 年列入，人类历史上规模最大的防御工程。"
        },
        {
          "type": "point",
          "name": "故宫",
          "lon": 116.4,
          "lat": 39.9,
          "description": "北京故宫，明清皇宫，1987 年列入，世界最大宫殿群。"
        },
        {
          "type": "point",
          "name": "秦始皇陵兵马俑",
          "lon": 109.3,
          "lat": 34.4,
          "description": "秦始皇陵，1987 年列入，\"世界第八大奇迹\"。"
        },
        {
          "type": "point",
          "name": "莫高窟",
          "lon": 94.8,
          "lat": 40,
          "description": "敦煌莫高窟，1987 年列入，丝路佛教艺术宝库。"
        },
        {
          "type": "point",
          "name": "布达拉宫",
          "lon": 91.1,
          "lat": 29.65,
          "description": "拉萨布达拉宫，1994 年列入，藏式建筑巅峰。"
        },
        {
          "type": "point",
          "name": "丽江古城",
          "lon": 100.2,
          "lat": 26.9,
          "description": "丽江古城，1997 年列入，纳西文化活态遗产。"
        },
        {
          "type": "point",
          "name": "苏州园林",
          "lon": 120.6,
          "lat": 31.3,
          "description": "苏州古典园林，1997 年列入，\"咫尺之内再造乾坤\"。"
        },
        {
          "type": "point",
          "name": "杭州西湖",
          "lon": 120.1,
          "lat": 30.2,
          "description": "杭州西湖文化景观，2011 年列入，\"淡妆浓抹总相宜\"。"
        },
        {
          "type": "point",
          "name": "黄山",
          "lon": 118.2,
          "lat": 30.3,
          "description": "黄山，1990 年列入，\"五岳归来不看山，黄山归来不看岳\"。"
        },
        {
          "type": "point",
          "name": "九寨沟",
          "lon": 103.9,
          "lat": 33.2,
          "description": "九寨沟，1992 年列入，童话世界般的钙华湖泊。"
        },
        {
          "type": "point",
          "name": "泰山",
          "lon": 117.1,
          "lat": 36.3,
          "description": "泰山，1987 年列入，五岳之首，\"封禅\"圣地。"
        },
        {
          "type": "point",
          "name": "金字塔（吉萨）",
          "lon": 31.1,
          "lat": 29.9,
          "description": "孟菲斯与吉萨金字塔，1979 年列入，古埃及文明象征。"
        },
        {
          "type": "point",
          "name": "卢克索",
          "lon": 32.6,
          "lat": 25.7,
          "description": "底比斯古城与帝王谷，1979 年列入，\"百门之城\"。"
        },
        {
          "type": "point",
          "name": "佩特拉",
          "lon": 35.4,
          "lat": 30.3,
          "description": "佩特拉古城，1985 年列入，纳巴泰玫瑰红岩都城。"
        },
        {
          "type": "point",
          "name": "雅典卫城",
          "lon": 23.7,
          "lat": 38,
          "description": "雅典卫城，1987 年列入，西方文明与民主发祥地。"
        },
        {
          "type": "point",
          "name": "罗马斗兽场",
          "lon": 12.5,
          "lat": 41.9,
          "description": "罗马历史中心，1980 年列入，永恒之城的标志。"
        },
        {
          "type": "point",
          "name": "吴哥窟",
          "lon": 103.9,
          "lat": 13.4,
          "description": "吴哥古迹群，1992 年列入，高棉帝国佛教圣城。"
        },
        {
          "type": "point",
          "name": "泰姬陵",
          "lon": 78,
          "lat": 27.2,
          "description": "泰姬陵，1983 年列入，\"完美建筑\"，莫卧儿艺术巅峰。"
        },
        {
          "type": "point",
          "name": "京都古都",
          "lon": 135.8,
          "lat": 35,
          "description": "古都京都，1994 年列入，日本文化精神原乡。"
        },
        {
          "type": "point",
          "name": "马丘比丘",
          "lon": -72.5,
          "lat": -13.2,
          "description": "马丘比丘，1983 年列入，\"空中之城\"，印加失落古城。"
        },
        {
          "type": "point",
          "name": "自由女神像",
          "lon": -74,
          "lat": 40.7,
          "description": "自由女神像，1984 年列入，\"自由照耀世界\"。"
        },
        {
          "type": "point",
          "name": "威尼斯",
          "lon": 12.3,
          "lat": 45.4,
          "description": "威尼斯及其潟湖，1987 年列入，水都之城。"
        },
        {
          "type": "point",
          "name": "巴黎塞纳河畔",
          "lon": 2.35,
          "lat": 48.85,
          "description": "巴黎塞纳河畔，1991 年列入，\"光明之城\"。"
        },
        {
          "type": "point",
          "name": "大堡礁",
          "lon": 147,
          "lat": -18.3,
          "description": "大堡礁，1981 年列入，世界最大珊瑚礁系统。"
        },
        {
          "type": "point",
          "name": "巨石阵",
          "lon": -1.8,
          "lat": 51.2,
          "description": "巨石阵，1986 年列入，史前巨石文化谜题。"
        }
      ]
    }
  ]
};
