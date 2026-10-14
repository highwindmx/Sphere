# 离线资源下载清单
# ====================
# Sphere 的 Cesium 地球沙盒需要以下资源文件才能完整运行。
# 本仓库默认不包含这些资源（体积从几 MB 到几十 GB 不等），需要按
# 此清单自行下载。完成后放在仓库根目录对应的 public/ 子目录下。
#
# 所有下载脚本放在 scripts/ 目录，无需手工操作。

## 1. 核心静态底图（必下，小体积）
-----------------------------------

### 1.1 NASA Blue Marble（全球 500m，冬季版，2.4 MB）
用途：Cesium Viewer 启动时的本地 fallback 底图 + 极地 Rectangle 补丁纹理来源
保存位置：`public/bluemarble.jpg`
下载地址：
  https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73909/world.topo.bathy.200410.3x5400x2700.jpg

一键下载（PowerShell）：
  Invoke-WebRequest -Uri "https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73909/world.topo.bathy.200410.3x5400x2700.jpg" -OutFile "public/bluemarble.jpg"

### 1.2 月球 DEM（LOLA 高程，12.5 MB PNG）
用途：月球 Viewer 的 LOLA 高程贴图（未使用 TerrainProvider 版本时的底图）
保存位置：`public/lunar_dem.png`
下载方式：见 raw-data/lunar 原始 TIF 下载 → 用 scripts/convert_lunar_dem.py 转换
原始数据（8.1 GB TIF，可选）：
  https://planetarycomputer.microsoft.com/api/data/v1/item/planetarycomputer:pds-browse:data-lpda-archive-pds-lunar-radar-dem/1591775144565471000

### 1.3 月球 WAC 影像（9.7 MB JPG）
用途：月球 Viewer 的底图影像贴图
保存位置：`public/lunar_wac.jpg` + `public/lunar/NASA Blue Marble ImageWall5_1920x1200-80.jpg`
原始数据（5.7 GB TIF，可选）：
  https://planetarycomputer.microsoft.com/api/data/v1/item/planetarycomputer:pds-browse:data-lpda-archive-pds-lunar-radar-dem/1591775144565471000

### 1.4 本地 Terrarium 地形瓦片（可选，默认在线回退）
用途：三维地形起伏（山脉/峡谷可视化）
保存位置：`public/tiles/terrain/{z}/{x}/{y}.png`
一键下载（Node.js）：
  node scripts/download-tiles.mjs              # 全球 z0-z5 + 中国 z6-z9（≈470 MB）
  node scripts/download-tiles.mjs --quick      # 全球 z0-z2（验证用）


## 2. 卫星影像瓦片（可选，几十 MB 起）
--------------------------------------

用途：Bing ion token 到期时的本地卫星影像底图（Esri World Imagery 0.3m–500m）
保存位置：`public/tiles/satellite/{z}/{x}/{y}.jpg`

### 方案 A：aria2c 批量下载（推荐，最快最稳）
  cd 项目根目录
  # 1. 生成 aria2 格式链接列表
  node scripts/download-satellite-tiles.mjs --china --list-only --format aria2
  #    ↑ 可选: --region places  /  --bbox 100,20,130,45 --min-z 6 --max-z 12
  # 2. 下载（aria2c 按列表 out= 路径自动建目录）
  aria2c -x 16 -s 16 -j 8 -i satellite-tiles-aria2.txt ^
         --max-tries=10 --allow-overwrite=true

### 方案 B：脚本直下（单进程但已做并发 + 断点续传）
  node scripts/download-satellite-tiles.mjs --china
  # 首次运行会自动创建 public/tiles/satellite/ 目录

### 方案 C：其他下载器
  node scripts/download-satellite-tiles.mjs --list-only --format url
  # 生成 satellite-tiles-url.txt，每行一个 URL，可导入迅雷/IDM/wget 批量下载

### 下载范围参考
  --quick       全球 z0-z2           21 瓦片      几分钟
  --china       中国全境 z0-z10       ≈55,000 瓦片   1–3 小时
  --region places 标注点周边 z10-z14  ≈30,000 瓦片   1–2 小时

### 监控进度
  node scripts/check-sat-progress.mjs
  # 输出总任务数 / 已下载数 / 已下载字节数 / 半成品数


## 3. 原始大文件（强烈可选，16 GB+，仅用于重新转换）
-----------------------------------------------------

如果你想重新转换月球 DEM/WAC 贴图：

| 文件 | 大小 | 下载地址 | 保存位置 |
|------|------|----------|----------|
| LOLA DEM 118m (全局) | 8.1 GB | https://planetarycomputer.microsoft.com/api/data/v1/item/planetarycomputer:pds-browse:data-lpda-archive-pds-lunar-radar-dem/1591775144565471000 | raw-data/lunar/ |
| WAC Mosaic 100m | 5.7 GB | 同上 archive | raw-data/lunar/ |
| LOLA ClrShade 128ppd | 3.0 GB | 同上 archive | raw-data/lunar/ |

转换脚本（Python，需要 rasterio + numpy）：
  python scripts/convert_lunar.py            # 统一转换入口


## 4. 资源目录结构总览
-----------------------

public/
├── bluemarble.jpg            ← 必下（2.4 MB）
├── lunar_dem.png             ← 必下（12.5 MB）
├── lunar_wac.jpg             ← 必下（9.7 MB）
├── lunar/
│   └── NASA Blue Marble...jpg  ← 必下（540 KB）
└── tiles/
    ├── terrain/              ← 可选（默认在线回退）
    │   └── {z}/{x}/{y}.png
    └── satellite/            ← 可选（默认 Bing 在线）
        └── {z}/{x}/{y}.jpg

raw-data/                      ← 永远不上传（16 GB+）
└── lunar/
    └── *.tif


## 5. 完整初始化清单（从上到下依次执行）
------------------------------------------

  # 1. clone 代码
  git clone https://github.com/highwindmx/Sphere.git
  cd Sphere

  # 2. 装前端依赖
  npm install

  # 3. 装后端依赖（Python 3.10+ / uv）
  uv sync                          # 或 python -m venv .venv && pip install -r requirements.txt

  # 4. 下载 NASA Blue Marble（可选但建议）
  Invoke-WebRequest -Uri "https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73909/world.topo.bathy.200410.3x5400x2700.jpg" -OutFile "public/bluemarble.jpg"

  # 5. 下载月球贴图（建议）
  # 用已经转好的成品：public/lunar_dem.png + public/lunar_wac.jpg
  # 或者从原始 TIF 转换（见 resources/下载清单第 3 节）

  # 6. （可选）下载 Terrarium 地形瓦片
  node scripts/download-tiles.mjs

  # 7. （可选）下载卫星影像瓦片
  node scripts/download-satellite-tiles.mjs --china --list-only --format aria2
  aria2c -x 16 -s 16 -j 8 -i satellite-tiles-aria2.txt --max-tries=10

  # 8. 启动开发服务器
  npm run dev                      # http://127.0.0.1:5173/

  # 9. 或构建 + Flask 纯 Web 服务
  npm run build
  uv run python app.py             # http://localhost:5000/
