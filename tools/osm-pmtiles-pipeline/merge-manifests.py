#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""合并 public/data/tiles/osm/pmtiles/ 下所有 m_*.json 分组清单 → manifest.json（前端唯一读取的文件）。

规则：
  · 以城市名为键取并集；同名条目以「tiles 更多」的为准（重复城市时保留更完整的那份）
  · 只保留磁盘上真实存在且非空的 .pmtiles
  · 老 manifest.json 里已有的城市一并并入（早期产物不丢）
  · 写出前先备份 manifest.json → manifest.bak.json

用法：
    ./.venv/Scripts/python.exe tools/merge-manifests.py [--dry-run] [--min-tiles 400]
"""
import argparse
import glob
import gzip
import json
import os
import struct
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUTDIR = os.path.join(ROOT, 'public', 'data', 'tiles', 'osm', 'pmtiles')


def _varint(buf, pos):
    shift = 0; val = 0
    while True:
        b = buf[pos]; pos += 1
        val |= (b & 0x7f) << shift
        if not (b & 0x80): break
        shift += 7
    return val, pos


def count_tiles(path):
    """数 pmtiles 目录里的瓦片条数（含 leaf 目录递归）。
    manifest 里断点续跑产出的条目没有 tiles 字段（=0），必须用这个补出来，否则 QA 全是假警报。"""
    try:
        data = open(path, 'rb').read()
        if data[:7] != b'PMTiles' or data[7] != 3:
            return -1
        root_off, root_len = struct.unpack_from('<QQ', data, 8)
        leaf_off, leaf_len = struct.unpack_from('<QQ', data, 40)

        def n_entries(off, ln):
            raw = gzip.decompress(data[off:off + ln])
            n, pos = _varint(raw, 0)
            last = 0; ids = []
            for _ in range(n):
                d, pos = _varint(raw, pos); last += d; ids.append(last)
            rls = []
            for _ in range(n):
                v, pos = _varint(raw, pos); rls.append(v)
            lens = []
            for _ in range(n):
                v, pos = _varint(raw, pos); lens.append(v)
            offs = []; prev_end = 0
            for i in range(n):
                v, pos = _varint(raw, pos)
                o = prev_end if v == 0 else (v - 1)
                offs.append(o); prev_end = o + lens[i]
            total = 0
            for i in range(n):
                if lens[i] == 0:            # 指向 leaf 目录
                    total += n_entries(leaf_off + offs[i], rls[i])
                else:
                    total += rls[i]
            return total

        return n_entries(root_off, root_len)
    except Exception:
        return -1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--min-tiles', type=int, default=400,
                    help='QA：瓦片数少于此值视为疑似残缺，仅报告不删除')
    args = ap.parse_args()

    merged = {}
    src_of = {}

    def take(name, rec):
        old = merged.get(name)
        if old is None or rec.get('tiles', 0) > old.get('tiles', 0):
            merged[name] = rec
            src_of[name] = src_of.get(name, '')

    files = sorted(glob.glob(os.path.join(OUTDIR, '*.json')))
    for fp in files:
        base = os.path.basename(fp)
        if base == 'manifest.json' or base.endswith('.bak.json'):
            continue
        try:
            data = json.load(open(fp, encoding='utf-8'))
        except Exception as e:
            print('  跳过坏清单 %s: %s' % (base, e))
            continue
        if not isinstance(data, dict):
            continue
        for name, rec in data.items():
            if not isinstance(rec, dict) or not rec.get('ok'):
                continue
            take(name, rec)
            src_of[name] = base

    # ⭐ 2026-10-30：老 manifest.json 的条目必须并入！
    # build-new-cities.py 直接把新城市写进 manifest.json（不写 m_*.json），
    # 若这里只读 m_*.json，重建会把那批城市整批抹掉（实测 41 座：布鲁塞尔/安卡拉/喀山…）。
    # docstring 一直写着「老 manifest 一并并入」，但代码没实现 —— 现在补上。
    old_path = os.path.join(OUTDIR, 'manifest.json')
    if os.path.exists(old_path):
        try:
            old = json.load(open(old_path, encoding='utf-8'))
            if isinstance(old, dict):
                n_old = 0
                for name, rec in old.items():
                    if isinstance(rec, dict) and rec.get('ok') and name not in merged:
                        take(name, rec)
                        src_of[name] = 'manifest.json(旧)'
                        n_old += 1
                if n_old:
                    print('  并入旧 manifest.json 独有条目 %d 条' % n_old)
        except Exception as e:
            print('  旧 manifest 读取失败（忽略）: %s' % e)

    # 只保留磁盘上真实存在的产物
    keep = {}
    for name, rec in merged.items():
        rel = rec.get('file', '')
        fn = os.path.basename(rel)
        p = os.path.join(OUTDIR, fn)
        if os.path.exists(p) and os.path.getsize(p) > 0:
            rec['bytes'] = os.path.getsize(p)
            if not rec.get('tiles'):        # 断点续跑条目没有 tiles 字段 → 现算
                rec['tiles'] = count_tiles(p)
            keep[name] = rec
    lost = len(merged) - len(keep)

    suspicious = sorted(
        [(n, r.get('tiles', 0), r.get('bytes', 0)) for n, r in keep.items()
         if r.get('tiles', 0) < args.min_tiles or r.get('bytes', 0) < 300000],
        key=lambda x: x[1])

    total_mb = sum(r.get('bytes', 0) for r in keep.values()) / 1048576.0
    print('合并 %d 条（缺文件剔除 %d），合计 %.1f MB' % (len(keep), lost, total_mb))
    print('\n疑似残缺（瓦片<%d 或 体积<300KB）：%d 条' % (args.min_tiles, len(suspicious)))
    for n, t, b in suspicious[:40]:
        print('  %-18s %5d 瓦片 %7.1f KB   [%s]' % (n, t, b / 1024.0, src_of.get(n, '')))
    if len(suspicious) > 40:
        print('  ... 另有 %d 条' % (len(suspicious) - 40))

    if args.dry_run:
        print('\n--dry-run：未写盘')
        return

    target = os.path.join(OUTDIR, 'manifest.json')
    if os.path.exists(target):
        shutil.copy2(target, target.replace('.json', '.bak.json'))
    json.dump(keep, open(target, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('\n已写出 %s（旧版已备份 manifest.bak.json）' % target)


if __name__ == '__main__':
    main()
