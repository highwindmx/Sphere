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
