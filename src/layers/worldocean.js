// Auto-rebuilt from extracted-layers.json — DO NOT HAND-EDIT
export const LAYER = {
  "id": "worldocean",
  "name": "世界海洋地形",
  "description": "全球重要海峡、北极航道与著名海底地形。点击标注飞到推荐视角。",
  "icon": "◈",
  "defaultColor": "#2e6fb8",
  "groups": [
    {
      "id": "straits",
      "name": "海峡要冲",
      "color": "#2e6fb8",
      "marker": "strait",
      "entities": [
        {
          "type": "point",
          "name": "马六甲海峡",
          "lon": 102,
          "lat": 2.5,
          "description": "马来半岛与苏门答腊之间，连接南海与印度洋，\"东方十字路口\"，全球最繁忙海道之一。"
        },
        {
          "type": "point",
          "name": "霍尔木兹海峡",
          "lon": 56.3,
          "lat": 26.5,
          "description": "波斯湾出口，\"世界油阀\"，全球三分之一海运石油经此。"
        },
        {
          "type": "point",
          "name": "苏伊士运河",
          "lon": 32.6,
          "lat": 30.5,
          "description": "连通地中海与红海，1869 年通航，亚欧航线缩短约 7000 公里。"
        },
        {
          "type": "point",
          "name": "巴拿马运河",
          "lon": -79.9,
          "lat": 9.1,
          "description": "连通大西洋与太平洋，1914 年通航，\"世界桥梁\"。"
        },
        {
          "type": "point",
          "name": "白令海峡",
          "lon": -169.8,
          "lat": 65.8,
          "description": "亚洲与美洲分界，俄罗斯与美国最近处仅 4 公里；同时是北极航道东端出口。"
        },
        {
          "type": "point",
          "name": "直布罗陀海峡",
          "lon": -5.3,
          "lat": 36,
          "description": "欧洲与非洲分界，地中海与大西洋的唯一通道。"
        },
        {
          "type": "point",
          "name": "博斯普鲁斯海峡",
          "lon": 29,
          "lat": 41,
          "description": "黑海与地中海唯一通道，伊斯坦布尔横跨两岸，\"天下咽喉\"。"
        },
        {
          "type": "point",
          "name": "德朗海峡（东北航道瓶颈）",
          "lon": 170,
          "lat": 78,
          "description": "俄罗斯东北航道（北方海航道）关键瓶颈，连接东西伯利亚海与拉普捷夫海，冬季冰封但夏季通航。"
        },
        {
          "type": "point",
          "name": "帕里水道（西北航道主航路）",
          "lon": -105,
          "lat": 74.5,
          "description": "加拿大北极群岛最宽冰间水道，西北航道商业航路；2012 年首次通过大型货轮。"
        },
        {
          "type": "point",
          "name": "兰开斯特海峡（西北航道入口）",
          "lon": -84,
          "lat": 74.2,
          "description": "西北航道东端入口，连接巴芬湾与加拿大北极群岛内部水道。"
        }
      ]
    },
    {
      "id": "seafloor",
      "name": "海底地形",
      "color": "#607d8b",
      "entities": [
        {
          "type": "point",
          "name": "马里亚纳海沟",
          "lon": 142.59,
          "lat": 11.37,
          "viewpoint": {
            "height": 80000,
            "pitch": -45,
            "heading": 320,
            "exaggeration": 3
          },
          "description": "太平洋板块俯冲到菲律宾板块之下形成的海沟，最深处约 11000 米——珠峰\"站\"在沟底头也露不出水面。海水是半透明渲染，深色凹痕就是洋底地形。"
        },
        {
          "type": "point",
          "name": "波多黎各海沟",
          "lon": -66.5,
          "lat": 19.5,
          "viewpoint": {
            "height": 90000,
            "pitch": -45,
            "heading": 180,
            "exaggeration": 3
          },
          "description": "大西洋最深处（约 8400 米），北美的板块边界断裂带，2004 年这里曾发生 6.5 级地震引发波多黎各海啸。"
        },
        {
          "type": "point",
          "name": "汤加海沟",
          "lon": -176,
          "lat": -23,
          "viewpoint": {
            "height": 85000,
            "pitch": -42,
            "heading": 0,
            "exaggeration": 3
          },
          "description": "南太平洋最深处（约 10800 米），世界最深海沟之一；俯冲带的上方正是汤加群岛活火山弧。"
        },
        {
          "type": "point",
          "name": "克马德克海沟",
          "lon": -177,
          "lat": -31,
          "viewpoint": {
            "height": 80000,
            "pitch": -40,
            "heading": 0,
            "exaggeration": 3
          },
          "description": "与汤加海沟相连的同一俯冲带，向南延伸至新西兰北岛东岸，全长约 1000 公里。"
        },
        {
          "type": "point",
          "name": "爪哇海沟",
          "lon": 110,
          "lat": -10.5,
          "viewpoint": {
            "height": 75000,
            "pitch": -40,
            "heading": 200,
            "exaggeration": 2.5
          },
          "description": "印度洋最深处（约 7450 米），印度板块俯冲到巽他群岛之下；2004 年印度洋海啸的源头就在这条俯冲带。"
        },
        {
          "type": "point",
          "name": "红海海底裂谷",
          "lon": 37,
          "lat": 19.5,
          "viewpoint": {
            "height": 60000,
            "pitch": -50,
            "heading": 0,
            "exaggeration": 2
          },
          "description": "红海是未来新大洋的\"胚胎\"——阿拉伯板块与非洲板块正以每年约 1 厘米的速度分离，裂谷中央是活火山轴。"
        }
      ]
    }
  ]
};
