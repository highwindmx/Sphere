# -*- coding: utf-8 -*-
"""
tools/osm-pmtiles-pipeline/render-tile-block.py

把一段瓦片区块**按数据本身**栅格化成 PNG（不经过 MapLibre），用于判定
「画面里的阶梯/缺口」是**数据侧几何**还是**渲染侧**问题。

- 多边形（water / landuse / leisure / natural）按 4096 单位坐标直接填充
- 线条（highway）按 2-3 px 宽画
- 每个瓦片画完后在图上叠加瓦片边界灰线（可选）

用法：
    uv run --no-project --with pmtiles --with mapbox-vector-tile --with pillow \
        python tools/osm-pmtiles-pipeline/render-tile-block.py <城市> <z> <x0> <x1> <y0> <y1> <out.png> [scale]
"""
import sys
import gzip
import math
from PIL import Image, ImageDraw
from pmtiles.reader import Reader, MmapSource
import mapbox_vector_tile as mvt

PMT = r'D:/Share/Scripts/Explore/sphere/public/data/osm/pmtiles'


def main():
    city, z, x0, x1, y0, y1, out = sys.argv[1:8]
    z, x0, x1, y0, y1 = int(z), int(x0), int(x1), int(y0), int(y1)
    scale = int(sys.argv[8]) if len(sys.argv) > 8 else 512        # 每块瓦片的像素边长
    EXT = 4096
    PX = scale
    k = EXT / PX
    W = (x1 - x0 + 1) * PX
    H = (y1 - y0 + 1) * PX
    im = Image.new('RGB', (W, H), (242, 239, 233))
    dr = ImageDraw.Draw(im)
    r = Reader(MmapSource(open(f'{PMT}/{city}.pmtiles', 'rb')))

    def to_px(pts, tx, ty):
        return [(int((x) / k + (tx - x0) * PX), int((y) / k + (ty - y0) * PX)) for x, y in pts]

    def rings(geom):
        c = geom['coordinates']
        if geom['type'] == 'Polygon':
            return [c[0]]
        return [poly[0] for poly in c]

    # 两遍：先 area（绿/水），再 transportation（线），最后网格
    for ty in range(y0, y1 + 1):
        for tx in range(x0, x1 + 1):
            d = r.get(z, tx, ty)
            if not d:
                continue
            t = mvt.decode(gzip.decompress(d), default_options={'y_coord_down': True})
            for name, layer in t.items():
                if name != 'area':
                    continue
                for ft in layer['features']:
                    pr = ft['properties']
                    if 'water' in pr:
                        col = (170, 218, 255)
                    elif any(k in pr for k in ('landuse', 'leisure', 'natural')):
                        col = (207, 232, 194)
                    elif 'building' in pr:
                        col = (217, 179, 140)
                    else:
                        continue
                    for ring in rings(ft['geometry']):
                        if len(ring) >= 3:
                            dr.polygon(to_px(ring, tx, ty), fill=col)
            for name, layer in t.items():
                if name != 'transportation':
                    continue
                for ft in layer['features']:
                    g = ft['geometry']
                    lines = [g['coordinates']] if g['type'] == 'LineString' else g['coordinates']
                    for ln in lines:
                        if len(ln) >= 2:
                            dr.line(to_px(ln, tx, ty), fill=(255, 255, 255), width=3)
    # 瓦片边界
    for ty in range(y0, y1 + 1):
        yy = (ty - y0) * PX
        dr.line([(0, yy), (W, yy)], fill=(255, 0, 0), width=1)
    for tx in range(x0, x1 + 1):
        xx = (tx - x0) * PX
        dr.line([(xx, 0), (xx, H)], fill=(255, 0, 0), width=1)
    im.save(out)
    print('%s  %dx%d  瓦片 %d..%d / %d..%d' % (out, W, H, x0, x1, y0, y1))


if __name__ == '__main__':
    main()
