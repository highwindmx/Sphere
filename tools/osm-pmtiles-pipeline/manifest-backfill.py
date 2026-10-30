#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
A 组任务死亡补救（2026-10-25）：把磁盘上已生成但未记入 manifest.json 的 pmtiles 补录。
背景：A 组后台任务被沙箱故障中断，--manifest-out m_agroup.json 未写出，
但 gen_city_pmtiles 是逐城落盘的 → 磁盘 .pmtiles 完好，仅缺 manifest 条目。

补录字段照现有条目：ok/file/tiles/bytes/bbox/center/minz/maxz/pbf
数据 © OpenStreetMap contributors (ODbL)
"""
import gzip
import json
import os
import struct

OUTDIR = 'public/data/tiles/osm/pmtiles'
MANIFEST = os.path.join(OUTDIR, 'manifest.json')
SLUG_SRC = 'tools/osm-pmtiles-pipeline/_pmtiles_manifest.json'      # A 组原始清单（含 bbox/lon/lat/pbf）


def _slug(name):
    keep = []
    for ch in name:
        if ch.isalnum():
            keep.append(ch)
        elif ch in ' -()（）·、':
            keep.append('_')
    s = ''.join(keep).strip('_')
    return s or 'city'


def read_varint(buf, pos):
    shift = 0
    val = 0
    while True:
        b = buf[pos]; pos += 1
        val |= (b & 0x7f) << shift
        if not (b & 0x80):
            break
        shift += 7
    return val, pos


def pmtiles_tile_count(path):
    """解析 PMTiles v3 header + root 目录，返回瓦片总数（addressed）与首块偏移。"""
    with open(path, 'rb') as f:
        data = f.read()
    assert data[:7] == b'PMTiles' and data[7] == 3, 'bad magic/version'
    root_off = struct.unpack_from('<Q', data, 8)[0]
    root_len = struct.unpack_from('<Q', data, 16)[0]
    raw = gzip.decompress(data[root_off:root_off + root_len])
    n, pos = read_varint(raw, 0)
    # 只需目录条目数 → run_length 全部走完即 addressed 总数
    pos += n  # 跳过 id delta 列（不需要精确 id）
    total = 0
    for _ in range(n):
        v, pos = read_varint(raw, pos)
        total += v
    return total, len(data)


def main():
    man = json.load(open(MANIFEST))
    slug2city = {}
    src = json.load(open(SLUG_SRC))
    for c in src['coverable']:
        slug2city[_slug(c['name'])] = c
    # 兜底：历史 manifest 里可能也有（bgroup 生成过的）
    for k, v in man.items():
        bb = v.get('bbox')
        ctr = v.get('center') or ([(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2] if bb else None)
        if ctr is None:
            continue
        slug2city.setdefault(_slug(k), {
            'name': k, 'lon': ctr[0], 'lat': ctr[1],
            'bbox': bb, 'minz': v.get('minz', 11), 'maxz': v.get('maxz', 15), 'pbf': v.get('pbf', '?'),
        })

    added, skipped = [], []
    for fn in sorted(os.listdir(OUTDIR)):
        if not fn.endswith('.pmtiles'):
            continue
        stem = fn[:-len('.pmtiles')]
        if stem in man:
            continue
        c = slug2city.get(stem)
        if c is None:
            skipped.append(stem)
            continue
        try:
            tiles, nbytes = pmtiles_tile_count(os.path.join(OUTDIR, fn))
        except Exception as e:
            skipped.append('%s (解析失败: %s)' % (stem, e))
            continue
        lon, lat = c['lon'], c['lat']
        man[c['name']] = {
            'ok': True,
            'file': 'pmtiles/' + fn,
            'tiles': tiles,
            'bytes': nbytes,
            'bbox': c['bbox'],
            'center': [lon, lat],
            'minz': c['minz'], 'maxz': c['maxz'],
            'pbf': c.get('pbf', '?'),
        }
        added.append('%s (%d 瓦片)' % (c['name'], tiles))

    json.dump(man, open(MANIFEST, 'w'), ensure_ascii=False, indent=1)
    print('补录 %d 条；跳过 %d 条；manifest 现有 %d 条' % (len(added), len(skipped), len(man)))
    for a in added:
        print('  +', a)
    for s in skipped:
        print('  ?', s)


if __name__ == '__main__':
    main()
