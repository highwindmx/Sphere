# 山川与天宫 · Sphere

一个用 **CesiumJS + Flask** 构建的交互式科普沙盒（浏览器原生 ESM + import map，零构建）：三维地球地形观察、天宫空间站实时轨道、探月三幕剧模拟，以及几十个标注图层（关隘/运河/山脉/海峡/洋流/文明古迹…）。

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

# 前端依赖（Cesium + cesium-navigation）
npm install
npm run vendor   # 把 Cesium 构建产物拷到 public/（import map 直接引用，无打包）

# 后端依赖（Flask，uv 优先）
uv sync                                 # 创建 .venv 并安装 pyproject.toml 声明的依赖（仅 flask）
```

### 2\. 配置 Cesium Ion Token（**必须**，否则 Bing 底图加载失败）

注册免费 token：https://cesium.com/ion/ （创建账号后在 API Tokens 页面复制默认 token）

```powershell
# 方式 A：写 .env 文件（app.py 启动时读取，.gitignore 已排除）
"SPHERE_CESIUM_ION_TOKEN=你的token" | Out-File -Encoding utf8 .env

# 方式 B：PowerShell 临时环境变量（当前终端有效）
$env:SPHERE_CESIUM_ION_TOKEN = "你的token"
python app.py
```

> Token 仅用于在线 Bing 底图。如果只使用本地卫星瓦片 + bluemarble fallback，可以跳过。
> Terrarium 地形瓦片也不需要 token（AWS Public Dataset）。

### 3\. 启动

```powershell
# Flask 直 serve 源码（无构建步骤，改代码刷新即生效）
uv run python app.py                   # http://localhost:5008/
```

Windows 一键：双击 `app.bat`（自动用 uv 或 venv 起服务）。

### 4\. （可选）下载卫星影像瓦片

Bing ion token 有每日配额限制，建议提前离线下载**国内**瓦片：

```powershell
cd 项目根目录
node tools/download-satellite-tiles.mjs --china --list-only --format aria2
aria2c -x 16 -s 16 -j 8 -i satellite-tiles-aria2.txt --max-tries=10

