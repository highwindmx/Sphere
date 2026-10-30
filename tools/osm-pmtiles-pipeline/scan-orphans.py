#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""扫描 pmtiles 孤儿文件（磁盘有、但任何 m_*.json 都未引用）。

【2026-10-26 事故教训】用户明确要求：**绝不直接删除，一律移动到隔离文件夹由用户自己处理**。
本脚本因此只提供两种模式：
  1. 默认：只报告（绝对安全）
  2. --quarantine：把孤儿**移动**到 archive/quarantine-pmtiles/（不删除，用户复核后自行处理）

另一个教训：m_*.json 编码混杂（fix-country-names.py 把部分组转成 UTF-8、部分仍 GBK）。
若用固定 GBK 读，UTF-8 文件解码失败被 except 吞掉，该组所有城市会被误判为孤儿。
本脚本强制先 utf-8 严格解码、失败再 gbk；读不出来的文件显式告警，绝不静默跳过。

用法：
  python tools/scan-orphans.py                    # 只报告
  python tools/scan-orphans.py --quarantine       # 移动到隔离文件夹（不删）
"""
import argparse
import glob
import json
import os
import shutil
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, 'public', 'data', 'osm', 'pmtiles')
QUAR = os.path.join(ROOT, 'archive', 'quarantine-pmtiles')


def load_json_any(path):
    """返回 (data, encoding)。先 utf-8 严格，再 gbk；都失败返回 (None, None)。"""
    raw = open(path, 'rb').read()
    for enc in ('utf-8', 'gbk'):
        try:
            return json.loads(raw.decode(enc)), enc
        except Exception:
            continue
    return None, None


def collect_ref():
    ref, bad, enc_stat = set(), [], {}
    for mj in sorted(glob.glob(os.path.join(OUT, 'm_*.json'))):
        data, enc = load_json_any(mj)
        name = os.path.basename(mj)
        enc_stat[name] = enc
        if data is None:
            bad.append(name)
            continue
        vals = (data.values() if isinstance(data, dict)
                else data if isinstance(data, list)
                else (data.get('cities') or data.get('results') or []))
        for c in vals:
            if isinstance(c, dict):
                f = c.get('file') or ''
                if f:
                    ref.add(os.path.basename(f))
    return ref, bad, enc_stat


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--quarantine', action='store_true',
                    help='把孤儿移动到 archive/quarantine-pmtiles/（不删除）')
    args = ap.parse_args()

    disk = {os.path.basename(p) for p in glob.glob(os.path.join(OUT, '*.pmtiles'))}
    ref, bad, enc_stat = collect_ref()

    print('=== m_*.json 编码状态 ===')
    for k, v in sorted(enc_stat.items()):
        print('  %-34s %s' % (k, v if v else '✗ 读不出来！'))
    if bad:
        print('\n⚠️ 有 %d 个 m_*.json 无法解析，其结果不可信（已排除）：' % len(bad))
        for b in bad:
            print('   ', b)
        print('   请先修复这些文件，避免误判孤儿。\n')

    orphan = sorted(disk - ref)
    print('磁盘 pmtiles: %d   被引用: %d   孤儿: %d' % (len(disk), len(ref), len(orphan)))
    if not orphan:
        return
    print('\n=== 孤儿清单（候选清理物）===')
    for f in orphan:
        try:
            mb = os.path.getsize(os.path.join(OUT, f)) / 1024.0 / 1024.0
        except OSError:
            mb = 0
        print('  %8.1f MB  %s' % (mb, f))

    if not args.quarantine:
        print('\n（默认只报告。要隔离请加 --quarantine：移动到 archive/quarantine-pmtiles/，不删除）')
        return
    if bad:
        print('\n✗ 存在无法解析的 m_*.json，拒绝移动（防误判）。')
        return
    os.makedirs(QUAR, exist_ok=True)
    n = 0
    for f in orphan:
        src = os.path.join(OUT, f)
        dst = os.path.join(QUAR, f)
        if os.path.exists(dst):
            stem, ext = os.path.splitext(f)
            dst = os.path.join(QUAR, '%s__%s%s' % (stem, time.strftime('%H%M%S'), ext))
        try:
            shutil.move(src, dst)
            n += 1
        except OSError as e:
            print('  移动失败', f, e)
    print('\n已移动 %d 个孤儿到 %s（未删除，你复核后自行处理）' % (n, QUAR))


if __name__ == '__main__':
    main()
