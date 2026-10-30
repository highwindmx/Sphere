# OSM → PMTiles 离线瓦片生产管线

> 本文件夹是 **sphere 项目里「离线 OSM 街道级瓦片」的完整生产链路**，已从主项目
> `tools/pmtiles/` 摘出、自包含。它只负责**把 OSM 源 `.osm.pbf` 切成单文件 `.pmtiles`**，
> 产物供前端 `src/osm-map-scene.js`（MapLibre 离线场景 + 地球模式 OSM 按钮高亮）消费。
>
> 前端运行时只读 `public/data/osm/pmtiles/manifest.json`，**不依赖本文件夹的任何脚本**；
> 本文件夹只在「需要重新生成/修补瓦片」时才用得到。

---

## 1. 总体链路

```
① 源 .osm.pbf  （Geofabrik 下载，public/OSM/*.osm.pbf；已在 2026-10-27 由用户删除）
      ↓ 按城市 bbox 裁剪 + 抽城（pbf-to-pmtiles.py，pyosmium 维护节点索引）
② 每城 1 个 .pmtiles 文件  +  每源包 1 个 m_<组>.json（抽取结果登记）
      ↓ merge-manifests.py 把所有 m_*.json 合并
③ 前端读的 manifest.json  （城市名 → 文件/ bbox / center / minz / maxz / 瓦片数）
      ↓ 运行时按命中 bbox + 相机高度 < 10km 探测「本地可用」
④ 地球模式 OSM 按钮变绿脉冲；点击 → MapLibre 离线街道级场景
```

最终成品规模：**433 城 / 432 个 `.pmtiles` 文件**（拜占庭复用伊斯坦布尔文件，故条目多 1），
约 6.6 GB，全部位于 `public/data/osm/pmtiles/`。

---

## 2. 目录结构

```
tools/osm-pmtiles-pipeline/
├── README.md                      # 本文件（方法总结）
├── pbf-to-pmtiles.py              # ★核心：单城/单组抽取（pbf → .pmtiles + m_<组>.json）
├── merge-manifests.py             # ★合成前端 manifest.json
├── run-remaining.py               # 断点续跑队列（按组调度 pbf-to-pmtiles）
├── progress-table.py              # 进度对账表
├── fix-country-names.py           # V1→V3 国别转码 + 旧名文件改名
├── fix-wrong-country.py           # 修正错误国别名（只改名不重抽，24+1 城）
├── scan-orphans.py                # 孤儿文件扫描（默认只报告，--quarantine 隔离）
├── geo-country.py                 # 国别判定（CHINA_POLY + CN_FORCE 白名单）
├── bgroup-cities-manifest.py      # 由 _all_cities.json 生成 _bgroup_manifest.vN.json
├── tour-cities-manifest.py        # 巡礼城市 → 源包对号入座
├── manifest-backfill.py           # 用 A 组原始清单回填 bbox/center
├── reuse-v1.py                    # v1 旧瓦片回收（仅历史）
├── _bgroup_manifest.v3.json       # ★权威城市清单（448 城；含 14 空城 + 拜占庭别名）
├── _bgroup_manifest.json          # v2 旧版（历史，未用）
├── _pmtiles_manifest.json         # A 组原始清单（含 bbox/lon/lat/pbf）
├── _all_cities.json / _world_cities.json / _tour_cities.json / extra-cities.json
└── docs/                         # 设计迭代与运维文档（见第 8 节）
    ├── OSM-MVT栅格化方案-V1..V5.md   # ⚠设计史：终版落地为 PMTiles，V1–V5 描述的
    │                               #   「MVT 栅格化贴 globe」方案已被废弃，仅作演进参考
    ├── OSM-TODO.md                 # 问题单（空城/重复/坐标错/国别/可删 pbf）
    └── RUN-LOCAL.md                # 本机跑批备忘录（命令行 + GBK/ACL 坑）
```

> **关于 `.mjs`**：本管线**没有任何 `.mjs`** —— 它是纯 Python。`src/osm-map-scene.js`
> 是前端消费端（运行时），不属于生产管线，留在主项目 `src/`。

---

## 3. 依赖与安装

