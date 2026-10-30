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
| 🏙 世界大城市 | 中国以外 261 座城市，8 个区域分组；美国 / 日本 / 欧洲 / 中国周边加密 |
| 🧭 背面剔除 + 边缘指示 | 球背面标注不再「透视」贴在球面上，改在画布边缘用折线 + 箭头 + 名称引出 |
| 🌊 海底地形底图 | Esri World Ocean Base（GEBCO / NOAA NGDC 测深），一键与卫星底图互换 |
| 🌐 海峡与航道 | 7 大经典海峡 + 北极航道关键锚点（德朗/帕里/兰开斯特） |
| 🌋 海底地形 | 马里亚纳/汤加/波多黎各/爪哇海沟、红海裂谷，带 exaggeration 推荐 |
| ⛰ 国内山脉 | 喜马拉雅/横断/昆仑/秦岭/祁连/天山/阴山 走向折线 |
| 💧 水利工程 | 古代（都江堰/灵渠/坎儿井…）+ 现代（三峡/白鹤滩/溪洛渡/葛洲坝…） |
| 🛰️ 天宫空间站 | TLE 实时解算轨道，depthFailMaterial 补全被地球遮挡半圈 |
| 🚀 探月三幕剧 | 地球发射 → 地月转移（压缩示意）→ 月面着陆，酒泉/文昌 × 雨海/静海 四个组合 |
| 🌙 月球模式 | LOLA DEM 高程 + WAC 底图，一键切换地月 Viewer |
| 📜 历史时空 | 一根年份轴驱动两套开源历史地图：**世界国界**（前 123000 — 2010，54 个年份快照）+ **中国历代疆域**（前 403 — 1948，17 朝代 / 181 阶段，含政权·道州·府州三层、历代城邑、长城运河丝路） |

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

## 标注的背面剔除、边缘指示与避让

三个问题、三个官方或半官方的解法（都在 `src/layer-renderer.js` / `src/offscreen.js`）：

| 问题 | 成因 | 解法 |
| --- | --- | --- |
| 球背面的标注「透视」贴在球面上 | 标注为了不被地形吃掉，统一设了 `disableDepthTestDistance = ∞` | 用 **Cesium 官方 `EllipsoidalOccluder`**（地平线剔除用的就是它）逐点判定，背面直接 `show = false`。侧栏「隐藏球背面标记」开关，关掉可回到旧的半透明虚影 |
| 背面/屏外标注就此消失，不知道对面有什么 | — | **屏幕边缘指示器**（`src/offscreen.js`，SVG 覆盖层）：把点方向投影到相机右/上基向量，从画布中心沿该方向射线与内缩矩形求交，画折线 + 朝外箭头 + 名称；按 15° 扇区限流（每扇区 2 条、总数 16），沿边缘均匀散开。侧栏「屏幕边缘指示」开关 |
| 标注叠字 | 旧版按「经纬度阈值」判断，与屏幕像素距离不对应（低空过度错开、高空不够） | **Cesium 官方 `RectangleCollisionChecker`**（`LabelCollection` 内部就是它）：投影到窗口坐标 → 估算包围盒（CJK 视为 1em、拉丁 0.55em）→ 依次试 0 / ±20 / ±40 px 偏移，五档全冲突才隐藏该条。近处标注优先占位 |

⚠ **1.146 实测坑**：`RectangleCollisionChecker.insert` 的**实参顺序是 `(id, rectangle)`**，与官方文档写的 `(rectangle, id)` 相反。传反了不抛错，只会**静默恒判「不冲突」**（标注照旧叠字）；只传一个参数则抛 `Cannot read properties of undefined (reading 'west')`，异常穿出 tick 会直接让 Cesium 停止渲染（`Rendering has stopped`）。

* * *

## 天体数据源（海底 / 月球 / 火星）

