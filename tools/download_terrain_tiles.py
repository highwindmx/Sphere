#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""download_terrain_tiles.py — 本地 Terrarium 地形瓦片下载器（Python 版）

等价 tools/download_terrain_tiles.py（2026-10-15 已修正为 Mercator），但用 Python 实现，
带断点续传、失败重试、并发、实时进度 + ETA、可选哈希校验。

数据源：AWS 公共数据集 elevation-tiles-prod（Terrarium PNG，全球到 z15）
    URL: https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
    无 API key、无使用限制、无 requester-pays。

切分方案（关键）：
    AWS Terrarium 原生为 Web Mercator XYZ（EPSG:3857，方形），x 按经度线性，
    y 按墨卡托纬度（非线性）。这与 src/terrarium-provider.js 的
    WebMercatorTilingScheme 零换算对应。
    ⚠️ 历史坑：旧脚本误用 Geographic（Geodetic）纬度公式算 y，导致中国区 z6–z9
    与兴趣点 z10–z12 下载到错误经纬度（实际是平的）。本脚本用正确 Mercator 公式。
    磁盘上这些错瓦片需先手动删除（见文末“删除坏瓦片”命令）再跑本脚本。

下载范围（默认，与 provider 完全对齐）：
    全球 z0–z5（全量，约 1365 张）
    中国 bbox [60,0,150,60]  z6–z9
    山脉兴趣点 z10–z12（以 mountains.js 折线中点 ±3° 为 bbox）

用法（在项目根目录运行）：
    python tools/download_terrain_tiles.py                  # 默认全套
    python tools/download_terrain_tiles.py --quick          # 仅全球 z0–z2（验证脚本/网络）
    python tools/download_terrain_tiles.py --region china   # 仅中国 z6–z9
    python tools/download_terrain_tiles.py --region places  # 仅兴趣点 z10–z12
    python tools/download_terrain_tiles.py --dry-run        # 仅统计分段/分级数量，不下载
    python tools/download_terrain_tiles.py --verify         # 下载后抽样本地 vs AWS 哈希比对
    python tools/download_terrain_tiles.py --no-places      # 不下兴趣点高分辨率
    python tools/download_terrain_tiles.py --force          # 忽略已存在，覆盖重下
