# OSM → MVT → 栅格化贴 globe 方案（V1）

目标：彻底替换当前「GeoJSON 瓦片 + Cesium Entity」的 OSM 显示方式（上海 3780 片 → 数万 entity，浏览器卡死），
改为 **MVT 二进制存储 + 服务端栅格化 PNG + `UrlTemplateImageryProvider` 贴图**，前端实体数归零。

---

## 1. 总体链路

```
① china.osm.pbf (1.61GB)
      ↓ bbox 提取（tools/osm-extract.py，已有）
② shanghai.osm.pbf (26MB)
      ↓ pyosmium apply_file(locations=True)  ← C++ 层维护节点索引
③ 内存中的 way 几何（lon/lat 序列）
      ↓ 按 zoom 分桶 + Mercator 量化 + 跨瓦片裁剪 + 抽稀
④ MVT（protobuf，gzip）→ shanghai.mbtiles（sqlite 单文件）
      ↓ 运行时按需解码 + skia/Pillow 栅格化
⑤ PNG 256×256 → 落盘缓存（LRU）
      ↓ Flask 路由 /osm-tiles/{z}/{x}/{y}.png
⑥ Cesium UrlTemplateImageryProvider 直接贴 globe
```

---

## 2. 工具资源清单

| 环节 | 首选 | 备选 | 本机现状 / 备注 |
| --- | --- | --- | --- |
| 读 PBF + 节点索引 | **pyosmium**（C++ libosmium 绑定） | osmium CLI | ✅ 已装（`.venv`）。`apply_file(locations=True)` 由 C++ 维护索引，避免亿级 Python 回调 |
| bbox 提取 | `tools/osm-extract.py`（已有） | osmium extract | ✅ 已验证：1.61GB → 27.3MB（819s 一次性） |
| 切片 + MVT 编码 | **自研切片器 + `mapbox-vector-tile`**（pip，纯 Python） | vtzero（C++，无 wheel） | 需自己实现：投影分桶、跨瓦片裁剪、抽稀 |
| 一步到位方案 | **tilemaker（WSL2 内）** | tilemaker Windows zip | ⚠ 官方 v3.0.0 的 Windows 包**已知不产出 mbtiles**（issue #687/#857），只能 WSL2 或源码构建 |
| 大规模抽稀 | tippecanoe（WSL2） | 自研 drop-smallest | 输入 GeoJSON/FlatGeobuf，自动按 zoom 抽稀 |
| 栅格化 | **skia-python**（pip 有 Windows wheel） | cairocffi / pycairo；Pillow ImageDraw | Pillow 的 ImageDraw 是纯 Python 循环，慢 10–50×，只适合小量 |
| 存储 | **`.mbtiles`**（sqlite，Python 标准库即可读写） | 散文件 `z/x/y.mvt` | 单文件好管理；`mb-util` 非必需 |
| 服务 | Flask 新路由 | 静态文件 | 命中缓存直出；未命中 → 渲染 → 落盘 → 返回 |
| 前端 | `Cesium.UrlTemplateImageryProvider` | 自定义 ImageryProvider | 零 entity → 不再卡 |

---

## 3. 中间产物与体积估算

### 3.1 实测标定（上海，`tools/osm-pbf-stats.py`）

| 指标 | 实测值 |
| --- | --- |
| PBF 大小 | 26.0 MB |
| 节点数 | 3,320,323 |
| way 数 | 562,078（highway 260,865 / building 195,095 / 面状标签 78,420 / 闭合 262,047） |
| 几何点总数 | 4,184,973（平均 7.4 点/way，最长 1,622） |
| 扫描耗时 | 15.6 s（1.7 MB/s，纯计数不建索引） |
| **密度** | **12.76 万节点/MB · 2.16 万 way/MB · 16.09 万几何点/MB** |

外推 china（1.61GB，按密度线性，农村地区节点占比更高，**保守 ±50%**）：≈ **2.06 亿节点 / 3,478 万 way / 2.59 亿几何点**。

