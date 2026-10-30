#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
旧瓦片（public/data/osm/pmtiles_v1/）回收器

背景：2026-10-26 抽取口径改为三档（T1 ±0.50° / T2 ±0.24° / T3 ±0.12°），
      且文件名改为「大洲-国家-城市」。旧目录 339 个文件全是旧的 ±0.12° 小框 + 旧命名。

判定规则：
  reuse   旧文件能匹配到新清单里 **T3 档**（±0.12°，与旧口径完全一致）的城市 → 重命名复用
  small   匹配到了城市，但新清单要求 T1/T2 大框 → 范围不合适，删
  stale   新清单里已经没有这座城（被去重合并掉 / 不在清单内）→ 删
  trash   残缺备份（*.bak-alps）等 → 删

用法：
    ./.venv/Scripts/python.exe tools/osm-pmtiles-pipeline/reuse-v1.py            # 只报告不动作
    ./.venv/Scripts/python.exe tools/osm-pmtiles-pipeline/reuse-v1.py --apply    # 执行复用+删除
"""
import argparse
import importlib.util
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
V1 = os.path.join(ROOT, 'public/data/osm/pmtiles_v1')
NEW = os.path.join(ROOT, 'public/data/osm/pmtiles')
MANIFEST = os.path.join(ROOT, 'tools/osm-pmtiles-pipeline/_bgroup_manifest.json')

spec = importlib.util.spec_from_file_location('p2', os.path.join(ROOT, 'tools/osm-pmtiles-pipeline/pbf-to-pmtiles.py'))
T = importlib.util.module_from_spec(spec)
spec.loader.exec_module(T)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true', help='执行重命名/删除（默认只报告）')
    ap.add_argument('--keep-json', action='store_true', default=True,
                    help='保留目录里的 json（默认保留，只处理 pmtiles）')
    args = ap.parse_args()

    man = json.load(open(MANIFEST, encoding='utf-8'))
    cities = man['coverable']

    # 旧文件名 = slug(城市名) → 新清单条目
    by_slug = {}
    for c in cities:
        by_slug.setdefault(T._slug(c['name']), []).append(c)
    # 新命名文件是否已存在（队列可能已经生成了）
    exist = set(os.listdir(NEW)) if os.path.isdir(NEW) else set()

    reuse, small, stale, trash, dupskip = [], [], [], [], []
    for f in sorted(os.listdir(V1)):
        p = os.path.join(V1, f)
        if not f.endswith('.pmtiles') or not os.path.isfile(p):
            continue
        if '.bak-' in f:
            trash.append((f, os.path.getsize(p)))
            continue
        stem = f[:-len('.pmtiles')]
        hits = by_slug.get(stem)
        if not hits:
            stale.append((f, os.path.getsize(p)))
            continue
        c = hits[0]
        new_name = T.city_fname(c) + '.pmtiles'
        if new_name in exist:
            dupskip.append((f, new_name, os.path.getsize(p)))
            continue
        if c.get('tier') == 'T3':
            reuse.append((f, new_name, os.path.getsize(p), c['name']))
        else:
            small.append((f, os.path.getsize(p), c['name'], c.get('tier')))

    mb = lambda n: n / 1048576.0
    print('=== 旧瓦片回收判定（%s）===' % ('执行模式' if args.apply else '仅报告'))
    print('\n[reuse] 范围一致（旧 ±0.12° == 新 T3），重命名复用：%d 个 / %.1f MB'
          % (len(reuse), mb(sum(x[2] for x in reuse))))
    for f, nn, sz, name in reuse[:12]:
        print('   %-24s → %s  (%.1f MB)' % (f, nn, sz / 1048576.0))
    if len(reuse) > 12:
        print('   … 其余 %d 个' % (len(reuse) - 12))

    print('\n[small] 匹配到城市但新口径要求更大框，范围不合适 → 删：%d 个 / %.1f MB'
          % (len(small), mb(sum(x[1] for x in small))))
    for f, sz, name, tier in small[:12]:
        print('   %-24s (%.1f MB)  %s 需要 %s 框' % (f, sz / 1048576.0, name, tier))
    if len(small) > 12:
        print('   … 其余 %d 个' % (len(small) - 12))

    print('\n[stale] 新清单已无此城（去重合并/不在清单）→ 删：%d 个 / %.1f MB'
          % (len(stale), mb(sum(x[1] for x in stale))))
    print('   ' + '、'.join(x[0][:-8] for x in stale[:25]))
    if len(stale) > 25:
        print('   … 其余 %d 个' % (len(stale) - 25))

    print('\n[trash] 残缺备份 → 删：%d 个 / %.1f MB' % (len(trash), mb(sum(x[1] for x in trash))))
    print('   ' + '、'.join(x[0] for x in trash))

    if dupskip:
        print('\n[dupskip] 新目录里已存在同名新文件 → 删旧：%d 个 / %.1f MB'
              % (len(dupskip), mb(sum(x[2] for x in dupskip))))
        for f, nn, sz in dupskip[:10]:
            print('   %-24s (新目录已有 %s)' % (f, nn))

    total_del = len(small) + len(stale) + len(trash) + len(dupskip)
    print('\n--- 汇总：复用 %d 个（%.1f MB） / 删除 %d 个（%.1f MB）---'
          % (len(reuse), mb(sum(x[2] for x in reuse)), total_del,
             mb(sum(x[1] for x in small) + sum(x[1] for x in stale) +
                sum(x[1] for x in trash) + sum(x[2] for x in dupskip))))
    if not args.apply:
        print('（只报告，未做任何改动。加 --apply 执行）')
        return

    ok = 0
    for f, nn, sz, name in reuse:
        try:
            os.replace(os.path.join(V1, f), os.path.join(NEW, nn))
            ok += 1
        except Exception as e:
            print('   复用失败 %s: %s' % (f, e))
    print('已复用 %d 个' % ok)

    d = 0
    for f, _sz in [(x[0], x[1]) for x in small] + stale + trash:
        try:
            os.remove(os.path.join(V1, f))
            d += 1
        except Exception as e:
            print('   删除失败 %s: %s' % (f, e))
    for f, _nn, _sz in dupskip:
        try:
            os.remove(os.path.join(V1, f))
            d += 1
        except Exception as e:
            print('   删除失败 %s: %s' % (f, e))
    print('已删除 %d 个' % d)

    rest = [x for x in os.listdir(V1) if x.endswith('.pmtiles')]
    print('v1 目录剩余 pmtiles：%d 个' % len(rest))
    if rest:
        print('   ' + '、'.join(rest[:20]))


if __name__ == '__main__':
    main()