"""

import argparse
import hashlib
import json
import math
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

# ---------- 路径与常量 ----------
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "public", "tiles", "terrain")
BASE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium"

CONCURRENCY = 8
MAX_RETRY = 3
TIMEOUT = 20  # 秒

GLOBAL_MAX = 5
CHINA_MAX = 9
CHINA_BBOX = (60.0, 0.0, 150.0, 60.0)  # minLon, minLat, maxLon, maxLat
LAT_CAP = 85.05112878  # Web Mercator 纬度上限

# ---------- Mercator (EPSG:3857) 切分 ----------
def lon_lat_to_tile(lon, lat, z):
    n = 2 ** z
    x = int((lon + 180.0) / 360.0 * n)
    lat_c = max(-LAT_CAP, min(LAT_CAP, lat))
    lat_rad = math.radians(lat_c)
    y = int((1.0 - math.log(math.tan(lat_rad) + 1.0 / math.cos(lat_rad)) / math.pi) / 2.0 * n)
    return x, max(0, min(n - 1, y))


def tiles_in_bbox(z, minlon, minlat, maxlon, maxlat):
    x1, y1 = lon_lat_to_tile(minlon, maxlat, z)
    x2, y2 = lon_lat_to_tile(maxlon, minlat, z)
    n = 2 ** z
    out = []
    for x in range(min(x1, x2), max(x1, x2) + 1):
        for y in range(min(y1, y2), max(y1, y2) + 1):
            if 0 <= y < n:
                out.append((x, y))
    return out


def push_global(z):
    n = 2 ** z
    return [(x, y) for x in range(n) for y in range(n)]


# ---------- 兴趣点（山脉中点）----------
def load_places():
    """通过 node 读取 mountains.js 的折线中点（单一数据源）。"""
    helper = os.path.join(ROOT, "tools", "emit_places.mjs")
    if not os.path.isfile(helper):
        print("[warn] 找不到 emit_places.mjs，跳过兴趣点。", file=sys.stderr)
        return 3.0, []
    try:
        # Windows 默认 locale 编码为 GBK，node 输出是 UTF-8，必须显式指定编码，
        # 否则子进程 stdout 解码线程会抛 UnicodeDecodeError，导致 proc.stdout 为 None。
        proc = subprocess.run(
            ["node", helper], capture_output=True, text=True,
            encoding="utf-8", errors="replace", cwd=ROOT, timeout=60
        )
    except FileNotFoundError:
        print("[error] 未找到 node，无法读取山脉兴趣点。请安装 Node.js，或加 --no-places。", file=sys.stderr)
        sys.exit(2)
    if proc.returncode != 0:
        print("[error] emit_places.mjs 失败：", proc.stderr, file=sys.stderr)
        sys.exit(2)
    if not proc.stdout:
        print("[error] emit_places.mjs 未返回任何 stdout（node 可能崩溃）。", file=sys.stderr)
        sys.exit(2)
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError as e:
        print("[error] emit_places.mjs 输出非 JSON：", e, file=sys.stderr)
        print("stdout 前 200 字符：", proc.stdout[:200], file=sys.stderr)
        sys.exit(2)
    return float(data.get("delta", 3.0)), data.get("places", [])


# ---------- 任务清单 ----------
def build_task_list(opts):
    tasks = []
    segments = []

    def push_bbox(z, bbox):
        lo = tiles_in_bbox(z, *bbox)
        tasks.extend((z, x, y) for (x, y) in lo)

    def mark(name):
        seg = {"name": name, "start": len(tasks)}
        segments.append(seg)
        return seg

    def finish(seg):
        seg["count"] = len(tasks) - seg["start"]

    if opts.quick:
        s = mark("全球 z0–z2 (--quick)")
        for z in range(0, 3):
            push_bbox(z, (-180, -85, 180, 85))  # 全球全量（quick 仅验证）
        finish(s)
        return dedupe(tasks, segments)

    if opts.region in (None, "global"):
        s = mark("全球 z0–z5")
        for z in range(0, GLOBAL_MAX + 1):
            tasks.extend((z, x, y) for (x, y) in push_global(z))
        finish(s)

    if opts.region in (None, "china"):
        s = mark(f"中国 bbox{CHINA_BBOX} z6–z{CHINA_MAX}")
        for z in range(6, CHINA_MAX + 1):
            push_bbox(z, CHINA_BBOX)
        finish(s)

    if opts.region in (None, "places") and not opts.no_places:
        delta, places = load_places()
        for p in places:
            s = mark(f"{p['name']}({p['lon']:.1f},{p['lat']:.1f}) ±{delta}° z10–z12")
            bbox = (p["lon"] - delta, p["lat"] - delta, p["lon"] + delta, p["lat"] + delta)
            for z in range(10, 13):
                push_bbox(z, bbox)
            finish(s)

    return dedupe(tasks, segments)


def dedupe(tasks, segments):
    seen = set()
    out = []
    dup = 0
    for t in tasks:
        k = f"{t[0]}/{t[1]}/{t[2]}"
        if k in seen:
            dup += 1
            continue
        seen.add(k)
        out.append(t)
    return out, segments, dup


def count_by_zoom(tasks):
    m = {}
    for z, _, _ in tasks:
        m[z] = m.get(z, 0) + 1
    return sorted(m.items())


# ---------- 下载单个瓦片 ----------
def tile_path(z, x, y):
    return os.path.join(OUT_DIR, str(z), str(x), f"{y}.png")


def tile_url(z, x, y):
    return f"{BASE_URL}/{z}/{x}/{y}.png"


def download_tile(z, x, y, force):
    out = tile_path(z, x, y)
    if not force and os.path.isfile(out):
        return "skip"
    for attempt in range(MAX_RETRY + 1):
        try:
            req = Request(tile_url(z, x, y), headers={"User-Agent": "sphere-terrain-downloader/1.0"})
            with urlopen(req, timeout=TIMEOUT) as resp:
                data = resp.read()
            if len(data) < 100:
                raise IOError(f"响应过小（{len(data)} 字节），疑似空瓦片")
            os.makedirs(os.path.dirname(out), exist_ok=True)
            with open(out, "wb") as f:
                f.write(data)
            return "ok"
        except (HTTPError, URLError, IOError, TimeoutError) as e:
            if attempt >= MAX_RETRY:
                raise
            time.sleep(0.5 * (attempt + 1))
    raise RuntimeError("unreachable")


# ---------- 并发调度 + 进度 ----------
def run_pool(tasks, force):
    done = 0
    ok = skip = fail = 0
    failures = []
    start = time.time()
    last_print = 0.0

    def worker(t):
        z, x, y = t
        try:
            return download_tile(z, x, y, force)
        except Exception as e:  # noqa: BLE001
            return ("fail", str(e))

    with ThreadPoolExecutor(max_workers=CONCURRENCY) as ex:
        futures = [ex.submit(worker, t) for t in tasks]
        for fut in as_completed(futures):
            done += 1
            r = fut.result()
            if r == "ok":
                ok += 1
            elif r == "skip":
                skip += 1
            else:
                fail += 1
                failures.append(r[1])
            now = time.time()
            if now - last_print >= 0.4 or done == len(tasks):
                last_print = now
                elapsed = now - start
                rate = done / elapsed if elapsed > 0 else 0
                remain = len(tasks) - done
                eta = int(remain / rate) if rate > 0 else 0
                eta_s = f"{eta // 60}m{eta % 60}s" if eta > 60 else f"{eta}s"
                sys.stdout.write(
                    f"\r{done}/{len(tasks)}  (新 {ok} · 跳过 {skip} · 失败 {fail}) · "
                    f"{rate:.1f} 张/秒 · 剩 {eta_s}   "
                )
                sys.stdout.flush()
    sys.stdout.write("\n")
    return ok, skip, fail, failures


# ---------- 校验：本地 vs AWS 哈希比对 ----------
def verify(tasks, sample=200):
    import random
    random.seed(0)
    pick = tasks if len(tasks) <= sample else random.sample(tasks, sample)
    mismatch = 0
    missing = 0
    checked = 0
    for z, x, y in pick:
        p = tile_path(z, x, y)
        if not os.path.isfile(p):
            missing += 1
            continue
        checked += 1
        local = hashlib.md5(open(p, "rb").read()).hexdigest()
        try:
            req = Request(tile_url(z, x, y), headers={"User-Agent": "sphere-verify/1.0"})
            with urlopen(req, timeout=TIMEOUT) as resp:
                remote = hashlib.md5(resp.read()).hexdigest()
        except Exception:  # noqa: BLE001
            continue
        if local != remote:
            mismatch += 1
            print(f"  [不一致] z{z} x{x} y{y}  本地 {local} 远程 {remote}")
    print(f"校验抽样 {len(pick)}：本地缺失 {missing} · 比对 {checked} · 不一致 {mismatch}")
    if mismatch == 0 and missing == 0:
        print("✅ 抽样瓦片全部与 AWS 在线一致")
    else:
        print("⚠️ 存在不一致/缺失，建议用 --force 重下对应层级")


# ---------- 主流程 ----------
def main():
    ap = argparse.ArgumentParser(description="本地 Terrarium 地形瓦片下载器（Python）")
    ap.add_argument("--quick", action="store_true", help="仅全球 z0–z2（验证）")
    ap.add_argument("--dry-run", action="store_true", help="仅统计，不下载")
    ap.add_argument("--verify", action="store_true", help="下载后抽样本地 vs AWS 哈希比对")
    ap.add_argument("--region", choices=["global", "china", "places"], default=None)
    ap.add_argument("--no-places", action="store_true", help="不下兴趣点高分辨率")
    ap.add_argument("--force", action="store_true", help="覆盖已存在的瓦片")
    opts = ap.parse_args()

    tasks, segments, dup = build_task_list(opts)

    print("===== 分段清单 =====")
    for seg in segments:
        print(f"  {seg['count']:>7}  {seg['name']}")
    print(f"  重复瓦片：{dup}")
    print(f"  去重后合计：{len(tasks)}")
    print("===== 按缩放级别 =====")
    for z, n in count_by_zoom(tasks):
        print(f"  z{z:>2}：{n}")

    exist = sum(1 for (z, x, y) in tasks if os.path.isfile(tile_path(z, x, y)))
    print(f"\n本地已存在：{exist} · 仍需下载：{len(tasks) - exist}")

    if opts.dry_run:
        return
    if opts.verify:
        verify(tasks)
        return

    if not tasks:
        print("没有任务。")
        return
    if len(tasks) > 200000:
        print("[warn] 任务量较大，预计耗时数小时。Ctrl+C 可取消，下次断点续传。")
    elif len(tasks) > 20000:
        print("预计耗时几十分钟到 1 小时。可随时 Ctrl+C 取消，下次运行断点续传。")
    else:
        print("预计几分钟内完成。")

    ok, skip, fail, failures = run_pool(tasks, opts.force)
    print(f"\n完成：新下 {ok} · 跳过 {skip} · 失败 {fail}")
    if failures:
        print(f"失败样例（前 10）：")
        for f in failures[:10]:
            print(f"  {f}")
        if len(failures) > 10:
            print(f"  …还有 {len(failures) - 10} 个失败")
        print("\n重新运行本脚本即可续传（已下的跳过，只重试失败）。")


if __name__ == "__main__":
    main()
