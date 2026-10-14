// Auto-rebuilt from extracted-layers.json — DO NOT HAND-EDIT
export const LAYER = {
  "id": "zhenghe",
  "name": "郑和下西洋",
  "description": "郑和七下西洋航线，南京→东南亚→印度→东非，海上丝路延伸。",
  "icon": "≈",
  "defaultColor": "#1e4a7a",
  "groups": [
    {
      "id": "main",
      "name": "西洋主线",
      "color": "#1e4a7a",
      "entities": [
        {
          "type": "polyline",
          "name": "郑和主航线（南京→忽鲁谟斯）",
          "coords": [
            [
              118.8,
              32
            ],
            [
              121.1,
              31.5
            ],
            [
              109,
              13.8
            ],
            [
              102.3,
              2.2
            ],
            [
              104.7,
              -3
            ],
            [
              95.3,
              5.5
            ],
            [
              79.8,
              6.9
            ],
            [
              75.8,
              11.3
            ],
            [
              56.3,
              26.6
            ]
          ],
          "width": 3,
          "description": "郑和主航线，南京经东南亚过马六甲海峡至印度古里，再入阿拉伯海至忽鲁谟斯，1405-1433 年七下西洋。"
        }
      ]
    },
    {
      "id": "africa",
      "name": "东非支线",
      "color": "#2e6fb8",
      "entities": [
        {
          "type": "polyline",
          "name": "东非支线（古里→麻林地）",
          "coords": [
            [
              75.8,
              11.3
            ],
            [
              45.3,
              2
            ],
            [
              40.1,
              -3.1
            ]
          ],
          "width": 2,
          "dashed": true,
          "description": "东非支线，自古里横渡阿拉伯海抵东非，最远达肯尼亚马林迪，带回\"麒麟\"（长颈鹿）。"
        }
      ]
    }
  ]
};
