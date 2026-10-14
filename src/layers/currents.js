// Auto-rebuilt from extracted-layers.json — DO NOT HAND-EDIT
export const LAYER = {
  "id": "currents",
  "name": "洋流与季风",
  "description": "全球主要暖流与冷流，影响航海、贸易与气候。",
  "icon": "≈",
  "defaultColor": "#d92626",
  "groups": [
    {
      "id": "warm",
      "name": "暖流",
      "color": "#d92626",
      "entities": [
        {
          "type": "polyline",
          "name": "黑潮（日本暖流）",
          "coords": [
            [
              120,
              12
            ],
            [
              122,
              18
            ],
            [
              128,
              28
            ],
            [
              138,
              38
            ],
            [
              142,
              48
            ],
            [
              150,
              55
            ]
          ],
          "width": 3,
          "description": "黑潮，北太平洋西部强劲暖流，赤道暖水北送，影响东亚气候。"
        },
        {
          "type": "polyline",
          "name": "墨西哥湾流",
          "coords": [
            [
              82,
              25
            ],
            [
              80,
              28
            ],
            [
              77,
              33
            ],
            [
              70,
              38
            ],
            [
              60,
              45
            ],
            [
              45,
              52
            ]
          ],
          "width": 3,
          "description": "湾流，北大西洋最强暖流，将热带暖水送往欧洲，使西欧冬暖。"
        },
        {
          "type": "polyline",
          "name": "北大西洋暖流",
          "coords": [
            [
              45,
              52
            ],
            [
              30,
              58
            ],
            [
              15,
              62
            ],
            [
              0,
              65
            ],
            [
              -15,
              68
            ]
          ],
          "width": 3,
          "description": "北大西洋暖流，湾流延续，\"西北欧暖气管道\"。"
        },
        {
          "type": "polyline",
          "name": "北太平洋暖流",
          "coords": [
            [
              150,
              48
            ],
            [
              175,
              45
            ],
            [
              -165,
              45
            ],
            [
              -150,
              42
            ],
            [
              -130,
              40
            ]
          ],
          "width": 3,
          "description": "北太平洋暖流，黑潮延续，东流至北美西岸。"
        },
        {
          "type": "polyline",
          "name": "阿古拉斯暖流",
          "coords": [
            [
              40,
              -25
            ],
            [
              33,
              -30
            ],
            [
              25,
              -35
            ],
            [
              18,
              -38
            ]
          ],
          "width": 2,
          "description": "阿古拉斯暖流，印度洋西部南向暖流，沿非洲东岸南下。"
        },
        {
          "type": "polyline",
          "name": "莫桑比克暖流",
          "coords": [
            [
              44,
              -12
            ],
            [
              42,
              -18
            ],
            [
              40,
              -25
            ],
            [
              38,
              -30
            ]
          ],
          "width": 2,
          "description": "莫桑比克暖流，南印度洋西部，阿古拉斯暖流前段。"
        }
      ]
    },
    {
      "id": "cold",
      "name": "冷流",
      "color": "#00d4ff",
      "entities": [
        {
          "type": "polyline",
          "name": "加利福尼亚寒流",
          "coords": [
            [
              128,
              42
            ],
            [
              125,
              37
            ],
            [
              122,
              33
            ],
            [
              120,
              27
            ]
          ],
          "width": 2,
          "description": "加利福尼亚寒流，北太平洋东岸南向冷流，使旧金山雾多。"
        },
        {
          "type": "polyline",
          "name": "秘鲁寒流",
          "coords": [
            [
              -80,
              -5
            ],
            [
              -80,
              -15
            ],
            [
              -78,
              -25
            ],
            [
              -76,
              -35
            ]
          ],
          "width": 2,
          "description": "秘鲁寒流（洪堡寒流），南美西岸北向冷流，全球最强上升流之一。"
        },
        {
          "type": "polyline",
          "name": "本格拉寒流",
          "coords": [
            [
              12,
              -10
            ],
            [
              11,
              -18
            ],
            [
              10,
              -25
            ],
            [
              8,
              -32
            ]
          ],
          "width": 2,
          "description": "本格拉寒流，南大西洋东岸北向冷流，沿非洲西南岸。"
        },
        {
          "type": "polyline",
          "name": "拉布拉多寒流",
          "coords": [
            [
              -55,
              62
            ],
            [
              -52,
              55
            ],
            [
              -50,
              48
            ],
            [
              -48,
              42
            ]
          ],
          "width": 2,
          "description": "拉布拉多寒流，北大西洋西部南向冷流，携冰山南下，泰坦尼克沉没区域。"
        },
        {
          "type": "polyline",
          "name": "西风漂流",
          "coords": [
            [
              120,
              -50
            ],
            [
              160,
              -55
            ],
            [
              -160,
              -58
            ],
            [
              -120,
              -55
            ],
            [
              -80,
              -52
            ],
            [
              -40,
              -50
            ],
            [
              0,
              -52
            ],
            [
              40,
              -50
            ],
            [
              80,
              -52
            ],
            [
              120,
              -50
            ]
          ],
          "width": 2,
          "dashed": true,
          "description": "南极绕极流（西风漂流），全球唯一贯通经度的洋流，水量最大。"
        }
      ]
    }
  ]
};
