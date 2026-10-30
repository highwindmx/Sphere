#!/usr/bin/env python
"""把 manifest 中 bbox 完全包含于另一城市的「子集城市」移除，并把对应 pmtiles 移入
隔离目录（可逆，不硬删）。这样飞到该坐标会自动命中父城市，渲染结果逐像素相同。

Cesium 图层（heritage/passes/worldcities 等）里的同名标记点是独立实体，不受影响。
"""
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MANI = ROOT / "public/data/tiles/osm/pmtiles/manifest.json"
PMT = ROOT / "public/data/tiles/osm/pmtiles"
QUAR = ROOT / "archive/quarantine-redundant-subsets"
QUAR.mkdir(parents=True, exist_ok=True)


def area(b):
    return (b[2] - b[0]) * (b[3] - b[1])


def contains(big, small):
    return (big[0] <= small[0] and big[1] <= small[1]
            and big[2] >= small[2] and big[3] >= small[3])


d = json.load(open(MANI, encoding="utf-8"))
entries = [(name, v.get("bbox"), v.get("file", "").replace("pmtiles/", ""))
           for name, v in d.items() if v.get("bbox")]

subsets = []
for name, b, fn in entries:
    parents = [(p, pb, pf) for (p, pb, pf) in entries
               if p != name and contains(pb, b)]
    if not parents:
        continue
    parents.sort(key=lambda x: area(x[1]))
    pname, _pb, _pf = parents[0]
    if area(_pb) == area(b):
        continue
    subsets.append((name, fn, pname))

print(f"将移除 {len(subsets)} 个子集城市，移入 {QUAR.name}/ ：")
moved, skipped = [], []
for name, fn, pname in subsets:
    # 防护：确认没有其他 manifest 条目仍引用该文件
    still_ref = [n for n, v in d.items()
                 if n != name and v.get("file", "").replace("pmtiles/", "") == fn]
    src = PMT / fn
    if still_ref:
        print(f"  ⚠ 跳过 {name}：仍被 {still_ref} 引用")
        skipped.append(name)
        continue
    if name in d:
        del d[name]
    if src.exists():
        dst = QUAR / fn
        shutil.move(str(src), str(dst))
        moved.append((name, fn, pname))
        print(f"  ✓ {name}  → 父 {pname}  (文件 {fn} 已移入隔离)")
    else:
        print(f"  ⚠ {name} 文件缺失 {fn}，仅从 manifest 移除")
        moved.append((name, fn, pname))

json.dump(d, open(MANI, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print(f"\nmanifest 条目: {len(d)}（原 {len(entries)}）")
print(f"已移入隔离: {len(moved)}  跳过: {len(skipped)}")
print("隔离目录:", QUAR)
