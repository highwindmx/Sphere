// 坐标系: WGS84 (EPSG:4326)，十进制度，[经度 lon, 纬度 lat]。
//   渲染端由 Cesium.Cartesian3.fromDegrees(lon, lat) 直接使用。
// 数据性质: 各馆坐标为近似位置（精度约市级 ±1–5 km）；url 为官方线上漫游 / 数字馆藏入口。
//   点击球面上的标注（InfoBox）或检索结果里的 🔗 按钮，即可在新标签打开对应网页。
// 来源: 各馆官方网站，2026-10-30 逐条核实页面存活（含用户提供的 virtual.basilicasanpietro.va）。

export const LAYER = {
  "id": "museums",
  "name": "数字博物馆",
  "description": "全球代表性博物馆与艺术馆的官方线上漫游 / 数字馆藏入口。",
  "icon": "🏛",
  "defaultColor": "#c97b4a",
  "groups": [
    {
      "id": "main",
      "name": "线上漫游",
      "color": "#c97b4a",
      "marker": "landmark",
      "entities": [
        {
          "type": "point",
          "name": "中国国家博物馆",
          "lon": 116.39,
          "lat": 39.91,
          "description": "北京，全景国博 / 藏品总目。",
          "url": "https://www.chnmuseum.cn"
        },
        {
          "type": "point",
          "name": "卢浮宫",
          "lon": 2.336,
          "lat": 48.861,
          "description": "巴黎，官网在线虚拟参观（多个展厅 360°）。",
          "url": "https://www.louvre.fr/en/visites-en-ligne"
        },
        {
          "type": "point",
          "name": "大英博物馆",
          "lon": -0.127,
          "lat": 51.519,
          "description": "伦敦，在线藏品近 500 万件，可放大细看。",
          "url": "https://www.britishmuseum.org/collection"
        },
        {
          "type": "point",
          "name": "大都会艺术博物馆",
          "lon": -73.963,
          "lat": 40.779,
          "description": "纽约，Open Access 藏品（CC0 可下载）。",
          "url": "https://www.metmuseum.org"
        },
        {
          "type": "point",
          "name": "梵蒂冈博物馆",
          "lon": 12.453,
          "lat": 41.906,
          "description": "梵蒂冈，虚拟游览（7 馆 + 西斯廷礼拜堂）。",
          "url": "https://www.museivaticani.va"
        },
        {
          "type": "point",
          "name": "圣伯多禄大殿虚拟游览",
          "lon": 12.453,
          "lat": 41.904,
          "description": "罗马 / 梵蒂冈，360° 实景虚拟游览（用户推荐）。",
          "url": "https://virtual.basilicasanpietro.va/it"
        },
        {
          "type": "point",
          "name": "乌菲齐美术馆",
          "lon": 11.255,
          "lat": 43.768,
          "description": "佛罗伦萨，360° 虚拟游览。",
          "url": "https://www.uffizi.it/en/online-exhibitions/uffizi-virtual-tour"
        },
        {
          "type": "point",
          "name": "荷兰国立博物馆",
          "lon": 4.885,
          "lat": 52.36,
          "description": "阿姆斯特丹，在线藏品 / 杰作。",
          "url": "https://www.rijksmuseum.nl/en"
        },
        {
          "type": "point",
          "name": "普拉多博物馆",
          "lon": -3.692,
          "lat": 40.414,
          "description": "马德里，在线收藏 6000+ 件。",
          "url": "https://www.museodelprado.es/"
        },
        {
          "type": "point",
          "name": "艾尔米塔什博物馆（冬宫）",
          "lon": 30.315,
          "lat": 59.939,
          "description": "圣彼得堡，虚拟参观（全景）。",
          "url": "https://www.hermitagemuseum.org/"
        },
        {
          "type": "point",
          "name": "盖蒂博物馆",
          "lon": -118.473,
          "lat": 34.077,
          "description": "洛杉矶，艺术与档案在线。",
          "url": "https://www.getty.edu/"
        },
        {
          "type": "point",
          "name": "伦敦自然历史博物馆",
          "lon": -0.176,
          "lat": 51.496,
          "description": "伦敦，在线展览 / 馆藏。",
          "url": "https://www.nhm.ac.uk/"
        },
        {
          "type": "point",
          "name": "梵高博物馆",
          "lon": 4.884,
          "lat": 52.357,
          "description": "阿姆斯特丹，馆藏在线。",
          "url": "https://www.vangoghmuseum.nl/"
        },
        {
          "type": "point",
          "name": "凡尔赛宫",
          "lon": 2.12,
          "lat": 48.804,
          "description": "巴黎，Google Arts 街景展厅。",
          "url": "https://artsandculture.google.com/partner/palace-of-versailles"
        },
        {
          "type": "point",
          "name": "谷歌艺术与文化（全球数字馆藏入口）",
          "lon": -122.08,
          "lat": 37.42,
          "description": "聚合 2000+ 机构的虚拟游览与数字馆藏（总入口）。",
          "url": "https://artsandculture.google.com"
        }
      ]
    }
  ]
};
