import json, os, glob, csv
from collections import Counter

ROOT = 'public/data/tiles/osm/pmtiles'
DL = 'D:/迅雷下载'          # 原生 Windows 路径，uv 的 Python 才认

manifest = json.load(open(os.path.join(ROOT, 'manifest.json'), encoding='utf-8'))
cities = list(manifest.keys())

disk = set(os.path.basename(p) for p in glob.glob(os.path.join(ROOT, '*.pmtiles')))
ref = set(os.path.basename(v['file']) for v in manifest.values())
orphan = sorted(disk - ref)
missing = sorted(ref - disk)

# ---- 子集城市扫描：bbox A 是否完全落在 bbox B 内 ----
def box(v):
    b = v['bbox']
    return b[0], b[1], b[2], b[3]   # minlon,minlat,maxlon,maxlat
EPS = 0.002
contained = {}   # name -> [containers]
for a in cities:
    ba = box(manifest[a])
    area_a = (ba[2]-ba[0])*(ba[3]-ba[1])
    for b in cities:
        if a == b:
            continue
        bb = box(manifest[b])
        area_b = (bb[2]-bb[0])*(bb[3]-bb[1])
        if area_b <= area_a:
            continue
        inside = (ba[0] >= bb[0]-EPS and ba[2] <= bb[2]+EPS and
                  ba[1] >= bb[1]-EPS and ba[3] <= bb[3]+EPS)
        if inside:
            contained.setdefault(a, []).append(b)

# ---- 下载 pbf 对账 ----
downloaded = sorted(os.path.basename(p) for p in glob.glob(os.path.join(DL, '*.pbf')))
dl_regions = set(f.replace('-latest.osm.pbf', '') for f in downloaded)
need = sorted(set(v.get('pbf', '?') for v in manifest.values()))
need_status = {}
for p in need:
    ok = (p in dl_regions) or (p + '-latest.osm.pbf') in downloaded
    # us 由 5 个分区组成；若已下 us-* 则视为覆盖
    if not ok and p == 'us':
        ok = any(d.startswith('us-') for d in dl_regions)
    # australia-oceania 至少要有 australia
    if not ok and p == 'australia-oceania':
        ok = 'australia' in dl_regions
    need_status[p] = 'OK' if ok else '缺'

# ---- 输出完整清单 CSV ----
out = os.path.join('tools/osm-pmtiles-pipeline/work', 'city-inventory.csv')
with open(out, 'w', encoding='utf-8-sig', newline='') as f:
    w = csv.writer(f)
    w.writerow(['name', 'file', 'minlon', 'minlat', 'maxlon', 'maxlat',
                'pbf', 'minz', 'maxz', 'tiles', 'on_disk', 'is_orphan', 'contained_by'])
    for name in sorted(cities):
        v = manifest[name]
        b = v['bbox']
        fn = os.path.basename(v['file'])
        w.writerow([name, fn, b[0], b[1], b[2], b[3], v.get('pbf'),
                    v.get('minz'), v.get('maxz'), v.get('tiles'),
                    'Y' if fn in disk else 'N',
                    'Y' if fn in orphan else '',
                    ';'.join(contained.get(name, []))])

# ---- 控制台摘要 ----
print('城市总数:', len(cities), '| 磁盘文件:', len(disk), '| manifest引用:', len(ref))
print('\n== 孤儿(磁盘有/manifest未引) %d ==' % len(orphan))
for f in orphan: print('   ', f)
print('\n== 缺失(manifest引/磁盘无) %d ==' % len(missing))
for f in missing: print('   ', f)

print('\n== 子集城市(自身bbox完全落在另一城市内) %d ==' % len(contained))
for a in sorted(contained):
    print('   %s  ⊆  %s' % (a, ','.join(contained[a])))

print('\n== pbf 需求 %d 区域 ==' % len(need))
for p in need:
    print('   %-22s %s' % (p, need_status[p]))
print('\n== 已下载但未在 manifest 使用(可能多余) ==')
for r in sorted(dl_regions - set(need)):
    print('   ', r)
print('\n清单已写:', out)