# 监控进度
node tools/check-sat-progress.mjs
```

下载完成后，Sphere 启动时自动检测 `public/tiles/esri/0/0/0.jpg`，替换底图为**本地优先 + Esri 在线回退**。

想让默认俯瞰视角的**全球**瓦片也完整（不依赖在线代理，首屏即全彩）：

```powershell
# 全球 z0-z5（1365 张，约 40MB，几分钟下完）；z6 以上按需在线代理或继续下
node tools/download-satellite-tiles.mjs --bbox -180,-85,180,85 --min-z 0 --max-z 5
```

在线代理失败时（无外网/Esri 不可达），未下载区域显示为蓝色椭球底色，Flask 控制台会打印 `[satellite-proxy] ... 失败` 及真实原因。

更多下载选项见 [`archive/resources/DOWNLOADS.md`](archive/resources/DOWNLOADS.md)。

* * *

## 图源设置面板（详细说明）

点右上角「图源设置」打开抽屉，分三区：影像源优先级 → 地形源 → 下载与缓存。

### 影像源优先级

-   **P1 = 首选底图**：故障按 P1→P2→P3 依次回退，不再单独设「设为首选」按钮；手动切源等价于把该源提到首位。
-   **本地优先** = 走本地代理缓存：有缓存直出 / 无缓存拉上游并落盘；关闭则直连上游、不缓存。
-   **启用** = 是否参与回退链（停用后故障不会回退到它）。
-   调整方式：行内 ▲▼ 按钮或直接拖拽整行；P1 变化会立即换底图。
-   已缓存数据来自本地扫盘（打开面板时取一次，服务端 30s TTL 缓存；统计未完成时显示「统计中…」）。

### 地形源

-   高程必须全球一致，所以地形不参与影像回退链，只做整体启用 / 停用。
-   单一数据源 AWS Terrarium（z0–z15），同样支持本地优先代理。

### 下载与缓存

每个图源下方一张 **4×3 表**（整表默认折叠，入队自动展开）：

| 列 | 内容 |
| --- | --- |
| ① 清晰度 | 骨架 z0–4 / 低清 z5–8 / 高清（标注点）/ 高清（全部）；上限自动钳制到该源 maxZ（如 GIBS 只有 z0–7：低清钳成 z5–7 可下载，高清整档禁用） |
| ② 已缓存 / 该档总量 | 该 z 区间已缓存的张数与体积（悬停看逐 z 明细）；标注点行显示「子集 N 张（精算 · 331 点）」 |
| ③ 下载 · 进度 | 下载按钮 + 行内进度条 / 文本 + 行内「✕ 取消」 |

-   **入队与并发**：点击即入队，同一任务重复点击忽略；并发 2 个同时跑，其余显示「⏳ 第 N 位」。
-   **取消**：行内「✕ 取消」只停自己那一个——排队中 = 移出队列，下载中 = 中止（后端按 key 精准取消），另一个不受影响。
-   **高清拆两行**：
    -   **标注点** = 左侧栏全部标注点周边 ±R km 的瓦片求并集（走 `/api/downloader/plan` 真枚举，比「全部」小一到两个量级，±25km 约 8,881 张）。
    -   **全部** = 该层级全球完整覆盖（z9–11 全球 550 万张、量级 60 GB+，慎点）。
    -   各源瓦片网格相同，标注点张数一致、体积按源略有差异；天地图按中国 bbox 下载（全球下它没意义）。
-   **下载分段建议**：骨架 z0–4（全球概览，分钟级）→ 低清 z5–8（大洲级，小时级）→ 高清 z9–11（城市级，建议先只下标注点子集）。

* * *

## 左上角坐标控件与浏览历史

| 元素 | 行为 |
| --- | --- |
| 经度 / 纬度输入框 | **placeholder 即实时光标坐标**（鼠标在地球上滑动时实时写入「经度 105.00°」）；鼠标移出球体回落为视点坐标 |
| 海拔（只读） | 光标/视点处地形高程，`⛰ 1,292 m`；**负值保留符号**并换图标 `🌊 -4,118 m`（terrarium 地形源含海底地形，负值即水下深度） |
| 📍 定位 | 填入经纬度飞行；**留空 = 定位到光标处**；成功后自动清空输入框（让 placeholder 继续显示实时光标位置） |
| 🏠 回国 | 飞回中国全图（105°E, 33°N，1,600km 俯视）；月球模式下先自动切回地球（2026-10-17 从侧栏工具行迁入坐标栏） |
| 🕘 记录 | 可折叠浏览历史：**默认折叠**，每次定位自动记入（localStorage，最多 20 条，按 0.01° 去重），**倒序**展示，点击条目回飞，可一键清空 |

* * *

## 探月任务 3D 模型（glTF）

探月任务（`src/rocket.js` 四幕动画）全程使用 glTF 3D 模型（billboard 仅作加载期/失败兜底）。模型资产由 `tools/make_mission_models.py` 纯标准库生成（无第三方依赖，重新生成：`./.venv/Scripts/python.exe tools/make_mission_models.py`）：

| 文件 | 内容 | 动画 | 用途 |
| --- | --- | --- | --- |
| `public/models/longmarch5.glb` | 长征五号整箭（13 节点：尾裙/红色环带/芯级/整流罩/4 助推器），Y-up 原点=发动机喷口面 | 静态 | 第一幕点火起飞 |
| `public/models/spacecraft.glb` | 飞船上面级（芯级 + 设备舱 + 对接环，无助推/整流罩） | 静态 | 第二幕地月转移 + 第三幕环月 |
| `public/models/booster.glb` | 捆绑助推器（17.3m） | 静态（运行时翻滚） | 第一幕分离件 |
| `public/models/fairing.glb` | 整流罩半瓣（半壳） | 静态（运行时自转） | 第一幕分离件 |
| `public/models/moon_lander.glb` | 月面着陆器（4 腿 + 喷口 + 设备舱 + 天线碟） | 静态 | 第三幕动力下降 + 第四幕驻留 |
| `public/models/yutu_rover.glb` | 玉兔号月球车（30 节点：车体/太阳翼/设备舱/桅杆/相机头 + 6 轮各带 3 根轮辐） | 6 轮滚动（绕轴半圈 0.5s，REPEAT 无缝循环） | 第四幕驶出巡视 |
| `public/models/CesiumMan.glb` | Cesium 官方骨骼动画样例（下载自 jsdelivr），作 skinning 可行性参照 | 骨骼行走 | 验证用 |

四幕结构（进度条节点：点火 0 / 转移 0.17 / 入月轨 0.60 / 着陆 0.80 / 巡视 0.90）：

1. **点火起飞**（地球 Viewer）：3D 整箭垂直上升，机头沿速度方向；助推器/整流罩分离为 3D 件（斜弹 + 翻滚 + 下坠），发射轨迹亮线。
2. **月地转移**（局部太阳系顶视图）：3D 飞船上面级沿航线切向飞行，规划航线虚线 + 已飞轨迹亮线，示意月球。
3. **环月制动 + 动力下降**（月球 Viewer）：3D 上面级沿环月切向；下降段换 3D 着陆器，末端按真实月面 DEM 接地，机位 clamp 30m。
4. **玉兔巡视**（月球 Viewer）：着陆器驻留，月球车自东侧驶出 14m，6 轮滚动节点动画（REPEAT ×1.2），相机取两者中点 30m 同框。

验证：`node tools/models-smoke.mjs`（逐模型资产冒烟）与 `node tools/mission-smoke.mjs`（任务级端到端：点火 → seek 0.05 第一幕截图 → seek 0.95 第四幕截图 + 模型就绪/动画断言 + 收尾清场，均需先启动 app.py）。

**已验证结论（2026-10-17）**：Cesium 1.146 原生 `Model` 完整支持 glTF 节点动画与 skinning 骨骼动画（CesiumMan 行走 animDiff=3.79，背景隔离后噪声=0）——火箭/探月器的 3D 动画角色无需引入 Three.js。

模型加载要点（1.146 API）：

-   `Model.fromGltfAsync({url, gltfCallback})` 返回 Promise；glTF 动画数量从 `gltfCallback` 的 `gltf.animations` 取（Model 对象不再暴露 `animations`）。
-   模型必须设 `modelMatrix`（如 `Cesium.Transforms.eastNorthUpToFixedFrame(pos)`）定位，否则躺在原点（地心）永远不可见。
-   动画挂载：`model.readyEvent` 或轮询 `model.ready` 后 `model.activeAnimations.add({index, loop: Cesium.ModelAnimationLoop.REPEAT, multiplier})`；**`add` 要求 `model.sceneGraph` 已构建（模型首次 update 后才有），未就绪调用会抛 TypeError**。
-   `requestRenderMode` 下手动出图必须 `scene.requestRender()` + `scene.render(time)` 两步（只调 render() 可能是 no-op）。
-   相机 `lookAt(target, hpr)` 后世界距离用 `camera.positionWC` 断言——`camera.position` 是 lookAt 参考系下的局部坐标，混用会误判「相机跑到原点」。
-   `minimumPixelSize` 的放大用 `_initialRadius`（≠当前 boundingSphere.radius），**表观像素实测 ≈ 0.231 × minPx**（理论公式会高估约 4 倍）；本项目按「对齐旧 billboard 尺寸」标定：火箭/飞船 150、分离件/着陆器 120、月球车 80。
-   月球 Viewer 每次进入月球模式都会重建（`destroyMoonViewer` → `viewer.destroy()`，其 primitives 随之销毁），任务侧按「viewer 换代即销毁重建模型槽位」处理。

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
├── tools/
│   ├── vendor-cesium.mjs         ← 拷贝 Cesium/导航控件产物到 public/（npm run vendor）
│   ├── download-satellite-tiles.mjs  ← Esri World Imagery 下载（支持 aria2 列表导出）
│   ├── download_terrain_tiles.py     ← AWS Terrarium 地形下载（全球 z0–z5 + 中国 z6–z9 + 山脉 z10–z12）
│   ├── check-sat-progress.mjs        ← 下载进度监控（任意 cwd 可用）
│   ├── check-net.mjs                 ← 网络连通性自检
│   ├── emit_places.mjs               ← 山脉折线中点导出（被 download_terrain_tiles.py 调用）
│   ├── validate_layers.mjs           ← 图层注册表完整性校验
│   ├── add_provenance_headers.mjs    ← 图层源数据出处头注入
│   ├── make_mission_models.py        ← 生成探月任务 glTF 模型（长征五号 / 玉兔号，纯标准库）
│   ├── models-smoke.mjs              ← glTF 模型加载+动画端到端冒烟（headless Edge + CDP）
│   └── convert_lunar.py              ← 原始 TIF → lunar_dem.png / lunar_wac.jpg
├── public/
│   ├── vendor/
│   │   ├── cesium/             ← npm run vendor 生成（Cesium 构建产物，不入库）
│   │   └── cesium-navigation/  ← npm run vendor 生成（导航控件，不入库）
│   ├── models/                 ← 探月任务 glTF 模型：longmarch5.glb / yutu_rover.glb / CesiumMan.glb
│   ├── patch/                  ← 极冠补丁图 + bluemarble.jpg（补丁源图）
│   ├── lunar/                  ← 月球模式资产：lunar_wac.jpg / lunar_dem.png + 源 TIF
│   └── tiles/
│       ├── terrain/            ← 已随仓库提供（Terrarium 高程瓦片，z0–z3）
│       └── esri/             ← 可选自行下载，自动回退 Esri 在线
├── archive/                    ← 历史归档（demo 原型 / debug 脚本与诊断图 / 原始数据），不参与运行
│   ├── demos/                  ← 图源设置面板 demo v1–v8（功能已全部并入生产 src/source-settings.js）
│   ├── debug/                  ← GIBS 拼缝/极区定位等历史 debug 冒烟与诊断截图
│   └── resources/DOWNLOADS.md  ← 完整离线资源清单 & 下载命令
├── app.py                      ← Flask 纯 Web 服务（serve index.html + src/ + public/，注入 Ion Token）
├── app.bat                     ← 一键启动（uv 优先，venv 兜底）
├── pyproject.toml              ← uv Python 依赖声明（仅 flask）；uv.lock 一并纳入版本库
├── index.html                  ← import map + CESIUM_BASE_URL + Token 占位
└── package.json
```

