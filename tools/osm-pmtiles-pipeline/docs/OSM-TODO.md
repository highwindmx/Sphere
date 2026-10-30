# 离线 OSM 瓦片 —— 待办 / 问题单

> 记录时间：2026-10-26 04:45（441 城单批跑批进行中）
> 用途：本轮跑批不便中断修改的问题先记账，跑完后统一后补。
> 相关脚本：`tools/osm-pmtiles-pipeline/pbf-to-pmtiles.py`（抽取）、`tools/osm-pmtiles-pipeline/bgroup-cities-manifest.py`（清单）、
> `tools/osm-pmtiles-pipeline/geo-country.py`（国别判定）、`tools/osm-pmtiles-pipeline/run-remaining.py`（队列）、`tools/osm-pmtiles-pipeline/reuse-v1.py`（旧瓦片回收）

---

## A. 抽出来是 EMPTY（源 pbf 里没有数据）

共 7 座。原因分两类：源包不含该地区 / 坐标本身在海上或境外。

| 城市 | 现归属 pbf | 原因 | 建议后补 |
|---|---|---|---|
| 里斯本 | spain | Geofabrik **spain 包不含葡萄牙** | 下载 `portugal-latest.osm.pbf`（约 100 MB）后重抽；或接受在线兜底 |
| 都拉基乌姆（都拉斯） | greece | 阿尔巴尼亚不在 greece 包 | 下载 `albania-latest.osm.pbf`（很小）后重抽；或在线兜底 |
| 拜占庭（君士坦丁堡） | greece | **其实就是伊斯坦布尔**，被错分到 greece 包 | ⭐ 零成本：清单里 OVERRIDE 改指 `turkey`（该城已出 34.7 MB） |
| 波斯湾（巴林） | iran | 海上坐标，源包无数据 | 改为在线兜底或从清单移除 |
| 忽鲁谟斯 | iran | 同上 | 同上 |
| 阿曼湾 | iran | 同上 | 同上 |
| 木鹿（马雷） | iran | 土库曼斯坦境内，iran 包不含 | 同上（或归并到中亚、用 asia 源重抽） |

## B. 疑似重复但**已保留独立条目**（待用户定夺）

去重规则目前是「同 pbf + 中心距 <0.08°」+「同城同国 + 小框被大框完整包含 + <0.12°」。
下面这几对超出阈值，本轮**保持独立**，若想合并（省算力、但失去特写）再说：

| 子条目 | 母城 | 中心距 | 备注 |
|---|---|---|---|
| 金字塔（吉萨）T3 | 开罗 T1 | 0.198°（22 km） | 独立奇观，保留特写合理 |
| 埼玉 T2 | 东京 T1 | 0.175°（19 km） | 独立都会 |
| 川崎 T2 | 东京 T1 | 0.160°（18 km） | 独立都会 |
| 新山 T2 | 新加坡 T1 | 0.161°（18 km） | ⚠ **跨国**：新山属马来西亚，现文件名被标成 `亚洲_新加坡_新山`，应纠偏为马来西亚 |

## C. 源城市库坐标错误（丝路层疑似批量填错）

- 伊吾（哈密）93.90, 40.40 与 沙州（敦煌）93.87, 40.36 几乎重合（实际相距约 400 km）
- 阳关 与 伊州（哈密）同为一点（实际相距约 500 km）

影响：这几条抽出来的框指向错误地点。后补方式：单独校一遍丝路/玄奘层坐标表（`tools/_all_cities.json` 的 silkroad / xuanzang / passes 层）。

## D. 国别归属已修（本轮，留档）

geo-country.py 的国家粗矩形在边境/高原互有重叠，取"面积最小框"时会判错。已修：

- 中国 20 条：拉萨/日喀则/林芝/波密/八宿→印度、南宁/昆仑关/马关→越南、焉耆/龟兹/疏勒/跋禄迦→哈萨克/吉尔吉斯、定日/聂拉木/樟木口岸→尼泊尔、丽江古城→缅甸 → 全部改回中国（用 CHINA_POLY 真实轮廓 + CN_FORCE 白名单）
- 美国南部 6 条：休斯敦/圣安东尼奥/圣迭戈/奥斯汀/新奥尔良/达拉斯 → 墨西哥，改回美国
- 欧洲 4 条：维也纳→匈牙利、慕尼黑→奥地利、德累斯顿→捷克、斯特拉斯堡→德国，全部改回
- 那霸：按用户指定归 **琉球**（不写日本）

## E. 源 pbf 可删清单（等本轮 441 城全部跑完再动）

| 档 | 文件 | 体积 | 说明 |
|---|---|---|---|
| 可删 | `shanghai.osm.pbf` | 0.03 GB | 文件头损坏，且 ⊂ china |
| 可删 | `sea-latest` | 3.43 GB | ⊂ asia |
| 可删 | `japan-latest` | 2.38 GB | ⊂ asia |
| 可删 | `alps-latest` | 2.17 GB | ⊂ dach + france + italy |
| 可删 | `china-latest` | 1.50 GB | ⊂ asia |
| 保留 | `turkey` / `russia` / 各国小 extract | — | 小文件走"快速通道"，比裁 asia 快 5~150 倍 |
| 绝不能删 | `asia` / `us` / `africa` / `south-america` / `central-america` / `australia-oceania` | — | 唯一数据源 |

---

## 本轮跑批收尾清单（跑完后必做）

1. `./.venv/Scripts/python.exe tools/osm-pmtiles-pipeline/merge-manifests.py` —— 把所有 `m_*.json` 合并成前端读的 `manifest.json`
2. 抽查 3~5 座城在地球上的实际观感（尤其北京：大兴机场/通州是否进框）
3. 按本节 A/B/C 逐项后补
4. 最后再决定是否删 E 档的 pbf
