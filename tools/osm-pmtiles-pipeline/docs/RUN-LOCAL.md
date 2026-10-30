# 本机跑批备忘（RUN-LOCAL）

离线 OSM PMTiles 抽取——本机前台运行 runbook。沙箱后台任务会被回收，故改为本机前台跑。

## 现状（2026-10-26）

- 已完成 **约 230 / 448** 个 `.pmtiles`（约 2.1 GB），输出目录 `public/data/osm/pmtiles/`。
- 待跑 **218 城 / 14 组**（单批串行，按源 pbf 大小升序）：
  - iran(3/7)、greece(5/7)、spain(6/7)、china(123/124)、alps(1/2)、japan(18/36)、sea(9/33)、south-america(4/23)、russia(0/7)、france(0/6)、dach(0/11)、africa(1/29)、us(0/41)、asia(5/60)
- 清单：`tools/osm-pmtiles-pipeline/_bgroup_manifest.v3.json`（448 城，权威版；在 v2 基础上**合并龟兹错点 + 新疆丝路点国别由哈萨克斯坦改中国**）。`tools/_bgroup_manifest.json` 是 441 旧版（被 Windows ACL 卡只读，忽略）。

## Windows 中文 locale 必读（已修，但记一笔）

本机 Python `open()` 默认走 **GBK**，而清单 JSON 是 **UTF-8**（含中文城市名），会报
`UnicodeDecodeError: 'gbk' codec can't decode ...`。已在以下文件的所有文本 `open` 加 `encoding='utf-8'`：

- `tools/osm-pmtiles-pipeline/run-remaining.py`（读/写清单与状态）
- `tools/osm-pmtiles-pipeline/pbf-to-pmtiles.py`（读清单、读续跑结果、写结果）

其余脚本（`merge-manifests.py` / `progress-table.py` / `geo-country.py` / `reuse-v1.py`）本就带 `encoding='utf-8'`。

> 若某天另起脚本仍撞 GBK，跑之前设环境变量即可兜底：
> - cmd：`set PYTHONUTF8=1`
> - PowerShell：`$env:PYTHONUTF8=1`

## 运行命令（Git Bash，从项目根 `D:/Share/Scripts/Explore/sphere`）

```bash
# 0) （可选）把权威清单提升为无后缀名版——本机拥有文件可写；不做也行，
#    run-remaining.py 已直接读 v3
copy tools\pmtiles\_bgroup_manifest.v3.json tools\_bgroup_manifest.json

# 1) 预览待跑队列（确认是 14 组 / 241 城）
./.venv/Scripts/python.exe tools/osm-pmtiles-pipeline/run-remaining.py --dry-run

# 2) 正式跑：单批串行 + 断点续跑（关窗口/休眠后重跑同句会自动跳过已完成）
./.venv/Scripts/python.exe tools/osm-pmtiles-pipeline/run-remaining.py
```

PowerShell 等价：`.\.venv\Scripts\python.exe tools\pmtiles\run-remaining.py`

## 行为要点

- 串行、一次一组，内存恒定不会 OOM。
- 已完成的 10 个整组（australia-oceania / central-america / great-britain / iraq / israel / italy / serbia / south-korea / turkey / ukraine）**自动跳过，不再扫源 pbf**。
- 组内续跑：`pbf-to-pmtiles.py` 按磁盘已有 `.pmtiles` 跳过，只补缺失城市。
- **中断恢复（实测 2026-10-26）**：Ctrl+C 后先删残留 clip 再重启，否则最长白等 15 分钟：
  `rm -f tools/.work/*.clip.osm.pbf`
  原因：`active_extracts()` 按 `tools/.work/*.clip.osm.pbf` 的 mtime（<25min）判"活跃"，只认文件时间不认进程；等待循环每 30s 查一次、900s 硬上限后自动继续（不会死循环）。组名匹配用首段（`south-korea`/`south-america` 会互相误判），删文件后无影响。
- 剩余全是重量级源（asia 15GB、us 11GB、africa 7.4GB、dach 5.8GB、france 4.75GB…），**预计一整晚（约 8–14 小时，看机器）**。

## 跑的过程中看进度（另开一个终端）