- Python 3.13（建议用项目 `.venv`）。
- 关键第三方库：`pyosmium`（C++ 节点索引）、`mapbox_vector_tile`（MVT 编码）。
- ⚠ 安装坑：venv 默认可能缺 `mapbox_vector_tile`；且多个 dist-info 的 METADATA 缺失会导致
  `uv pip install` 报 numpy 读不了。**必须用 `--no-deps` 单独装**：

```bat
.\.venv\Scripts\python.exe -m pip install --no-deps mapbox-vector-tile pyosmium
```

- ⚠ Windows 中文 locale 默认 GBK：所有 `open()` 读清单/结果都必须显式 `encoding='utf-8'`
  （脚本已修复；`PYTHONUTF8=1` 可作兜底）。

---

## 4. 标准跑批流程（命令行）

```bat
:: 1) 断点续跑前先 dry-run 看计划（不抽）
.\.venv\Scripts\python.exe tools\osm-pmtiles-pipeline\run-remaining.py --dry-run

:: 2) 正式跑（按组调度；Ctrl+C 后可重跑，已生成的 .pmtiles 会自动跳过）
.\.venv\Scripts\python.exe tools\osm-pmtiles-pipeline\run-remaining.py

:: 3) 单组/单城重抽（指定 pbf 源与城市，用于补城）
.\.venv\Scripts\python.exe tools\osm-pmtiles-pipeline\pbf-to-pmtiles.py ^
    --manifest tools\osm-pmtiles-pipeline\_bgroup_manifest.v3.json ^
    --only china --cities "伊州（哈密）,海口"

:: 4) 进度对账
.\.venv\Scripts\python.exe tools\osm-pmtiles-pipeline\progress-table.py ^
    --manifest tools\osm-pmtiles-pipeline\_bgroup_manifest.v3.json

:: 5) 国别/坐标修正（改名，不重抽）—— 见第 5 节
.\.venv\Scripts\python.exe tools\osm-pmtiles-pipeline\fix-wrong-country.py

:: 6) 全部跑完后合成前端 manifest
.\.venv\Scripts\python.exe tools\osm-pmtiles-pipeline\merge-manifests.py
```

---

## 5. 国别与坐标修正（已落地，记录备查）

瓦片覆盖本身由真实坐标决定，国别只是**文件名标签**。下列修正都是「只改名、不重抽」：

| 修正 | 数量 | 做法 | 脚本 |
|---|---|---|---|
| 边境城误判邻国（西藏/新疆/云南→印/尼/缅/越/哈/吉；美南→墨；欧洲互错） | 24 | 磁盘 rename + 同步 `m_*.json` 的 `file` + V3 `country` | `fix-wrong-country.py`（CORRECT 表） |
| **新山 → 马来西亚**（原误标新加坡） | 1 | 同上 | `fix-wrong-country.py`（已加 `新山`） |
| **那霸 → 琉球**（用户指定，不写日本） | 1 | V3 `country` 改「琉球」 | 直接改 V3 |
| 拜占庭（君士坦丁堡）= 伊斯坦布尔 | 别名 | 不重抽，种子进 `m_asia.json`，`file` 指向已生成的 `亚洲_土耳其_伊斯坦布尔.pmtiles` | 手工（bgroup-cities-manifest 思路） |
| 里斯本 / 都拉基乌姆 | 重抽 | V3 `pbf` 指向 `portugal` / `albania`（源包需先下载） | `pbf-to-pmtiles.py` |
| 伊州（哈密） | 重抽 | V3 bbox 由 `[92.47,39.76,…]`（荒漠空框）改哈密真实 `[93.35,42.68,93.75,43.08]` | V3 + `pbf-to-pmtiles.py` |
| 海口 | 重抽 | V3 `pbf` 由 `sea` 改 `china`（sea 不含海南） | V3 + `pbf-to-pmtiles.py` |

---

## 6. 已知坑（按踩坑频率排序）

1. **GBK 解码崩溃**：Windows 默认 `open()` 按 GBK 读 UTF-8 清单/JSON → 必须 `encoding='utf-8'`。
2. **Windows 只读 ACL**：`fix-country-names.py` 写 `m_*.json` 时偶发 `PermissionError`，
   先 PowerShell `Get-ChildItem -Recurse | ForEach { $_.IsReadOnly=$false }` 清只读位。