| 目标 | 用途 | 源 | 说明 |
| --- | --- | --- | --- |
| 地球海底 | 测深底图 | **Esri World Ocean Base** `server.arcgisonline.com/.../Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}` | ✅ 已接入（侧栏「🌊 海底地形」，走 `tiles/ocean` 代理、本地缓存）。Web Mercator，全球 ~1:577k，美国沿海 ~1:72k，免 key |
| 地球海底 | 原始网格 | GEBCO_2025 Grid（`download.gebco.net`）／ETOPO 2022（NOAA NCEI） | 15 arc-sec ≈ 450 m，需下载后自行切片（本地已有 terrarium 管线可复用） |
| 地球海底 | WMS | GEBCO WMS（`layers=gebco_latest_3` 等） | 可直接用 `WebMapServiceImageryProvider`，无需切片 |
| 月球 | 影像 | **NASA Moon Trek LRO WAC 303ppd** | ✅ 已接入（走 `tiles/lunar` 代理，≈100 m/像素，相对本地 `lunar_wac.jpg` 的 ~660 m/像素提升约 6.6×） |
| 月球 | 真高程 | LOLA DEM（USGS Astropedia GeoTIFF，如 `LDEM_1024`） | 需下载后本地切片成 terrarium/quantized-mesh；本地 `lunar_dem.png` 仅 4096×2048（≈8.5 km/像素） |
| 月球 | 视觉地形 | Moon Trek / USGS `moon_simp_cyl` WMS 的 LOLA 晕渲层 | 只能当影像叠加，不能当地形 provider |
| 火星 | 影像 | **USGS WMS `mars_simp_cyl.map`**：`MDIM21`（Viking 232 m）、`MDIM21_color`、`THEMIS`（红外 100 m） | ✅ 沙箱实测 GetCapabilities 通过，共 18 个图层 |
| 火星 | 地形晕渲 | 同一 WMS 的 `MOLA_color` / `MOLA_bw` / `MOLA_THEMIS_blend` / `HRSC_MOLA_Blend_Hillshade`（463 m / 200 m） | 影像叠加层，不是高程 |
| 火星 | 真高程 | MOLA DEM 463 m、HRSC_MOLA_Blend 200 m（Astropedia） | 下载后本地切片；火星椭球半径 3,386,190 m（极半径 3,376,200 m） |
| 火星 | 高清 | Murray Lab CTX 瓦片（5–6 m，赤道带）／Mars Trek WMTS／HiRISE DTM（1 m，局部） | 区域覆盖，适合做「着陆区」专题 |

> 火星 Viewer 尚未落地（需要新椭球 + 新容器 + 图层，改动量在数百行）。上面 USGS 的 18 个图层名已实测拿到，随时可以接。

* * *

## 左上角坐标控件与浏览历史

| 元素 | 行为 |
| --- | --- |
| 经度 / 纬度输入框 | **placeholder 即实时光标坐标**（鼠标在地球上滑动时实时写入「经度 105.00°」）；鼠标移出球体回落为视点坐标 |
| 海拔（只读） | 光标/视点处地形高程，`⛰ 1,292 m`；**负值保留符号**并换图标 `🌊 -4,118 m`（terrarium 地形源含海底地形，负值即水下深度） |
| 🎯 定位 | 填入经纬度飞行；**留空 = 定位到光标处**；成功后自动清空输入框（让 placeholder 继续显示实时光标位置）。图标用靶点，与下方「地名查询 📍」区分 |
| 🏠 回国 | 飞回中国全图（105°E, 33°N，1,600km 俯视）；月球模式下先自动切回地球（2026-10-17 从侧栏工具行迁入坐标栏） |
| 🕘 记录 | 可折叠浏览历史：**默认折叠**，每次定位自动记入（localStorage，最多 20 条，按 0.01° 去重），**倒序**展示，点击条目回飞，可一键清空 |

* * *

## 探月任务 3D 模型（glTF）

探月任务（`src/rocket.js` 四幕动画）全程使用 glTF 3D 模型（billboard 仅作加载期/失败兜底）。模型资产由 `tools/make_mission_models.py` 纯标准库生成（无第三方依赖，重新生成：`./.venv/Scripts/python.exe tools/make_mission_models.py`）：

