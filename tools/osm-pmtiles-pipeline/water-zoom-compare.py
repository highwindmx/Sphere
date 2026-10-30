# -*- coding: utf-8 -*-
"""
tools/osm-pmtiles-pipeline/water-zoom-compare.py

对同一个地理窗口，逐 zoom 把「水体面」栅格化并统计连通性，
用于判定「低层级河流被切成碎段」是 **简化/面积阈值** 造成，还是源数据本来就碎。

用法：
    uv run --no-project --with pmtiles --with mapbox-vector-tile --with pillow --with scipy \
        python tools/osm-pmtiles-pipeline/water-zoom-compare.py <城市文件基名> <lon> <lat> <span_deg> <z,z,...> <outdir>

例：
    ... water-zoom-compare.py 亚洲_中国_上海.v3 121.53 31.20 0.10 11,13,15 $TEMP/wc
"""
import sys, os, gzip, math
import numpy as np
from PIL import Image, ImageDraw
from pmtiles.reader import Reader, MmapSource
import mapbox_vector_tile as mvt
from scipy import ndimage

PMT = r'D:/Share/Scripts/Explore/sphere/public/data/tiles/osm/pmtiles'
EXT = 4096
PX = 600          # 输出图边长


def world_px(lon, lat, z):
    n = 2 ** z
    x = (lon + 180.0) / 360.0 * n
    lr = math.radians(lat)
    y = (1.0 - math.log(math.tan(lr) + 1.0 / math.cos(lr)) / math.pi) / 2.0 * n
    return x * EXT, y * EXT      # 单位：4096/瓦片


def is_water_props(p):
    if p.get('natural') in ('water', 'wetland', 'bay', 'strait'): return True
    if 'water' in p: return True
    if p.get('landuse') in ('reservoir', 'basin', 'salt_pond'): return True
    if p.get('waterway') in ('riverbank', 'dock', 'canal'): return True
    return False


def main():
    city, lon, lat, span = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4])
    zs = [int(s) for s in sys.argv[5].split(',')]
    outdir = sys.argv[6]
    os.makedirs(outdir, exist_ok=True)
    r = Reader(MmapSource(open(f'{PMT}/{city}.pmtiles', 'rb')))
    half = span / 2.0
    print(f'窗口 lon {lon-half:.4f}..{lon+half:.4f}  lat {lat-half:.4f}..{lat+half:.4f}')
    print(f'{"z":>3} {"瓦片":>5} {"水体要素":>8} {"水体占比%":>9} {"连通块":>6} {"最大块占比%":>10}')
    for z in zs:
        # 窗口四角的世界像素坐标
        xs = [world_px(lon - half, lat - half, z)[0], world_px(lon + half, lat - half, z)[0]]
        ys = [world_px(lon - half, lat + half, z)[1], world_px(lon + half, lat - half, z)[1]]
        x0, x1 = min(xs), max(xs)
        y0, y1 = min(ys), max(ys)
        tx0, tx1 = int(x0 // EXT), int(x1 // EXT)
        ty0, ty1 = int(y0 // EXT), int(y1 // EXT)
        im = Image.new('L', (PX, PX), 0)
        dr = ImageDraw.Draw(im)
        nfeat = ntile = 0
        for tx in range(tx0, tx1 + 1):
            for ty in range(ty0, ty1 + 1):
                d = r.get(z, tx, ty)
                if not d:
                    continue
                ntile += 1
                try:
                    t = mvt.decode(gzip.decompress(d), default_options={'y_coord_down': True})
                except Exception:
                    continue
                lay = t.get('area')
                if not lay:
                    continue
                for f in lay['features']:
                    p = f.get('properties') or {}
                    if not is_water_props(p):
                        continue
                    g = f['geometry']
                    if g['type'] != 'Polygon':
                        continue
                    nfeat += 1
                    for ring in g['coordinates']:
                        pts = []
                        for cx, cy in ring:
                            gx = tx * EXT + cx
                            gy = ty * EXT + cy
                            pts.append(((gx - x0) / (x1 - x0) * PX,
                                        (gy - y0) / (y1 - y0) * PX))
                        if len(pts) >= 3:
                            dr.polygon(pts, fill=255)
        a = np.array(im) > 127
        ratio = a.mean() * 100
        lab, n = ndimage.label(a)
        if n:
            sizes = ndimage.sum(a, lab, range(1, n + 1))
            biggest = sizes.max() / a.sum() * 100 if a.sum() else 0
        else:
            biggest = 0
        p = os.path.join(outdir, f'water-z{z}.png')
        im.save(p)
        print(f'{z:>3} {ntile:>5} {nfeat:>8} {ratio:>9.2f} {n:>6} {biggest:>10.1f}   -> {os.path.basename(p)}')


if __name__ == '__main__':
    main()