3. **三级 ROOT**：脚本在 `tools/osm-pmtiles-pipeline/` 内，必须由 `__file__` 向上 `dirname` **三次**
   才到项目根（两级会错位一层）。
4. **文件名 slug**：城市磁盘名 = `_slug('大洲-国家-城市')`，括号/连字符/空格全转 `_`；
   对账必须用脚本的 `_slug`/`city_fname`，**不能**按原始中文名拼，否则假「缺失/孤儿」。
5. **Empty 城市**：源 pbf 该 bbox 内无 OSM 数据 → 抽取判定 `ok=False / file=None`，进不了 manifest；
   属正常（海上/小岛/坐标错），不是 bug。
6. **删了 pbf 就不能重抽**：本管线依赖 `public/OSM/*.osm.pbf` 源包。2026-10-27 用户已删除源 pbf，
   **此后只能改名/合并，无法再从源重抽**。再要补空城必须先重新下载对应 Geofabrik 包。
7. **只移不删**：清理孤儿/旧名文件一律 `shutil.move` 到 `archive/quarantine-pmtiles/`，绝不 `os.remove`
   （曾误删 64 个合法瓦片，立此铁律）。

---

## 7. 成品与前端消费

- 瓦片目录：`public/data/osm/pmtiles/*.pmtiles`（432 个）+ `manifest.json`（433 条目）。
- 读取器：`public/vendor/pmtiles-reader.js`（零依赖自写，npm/CDN 被沙箱挡故内置）。
- 前端逻辑：`src/osm-map-scene.js`
  - 地球模式每 400ms 轮询：相机中心命中某城 bbox 且高度 < 10km → 右侧浮动 🗺 与侧栏 🗺 OSM
    按钮切 `.osm-available`（绿色高亮 + 脉冲动画，见 `index.html`）；点击即切到该城离线街道级场景。
  - 月/火模式不亮（离线数据仅地球）。

---

## 8. 参考文献（`docs/`）

- `OSM-MVT栅格化方案-V1..V5.md`：**设计迭代史**。V1–V5 描述的是已被废弃的
  「MVT → 服务端栅格化 PNG → Cesium UrlTemplateImageryProvider」旧方案；
  **最终落地为本文档的 PMTiles 方案**（pbf → 单文件 pmtiles → MapLibre 离线场景）。
  保留作演进参考，实际方法以本 README 与脚本为准。
- `OSM-TODO.md`：空城/重复/坐标错/国别/可删 pbf 的问题单。
- `RUN-LOCAL.md`：本机跑批备忘录（命令行 + GBK/ACL 坑 + 依赖安装）。

---

## 9. 当前状态（2026-10-27）

- ✅ 433 城 / 432 文件就绪，manifest 与磁盘孤儿 0、错误国别残留 0。
- ✅ 新山已归马来西亚；那霸归琉球；拜占庭复用伊斯坦布尔。
- ⚠ 14 个 Empty 城市 + 拜占庭别名仍列于 V3（用于将来补抽），不影响前端。
- ⚠ 源 pbf 已删除，本管线从此只支持改名/合并类维护，不再能从源重抽。
  （2026-10-29 用户重新提供 `china-latest.osm.pbf`，中国区 121 城可重抽。）

---

## 9b. v3 分级抽稀 + multipolygon（2026-10-29）

**动机**：v2 的 `feat_zs` 只让 `highway class 0` 进全部 zoom，其余（**含全部面要素**）只进 `zmax`。
实测后果：上海 z11=4087 线/0 面、z13=167/0、z14=3/0 —— 缩小时水面/绿地/建筑全无，
只剩几根高速线。前端因此把离线缩放下限钉死在 z15（`detailZ`），用户无法缩小看大范围。

**v3 改动（`pbf-to-pmtiles.py`）**：