| 文件 | 内容 | 动画 | 用途 |
| --- | --- | --- | --- |
| `public/models/longmarch5.glb` | 长征五号整箭（13 节点：尾裙/红色环带/芯级/整流罩/4 助推器），Y-up 原点=发动机喷口面 | 静态 | 第一幕点火起飞 |
| `public/models/longmarch5_core.glb` | 芯级箭体（带整流罩，无助推器） | 静态 | 第一幕抛助推器后 |
| `public/models/spacecraft.glb` | 飞船上面级（芯级 + 设备舱 + 对接环，无助推/整流罩） | 静态 | 第一幕抛整流罩后 + 第二幕地月转移 + 第三幕环月 |
| `public/models/flame.glb` | 发动机火焰（三层锥嵌套半透明，原点=喷口、焰柱 +Y） | 静态（运行时油门缩放 + 闪烁） | 主发动机喷气特效 |
| `public/models/rcs.glb` | RCS 姿控喷气（蓝白两级锥） | 静态 | 姿态调整喷气特效 |
| `public/models/booster.glb` | 捆绑助推器（17.3m） | 静态（运行时翻滚） | 第一幕分离件 |
| `public/models/fairing.glb` | 整流罩半瓣（半壳） | 静态（运行时自转） | 第一幕分离件 |
| `public/models/moon_lander.glb` | 月面着陆器（4 腿 + 喷口 + 设备舱 + 天线碟） | 静态 | 第三幕动力下降 + 第四幕驻留 |
| `public/models/yutu_rover.glb` | 玉兔号月球车（30 节点：车体/太阳翼/设备舱/桅杆/相机头 + 6 轮各带 3 根轮辐） | 6 轮滚动（绕轮轴整圈 0.86s，4 关键帧 REPEAT 无缝） | 第四幕驶出巡视 |
| `public/models/CesiumMan.glb` | Cesium 官方骨骼动画样例（下载自 jsdelivr），作 skinning 可行性参照 | 骨骼行走 | 验证用 |

四幕结构（进度条节点：点火 0 / 转移 0.22 / 入月轨 0.64 / 着陆 0.83 / 巡视 0.93；第一幕 0.6× 慢放、第四幕 0.7× 慢放）：

1. **点火起飞**（地球 Viewer，约 38s @1×）：3D 整箭垂直上升，机头沿速度方向（重力转弯）；**分离后模型随之切换**（整箭 → 芯级箭 → 飞船上面级，进度条回拖也不会卡错形态）；主发动机**火焰**（油门缩放 + 高频闪烁）、发射台**灰尘**椭圆扩散、过顶段 **RCS 姿控喷气**；助推器/整流罩分离为 3D 件（斜弹 + 翻滚 + 下坠），发射轨迹亮线。
2. **月地转移**（地月顶视图，真实比例）：**霍曼转移椭圆**（近地点 200 km → 远地点 384,400 km，牛顿迭代解开普勒方程），月球沿轨道面同步移动（转移半周期 ≈ 4.96 天扫过 ≈ 65°后与飞船在远地点会合）；轨道面由文昌入轨点 + 东向速度确定；相机悬在**轨道面法向**俯瞰；TLI 点火火焰；月球体积 ×8 放大仅便于观察（UI 有标注）。
   - 线型约定：**实线椭圆弧 = 行径**（未飞半段画淡虚线，两半合成完整椭圆）、**黄色虚直线 = 地月连线**（随月球移动，标 384,400 km）。
3. **环月制动 + 动力下降**（月球 Viewer）：环月轨道倾角 = 着陆点纬度（过着陆点，UI 标注），100 km 圆轨；**逆向点火**（喷流沿速度方向）→ 离轨制动（仍是飞船上面级）→ 着陆器分离动力下降（油门曲线 + 主发动机火焰 + 末段 RCS 精调 + 触月激尘），末端按真实月面 DEM 接地。
4. **玉兔巡视**（月球 Viewer）：着陆器驻留，月球车沿**缓弯弧线（航向 96°→126°）**行驶 14 m，逐点按 DEM 取地面高贴地、车头对准行进方向、留下车辙亮线；6 轮滚动节点动画（整圈 0.86s ≈ 1.16 转/秒，与 1.17 m/s 车速匹配）。

