# 离线资源下载清单

本仓库不包含大体积资源，需按下表下载后放入 `public/` 对应目录。所有脚本位于 `tools/`。

## 核心资源（必下）

| 星球 | 内容 | 大小 | 保存位置 | 下载地址 |
| --- | --- | --- | --- | --- |
| 地球 | NASA Blue Marble 全球底图（500m，冬季版） | 2.4 MB | public/bluemarble.jpg | NASAInvoke-WebRequest -Uri "" -OutFile "public/bluemarble.jpg" |
| 月球 | LOLA 高程贴图 PNG | 12.5 MB | public/lunar_dem.png | 需从原始 TIF 转换：python tools/convert_lunar.py |
| 月球 | WAC 影像贴图 JPG | 9.7 MB | public/lunar_wac.jpg | 需从原始 TIF 转换：python tools/convert_lunar.py |

## 可选资源

| 星球 | 内容 | 大小 | 保存位置 |
| --- | --- | --- | --- |
| 地球 | Terrarium 地形瓦片（全球 z0-z5 + 中国 z6-z9） | ~470 MB | public/tiles/terrain/{z}/{x}/{y}.png 下载：uv run python tools/download_terrain_tiles.py |
| 地球 | 卫星影像瓦片（中国 z0-z10） | 几十~几百 MB | public/tiles/satellite/{z}/{x}/{y}.jpg 下载：node tools/download-satellite-tiles.mjs --china |
| 地球 | 卫星影像瓦片（aria2 批量） | 同上 | node tools/download-satellite-tiles.mjs --china --list-only --format aria2 然后 aria2c -x 16 -s 16 -j 8 -i satellite-tiles-aria2.txt --max-tries=10 |

## 月球原始大文件（仅重新转换时需要，16 GB+）

| 内容 | 大小 | 保存位置 | 下载地址 |
| --- | --- | --- | --- |
| LOLA DEM 118m 全局 | 8.1 GB | raw-data/lunar/ | Planetary Computer |
| WAC Mosaic 100m | 5.7 GB | raw-data/lunar/ | 同上 |
| LOLA ClrShade 128ppd | 3.0 GB | raw-data/lunar/ | 同上 |

## 初始化流程

```bash
git clone <repo> && cd Sphere
npm install                              # 前端依赖（cesium 等）
uv sync                                  # 后端依赖（flask 等）
# 下载核心资源（见上表）
# 可选：uv run python tools/download_terrain_tiles.py
uv run python app.py                     # http://localhost:5008/
```