| 项 | v2 | v3 |
| --- | --- | --- |
| 分级策略 | 仅 hw class 0 进全级 | `feature_zooms()`：水体全级；绿地 z12+；其它面 z13+；建筑仅 z15 |
| 公路分级 | class 0 / 其余 | motorway·trunk 全级 / primary z12+ / secondary z13+ / tertiary z14+ / 其余 z15 |
| 简化容差 | z<13 → 1.0 | `_TOL_BY_Z`：z11=4.0、z12=2.0、z13=1.0、z14+ 不简化 |
| 小面过滤 | 无 | `_MIN_AREA_UNITS`：z11=400、z12=120、z13=30、z14=6 局部单位²（水体阈值 ×0.25） |
| relation | **完全不处理** | `collect_multipolygons()` 先收 relation，`finish_relations()` 拼环→shapely 逐瓦片裁剪发面（含 inner 洞） |
| manifest | 无标记 | 成功条目写 `overview: true`（前端据此放开缩放下限） |

**踩坑**：`_ROAD_MIN_Z.get(_ROAD_CLASS.get(hw,4), 0)` 的默认值必须是 **0**（class 0 不在表里），
写成 15 会让高速路只剩 z15 —— 缩小后整城无路。

**上海试点结果**（bbox 120.95,30.75,122.00,31.75，与旧文件实际覆盖一致）：

| | 旧 | 新 v3 |
| --- | --- | --- |
| 瓦片 | 12506 | 13880 |
| 体积 | 26.2 MB | 33.2 MB |
| z11 单瓦片 | 4087 线 / **0 面** | 1160 线 / 292 面 |
| z13 单瓦片 | 167 线 / **0 面** | 322 线 / 338 面 |
| z15 单瓦片 | 22 线 / 13 面 | 22 线 / 13 面（不变） |

命令（`--bbox` 的 pbf 段可为 Windows 绝对路径，解析用 `split(':', 2)`）：

```bat
.venv\Scripts\python.exe tools\osm-pmtiles-pipeline\pbf-to-pmtiles.py ^
  --bbox "上海v3:120.95,30.75,122.00,31.75:C:/Users/KaishengMao/Downloads/china-latest.osm.pbf" ^
  --out tools/osm-pmtiles-pipeline/work/pilot
```

产出 `上海v3.pmtiles` → 改名 `亚洲_中国_上海.v3.pmtiles` 放进 `public/data/osm/pmtiles/`，
manifest 里把 `上海` 条目的 `file` 指过去并加 `"overview": true`。旧文件保留不动。

**依赖补装**（`.venv` 里缺）：`uv pip install --no-deps --python .venv/Scripts/python.exe mapbox-vector-tile`
+ `uv pip install --no-deps --reinstall --python .venv/Scripts/python.exe protobuf`。

---

## 10. PMTiles Studio（可视化网页工作台）

让非命令行用户也能用：指定本地 pbf 路径 → 录入/导入若干「城市 = 名称 + 四至 + 层级」
→ 一键抽取 → **实时观察进度**。本质是把 `pbf-to-pmtiles.py` 包成网页，**核心脚本零改动**
（2026-10-30 起改为进程内加载核心模块，走与 `build-new-cities.py` 同源的路径）。

### 启动
```bat
.\.venv\Scripts\python.exe tools\osm-pmtiles-pipeline\pmtiles_studio.py
:: 默认 http://127.0.0.1:5011/   （独立端口，不与主项目 5008 冲突）
```

### 页面功能
1. **① 源 PBF 路径**：填本地 `.osm.pbf` 完整路径 + 「检查文件」（返回大小/存在）。
2. **② 城市定义表**：每行 = 名称 / 大洲 / 国家 / 最小经度 / 最小纬度 / 最大经度 / 最大纬度 /
   最小层级 / 最大层级；右下角实时预览输出文件名（`大洲_国家_名称.pmtiles`）。
   - `+ 添加一行` / `填充示例` / `删除行`
   - **导入 JSON**：支持两种格式——
     - 裸数组 `[{name, continent, country, bbox:[minlon,minlat,maxlon,maxlat], minz, maxz}, …]`
     - 或本管线清单 `{ "coverable": [ … ] }`（即 `_bgroup_manifest.v3.json` 结构）
     - 可点选文件，也可把 `.json` 拖进虚线框
   - **导出 JSON**：把当前表格导出为上述裸数组
