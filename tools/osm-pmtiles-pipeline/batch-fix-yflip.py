#!/usr/bin/env python
"""批量修复 pmtiles 的「每瓦片 y 镜像」缺陷，支持中断后续跑 + 跳过已完成。

特性
----
- 进度日志 `work/yflip-progress*.jsonl`（每行一条 JSON 记录）。
- 「已完成」判定：文件名在 done 集合，或当前文件 sha256 命中任一记录的 sha_out
  （后者用于「修复已落盘但还没写日志就中断」的崩溃恢复）。
- 该修复是「翻转一次」：对已经修好的文件再跑会翻回错误。故重复运行安全——
  已完成文件会被直接跳过，绝不二次翻转。
- 多进程：--workers N 会把待办清单切成 N 片，各自用子进程处理并写各自的日志
  （避免并发写同一文件）；父进程等所有子进程结束后汇总。Windows 下也安全（spawn）。

用法
----
  # 预览将要处理的文件（不改动）
  uv run --no-project --with pmtiles --with mapbox-vector-tile --with shapely \
      python tools/osm-pmtiles-pipeline/batch-fix-yflip.py --dry-run

  # 单进程全量（可 Ctrl+C 中断，重跑自动续）
  uv run --no-project --with pmtiles --with mapbox-vector-tile --with shapely \
      python tools/osm-pmtiles-pipeline/batch-fix-yflip.py

  # 4 进程并行
  uv run --no-project --with pmtiles --with mapbox-vector-tile --with shapely \
      python tools/osm-pmtiles-pipeline/batch-fix-yflip.py --workers 4

  # 把某个已手动修好的文件登记为「完成」，避免重复处理
  uv run --no-project --with pmtiles python \
      tools/osm-pmtiles-pipeline/batch-fix-yflip.py --seed-done 亚洲_中国_上海.v3.pmtiles
"""
import sys
import os
import json
import glob
import time
import hashlib
import subprocess
import importlib.util
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORK = HERE / "work"
WORK.mkdir(exist_ok=True)
LOG_GLOB = str(WORK / "yflip-progress*.jsonl")


def _load_fix():
    """uv run 不会把脚本目录放进 sys.path，用显式路径加载 fix-y-flip.py。"""
    cands = []
    if __file__:
        cands.append(Path(__file__).resolve().parent / "fix-y-flip.py")
    cands.append(Path.cwd() / "tools/osm-pmtiles-pipeline/fix-y-flip.py")
    cands.append(Path("tools/osm-pmtiles-pipeline/fix-y-flip.py"))
    for c in cands:
        if c.exists():
            spec = importlib.util.spec_from_file_location("fix_y_flip", str(c))
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            return mod
    raise SystemExit("找不到 fix-y-flip.py，请确认与 batch-fix-yflip.py 同目录")


fix_y_flip = _load_fix()


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def load_done():
    done, sha_out = set(), set()
    for fp in glob.glob(LOG_GLOB):
        for line in open(fp, encoding="utf-8"):
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except Exception:
                continue
            if r.get("status") == "ok":
                done.add(r["name"])
                if r.get("sha_out"):
                    sha_out.add(r["sha_out"])
    return done, sha_out


def fix_file(src, logpath):
    tmp = str(src) + ".tmp"
    t0 = time.time()
    try:
        n_tiles, n_feat, size_out = fix_y_flip.fix_one(str(src), tmp)
    except Exception as e:  # 单文件失败不阻断整体
        return {"name": src.name, "status": "error", "error": repr(e)}
    sha_in = sha256(str(src))
    os.replace(tmp, str(src))          # 原子替换，避免中断留下半文件
    sha_out = sha256(str(src))
    return {"name": src.name, "status": "ok", "sha_in": sha_in, "sha_out": sha_out,
            "size_out": size_out, "tiles": n_tiles, "feat": n_feat,
            "sec": round(time.time() - t0, 1)}


def slice_of(seq, a, b):
    n = len(seq)
    lo = (a * n) // b
    hi = ((a + 1) * n) // b
    return seq[lo:hi]


def main():
    args = sys.argv[1:]
    d = dict()
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--dir":
            d["dir"] = args[i + 1]; i += 2
        elif a == "--workers":
            d["workers"] = int(args[i + 1]); i += 2
        elif a == "--slice":
            s = args[i + 1].split("/"); d["slice"] = (int(s[0]), int(s[1])); i += 2
        elif a == "--seed-done":
            d["seed"] = args[i + 1]; i += 2
        elif a == "--only":
            d["only"] = args[i + 1]; i += 2
        elif a == "--dry-run":
            d["dry"] = True; i += 1
        else:
            i += 1

    pmt_dir = Path(d.get("dir", HERE.parent.parent / "public/data/osm/pmtiles"))

    if d.get("seed"):
        fp = pmt_dir / d["seed"]
        rec = {"name": fp.name, "status": "ok", "sha_out": sha256(str(fp)),
               "seed": True, "ts": time.time()}
        (WORK / "yflip-progress.seed.jsonl").open("a", encoding="utf-8") \
            .write(json.dumps(rec, ensure_ascii=False) + "\n")
        print(f"已登记为已完成（避免重复处理）: {fp.name}")
        return

    done, sha_out = load_done()
    cand = sorted(pmt_dir.glob("*.pmtiles"))
    pending = []
    for p in cand:
        if p.name in done:
            continue
        if sha256(str(p)) in sha_out:   # 已修复但未在日志（崩溃恢复）
            continue
        if d.get("only") and d["only"] not in p.name:
            continue
        pending.append(p)

    if d.get("dry"):
        print(f"候选目录: {pmt_dir}")
        print(f"待处理 {len(pending)} 个（已跳过 {len(cand)-len(pending)} 个已完成）：")
        for p in pending:
            print("  ", p.name)
        return

    workers = d.get("workers", 1)
    if "slice" not in d and workers > 1:
        # 切 N 片，各自起子进程
        print(f"并行模式：{workers} 进程，待处理 {len(pending)} 个", flush=True)
        procs = []
        for k in range(workers):
            cmd = [sys.executable, str(HERE / "batch-fix-yflip.py"),
                   "--dir", str(pmt_dir), "--slice", f"{k}/{workers}"]
            if d.get("only"):
                cmd += ["--only", d["only"]]
            procs.append(subprocess.Popen(cmd))
        for pr in procs:
            pr.wait()
        print("全部子进程结束。可用 --dry-run 复查剩余。")
        return

    if "slice" in d:
        pending = slice_of(pending, *d["slice"])
        logpath = WORK / f"yflip-progress.{d['slice'][0]}-{d['slice'][1]}.jsonl"
    else:
        logpath = WORK / "yflip-progress.jsonl"

    print(f"本进程处理 {len(pending)} 个 → 日志 {logpath.name}", flush=True)
    n_ok = n_err = 0
    with open(logpath, "a", encoding="utf-8") as lf:
        for p in pending:
            rec = fix_file(p, logpath)
            lf.write(json.dumps(rec, ensure_ascii=False) + "\n")
            lf.flush()
            if rec["status"] == "ok":
                n_ok += 1
                print(f"  ✓ {rec['name']}  {rec['tiles']} 瓦片 / {rec['feat']} 要素 / {rec['sec']}s", flush=True)
            else:
                n_err += 1
                print(f"  ✗ {rec['name']}  ERROR {rec['error']}", flush=True)
    print(f"本进程完成：ok={n_ok} err={n_err}")


if __name__ == "__main__":
    main()
