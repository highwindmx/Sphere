// 坐标系: WGS84 (EPSG:4326)，十进制度，[经度 lon, 纬度 lat]。
//   注：太空主题条目本身不对应地表地点，标注坐标取相关机构所在地（NASA 中心 / ESA 总部等），
//       仅作"可在地球仪上找到该线上体验入口"的锚点；url 为官方线上可视化 / 科普入口。
// 数据性质: 教学 / 科普向。点击标注（InfoBox）或检索结果里的 🔗 按钮，在新标签打开对应网页。
// 来源: 各机构官网，2026-10-30 逐条核实页面存活。

export const LAYER = {
  "id": "spacetour",
  "name": "线上太空漫游",
  "description": "NASA / ESA 等官方太空可视化与科普的线上入口。",
  "icon": "🚀",
  "defaultColor": "#6b7a9e",
  "groups": [
    {
      "id": "main",
      "name": "官方太空体验",
      "color": "#6b7a9e",
      "marker": "rocket",
      "entities": [
        {
          "type": "point",
          "name": "NASA 官网",
          "lon": -77.01,
          "lat": 38.88,
          "description": "美国宇航局官网，含 Eyes 太阳系可视化、阿波罗档案等。",
          "url": "https://www.nasa.gov"
        },
        {
          "type": "point",
          "name": "NASA Eyes（太阳系实时 3D 可视化）",
          "lon": -80.65,
          "lat": 28.52,
          "description": "NASA Eyes：太阳系 / 系外行星 / 小行星实时 3D 可视化。",
          "url": "https://eyes.nasa.gov"
        },
        {
          "type": "point",
          "name": "NASA 太阳系探索",
          "lon": -118.17,
          "lat": 34.2,
          "description": "NASA 太阳系探索总入口（行星 / 卫星 / 小行星 / 彗星）。",
          "url": "https://science.nasa.gov/solar-system/"
        },
        {
          "type": "point",
          "name": "詹姆斯·韦布空间望远镜",
          "lon": -76.85,
          "lat": 39.02,
          "description": "JWST 官方站点，深空红外天文台图像与科普。",
          "url": "https://webbtelescope.org"
        },
        {
          "type": "point",
          "name": "哈勃空间望远镜",
          "lon": -76.62,
          "lat": 39.33,
          "description": "HST 官方图像库与科普（STScI）。",
          "url": "https://hubblesite.org"
        },
        {
          "type": "point",
          "name": "欧洲空间局 ESA",
          "lon": 2.23,
          "lat": 48.85,
          "description": "ESA 官网，欧洲航天任务与数据。",
          "url": "https://www.esa.int"
        },
        {
          "type": "point",
          "name": "国际空间站（实时追踪）",
          "lon": -95.1,
          "lat": 29.55,
          "description": "实时查看国际空间站当前位置（ESA）。",
          "url": "https://www.esa.int/Science_Exploration/Human_and_Robotic_Exploration/International_Space_Station/Where_is_the_International_Space_Station"
        }
      ]
    }
  ]
};
