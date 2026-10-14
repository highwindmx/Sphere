# 山川与天宫 · Sphere

一个用 **CesiumJS + Vite** 构建的交互式科普沙盒：三维地球地形观察、天宫空间站实时轨道、探月三幕剧模拟，以及几十个标注图层（关隘/运河/山脉/海峡/洋流/文明古迹…）。

![Sphere screenshot](docs/screenshot-placeholder.png)

* * *

## 功能一览

| 分类 | 内容 |
| --- | --- |
| 🌍 地形观察 | 全球高精度卫星底图 + Terrarium 高程瓦片 + 垂直夸张滑块（1–4×） |
| 🌗 晨昏光影 | 真实太阳方向，晨昏线随时间移动；极区随 enableLighting 自动加深色调 |
| 🗺 标注图层 | 30+ 图层（分类树 + 搜索 + 全选/全清），点击标注可飞到推荐视角 |
| 🌐 海峡与航道 | 7 大经典海峡 + 北极航道关键锚点（德朗/帕里/兰开斯特） |
| 🌋 海底地形 | 马里亚纳/汤加/波多黎各/爪哇海沟、红海裂谷，带 exaggeration 推荐 |
| ⛰ 国内山脉 | 喜马拉雅/横断/昆仑/秦岭/祁连/天山/阴山 走向折线 |
| 💧 水利工程 | 古代（都江堰/灵渠/坎儿井…）+ 现代（三峡/白鹤滩/溪洛渡/葛洲坝…） |
| 🛰️ 天宫空间站 | TLE 实时解算轨道，depthFailMaterial 补全被地球遮挡半圈 |
| 🚀 探月三幕剧 | 地球发射 → 地月转移（压缩示意）→ 月面着陆，酒泉/文昌 × 雨海/静海 四个组合 |
| 🌙 月球模式 | LOLA DEM 高程 + WAC 底图，一键切换地月 Viewer |

* * *

## 快速开始

### 1\. 克隆 + 安装

```powershell
git clone https://github.com/highwindmx/Sphere.git
cd Sphere

# 前端依赖（Vite + Cesium）
npm install

# 后端依赖（Flask，uv 优先）
uv sync                                 # 或: python -m venv .venv && pip install -r requirements.txt
```

### 2\. 配置 Cesium Ion Token（**必须**，否则 Bing 底图加载失败）

注册免费 token：https://cesium.com/ion/ （创建账号后在 API Tokens 页面复制默认 token）

```powershell
# 方式 A：写 .env 文件（Vite 自动读取，.gitignore 已排除）
"VITE_CESIUM_ION_TOKEN=你的token" | Out-File -Encoding utf8 .env

# 方式 B：PowerShell 临时环境变量（当前终端有效）
$env:VITE_CESIUM_ION_TOKEN = "你的token"
npm run dev
```

> Token 仅用于在线 Bing 底图。如果只使用本地卫星瓦片 + bluemarble fallback，可以跳过。
> Terrarium 地形瓦片也不需要 token（AWS Public Dataset）。

### 3\. 启动

```powershell
# 开发模式（热重载，推荐）
npm run dev                            # http://127.0.0.1:5173/

# 或构建 + Flask 纯 Web 服务
npm run build
uv run python app.py                   # http://localhost:5000/
```

Windows 一键：双击 `app.bat`（自动用 uv 或 venv 起服务）。

### 4\. （可选）下载卫星影像瓦片

Bing ion token 有每日配额限制，建议提前离线下载**国内**瓦片：

```powershell
cd 项目根目录
node scripts/download-satellite-tiles.mjs --china --list-only --format aria2
aria2c -x 16 -s 16 -j 8 -i satellite-tiles-aria2.txt --max-tries=10

# 监控进度
node scripts/check-sat-progress.mjs
```

下载完成后，Sphere 启动时自动检测 `public/tiles/satellite/0/0/0.jpg`，替换底图为**本地优先 + Esri 在线回退**。

更多下载选项见 [`resources/DOWNLOADS.md`](resources/DOWNLOADS.md)。

* * *

## 项目结构