3. **③ 输出目录**（默认 `public/data/osm/pmtiles`，瓦片落此即被前端 manifest 合并时纳入）
   + 并发 `chunk`（默认 16）。
   - **「🔀 并入前端 manifest」按钮**：手动触发合并（见下「并入机制」）。
   - **「完成后自动并入 manifest」勾选**：勾上后，每次抽取成功结束自动合并（默认**不勾**，
     让你先审一眼抽得对不对，避免手填坐标错误污染前端索引）。
4. **④ y 镜像翻转修复**：`🔍 预览待修复` / `🔧 执行修复`（可 1–8 进程）/ `登记为已正确`。
   统计行显示 `已修 N/总数（剩余 M）`。详见第 9 节。
5. **⑤ 进度**：整体进度条 + 已完成/总数 + 成功/空城计数 + osmium 状态徽标 + **实时滚动日志**
   （逐行转发核心脚本 stdout）+ 完成后逐城结果表（瓦片数 / 大小 / 文件 / 备注）+ 并入结果状态。
6. **⑥ 结果**：逐城表格。

### 抽取完成后发生什么（2026-10-30 起的新流程）
与命令行 `build-new-cities.py` 完全同源，三件事**自动**做完，无需再点任何按钮：

1. **直接写前端 `manifest.json`**：读旧 → 更新成功条目 → 写回。
   ⚠ 不要再走「累积进 `m_studio.json` 再 merge」那条老路——`merge-manifests.py` 曾经只扫 `m_*.json`，
   会把只存在于 `manifest.json` 的新城市整批抹掉（2026-10-30 已修：现在会并入旧 manifest 独有条目）。
2. **登记 y-flip 进度**：新生成的文件把 `文件名 + sha256` 写进
   `work/yflip-progress.built-correct.jsonl`，后台/将来的 `batch-fix-yflip.py` 不会再把它翻回镜像。
3. **可选**：勾「完成后自动并入」= 额外跑一次 `merge-manifests.py` 全表重建（用于清理孤儿条目）。

### 后端接口（备忘）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/info` | osmium 是否可用、默认输出目录、工具链（uv / 当前解释器）、y-flip 统计 |
| POST | `/api/check` | `{pbf}` → 文件存在/大小 |
| POST | `/api/run` | `{pbf, cities, outdir, chunk, auto_merge}` → `{job_id}`（异步，进程内跑核心模块） |
| GET | `/api/progress/<job_id>` | **SSE** 流式：state / log / end（含 merge 结果）事件 |
| POST | `/api/stop/<job_id>` | 请求停止（在**批次之间**生效，见下） |
| POST | `/api/merge` | 可选：全表重建 `manifest.json`（`merge-manifests.py`） |
| POST | `/api/yflip` | `{mode:'dry-run'\|'run'\|'seed', workers, name}` → 翻转修复/预览/登记 |
| GET | `/api/jobs` | 列出全部任务状态 |

### 实现要点
- **不再子进程调 CLI**（2026-10-30 改）：直接 `importlib` 加载 `pbf-to-pmtiles.py` 当模块，
  调 `gen_city_pmtiles(..., include_relations=True)`，与 `build-new-cities.py` 同一条代码路径。
  原因：CLI 只把结果写进 `manifest-out` 文件，既不登记 y-flip 进度、也不合并前端 manifest。
- 进度仍来自核心脚本的 stdout：`contextlib.redirect_stdout` 到自定义 writer，逐行入 `job['log']`
  并解析 `✓/✗` 行累计进度，SSE 侧逻辑零改动。
- SSE 采用**日志索引轮询**（每客户端自记读到第几行），多客户端安全、不重复、迟连可追。
- ⚠ **停止语义**：`gen_city_pmtiles` 一次处理整批（邻近城市共享一次 osmium 预裁剪，快 5~150 倍），
  中途打断会留下半成品 pmtiles、且断点续跑会误判为已完成 → 停止只在**批次之间**生效。
- 翻转修复用 `uv run --no-project --with osmium --with pmtiles --with mapbox-vector-tile --with shapely`
  起子进程：`.venv` 里没装 `pmtiles`（`fix-y-flip.py` 裸 import），且 PyPI 包名是 **osmium**
  （`--with pyosmium` 会让 uv 报 "No solution found"，别再写错）。