```bash
# 最简：数文件，爬向 448
ls public/data/osm/pmtiles/*.pmtiles | wc -l

# 带分组明细
./.venv/Scripts/python.exe tools/osm-pmtiles-pipeline/progress-table.py --manifest tools/osm-pmtiles-pipeline/_bgroup_manifest.v3.json

# 简写（默认值已指向 v3，可省 --manifest）
./.venv/Scripts/python.exe tools/osm-pmtiles-pipeline/progress-table.py
```

PowerShell 版：`.\.venv\Scripts\python.exe tools\pmtiles\progress-table.py --manifest tools\pmtiles\_bgroup_manifest.v3.json`
（PowerShell 里数文件没有 `wc`：`(Get-ChildItem public\data\osm\pmtiles\*.pmtiles).Count`）

> ⚠️ **旧命令已失效**：`tools\progress-table.py --manifest tools\_bgroup_manifest.v2.json`
> 脚本已移至 `tools/osm-pmtiles-pipeline/`，且 **v2 清单已隔离**到 `archive/quarantine-tools/snapshots/` —— 现在权威清单是 **`_bgroup_manifest.v3.json`**（448 城）。

## Python 依赖（离线跑批必需）

- `pbf-to-pmtiles.py` 第 41 行裸 `import mapbox_vector_tile`（MVT 编码核心）。
- 2026-10-26 发现该包在本机 venv 中丢失；且 venv 多个 dist-info 的 `METADATA` 缺失导致 `uv pip install` 无法解析依赖图。修复命令：
  ```bash
  uv pip install --no-deps --python .venv/Scripts/python.exe mapbox-vector-tile
  ```
- 症状预判：若日志出现 `ModuleNotFoundError: No module named 'mapbox_vector_tile'`，跑上面一句即可（已验证 import + encode 均正常）。

## 全部跑完后（必须做）

```bash
# 0) 收尾修正（必须在 run-remaining.py 完全跑完、无活跃进程后执行）：
#    - 旧国别文件名改名：龟兹/焉耆 哈萨克斯坦→中国、耶路撒冷 以色列→巴勒斯坦
#    - 所有 m_*.json 由 GBK 转 UTF-8（早期 v2 进程写的是 GBK，不转 merge 会挂）
./.venv/Scripts/python.exe tools/osm-pmtiles-pipeline/fix-country-names.py

# 1) 合并所有 m_*.json → 前端 manifest.json；并报告疑似残缺瓦片
./.venv/Scripts/python.exe tools/osm-pmtiles-pipeline/merge-manifests.py
```

- fix 脚本只动 4 个旧国别城市（阿拉木图/阿斯塔纳在 v3 仍是哈萨克斯坦、特拉维夫仍是以色列，均不动）。
- merge 会列出 `tiles<400 或 <300KB` 的「疑似空城」——基本对应 `OSM-TODO.md` 的 A 类（缺源 pbf），后补即可，不影响其余城市上线。

## 跑后清理（可选）

- v3 相对 v2 的改动：**合并龟兹（库车）错点**（删 silkroad 层 41.40/83.70，保留 xuanzang 层 41.70/82.90 库车真址）、**新疆丝路点国别由哈萨克斯坦改中国**（龟兹、焉耆×2）。若磁盘残留旧名/旧国别 `.pmtiles`（如 `亚洲-哈萨克斯坦-龟兹（库车）.pmtiles`），不会被 manifest 引用，成为孤儿文件，无害；跑完合并后可直接删。

## 已知遗留（详见 `OSM-TODO.md`）

- **A 类**：7 个 EMPTY 城缺源 pbf，需补下载后后跑。
- **B 类**：疑似重复待确认（金字塔→开罗、埼玉/川崎→东京、新山→新加坡等）。
- **C 类**：源库坐标错（伊吾≈沙州、阳关≈伊州）。
- **E 类**：可删的重复 pbf 清单。

## 备注

- 沙箱里曾建过「每小时汇报进度」自动化，监测的是沙箱队列、对本地跑无意义，已关闭。
- 每小时汇报当初因自动化最小间隔限制（不支持 30 分钟）设为 HOURLY；本地跑无需此汇报。
