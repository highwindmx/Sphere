#!/usr/bin/env python
"""进度表：按源 pbf 组统计 288 城的 pmtiles 完成情况，并给粗略剩余耗时估算。

用法：
    ./.venv/Scripts/python.exe tools/progress-table.py            # 全部组
    ./.venv/Scripts/python.exe tools/progress-table.py --only france,greece
    ./.venv/Scripts/python.exe tools/progress-table.py --todo     # 只看未完成的组
"""
import argparse
import importlib.util
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def load_tool():
    spec = importlib.util.spec_from_file_location(
        'pbf2p', os.path.join(ROOT, 'tools', 'pmtiles', 'pbf-to-pmtiles.py'))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--manifest', default=os.path.join(ROOT, 'tools', 'pmtiles', '_bgroup_manifest.v3.json'))
    ap.add_argument('--pbfdir', default=os.path.join(ROOT, 'public', 'OSM'))
    ap.add_argument('--out', default=os.path.join(ROOT, 'public', 'data', 'tiles', 'osm', 'pmtiles'))
    ap.add_argument('--only', default=None)
    ap.add_argument('--todo', action='store_true', help='只显示未完成的组')
    ap.add_argument('--grow', type=float, default=150.0, help='cluster 合并阈值（与 run-remaining 一致）')
    ap.add_argument('--area', type=float, default=16.0, help='cluster bbox 面积上限（平方度）')
    args = ap.parse_args()

    T = load_tool()
    man = json.load(open(args.manifest, encoding='utf-8'))
    cities = man.get('coverable', [])
    only = args.only.split(',') if args.only else None

    os.makedirs(args.out, exist_ok=True)

    # 按源 pbf 分组
    groups = {}
    for c in cities:
        groups.setdefault(c['pbf'], []).append(c)

    def src_size(key):
        if os.path.isabs(key) and os.path.exists(key):
            return os.path.getsize(key) / 1073741824.0
        for cand in (key + '.osm.pbf', key + '-latest.osm.pbf', key):
            p = os.path.join(args.pbfdir, cand)
            if os.path.exists(p):
                return os.path.getsize(p) / 1073741824.0
        return -1.0

    rows = []
    for key in sorted(groups, key=lambda k: -src_size(k)):
        if only and key not in only:
            continue
        cs = groups[key]
        done, done_bytes, todo = [], 0, []
        for c in cs:
            fp = os.path.join(args.out, T.city_fname(c) + '.pmtiles')
            if os.path.exists(fp) and os.path.getsize(fp) > 0:
                done.append(c)
                done_bytes += os.path.getsize(fp)
            else:
                todo.append(c)
        if args.todo and not todo:
            continue
        # 剩余开销模型：每个待跑 cluster 要全扫一次源 pbf（C++ ~40MB/s），
        # 再加每城 pyosmium 建瓦片 ~25s（实测 greece 组 4 cluster/5 城 172s → 本式估 189s）
        clusters = len(T.cluster_cities(todo, args.grow, args.area)) if todo else 0
        gb = src_size(key)
        est = 0.0
        if todo and gb > 0:
            mb = gb * 1024
            est = (clusters * (mb / 40.0 + 8) + len(todo) * 25) / 60.0
        rows.append({
            'key': key, 'total': len(cs), 'done': len(done), 'todo': len(todo),
            'clusters': clusters, 'gb': gb, 'mb_out': done_bytes / 1048576.0,
            'est': est, 'missing_names': [c['name'] for c in todo],
        })

    hdr = '%-24s %8s %9s %6s %8s %10s %9s' % ('源 pbf 组', '源文件GB', '完成/总城', '剩clu', '已生成MB', '预计剩余min', '进度')
    print(hdr)
    print('-' * len(hdr))
    t_done = t_tot = 0
    t_mb = t_est = 0.0
    for r in rows:
        pct = 100.0 * r['done'] / r['total'] if r['total'] else 0
        bar_len = 12
        fill = int(round(bar_len * pct / 100))
        bar = '#' * fill + '.' * (bar_len - fill)
        print('%-24s %8.2f %5d/%-4d %6d %8.1f %10.0f  %s %5.0f%%'
              % (r['key'][:24], r['gb'], r['done'], r['total'], r['clusters'],
                 r['mb_out'], r['est'], bar, pct))
        t_done += r['done']
        t_tot += r['total']
        t_mb += r['mb_out']
        t_est += r['est']
    print('-' * len(hdr))
    pct = 100.0 * t_done / t_tot if t_tot else 0
    print('%-24s %8s %5d/%-4d %6s %8.1f %10.0f         %5.1f%%'
          % ('合计', '', t_done, t_tot, '', t_mb, t_est, pct))
    nxt = [r for r in rows if r['todo']]
    if nxt:
        small = sorted(nxt, key=lambda r: r['gb'])[:6]
        print('\n建议下一批（源文件小的先跑，内存友好）：')
        for r in small:
            print('  %-20s 剩 %2d 城 / %2d cluster / %.2fGB / 约 %.0f 分钟'
                  % (r['key'], r['todo'], r['clusters'], r['gb'], r['est']))
    return rows


if __name__ == '__main__':
    main()