* * *

## 技术栈

| 层 | 技术 |
| --- | --- |
| 三维引擎 | CesiumJS（浏览器原生 ESM + import map，构建产物直拷 public/cesium/） |
| 导航控件 | cesium-navigation-es6（指南针 / 缩放 / 重置视图 / 比例尺） |
| 卫星解算 | satellite.js 5.x（SGP4 模型） |
| 构建 | 无（npm run vendor 直拷产物；Flask 直 serve 源码，改完刷新即生效） |
| 后端 | Flask 3.x + uv |
| 在线底图 | Bing Maps Aerial（Cesium ion） |
| 离线底图 | Esri World Imagery（公开瓦片，server.arcgisonline.com/.../tile/{z}/{y}/{x}） |
| 高程 | AWS Terrarium（PNG heightmap，全球 z0–z15） |
| 极区补洞 | Rectangle Entity + 冰色渐变兜底（GeographicTilingScheme 检测显隐）+ softAlpha 柔化接缝 |

* * *

## License & Attribution

-   **CesiumJS**: Apache 2.0
-   **Bing Maps Aerial**: © Microsoft（在线使用通过 Cesium ion）
-   **Esri World Imagery**: © Esri（离线缓存仅限个人科普用途）
-   **NASA Blue Marble**: Public Domain
-   **Lunar DEM/WAC**: Planetary Data System（public domain 教育用途）
-   **Terrarium elevation tiles**: Amazon Web Services Public Dataset（CC BY 4.0）

  

Powered by TRAE/highwindmx