### 3.2 产物体积表

| # | 产物 | 上海（26MB PBF） | 中国（1.61GB PBF） | 说明 |
| --- | --- | --- | --- | --- |
| 0 | 源 PBF | 26 MB | 1.61 GB | 常驻（已 gitignore） |
| 1 | bbox 提取后 PBF | 26 MB | 全国无需提取 | 一次性 |
| 2 | **节点位置索引** | 332万 × 5.5B ≈ **18 MB**（flex_mem 内存）<br>332万 × 8B ≈ 27 MB（dense 落盘） | 2.06亿 × 5.5B ≈ **1.13 GB 内存**<br>落盘 ≈ 1.65 GB | ⚠ **最大的中间态**；全国必须分块处理或用 `--index-type=dense_file_array` 落盘 |
| 3 | GeoJSON / FlatGeobuf 中间文件 | ~200–400 MB | **12–25 GB** ⚠ | 仅 tippecanoe 路线需要；**应避免**（体积约为 PBF 的 10×） |
| 4 | **MVT（z0–14，含 gzip）** | **12–20 MB** | **0.4–1.2 GB**（z14）<br>0.15–0.25 GB（限 z12） | 终态产物，落 `.mbtiles` |
| 5 | PNG 栅格缓存（z0–14 全量） | ~50–70 MB | **20–40 GB** ⚠ | **不可全量预生成** → 必须按需 + LRU |

### 3.3 估算依据

- **MVT**：每几何点 varint delta 编码 ≈ 2–3 B（extent 4096，每点 2 个 varint）→ 上海 418万点 × 3B ≈ 12.6 MB raw；低 zoom 重复计数约 ×1.3；属性约 10 B/way（56万 → 5.6 MB）；gzip 后 ×0.5–0.7 → **约 11–15 MB**。
- **瓦片数**：`N(z,bbox) = 4^z × (Δlon/360) × Δy_merc`，其中 `Δy_merc = |ln tan(π/4+φ/2)| 差 / 2π`。
  上海（约 1.15°×1.2°，墨卡托 y 跨度 1.05%）→ z14 ≈ 59 × 172 ≈ **1.0 万片**（与现有数据集 3780 片同量级）。
- **PNG**：256² 空片 ≈ 0.3 KB、稀疏 1–3 KB、密集路网 8–25 KB。上海 z14 非空片 ~1.0 万 × 6 KB ≈ 60 MB。
- ⚠ 以上系数**必须用上海实跑一次校正**（见 §5 P0）。

---

## 3.4 时间代价（含实测基准）

实测基准（`tools/mvt-bench.py`，10 万 way / 74 万几何点 / 100 瓦片）：

| 指标 | 实测 |
| --- | --- |
| MVT 编码吞吐 | **0.29 M 点/秒**（含 shapely 构造） |
| 每 way 编码体积 | 38 B（raw）→ gzip 压缩比 0.65 |
| 每瓦片（1000 way） | 37.4 KB raw → 24.4 KB gzip |

已有的实测锚点：`tools/osm-extract.py` 1.61GB → 27.3MB **819 s**；现有 `osm-tiles-osmium.py` 切 GeoJSON **164 s**（上海 27.3MB → 3780 片）。

### 上海（从 1.61GB 中国 PBF 起，首次）

| 阶段 | 耗时 | 说明 |
| --- | --- | --- |
| ① bbox 提取 1.61GB → 26MB | **819 s（13.7 min）** | 实测，一次性；换城市需重跑 |
| ② 读 PBF + 建索引 + 分桶 + 编码 → MVT | **3–6 min** | 编码本身仅 14–20 s（0.29 M点/s × 418 万点 ×1.3 重复）；**瓶颈在读取与节点索引**（现有 GeoJSON 切片实测 164 s） |
| ③ gzip 落 .mbtiles | 1–3 s | ~20 MB @ 30 MB/s |
| ④ 栅格化（**按需**）视野内 20–50 片 | **0.1–1 s**（skia） | 用户实际感知的只有这一项 |
| ④′ 栅格化（全量预渲染 1.0 万片 z14） | skia **1–3 min** / Pillow **8–33 min** | 每片 256²：skia 5–20 ms，Pillow 50–200 ms |
| **合计（按需模式）** | **约 17 min**，其中 13.7 min 是一次性提取 | 若上海 PBF 已存在 → 只需 **3–6 min** |