**播放中交互**：画布内鼠标拖拽/滚轮可临时接管相机（脚本机位暂停写入），松手后先静默 1.4s、再用 1.8s 平滑混合回归脚本机位；**只有时间轴上的拖拽才影响时序**（画布左键拖动不 seek）；**右上角导航控件**（指南针/缩放/重置）在第一、三、四幕保持可用（仅第二幕顶视构图锁定），缩放量会被脚本机位继承（不会被回归抹掉）。

**月面高清瓦片**：本地只有 `lunar_wac.jpg`（8192×4096 ≈ 660 m/像素）与 `lunar_dem.png`（≈8.5 km/像素），近距离看不出月面细节。已接入 NASA Moon Trek 官方 WMTS（LRO WAC 全局镶嵌 303 ppd ≈ 100 m/像素）：前端请求本地端点 `/tiles/lunar/{z}/{x}/{y}.jpg`，`app.py` 未命中时代理上游并回写 `public/tiles/lunar/`（与 esri/eox/gibs 同一套「本地优先 + 在线缓存」）；探测失败（离线/不可达）自动回退本地贴图。侧栏「月面高清瓦片」可开关（存 localStorage）。

验证：`node tools/models-smoke.mjs`（10 模型资产冒烟：ready + 渲染像素 diff + 动画双帧 diff 噪声标定）与 `node tools/mission-smoke.mjs`（任务级端到端：探月任务进入（航天探索面板「🚀 探月任务」）→ 分离换模型/火焰/相机接管/时间轴隔离/转移/LOI/下降/巡视断言 + 三幕截图 + 收尾清场，均需先启动 app.py）。

**已验证结论（2026-10-17）**：Cesium 1.146 原生 `Model` 完整支持 glTF 节点动画与 skinning 骨骼动画（CesiumMan 行走 animDiff=3.79，背景隔离后噪声=0）——火箭/探月器的 3D 动画角色无需引入 Three.js。

模型加载要点（1.146 API）：

-   `Model.fromGltfAsync({url, gltfCallback})` 返回 Promise；glTF 动画数量从 `gltfCallback` 的 `gltf.animations` 取（Model 对象不再暴露 `animations`）。
-   模型必须设 `modelMatrix`（如 `Cesium.Transforms.eastNorthUpToFixedFrame(pos)`）定位，否则躺在原点（地心）永远不可见。
-   动画挂载：`model.readyEvent` 或轮询 `model.ready` 后 `model.activeAnimations.add({index, loop: Cesium.ModelAnimationLoop.REPEAT, multiplier})`；**`add` 要求 `model.sceneGraph` 已构建（模型首次 update 后才有），未就绪调用会抛 TypeError**。
-   `requestRenderMode` 下手动出图必须 `scene.requestRender()` + `scene.render(time)` 两步（只调 render() 可能是 no-op）。
-   相机 `lookAt(target, hpr)` 后世界距离用 `camera.positionWC` 断言——`camera.position` 是 lookAt 参考系下的局部坐标，混用会误判「相机跑到原点」。
-   `minimumPixelSize` 的放大用 `_initialRadius`（≠当前 boundingSphere.radius），**表观像素实测 ≈ 0.231 × minPx**（理论公式会高估约 4 倍）；本项目按「对齐旧 billboard 尺寸」标定：火箭/飞船 150、分离件/着陆器 120、月球车 80。
-   月球 Viewer 每次进入月球模式都会重建（`destroyMoonViewer` → `viewer.destroy()`，其 primitives 随之销毁），任务侧按「viewer 换代即销毁重建模型槽位」处理。
-   glTF 数据 +Y 经 Cesium 内部校正后**不等于** ENU +Z（实测存在轴向翻转分量）——「机头/焰柱对准某方向」不能用「数据 +Y 旋转到该方向」的四元数，必须以「校正后轴向 = ENU Z」为基准推旋转，并用截图/矩阵列向量实证验收（本项目 flame 方向曾因此连续误判三轮）。
-   **动画曲线的 `lerp(a,b,t)` 写反（t=0 返回 b）会让所有路径/油门/相机 range 整体倒放且带段间跳变**，状态断言（ready/show）抓不到，必须配几何数值断言（如飞行方向 dot up）或截图审查。

