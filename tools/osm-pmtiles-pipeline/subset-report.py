#!/usr/bin/env python
"""列出 manifest 中 bbox 完全包含于另一城市的「子集城市」，给出父城市、坐标、文件存在性。"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MANI = ROOT / "public/data/osm/pmtiles/manifest.json"
PMT = ROOT / "public/data/osm/pmtiles"

d = json.load(open(MANI, encoding="utf-8"))


def area(b):
    return (b[2] - b[0]) * (b[3] - b[1])


def contains(big, small):
    return (big[0] <= small[0] and big[1] <= small[1]
            and big[2] >= small[2] and big[3] >= small[3])


entries = []
for name, v in d.items():
    b = v.get("bbox")
    if not b:
        continue
    entries.append((name, b, v.get("file", "").replace("pmtiles/", "")))

print(f"manifest 条目: {len(entries)}")
subsets = []
for name, b, fn in entries:
    # 找面积最小、且真包含本 bbox 的父
    parents = [(pname, pb, pfn) for (pname, pb, pfn) in entries
               if pname != name and contains(pb, b)]
    if not parents:
        continue
    parents.sort(key=lambda x: area(x[1]))
    pname, pb, pfn = parents[0]
    if area(pb) == area(b):
        continue  # 完全等同才算同一条，不计
    on_disk = (PMT / fn).exists()
    parent_on_disk = (PMT / pfn).exists()
    subsets.append((name, b, fn, pname, pb, pfn, on_disk, parent_on_disk))

print(f"\n=== 子集城市共 {len(subsets)} 个 ===")
for name, b, fn, pname, pb, pfn, od, pod in subsets:
    flag = "" if (od and pod) else "  ⚠文件缺失"
    print(f"{name}")
    print(f"   bbox=({b[0]:.3f},{b[1]:.3f},{b[2]:.3f},{b[3]:.3f})  file={fn}  on_disk={od}")
    print(f"   ⊃ 父城市={pname}  bbox=({pb[0]:.3f},{pb[1]:.3f},{pb[2]:.3f},{pb[3]:.3f})  file={pfn}  on_disk={pod}{flag}")