### 全国（一次全扫，推荐摊薄方式）

| 阶段 | 耗时 |
| --- | --- |
| 读 1.61GB + 建索引 | 15–25 min（1.7 MB/s 纯扫描，建索引更慢） |
| 编码 2.59 亿几何点 | **15 min**（基准外推） |
| **合计（Python 路线）** | **40–60 min** |
| 合计（tilemaker / WSL2，C++） | **10–30 min** |

**结论**：把「每城 819 s 提取 + 3–6 min 切片」换成「一次全扫 40–60 min」后，后续所有城市**零提取成本**，只从 mbtiles 里取瓦片。

### 时间优化手段

1. **一次全扫切片**：合并①+②，避免每城重复扫 1.61GB。
2. **按需栅格化**：省掉 1–3 min 全量预渲染，且磁盘只缓存访问过的瓦片（不占 60MB 全量）。
3. **索引落盘**（`dense_file_array` 8B/节点）：内存从 1.1GB 降到 ~50MB 常驻，代价是稍慢。
4. **多进程分块**：按 z 或 bbox 分块 `multiprocessing`，近线性加速（GIL 绕过）。
5. **切片器直接产出 WKB 而非 shapely**：本基准里 shapely 构造占了一部分开销，能省 30–50% 编码时间。

### 与现状的对比（为什么值得）

| | 现状（GeoJSON + Entity） | MVT + 栅格化 |
| --- | --- | --- |
| 浏览器成本 | 解析 20MB GeoJSON + 建数万 entity → **卡死（实测）** | 0 entity，只贴图 |
| 服务端成本 | 0 | 一次性 3–6 min（上海） |
| 首屏感知 | 卡死 | **0.1–1 s**（按需渲染视野内几十片） |

---

## 3.5 44GB 全量 PBF 一次性预处理的成本（逐文件外推）

`public/OSM/` 实测 21 个文件 **43.1 GB**（us 11.4 / dach 5.8 / france 4.8 / russia 3.9 / sea 3.4 / japan 2.4 / alps 2.2 / italy 2.1 / gb 2.0 / china 1.5 / spain 1.4 …）。
估算器：`tools/osm-preprocess-estimate.py`（系数全部来自本项目实测）。

### ⭐ 三本账必须分开看（内存 ≠ 硬盘）

常被混为一谈，这里一次讲清：

| 账本 | 落点 | 是否永久占用磁盘 | 数值 |
| --- | --- | --- | --- |
| **① 内存 RAM** | 进程堆内存 | **否**，进程结束即释放 | 串行 7.6G；8 进程并发 **24.1G** |
| **② 临时磁盘** | 索引落盘（dense_file_array） | **否**，单文件处理完立刻删 | 仅当 RAM 不够才启用：11.1G（串行）/ 35.0G（8 并发） |
| **③ 常驻磁盘** | MVT/.mbtiles + PNG LRU | **是** | **z14 33.5G / z12 15.0G** |

**关键：索引默认走 `flex_mem` 纯内存，根本不写磁盘。** 只有内存不够时才降级落盘，且是"处理完一个文件就删掉"的临时文件，不会累积。所以"索引 11G"不是硬盘开销。

### 总量

| 项 | 值 |
| --- | --- |
| 输入 | 43.1 GB / 21 文件 |
| 节点 / way / 几何点 | **56.3 亿 / 9.53 亿 / 70.9 亿** |
| ① 峰值 RAM（串行 / 8 进程） | **7.6 GB / 24.1 GB** |
| ② 临时磁盘（仅 RAM 不足时） | 11.1 GB（用完即删，常态 0） |
| ③ 常驻磁盘 MVT | z14 **28.5 GB** / z12 **10.0 GB** |
| ③ 常驻磁盘 PNG（按需 LRU，非全量） | 5 GB（自定上限） |
| ~~PNG 全量预渲染~~ | ~~z14 99.7 GB~~ ❌ **已否决，不采用** |