* * *

## 历史时空（两套开源历史地图）

侧栏「📜 历史时空」勾选启用后，一根年份轴同时驱动两套数据：

| 数据集 | 上游 | 覆盖范围 | 资产 | 图层 |
| --- | --- | --- | --- | --- |
| 世界历史国界 | [aourednik/historical-basemaps](https://github.com/aourednik/historical-basemaps) | **54 个年份快照**，前 123000（直立人分布）→ 2010 | 11.1 MB / 54 个按年分片 | 半透明国界面 + 大国标签 + 2220 个历史城市点（按存续年代过滤） |
| 中国历代疆域 | [DeanChensj/jiangshan-map](https://github.com/DeanChensj/jiangshan-map) | **17 朝代 / 181 个阶段**，前 403（三家分晋）→ 1948 | 2.7 MB（VLQ 惰性解码包） | 政权 / 高层政区 / 府州 / 历代城邑 / 长城·运河·丝路 / 历史事件点 |

交互：

-   **年份轴**：世界快照档位 + 中国阶段起点合并去重，共 **230 档**；`‹ ›` 逐档、滑块拖动、`▶ 播放` 自动推进（900 ms/档）。
-   **重叠年份两套同屏**：如 1900 年同时显示世界列强版图与清帝国政区，1492 年显示 600 个世界政区 + 明代政区。
-   **世界国界按 `SUBJECTO`（宗主国）着色**——同一殖民帝国的所有属地同色，`BORDERPRECISION` 越低填充越淡（示意边界）。
-   **悬停**看归属（如「British Raj · 属 United Kingdom」），**点击面**飞到该政权；城邑点显示「古名（今名）· 都城 · 备注」。
-   **分层开关**：政权 / 高层政区 / 府州 / 历代城邑 / 长城运河丝路 / 历史事件点 / 世界历史城市（府州与历史城市默认关，要素已多）。
-   **标签分级**：政权名全球可见；城邑名拉近到 4000 km 视距内才出现；世界历史城市名需 2500 km 内——避免同屏数百个标签糊成一片。
-   **面数上限**：精简 300 / 标准 600 / 全部。按面积降序保留主要政权，丢掉细碎碎片。

### 数据资产与重建

产物在 `public/data/history/`（**已入库**，共约 14 MB），由 `tools/history/` 下两个脚本从上游仓库构建：

```powershell
# 世界历史国界：71.2 MB 源 GeoJSON → 11.1 MB（RDP 简化 + 坐标 3 位小数 + 属性裁剪）
./.venv/Scripts/python.exe tools/history/build-world-basemaps.py --src <historical-basemaps 根目录>
# 无 --src 时自动 git clone 到 .cache/historical-basemaps

# 中国历代疆域：只搬 2.7 MB 的 VLQ 惰性解码包，再生成年份→快照索引
node tools/history/build-china-atlas.mjs --src <jiangshan-map 根目录>
```

⚠ **为什么不用 jiangshan-map 官方的 `export_geojson.js`**：那份脚本会把 181 个阶段展开成 **63 MB** GeoJSON；而上游 `atlas_snapshots.js` 是拓扑去重 + VLQ 编码的**惰性解码包**（访问 `shape.coordinates` 才展开单个面），只有 **1.67 MB**。本项目直接搬这个包，前端在切阶段时按需解码，资产体积差 37 倍。

⚠ **`polygon.hierarchy` 不接受数组**：MultiPolygon 必须拆成多个 entity，否则 Cesium 读 `positions` 得到 `undefined` → `normalized result is not a number` → 整个场景 `Rendering has stopped`。`src/history-atlas.js` 的 `addPolygon()` 已按此拆，并对环做合法性清洗（< 4 顶点、非有限值、连续重复点全部剔除）。

⚠ **政区默认不贴地形**：`polygon.clampToGround` 按 terrainProvider 的**真实**高程生成几何，而球体现在开着垂直夸张（默认 1.2×）——两者不一致，政区面会整体沉到夸张后的地形之下、肉眼完全看不到。想看贴地起伏，先把夸张调回 1× 再勾选「政区贴合地形」。

* * *

## 项目结构

```
Sphere/
├── src/
│   ├── main.js                 ← 应用入口（Viewer / 极地补丁 / 底图 / 交互）
│   ├── history-atlas.js        ← 历史时空：年份轴 + 两套历史地图的加载/渲染/拾取 + 侧栏面板
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
│   ├── history/                      ← 历史时空数据管线
│   │   ├── build-world-basemaps.py   ← 世界历史国界：源 GeoJSON → 简化分片（71 MB → 11 MB）
│   │   └── build-china-atlas.mjs     ← 中国历代疆域：搬 VLQ 包 + 生成朝代/阶段/年份索引
│   ├── make_mission_models.py        ← 生成探月任务 glTF 模型（长征五号 / 玉兔号，纯标准库）
│   ├── models-smoke.mjs              ← glTF 模型加载+动画端到端冒烟（headless Edge + CDP）
│   └── convert_lunar.py              ← 原始 TIF → lunar_dem.png / lunar_wac.jpg
├── public/
│   ├── data/
│   │   ├── osm/                 ← 离线 OSM 矢量（PMTiles 单文件，gitignore）
│   │   └── history/             ← 历史时空资产（约 14 MB，已入库）
│   │       ├── world/           ← 世界历史国界：index.json + w_<year>.json × 54 + places.json
│   │       └── china/           ← 中国历代疆域：index.json + 4 个上游 js（VLQ 包 / 朝代 / 水文 / 词典）
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

**本项目自 2026-10-26 起以 [GPL-3.0](LICENSE) 发布**（因随仓库分发的 `public/data/history/` 历史地图数据来自 GPL-3.0 上游）。

第三方组件：

-   **CesiumJS**: Apache 2.0
-   **Bing Maps Aerial**: © Microsoft（在线使用通过 Cesium ion）
-   **Esri World Imagery**: © Esri（离线缓存仅限个人科普用途）
-   **NASA Blue Marble**: Public Domain
-   **Lunar DEM/WAC**: Planetary Data System（public domain 教育用途）
-   **Terrarium elevation tiles**: Amazon Web Services Public Dataset（CC BY 4.0）

历史时空数据（均经 `tools/history/` 脚本转换，保留原许可）：

| 数据 | 上游 | 许可 | 备注 |
| --- | --- | --- | --- |
| 世界历史国界 | [aourednik/historical-basemaps](https://github.com/aourednik/historical-basemaps) | GPL-3.0 | 54 个年份快照；属性 `NAME / SUBJECTO / PARTOF / BORDERPRECISION` |
| 中国历代疆域 | [DeanChensj/jiangshan-map](https://github.com/DeanChensj/jiangshan-map) | GPL-3.0 | 17 朝代 / 181 阶段；上游另有派生条款：府州级边界与战国疆域派生自 **CHGIS V6**（哈佛燕京学社 & 复旦大学）与 **Robert M. Hartwell** 数据集，**保留原始「学术、非商业使用」限制** |

⚠ 两套历史边界均为**示意级近似**（schematic approximations），用于说明历史管辖范围，**不是现代测绘国界**；上游亦建议学术用途前与其他来源交叉核对。涉及 CHGIS 派生部分不得用于商业用途。

  

Powered by TRAE/highwindmx