# -*- coding: utf-8 -*-
"""
tools/osm-pmtiles-pipeline/zoom-consistency.py

**同一文件内部**跨 zoom 一致性：某 z12 瓦片的水体，与它的 64 个 z15 子瓦片拼出来的水体是否重合。

为什么要这个：与在线比会被「要素取舍 / 样式 / 网络」三重污染；与自己比只有一个变量 —— 我们的
per-zoom 生成有没有把几何放歪。若 z12 与 z15 重合而屏幕上却是两处江，那就是渲染侧；
若 z12 相对 z15 整体偏移/变形，就是**管线 per-zoom 生成**的锅（且放大后必然"跳一下"）。

用法：
    uv run --no-project --with pmtiles --with mapbox-vector-tile --with pillow --with numpy \
        python tools/osm-pmtiles-pipeline/zoom-consistency.py <城市> <z> <x> <y> [child] [out.png]
"""
import sys, gzip, json
import numpy as np
from PIL import Image, ImageDraw
from pmtiles.reader import Reader, MmapSource
import mapbox_vector_tile as mvt

PMT = 'D:/Share/Scripts/Explore/sphere/public/data/tiles/osm/pmtiles'
EXT = 4096


def dec(raw):
    if raw[:2] == b'\x1f\x8b':
        raw = gzip.decompress(raw)
    return mvt.decode(raw, default_options={'y_coord_down': True}) if raw else {}


def rings(t):
    out = []
    for name, layer in t.items():
        if name != 'area':
            continue
        for ft in layer['features']:
            if 'water' not in ft['properties']:
                continue
            g = ft['geometry']
            polys = [g['coordinates']] if g['type'] == 'Polygon' else g['coordinates']
            for poly in polys:
                ring = poly[0] if isinstance(poly[0][0], (list, tuple)) else poly
                if len(ring) >= 3:
                    out.append(ring)
    return out


def mask(rings_, PX, k, off=(0, 0)):
    im = Image.new('1', (PX, PX), 0)
    dr = ImageDraw.Draw(im)
    for r in rings_:
        dr.polygon([(p[0] * k + off[0], p[1] * k + off[1]) for p in r], fill=1)
    return np.asarray(im, dtype=bool)


def main():
    city, z, x, y = sys.argv[1:5]
    z, x, y = int(z), int(x), int(y)
    c = int(sys.argv[5]) if len(sys.argv) > 5 else 3     # 子层级差（3 → 8x8 子瓦片）
    out = sys.argv[6] if len(sys.argv) > 6 else 'work/zoom-consistency.png'
    PX = 512
    man = json.load(open('%s/manifest.json' % PMT, encoding='utf-8'))
    fpath = '%s/%s' % (PMT, man[city]['file'].split('/')[-1])
    r = Reader(MmapSource(open(fpath, 'rb')))

    # 父瓦片（自身）
    d = r.get(z, x, y)
    A = mask(rings(dec(d or b'')), PX, float(PX) / EXT)

    # 子瓦片拼图（同一地理范围，放大到同一尺寸）
    sub = 2 ** c
    cell = PX // sub
    B = np.zeros((PX, PX), bool)
    have = 0
    for i in range(sub):
        for j in range(sub):
            dd = r.get(z + c, x * sub + i, y * sub + j)
            if not dd:
                continue
            have += 1
            m = mask(rings(dec(dd)), cell, float(cell) / EXT)
            B[j * cell:(j + 1) * cell, i * cell:(i + 1) * cell] |= m
    print('父 z%d/%d/%d 水体像素 %d ；子 z%d 共 %d/%d 块，拼出 %d'
          % (z, x, y, A.sum(), z + c, have, sub * sub, B.sum()))

    # 求最佳平移（把 A 平移去对齐 B）
    best = (-1, 0, 0)
    R = 40
    for dy in range(-R, R + 1, 1):
        for dx in range(-R, R + 1, 1):
            if dx == 0 and dy == 0:
                continue
            A2 = np.zeros_like(A)
            ys0, ys1 = max(0, dy), min(PX, PX + dy)
            xs0, xs1 = max(0, dx), min(PX, PX + dx)
            A2[ys0:ys1, xs0:xs1] = A[ys0 - dy:ys1 - dy, xs0 - dx:xs1 - dx]
            inter = int((A2 & B).sum())
            sc = inter / float(max(1, min(A.sum(), B.sum())))
            if sc > best[0]:
                best = (sc, dx, dy)
    iou0 = (A & B).sum() / float(max(1, (A | B).sum()))
    print('原始对齐 IoU %.3f ；最佳平移 (%+d,%+d) 时重合率 %.3f（=%.0f 局部单位，%.0f m 量级）'
          % (iou0, best[1], best[2], best[0], best[1] * EXT / PX, 0))

    im = np.zeros((PX, PX, 3), np.uint8)
    im[A] = [230, 60, 60]
    im[B] = [40, 160, 70]
    im[A & B] = [255, 255, 0]
    Image.fromarray(im).save(out)
    print('已输出:', out, '（红=当前 z 瓦片 绿=子层级拼接 黄=重合）')


if __name__ == '__main__':
    main()