### 最大的 5 个文件（单文件成本）

| 文件 | 大小 | 节点 | way | 几何点 | 读+索引(h) | 编码(h) | MVT z14 | 索引 RAM |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **us** | 11.4G | 14.9亿 | 2.52亿 | 18.8亿 | **8.1** | 1.8 | 7.5G | **7.6G** ⚠ |
| dach | 5.8G | 7.6亿 | 1.29亿 | 9.6亿 | 4.1 | 0.9 | 3.9G | 3.9G |
| france | 4.8G | 6.2亿 | 1.05亿 | 7.8亿 | 3.4 | 0.7 | 3.1G | 3.2G |
| russia | 3.9G | 5.1亿 | 0.86亿 | 6.4亿 | 2.8 | 0.6 | 2.6G | 2.6G |
| sea | 3.4G | 4.5亿 | 0.76亿 | 5.6亿 | 2.4 | 0.5 | 2.3G | 2.3G |

### 时间

| 方案 | 耗时 | 需要 RAM |
| --- | --- | --- |
| Python 单进程（z14） | **37.4 h** | 7.6G |
| Python 8 进程（z14） | **4.7 h** | **24.1G** ⚠ |
| Python 3 进程（z14，16GB 机器） | **12.5 h** | 14.7G |
| Python 8 进程（限 z12） | **1.6 h** | 24.1G |
| C++ tilemaker（WSL2，5–8×） | **1.6–7.5 h** | 由 C++ 侧管理 |

⚠ **4.7 h 这个数字的前提是 24.1 GB RAM**。若机器只有 16 GB，并行度必须降到 3（14.7G），耗时回到 12.5 h；或改 `dense_file_array` 落盘换 RAM（临时占 35.0G 磁盘）。

### 常驻磁盘总账（这才是"硬盘会增加多少"）

| 方案 | 常驻产物 | 含源 PBF 的总占用 |
| --- | --- | --- |
| **A：z14** | **33.5 GB**（MVT 28.5 + PNG 5） | 76.5 GB（源 43.1 保留） |
| **B：z12** | **15.0 GB**（MVT 10.0 + PNG 5） | 58.0 GB（源 43.1 保留） |
| 跑完删掉源 PBF | — | **A 33.5 GB / B 15.0 GB** |

**结论：硬盘净增 33.5 GB（z14）或 15.0 GB（z12），不是 100 GB。**~\~100 GB 那个数是"PNG 全量预渲染"，已在方案中否决。

### 必须做的四项削减

1. **去重**：`alps`（阿尔卑斯跨国）与 `italy`/`france`/`dach` 大面积重叠，`dach` 本身 = 德+奥+瑞。重叠估计 15–25% → 可省 6–10 GB 输入及对应时间/空间。
2. **分区 zoom**：城市/人口密集区 z14，其余 z12 → MVT 由 28.5 GB 降到 12–15 GB。
3. **按文件逐个处理，索引只在单文件生命周期内存在**：us 单文件就要 7.6 GB RAM。串行 7.6G 够用；想并行提速就得按内存定并行度（16 GB → 3 进程；32 GB → 8 进程）。内存不够才启用 `dense_file_array` 落盘（临时 11.1G/串行、35.0G/8 并发，**用完即删**）。
4. **PNG 绝不预生成（99.7 GB）**：改为按需栅格化 + LRU 上限 5 GB。用户感知的只有"视野内 20–50 片首次渲染 5–20 ms"。

⚠ 密度系数由上海（超密集都市）外推全球，农村地区节点占比更高 → 节点数/索引可能高估 ±50%；**正式全量前必须先跑 P0（malta 9MB + shanghai 26MB）校正系数**。

---

