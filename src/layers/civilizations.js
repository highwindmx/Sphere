// Auto-rebuilt from extracted-layers.json — DO NOT HAND-EDIT
export const LAYER = {
  "id": "civilizations",
  "name": "古文明发源地",
  "description": "两河、尼罗、印度河、黄河、爱琴、玛雅、印加七大古文明。",
  "icon": "◈",
  "defaultColor": "#d4a04a",
  "groups": [
    {
      "id": "centers",
      "name": "文明中心",
      "color": "#d4a04a",
      "marker": "civ",
      "entities": [
        {
          "type": "point",
          "name": "两河文明（巴比伦）",
          "lon": 44.4,
          "lat": 32.5,
          "description": "美索不达米亚，苏美尔→巴比伦→亚述，楔形文字与汉谟拉比法典，人类最早城市文明。"
        },
        {
          "type": "point",
          "name": "尼罗文明（底比斯）",
          "lon": 32.6,
          "lat": 25.7,
          "description": "古埃及，尼罗河定期泛滥孕育，金字塔与象形文字，法老王国延续三千年。"
        },
        {
          "type": "point",
          "name": "印度河文明（摩亨佐达罗）",
          "lon": 68.1,
          "lat": 27.3,
          "description": "哈拉帕文明，印度河流域，规划严整的城市与排水系统，前 2500 年鼎盛。"
        },
        {
          "type": "point",
          "name": "黄河文明（二里头）",
          "lon": 112.5,
          "lat": 34.7,
          "description": "华夏文明发祥地，二里头疑为夏都，青铜礼器与甲骨文字，延续至今唯一未中断的古文明。"
        },
        {
          "type": "point",
          "name": "爱琴文明（克诺索斯）",
          "lon": 25.1,
          "lat": 35.3,
          "description": "米诺斯文明，克里特岛克诺索斯王宫，欧洲最早文明，前 2000 年鼎盛。"
        },
        {
          "type": "point",
          "name": "玛雅文明（蒂卡尔）",
          "lon": -89.6,
          "lat": 17.2,
          "description": "中美洲玛雅文明，尤卡坦半岛热带丛林，历法与天文，前 250 年至 900 年鼎盛。"
        },
        {
          "type": "point",
          "name": "印加文明（库斯科）",
          "lon": -71.1,
          "lat": -13.5,
          "description": "安第斯山印加帝国，以库斯科为中心，无文字结绳记事，前 15 世纪统一安第斯。"
        }
      ]
    },
    {
      "id": "regions",
      "name": "文明区域",
      "color": "#c9a04e",
      "entities": [
        {
          "type": "polygon",
          "name": "两河流域",
          "coords": [
            [
              43,
              35
            ],
            [
              48,
              35
            ],
            [
              48,
              31
            ],
            [
              43,
              31
            ]
          ],
          "description": "底格里斯与幼发拉底两河流域，\"美索不达米亚\"（两河之间）。"
        },
        {
          "type": "polygon",
          "name": "尼罗河流域",
          "coords": [
            [
              31,
              31
            ],
            [
              33,
              31
            ],
            [
              33,
              24
            ],
            [
              31,
              24
            ]
          ],
          "description": "尼罗河中下游，\"埃及是尼罗河的赠礼\"。"
        },
        {
          "type": "polygon",
          "name": "印度河流域",
          "coords": [
            [
              67,
              28
            ],
            [
              74,
              28
            ],
            [
              74,
              24
            ],
            [
              67,
              24
            ]
          ],
          "description": "印度河中下游，哈拉帕文明核心区。"
        },
        {
          "type": "polygon",
          "name": "黄河流域",
          "coords": [
            [
              102,
              38
            ],
            [
              118,
              38
            ],
            [
              118,
              34
            ],
            [
              102,
              34
            ]
          ],
          "description": "黄河中下游，华夏文明核心区，\"中原\"。"
        }
      ]
    }
  ]
};