```
Sphere/
├── src/
│   ├── main.js                 ← 应用入口（Viewer / 极地补丁 / 底图 / 交互）
│   ├── layer-renderer.js       ← 点/折线/多边形/标注四种 entity 渲染器
│   ├── layers/
│   │   ├── index.js            ← 图层注册表（30 个 import + LAYER_CATEGORIES 分类树）
│   │   ├── worldocean.js       ← 海峡要冲 + 北极航道 + 海底地形
│   │   ├── mountains.js        ← 国内主要山脉（polyline 走向）
│   │   ├── waterworks.js       ← 古代 + 现代水利
│   │   ├── geolines.js         ← 地理参考线（rhumb 纬线 / 大圆经线）
│   │   ├── currents.js         ← 冷暖流
│   │   ├── plates.js           ← 板块边界
│   │   ├── tiangong.js         ← 天宫轨道（TLE + satellite.js 解算）
│   │   ├── moonmission.js      ← 探月任务（四大发射场 + 着陆点）
│   │   └── ...                 ← 其他 23 个图层
│   ├── tiangong.js             ← 天宫 SampledPosition 运行时
│   ├── rocket.js               ← 探月三幕剧（地球发射 / LOI 环月 / 着陆）
│   ├── lunar.js                ← 月球 Viewer + LOLA DEM
│   ├── moon-landing.js         ← 月面着陆姿态
│   └── terrarium-provider.js   ← Terrarium PNG → Cesium.Terrain
├── scripts/
│   ├── download-satellite-tiles.mjs  ← Esri World Imagery 下载（支持 aria2 列表导出）
│   ├── check-sat-progress.mjs        ← 下载进度监控（任意 cwd 可用）
│   ├── download-tiles.mjs            ← AWS Terrarium 地形下载
│   └── convert_lunar.py               ← 原始 TIF → lunar_dem.png / lunar_wac.jpg
├── public/
│   ├── bluemarble.jpg          ← 已随仓库提供（NASA 全球底图，极地补丁来源）
│   ├── lunar_dem.png / lunar_wac.jpg  ← 已随仓库提供（月球贴图）
│   └── tiles/
│       ├── terrain/            ← 已随仓库提供（Terrarium 高程瓦片，z0–z3）
│       └── satellite/          ← 可选自行下载，自动回退 Esri 在线
├── resources/
│   └── DOWNLOADS.md            ← 完整离线资源清单 & 下载命令
├── app.py                      ← Flask 纯 Web 服务（serve dist/ + SPA fallback）
├── app.bat                     ← 一键启动（uv 优先，venv 兜底）
├── pyproject.toml              ← uv Python 依赖声明（仅 flask）
├── requirements.txt            ← pip 兜底
├── index.html
├── vite.config.js
└── package.json
```

* * *

## 技术栈

| 层 | 技术 |
| --- | --- |
| 三维引擎 | CesiumJS 1.125（Vite ESM 模式，vite-plugin-cesium 处理静态资源） |
| 卫星解算 | satellite.js 5.x（SGP4 模型） |
| 构建 | Vite 5.4 |
| 后端 | Flask 3.x + uv |
| 在线底图 | Bing Maps Aerial（Cesium ion） |
| 离线底图 | Esri World Imagery（公开瓦片，server.arcgisonline.com/.../tile/{z}/{y}/{x}） |
| 高程 | AWS Terrarium（PNG heightmap，全球 z0–z15） |
| 极区补洞 | Rectangle Entity + bluemarble 裁条带 + softAlpha 柔化接缝（±6°） |

* * *

## License & Attribution

-   **CesiumJS**: Apache 2.0
-   **Bing Maps Aerial**: © Microsoft（在线使用通过 Cesium ion）
-   **Esri World Imagery**: © Esri（离线缓存仅限个人科普用途）
-   **NASA Blue Marble**: Public Domain
-   **Lunar DEM/WAC**: Planetary Data System（public domain 教育用途）
-   **Terrarium elevation tiles**: Amazon Web Services Public Dataset（CC BY 4.0）

  

Powered by TRAE/highwindmx