## 4. 关键实现要点

1. **切片**：Mercator 归一化 → 按 target zoom 量化到 extent 4096 → way 跨瓦片时按 Sutherland–Hodgman 裁剪（否则线被截断/丢失）。
2. **抽稀（必须）**：低 zoom 不放行小路/建筑。参考现有 `AREA_TAGS` 的分层思路：
   - z0–9：高速/主干（`highway ∈ motorway|trunk|primary`）
   - z10–12：+ 次干/支路 + 水域/绿地
   - z13–14：+ 建筑 + 小路 + 面状要素
   不抽稀会导致 z5 单瓦片塞进全省道路 → MVT 直接爆掉。
3. **MVT 编码**：`mapbox-vector-tile.encode()`，图层分 `transportation / water / landuse / building`。
4. **栅格化**：skia 一次 Path 批绘（不要逐条 stroke）；线宽按 zoom 分级，抗锯齿开启；透明底 PNG（叠在 Esri 影像之上）。
5. **服务与缓存**：Flask `/osm-tiles/{z}/{x}/{y}.png` → 缓存命中直出（304/内存映射），未命中解码 MVT → 渲染 → 落盘 → 返回；LRU 上限（如 2 GB / 5 万片）。
6. **与现有矢量层的关系**：栅格化后**失去点击拾取**（`pickOsmEntity`）。建议做成开关——大范围用栅格，小范围高精度仍可加载矢量层做拾取。
7. **ODbL 署名**保持不变（UI 已有）。

---

## 5. 分阶段计划

| 阶段 | 内容 | 产出 / 验收 |
| --- | --- | --- |
| **P0 标定**（半天） | 用上海 26MB 跑通 ②→④（自研切片器 + mapbox-vector-tile），记录真实体积与耗时 | 得到 MVT/PBF 真实系数 → **回写修正 §3.2 估值** |
| **P1 服务化**（1 天） | Flask 路由 + 栅格化 + PNG 缓存 + Cesium 挂载，替换上海现有 GeoJSON entity | 上海缩放全程不卡；实体数 0；帧率对比前后 |
| **P2 抽稀与配色**（1 天） | 分层抽稀 + 路等级配色 + 面状要素着色 | 视觉对齐 OSM 官网风格 |
| **P3 扩区**（按需） | 全国 z≤12 预生成（优先 WSL2 + tilemaker/tippecanoe），城市 z14 按需 | 磁盘占用受控（§3.2 第 4/5 行） |

---

## 6. 待你拍板的三个选择

| # | 选项 | 影响 |
| --- | --- | --- |
| 1 | **路线 A 纯 Python**（pyosmium + mapbox-vector-tile + skia-python）vs **路线 B WSL2 原生**（tilemaker/tippecanoe） | A 零环境依赖、可控但要自研裁剪/抽稀（~400 行）；B 快 10–50×、抽稀现成，但要装 WSL2 |
| 2 | **zoom 上限**：z14（上海 1 万片 / 60MB PNG）vs z12（全国 ~100 万片 / ~3GB PNG） | 决定磁盘与预处理时间量级 |
| 3 | 是否**保留矢量拾取层**作为小范围叠加 | 决定是否需要双份数据（MVT + GeoJSON） |

---

## 7. 已知坑（承接既有教训）

- osmium 的 `Location.x/.y` 是**纳度整数**，坐标必须用 `loc.lon / loc.lat`（已修过一次）。
- PBF 按 OSM id 排序、与地理无关 → 必须全扫；**别用 Python 回调遍历节点**，用 `apply_file(locations=True)` 让 C++ 维护索引。
- 迅雷下载的 Geofabrik extract 会预分配空洞 → 任何大 PBF 先 `tools/osmpbf.py verify`。
- safe-delete 钩子按累计删除数 >50 终止进程 → 中间产物写系统 TEMP，清理用 rename 代替删除。
- 栅格化层开启时若出现倾斜视角消失，参考现有 `depthTestAgainstTerrain` 临时关闭的处理。
