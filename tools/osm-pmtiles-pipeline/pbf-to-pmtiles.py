#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
从 .osm.pbf 生成 **PMTiles v3** 单文件归档。

流程（2026-10-25 优化版，v2 管线）：
  ① osmium-tool extract（C++）：按「邻近城市 cluster」bbox 从大 pbf 裁出小 pbf
     （tools/osmium-bin/Library/bin/osmium.exe，conda-forge 预编译解包；找不到则回退全扫）
  ② pyosmium 流式扫小 pbf → 按城市 bbox 裁剪成 MVT 瓦片(mapbox_vector_tile) →
     每城打包成一个 .pmtiles（Hilbert tile_id + 列式 varint 目录 + gzip）

为什么两段式（实测 A/B，2026-10-25）：
  · pyosmium 每 way 一次 Python 回调 = 语言层税：france 73.6M way 全扫 5097s（14.4K way/s），
    只为生成 1 个城市（里昂）；osmium extract C++ 裁同样区域仅 46.6s → 小 pbf 再扫 <60s。
  · 裁剪附带解锁并行（小 pbf 位置索引内存从 GB 级降到 MB 级）。

设计要点：
  · 复用 osm-mvt-tiles.py 的裁剪/简化逻辑（已实测可渲染）；
  · 保留 height/levels（供 fill-extrusion 真 3D 楼）+ name；
  · zxy_to_tileid / 目录序列化严格对齐 protomaps 参考实现(cpp/pmtiles.hpp)；
    自检：zxy_to_tileid(8,40,87)==36052。
  · 城市匹配带 0.5° 网格索引（way 先过网格总闸再精筛，避免 way×N城 暴力循环）。
  · 按源 pbf 分组、分块扫描（控内存），生成后写 manifest.json。
  · 空城市（0 瓦片）判定为 EMPTY 并记录（多为源 pbf 未覆盖该点）。

数据 © OpenStreetMap contributors (ODbL)
"""
import argparse
import gzip
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import time

import osmium
from shapely.geometry import LineString, Polygon
import mapbox_vector_tile

EXTENT = 4096
BUFFER_PX = 64
_SQ_EPS = 1e-12
MASK32 = 0xFFFFFFFF

# ============================ v3 分级抽稀策略（2026-10-29）============================
# 旧版（v2）：只有 highway class 0 进全部 zoom，其余（含**全部面要素**）只进 zmax。
#   后果实测：z11–z14 里只有 transportation 主轴，零 area —— 缩小时水面/绿地/建筑全无，
#   画面只剩几根高速线（上海 z14 单瓦片 3 条线 0 个面）。
# v3：按「要素类别 × zoom」铺开，让每一级都可独立成图：
#   · 公路按等级分流（motorway/trunk→全级，primary→z12+，secondary→z13+，tertiary→z14+，其余→z15）
#   · 水体 → 全级（水面是底图骨架）；绿地 → z12+；其它面（工业/居住/学校…）→ z13+
#   · 建筑 → 仅 z15（数量太大，低层级没意义）
#   · 低层级按局部面积阈值砍碎小面，控体积
_ROAD_CLASS = {
    'motorway': 0, 'trunk': 0, 'motorway_link': 0, 'trunk_link': 0,
    'primary': 1, 'primary_link': 1,
    'secondary': 2, 'secondary_link': 2,
    'tertiary': 3, 'tertiary_link': 3,
}
_ROAD_MIN_Z = {1: 12, 2: 13, 3: 14, 4: 15}       # 缺失(0 级) = 进全部 zoom
_WATER_NATURAL = {'water', 'wetland', 'bay', 'strait'}
_WATER_LANDUSE = {'reservoir', 'basin', 'salt_pond'}
_WATER_WAY = {'riverbank', 'dock', 'canal'}
_GREEN_LANDUSE = {'forest', 'grass', 'meadow', 'farmland', 'orchard', 'vineyard',
                  'village_green', 'recreation_ground', 'cemetery'}
_GREEN_NATURAL = {'wood', 'scrub', 'heath', 'grassland', 'tree_row'}
_GREEN_LEISURE = {'park', 'garden', 'golf_course', 'nature_reserve', 'pitch'}
_TOL_BY_Z = {11: 4.0, 12: 2.0, 13: 1.0}          # 局部单位（4096/瓦片）；14/15 不简化
_MIN_AREA_UNITS = {11: 400.0, 12: 120.0, 13: 30.0, 14: 6.0, 15: 0.0}   # 局部单位²
# ⭐⭐ 水体专用更严的上限（2026-10-29 第六轮）。
#   z11 通用 tol=4.0 局部单位 ≈ 19m，而黄浦江支流（苏州河、蕴藻浜等）水面宽仅 20–30m，
#   一简化两岸顶点就合并/错位 → 河面被压塌成「一小段一小段的碎条」（用户说的"河流不连贯"）。
#   水体是「连通性敏感」要素：宁可多几个顶点，也不能变形。
#   z11/z12 直接用 1.0（≈4.8m/2.4m），z13 用 0.5（≈0.6m），z14/15 本来就不简化。
_WATER_TOL_CAP = {11: 1.0, 12: 1.0, 13: 0.5}
_WATER_MIN_AREA_SCALE = 0.02                     # 水体面积阈值只保留 2%（小水塘也别丢）

AREA_TAGS = {'landuse', 'natural', 'water', 'waterway', 'leisure', 'amenity'}


def is_water(tags):
    if tags.get('natural') in _WATER_NATURAL: return True
    if 'water' in tags: return True
    if tags.get('landuse') in _WATER_LANDUSE: return True
    if tags.get('waterway') in _WATER_WAY: return True
    return False


def is_green(tags):
    if tags.get('landuse') in _GREEN_LANDUSE: return True
    if tags.get('natural') in _GREEN_NATURAL: return True
    if tags.get('leisure') in _GREEN_LEISURE: return True
    return False


def water_tol_area(z, tags, tol, minarea):
    """水体单独收紧简化容差与面积阈值（见 _WATER_TOL_CAP 说明）。"""
    if is_water(tags):
        cap = _WATER_TOL_CAP.get(z)
        tol = min(tol, cap) if cap is not None else tol
        minarea *= _WATER_MIN_AREA_SCALE
    return tol, minarea


def feature_zooms(tags, is_area, zmin, zmax):
    """v3：该要素应进入哪些 zoom（返回升序 tuple）。"""
    if is_area:
        if 'building' in tags:
            return (zmax,)
        if is_water(tags):
            return tuple(range(zmin, zmax + 1))
        if is_green(tags):
            return tuple(range(max(zmin, 12), zmax + 1))
        return tuple(range(max(zmin, 13), zmax + 1))
    hw = tags.get('highway')
    if hw:
        # ⚠️ 默认值必须是 0（= 进全部 zoom）。class 0（motorway/trunk）故意不在
        #    _ROAD_MIN_Z 里，若把默认写成 15 会让高速路只剩 z15 —— 缩小时整城无路。
        need = _ROAD_MIN_Z.get(_ROAD_CLASS.get(hw, 4), 0)
        return tuple(range(max(zmin, need), zmax + 1))
    if 'waterway' in tags:
        # ⭐⭐ 大河道中心线必须进**全部** zoom（2026-10-29）：低层级水面被简化后，
        #   中心线是河网唯一的连续骨架；只进 z13+ 时 z11 只剩碎水面，读作「河流断裂」。
        #   小溪/沟渠仍只进 z13+（数量太大，控体积）。
        if tags['waterway'] in ('river', 'canal'):
            return tuple(range(zmin, zmax + 1))
        return tuple(range(max(zmin, 13), zmax + 1))
    if 'railway' in tags:
        return tuple(range(max(zmin, 13), zmax + 1))
    return (zmax,) if zmax >= zmin else (zmax,)
# 保留标签：含 height/levels（3D 楼）与 name
KEEP_TAGS = ('highway', 'building', 'landuse', 'natural', 'water', 'waterway',
             'leisure', 'amenity', 'name', 'name:en', 'bridge', 'tunnel', 'layer',
             'height', 'levels', 'building:levels')

# ============================ PMTiles v3 ============================
def _rotate(n, x, y, rx, ry):
    if ry == 0:
        if rx != 0:
            x = (n - 1 - x) & MASK32
            y = (n - 1 - y) & MASK32
        x, y = y, x
    return x, y

def zxy_to_tileid(z, x, y):
    """严格对齐 protomaps cpp/pmtiles.hpp::zxy_to_tileid。"""
    acc = ((1 << (2 * z)) - 1) // 3
    tx, ty = x & MASK32, y & MASK32
    a = z - 1
    s = (1 << a) if a >= 0 else 0
    while s > 0:
        rx = s & tx
        ry = s & ty
        tx, ty = _rotate(s, tx, ty, rx, ry)
        acc += ((3 * rx) ^ ry) << a
        a -= 1
        s >>= 1
    return acc

def _write_varint(value):
    out = bytearray()
    v = value & MASK32 if value < (1 << 32) else value
    while v >= 0x80:
        out.append((v & 0x7f) | 0x80)
        v >>= 7
    out.append(v)
    return bytes(out)

def serialize_directory(entries):
    """entries: list of dict(tile_id, offset, length, run_length)，已按 tile_id 升序。
    列式 varint（对齐 serialize_directory）。"""
    buf = bytearray()
    buf += _write_varint(len(entries))
    last = 0
    for e in entries:
        buf += _write_varint(e['tile_id'] - last)
        last = e['tile_id']
    for e in entries:
        buf += _write_varint(e['run_length'])
    for e in entries:
        buf += _write_varint(e['length'])
    for i, e in enumerate(entries):
        if i > 0 and e['offset'] == entries[i-1]['offset'] + entries[i-1]['length']:
            buf += _write_varint(0)
        else:
            buf += _write_varint(e['offset'] + 1)
    return bytes(buf)

def e7(deg):
    return int(round(deg * 1e7))

def build_pmtiles(tile_blobs, bbox, center, minz, maxz, name):
    """tile_blobs: dict (z,x,y)->gzipped MVT bytes。返回 (pmtiles_bytes, n_tiles)。"""
    if not tile_blobs:
        return b'', 0
    # 按 tile_id 排序，紧凑拼接
    items = sorted(((zxy_to_tileid(z, x, y), (z, x, y), data)
                    for (z, x, y), data in tile_blobs.items()))
    tile_data = bytearray()
    entries = []
    for tid, zxy, data in items:
        entries.append({'tile_id': tid, 'offset': len(tile_data),
                        'length': len(data), 'run_length': 1})
        tile_data += data
    addressed = sum(e['run_length'] for e in entries)
    n_entries = len(entries)
    n_contents = len({e['offset'] for e in entries})

    root_dir = gzip.compress(serialize_directory(entries), 6)
    meta = {
        "name": name, "format": "pbf", "tiletype": "vector",
        "bounds": [bbox[0], bbox[1], bbox[2], bbox[3]],
        "center": [center[0], center[1], (minz + maxz) // 2],
        "minzoom": minz, "maxzoom": maxz,
        "vector_layers": [
            {"id": "transportation", "fields": {"highway": "String", "name": "String"}},
            {"id": "area", "fields": {"building": "String", "height": "String",
                                      "levels": "String", "landuse": "String"}},
        ],
    }
    meta_bytes = gzip.compress(json.dumps(meta, ensure_ascii=False).encode('utf-8'), 6)

    root_off = 127
    meta_off = root_off + len(root_dir)
    leaf_off = meta_off + len(meta_bytes)
    leaf_len = 0
    data_off = leaf_off + leaf_len
    data_len = len(tile_data)

    h = bytearray(127)
    h[0:7] = b'PMTiles'
    h[7] = 3
    struct.pack_into('<Q', h, 8,  root_off)
    struct.pack_into('<Q', h, 16, len(root_dir))
    struct.pack_into('<Q', h, 24, meta_off)
    struct.pack_into('<Q', h, 32, len(meta_bytes))
    struct.pack_into('<Q', h, 40, leaf_off)
    struct.pack_into('<Q', h, 48, leaf_len)
    struct.pack_into('<Q', h, 56, data_off)
    struct.pack_into('<Q', h, 64, data_len)
    struct.pack_into('<Q', h, 72, addressed)
    struct.pack_into('<Q', h, 80, n_entries)
    struct.pack_into('<Q', h, 88, n_contents)
    h[96] = 1                                   # clustered
    h[97] = 2                                   # internal gzip
    h[98] = 2                                   # tile gzip
    h[99] = 1                                   # MVT
    h[100] = minz
    h[101] = maxz
    struct.pack_into('<i', h, 102, e7(bbox[0]))
    struct.pack_into('<i', h, 106, e7(bbox[1]))
    struct.pack_into('<i', h, 110, e7(bbox[2]))
    struct.pack_into('<i', h, 114, e7(bbox[3]))
    h[118] = (minz + maxz) // 2
    struct.pack_into('<i', h, 119, e7(center[0]))
    struct.pack_into('<i', h, 123, e7(center[1]))

    return bytes(h) + root_dir + meta_bytes + bytes(tile_data), len(items)

# ============================ 几何 / 裁剪（复用实测逻辑） ============================
def world_px(lon, lat, z):
    n = 2 ** z
    x = (lon + 180.0) / 360.0 * n
    s = math.sin(math.radians(lat))
    s = max(-0.9999, min(0.9999, s))
    y = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n
    return x, y

def _clamp(v, n):
    return max(0, min(n - 1, v))

def tiles_for_seg(p0, p1, z, maxspan=24):
    n = 2 ** z
    x0, y0 = p0; x1, y1 = p1
    tx0, tx1 = int(math.floor(min(x0, x1))), int(math.floor(max(x0, x1)))
    ty0, ty1 = int(math.floor(min(y0, y1))), int(math.floor(max(y0, y1)))
    if (tx1 - tx0) <= maxspan and (ty1 - ty0) <= maxspan:
        return [(tx, ty) for tx in range(_clamp(tx0, n), _clamp(tx1, n) + 1)
                for ty in range(_clamp(ty0, n), _clamp(ty1, n) + 1)]
    steps = int(max(abs(x1 - x0), abs(y1 - y0)) * 2) + 1
    out = set()
    for i in range(steps + 1):
        t = i / steps
        out.add((_clamp(int(math.floor(x0 + (x1 - x0) * t)), n),
                 _clamp(int(math.floor(y0 + (y1 - y0) * t)), n)))
    return list(out)

def clip_polyline(pts, xmin, ymin, xmax, ymax):
    out, cur = [], []
    def inside(p): return xmin <= p[0] <= xmax and ymin <= p[1] <= ymax
    if len(pts) == 1:
        return [pts] if inside(pts[0]) else []
    for i in range(len(pts) - 1):
        p0, p1 = pts[i], pts[i+1]
        dx, dy = p1[0]-p0[0], p1[1]-p0[1]
        t0, t1, ok = 0.0, 1.0, True
        for p, q in ((-dx, p0[0]-xmin), (dx, xmax-p0[0]), (-dy, p0[1]-ymin), (dy, ymax-p0[1])):
            if p == 0:
                if q < 0: ok = False; break
            else:
                r = q / p
                if p < 0:
                    if r > t1: ok = False; break
                    if r > t0: t0 = r
                else:
                    if r < t0: ok = False; break
                    if r < t1: t1 = r
        if not ok or t1 <= t0:
            if len(cur) >= 2: out.append(cur)
            cur = []; continue
        a = (p0[0]+dx*t0, p0[1]+dy*t0); b = (p0[0]+dx*t1, p0[1]+dy*t1)
        if not cur: cur = [a, b]
        elif abs(cur[-1][0]-a[0]) < 1e-9 and abs(cur[-1][1]-a[1]) < 1e-9: cur.append(b)
        else:
            if len(cur) >= 2: out.append(cur)
            cur = [a, b]
    if len(cur) >= 2: out.append(cur)
    return out

def _clip_half(poly, inside, isect):
    out = []; n = len(poly)
    for i in range(n):
        a, b = poly[i], poly[(i+1) % n]
        ia, ib = inside(a), inside(b)
        if ia and ib: out.append(b)
        elif ia and not ib: out.append(isect(a, b))
        elif (not ia) and ib: out.append(isect(a, b)); out.append(b)
    return out

def clip_polygon(pts, xmin, ymin, xmax, ymax):
    poly = pts[:]
    if poly[0] == poly[-1]: poly = poly[:-1]
    if len(poly) < 3: return []
    def ix_left(a, b): t=(xmin-a[0])/(b[0]-a[0]); return (xmin, a[1]+(b[1]-a[1])*t)
    def ix_right(a, b): t=(xmax-a[0])/(b[0]-a[0]); return (xmax, a[1]+(b[1]-a[1])*t)
    def ix_bot(a, b): t=(ymin-a[1])/(b[1]-a[1]); return (a[0]+(b[0]-a[0])*t, ymin)
    def ix_top(a, b): t=(ymax-a[1])/(b[1]-a[1]); return (a[0]+(b[0]-a[0])*t, ymax)
    poly = _clip_half(poly, lambda p: p[0] >= xmin, ix_left)
    if len(poly) < 3: return []
    poly = _clip_half(poly, lambda p: p[0] <= xmax, ix_right)
    if len(poly) < 3: return []
    poly = _clip_half(poly, lambda p: p[1] >= ymin, ix_bot)
    if len(poly) < 3: return []
    poly = _clip_half(poly, lambda p: p[1] <= ymax, ix_top)
    if len(poly) < 3: return []
    return poly

def to_local(seq, tx, ty):
    return [(int(round((px-tx)*EXTENT)), int(round((py-ty)*EXTENT))) for px, py in seq]

def simplify(seq, tol):
    if len(seq) <= 2 or tol <= 0: return seq
    keep = [False]*len(seq); keep[0] = keep[-1] = True
    stack = [(0, len(seq)-1)]
    while stack:
        i0, i1 = stack.pop()
        if i1 <= i0+1: continue
        x0, y0 = seq[i0]; x1, y1 = seq[i1]
        dx, dy = x1-x0, y1-y0; den2 = dx*dx+dy*dy
        best, bi = -1.0, -1
        for i in range(i0+1, i1):
            px, py = seq[i]
            if den2 < _SQ_EPS: d2 = (px-x0)**2+(py-y0)**2
            else:
                t = ((px-x0)*dx+(py-y0)*dy)/den2
                t = 0.0 if t < 0 else (1.0 if t > 1 else t)
                d2 = (px-x0-t*dx)**2+(py-y0-t*dy)**2
            if d2 > best: best, bi = d2, i
        if best > tol*tol and bi > 0:
            keep[bi] = True; stack.append((i0, bi)); stack.append((bi, i1))
    return [p for p, k in zip(seq, keep) if k]

def ring_area(seq):
    """鞋带公式（局部单位），返回绝对面积。"""
    a = 0.0
    n = len(seq)
    for i in range(n - 1):
        x0, y0 = seq[i]; x1, y1 = seq[i + 1]
        a += x0 * y1 - x1 * y0
    return abs(a) * 0.5

def assemble_rings(parts):
    """把 multipolygon relation 的成员 way 片段拼成闭合环。
    parts: [[(lon,lat), ...], ...]  →  [[(lon,lat), ... 闭合]]"""
    pool = [list(p) for p in parts if len(p) >= 2]
    rings = []
    while pool:
        cur = pool.pop(0)
        while cur[0] != cur[-1]:
            hit = None
            for i, w in enumerate(pool):
                if w[0] == cur[-1]: hit = (i, w, False); break
                if w[-1] == cur[-1]: hit = (i, w, True); break
            if hit is None: break
            i, w, rev = hit
            pool.pop(i)
            cur += (w[::-1] if rev else w)[1:]
        if len(cur) >= 4 and cur[0] == cur[-1]:
            rings.append(cur)
    return rings

# ============================ 多城市单遍扫描 ============================
GRID_DEG = 0.5           # 城市匹配网格粒度（度）
CLUSTER_MAX_GROW = 3.0   # cluster 合并阈值：组 bbox 面积 ≤ 城内面积和 × 3
CLUSTER_MAX_AREA = 25.0  # cluster bbox 绝对上限（平方度）。没有它，大洲级 pbf 会把几十座城
                         # 串成一个几千平方度的巨框 → 裁剪产物仍是 GB 级，反而更慢更吃内存。
OSMIUM_CANDIDATES = [
    'tools/osmium-bin/Library/bin/osmium.exe',   # 项目内置（conda-forge 解包）
    'osmium',                                     # PATH 回退
]


def find_osmium():
    """定位 osmium-tool 可执行文件；找不到返回 None（回退全扫）。"""
    for p in OSMIUM_CANDIDATES:
        try:
            r = subprocess.run([p, '--version'], capture_output=True, timeout=15)
            if r.returncode == 0:
                return p
        except Exception:
            pass
    return None


def bbox_union(a, b):
    return [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]


def bbox_area(b):
    return max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])


def cluster_cities(cities, max_grow=CLUSTER_MAX_GROW, max_area=CLUSTER_MAX_AREA):
    """邻近城市贪心分组：组 bbox 面积 ≤ 组内城市 bbox 面积和 × max_grow。
    目的：每个 cluster 一次 osmium extract（全扫源 pbf 的 C++ 开销），
    密集区并组、稀疏区分开，避免组 bbox 膨胀成全国（白裁）。"""
    items = sorted(cities, key=lambda c: ((c['bbox'][0] + c['bbox'][2]) / 2,
                                          (c['bbox'][1] + c['bbox'][3]) / 2))
    groups = []
    for c in items:
        placed = False
        for g in groups:
            nb = bbox_union(g['bbox'], c['bbox'])
            if (bbox_area(nb) <= max_grow * max(bbox_area(g['bbox']) + bbox_area(c['bbox']), 1e-12)
                    and bbox_area(nb) <= max_area):
                g['cities'].append(c)
                g['bbox'] = nb
                placed = True
                break
        if not placed:
            groups.append({'cities': [c], 'bbox': list(c['bbox'])})
    return [g['cities'] for g in groups]


def extract_cluster(osmium, src_pbf, bbox, out_path, timeout=3600, strategy='smart'):
    """osmium extract：C++ 全扫 src_pbf，裁出 bbox 内 way（complete-ways，
    含引用 node 完整坐标）→ out_path。返回是否成功。
    strategy=smart：稀疏位置索引，大文件（>4GB）峰值内存比默认 complete-ways 省一半以上
    （实测 us 11.4GB complete-ways 与 asia 16.4GB 并发会 OOM → smart + 串行）。"""
    l, b, r, t = bbox
    cmd = [osmium, 'extract', '--bbox', '%.6f,%.6f,%.6f,%.6f' % (l, b, r, t),
           '--strategy', strategy, '--overwrite', '-o', out_path, src_pbf]
    try:
        p = subprocess.run(cmd, capture_output=True, timeout=timeout)
        if p.returncode != 0:
            print('    osmium extract 失败: %s' % p.stderr.decode('utf-8', 'ignore')[-200:], flush=True)
            return False
        return os.path.exists(out_path) and os.path.getsize(out_path) > 0
    except Exception as e:
        print('    osmium extract 异常: %s' % e, flush=True)
        return False


def collect_multipolygons(path):
    """v3：第一遍只收 relation —— type=multipolygon 且带面标签者，
    返回 {rel_id: (tags, [outer way ids], [inner way ids])}。
    成员 way 的几何在第二遍（带 locations）里按 id 回填。"""
    out = {}

    class _RelPass(osmium.SimpleHandler):
        def relation(self, r):
            tags = dict(r.tags)
            if tags.get('type') not in ('multipolygon', 'boundary'):
                return
            if 'building' not in tags and not any(t in tags for t in AREA_TAGS):
                return
            outer, inner = [], []
            for m in r.members:
                if m.type != 'w':
                    continue
                (inner if m.role == 'inner' else outer).append(m.ref)
            if outer:
                out[r.id] = (tags, outer, inner)

    _RelPass().apply_file(path)
    return out


class MultiCityPass(osmium.SimpleHandler):
    def __init__(self, cities, zooms, rels=None):
        super().__init__()
        self.cities = cities                 # [{name,bbox,minz,maxz}]
        self.zooms = zooms
        self.zmax = max(zooms)
        self.zmin = min(c['minz'] for c in cities)
        self.buckets = {i: {} for i in range(len(cities))}   # city_idx -> {(z,x,y):{lines,areas}}
        self.n_seen = self.n_hit = self.n_miss = 0
        self.n_rel = 0
        self.t0 = time.time()
        # 0.5° 网格索引：城市 bbox 覆盖的所有格 → 城内城市列表（城少时关闭，暴力更省）
        self.grid = {}
        self.use_grid = len(cities) > 3
        if self.use_grid:
            for ci, city in enumerate(cities):
                bw, bs, be, bn = city['bbox']
                for gx in range(int(bw // GRID_DEG), int(be // GRID_DEG) + 1):
                    for gy in range(int(bs // GRID_DEG), int(bn // GRID_DEG) + 1):
                        self.grid.setdefault((gx, gy), []).append(ci)
        # ---- v3：multipolygon relation 支持 ----
        self.rels = rels or {}               # rel_id -> (tags, [outer way ids], [inner way ids])
        self.rel_way_role = {}               # way_id -> [(rel_id, 'outer'|'inner')]
        self.rel_parts = {}                  # (rel_id, role) -> [pts, ...]
        for rid, (_t, outer, inner) in self.rels.items():
            for wid in outer: self.rel_way_role.setdefault(wid, []).append((rid, 'outer'))
            for wid in inner: self.rel_way_role.setdefault(wid, []).append((rid, 'inner'))
            self.rel_parts[(rid, 'outer')] = []
            self.rel_parts[(rid, 'inner')] = []

    def _coords(self, w):
        pts = []
        for n in w.nodes:
            loc = n.location
            if not loc.valid():
                self.n_miss += 1; return None
            pts.append((loc.lon, loc.lat))
        return pts

    def _emit_way(self, ci, pts, props, tags, is_area):
        """按 v3 分级策略把一条 way 铺进对应 zoom 的各瓦片。"""
        feat_zs = feature_zooms(tags, is_area, self.zmin, self.zmax)
        b = self.buckets[ci]
        bw, bs, be, bn = self.cities[ci]['bbox']
        for z in feat_zs:
            wp = [world_px(p[0], p[1], z) for p in pts]
            eps = BUFFER_PX / EXTENT
            tol = _TOL_BY_Z.get(z, 0.0)
            minarea = _MIN_AREA_UNITS.get(z, 0.0)
            if is_area:
                tol, minarea = water_tol_area(z, tags, tol, minarea)
            tiles = set()
            n = 2 ** z
            for i in range(len(wp)-1):
                tiles.update(tiles_for_seg(wp[i], wp[i+1], z))
            for (tx, ty) in tiles:
                # 只保留城市 bbox 覆盖的瓦片
                cx0, cy0 = world_px(bw, bn, z); cx1, cy1 = world_px(be, bs, z)
                if tx < int(math.floor(cx0)) - 1 or tx > int(math.floor(cx1)) + 1: continue
                if ty < int(math.floor(cy0)) - 1 or ty > int(math.floor(cy1)) + 1: continue
                xmin, xmax = tx-eps, tx+1+eps
                ymin, ymax = ty-eps, ty+1+eps
                key = (z, tx, ty)
                bk = b.get(key)
                if bk is None: bk = {'lines': [], 'areas': []}; b[key] = bk
                if is_area:
                    cp = clip_polygon(wp, xmin, ymin, xmax, ymax)
                    if len(cp) < 3: continue
                    local = simplify(to_local(cp, tx, ty), tol)
                    if len(local) < 3: continue
                    if minarea > 0 and ring_area(local) < minarea: continue
                    bk['areas'].append((local, props))
                else:
                    for seg in clip_polyline(wp, xmin, ymin, xmax, ymax):
                        local = simplify(to_local(seg, tx, ty), tol)
                        if len(local) >= 2: bk['lines'].append((local, props))

    def way(self, w):
        self.n_seen += 1
        if self.n_seen % 5000000 == 0:
            print('    … 已扫 %d 万 way，命中 %d (%.0fs)'
                  % (self.n_seen // 10000, self.n_hit, time.time() - self.t0), flush=True)
        tags = dict(w.tags)
        # ⭐ relation 成员 way 通常自身无标签，必须在标签闸之前收几何（v3）
        rr = self.rel_way_role.get(w.id)
        interesting = any(t in tags for t in
                          ('highway', 'building', 'landuse', 'natural', 'water',
                           'waterway', 'leisure', 'amenity'))
        if not rr and not interesting:
            return
        pts = self._coords(w)
        if pts is None: return
        if rr:
            for rid, role in rr:
                self.rel_parts[(rid, role)].append(pts)
        if not interesting or len(pts) < 2:
            return
        props = {k: v for k, v in tags.items() if k in KEEP_TAGS}
        props['osm_id'] = w.id
        hw = tags.get('highway')
        closed = len(pts) > 2 and abs(pts[0][0]-pts[-1][0]) < 1e-9 and abs(pts[0][1]-pts[-1][1]) < 1e-9
        is_area = closed and hw is None and ('building' in tags or any(t in tags for t in AREA_TAGS))

        # ---- 城市匹配：网格总闸 → 候选集精筛（替代 way×N城 暴力循环）----
        if self.use_grid:
            xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
            gx0, gx1 = int(min(xs) // GRID_DEG), int(max(xs) // GRID_DEG)
            gy0, gy1 = int(min(ys) // GRID_DEG), int(max(ys) // GRID_DEG)
            cand = set()
            for gx in range(gx0, gx1 + 1):
                for gy in range(gy0, gy1 + 1):
                    lst = self.grid.get((gx, gy))
                    if lst:
                        cand.update(lst)
            if not cand:
                return                      # 无人区 way：0 次城市比较
            city_list = [(ci, self.cities[ci]) for ci in cand]
        else:
            city_list = list(enumerate(self.cities))

        for ci, city in city_list:
            bw, bs, be, bn = city['bbox']
            if not any(bw <= p[0] <= be and bs <= p[1] <= bn for p in pts):
                continue
            self.n_hit += 1
            self._emit_way(ci, pts, props, tags, is_area)

    # ------------------------------------------------------------------
    def finish_relations(self):
        """apply_file 之后调用：把 multipolygon relation 拼环 → 发成 area。
        用 shapely 做环内洞判定与逐瓦片裁剪（relation 数量少，性能可接受）。"""
        if not self.rels:
            return
        from shapely.geometry import Polygon as SPoly, box as SBox
        eps = BUFFER_PX / EXTENT
        for rid, (tags, _outer, _inner) in self.rels.items():
            outers = assemble_rings(self.rel_parts.get((rid, 'outer'), []))
            inners = assemble_rings(self.rel_parts.get((rid, 'inner'), []))
            if not outers:
                continue
            props = {k: v for k, v in tags.items() if k in KEEP_TAGS}
            props['osm_id'] = rid
            is_area = ('building' in tags) or any(t in tags for t in AREA_TAGS)
            feat_zs = feature_zooms(tags, is_area, self.zmin, self.zmax)
            inner_rings = []
            for ir in inners:
                try:
                    ip = SPoly(ir)
                    if not ip.is_valid: ip = ip.buffer(0)
                    if ip.is_empty or ip.geom_type != 'Polygon': continue
                    inner_rings.append((ip, list(ip.exterior.coords)))
                except Exception:
                    pass
            for o in outers:
                try:
                    shell = SPoly(o)
                except Exception:
                    continue
                rp = shell.representative_point()
                holes = [ring for (ip, ring) in inner_rings
                         if ip.contains(rp) and shell.contains(ip)]
                try:
                    poly = SPoly(o, holes)
                except Exception:
                    poly = SPoly(o)
                if not poly.is_valid:
                    poly = poly.buffer(0)
                if poly.is_empty:
                    continue
                geoms = list(poly.geoms) if poly.geom_type == 'MultiPolygon' else [poly]
                self.n_rel += 1
                for ci, city in enumerate(self.cities):
                    bw, bs, be, bn = city['bbox']
                    if poly.bounds[2] < bw or poly.bounds[0] > be: continue
                    if poly.bounds[3] < bs or poly.bounds[1] > bn: continue
                    self._emit_poly(ci, geoms, props, tags, feat_zs, eps, SBox)

    def _emit_poly(self, ci, geoms, props, tags, feat_zs, eps, SBox):
        from shapely.geometry import Polygon as SPoly
        b = self.buckets[ci]
        bw, bs, be, bn = self.cities[ci]['bbox']
        for z in feat_zs:
            tol = _TOL_BY_Z.get(z, 0.0)
            minarea = _MIN_AREA_UNITS.get(z, 0.0)
            tol, minarea = water_tol_area(z, tags, tol, minarea)
            # 经纬度 → 世界像素（该 zoom）
            wpoly = []
            for g in geoms:
                ext = [world_px(x, y, z) for x, y in g.exterior.coords]
                ints = [[world_px(x, y, z) for x, y in r.coords] for r in g.interiors]
                wpoly.append((ext, ints))
            allp = [p for ext, _i in wpoly for p in ext]
            if not allp: continue
            xs = [p[0] for p in allp]; ys = [p[1] for p in allp]
            tx0, tx1 = int(math.floor(min(xs))), int(math.floor(max(xs)))
            ty0, ty1 = int(math.floor(min(ys))), int(math.floor(max(ys)))
            cx0, cy0 = world_px(bw, bn, z); cx1, cy1 = world_px(be, bs, z)
            tx0 = max(tx0, int(math.floor(cx0)) - 1); tx1 = min(tx1, int(math.floor(cx1)) + 1)
            ty0 = max(ty0, int(math.floor(cy0)) - 1); ty1 = min(ty1, int(math.floor(cy1)) + 1)
            if tx1 < tx0 or ty1 < ty0: continue
            for tx in range(tx0, tx1 + 1):
                for ty in range(ty0, ty1 + 1):
                    win = SBox(tx - eps, ty - eps, tx + 1 + eps, ty + 1 + eps)
                    for ext, ints in wpoly:
                        try:
                            sp = SPoly(ext, ints)
                            if not sp.is_valid: sp = sp.buffer(0)
                            if not sp.intersects(win): continue
                            inter = sp.intersection(win)
                        except Exception:
                            continue
                        if inter.geom_type == 'MultiPolygon':
                            parts = list(inter.geoms)
                        elif inter.geom_type == 'Polygon':
                            parts = [inter]
                        else:
                            parts = []
                        for part in parts:
                            local = simplify(to_local(list(part.exterior.coords), tx, ty), tol)
                            if len(local) < 3: continue
                            if minarea > 0 and ring_area(local) < minarea: continue
                            key = (z, tx, ty)
                            bk = b.get(key)
                            if bk is None: bk = {'lines': [], 'areas': []}; b[key] = bk
                            bk['areas'].append((local, props))


def encode_tile(bucket):
    layers = []
    if bucket['lines']:
        layers.append({'name': 'transportation',
                       'features': [{'geometry': LineString(c), 'properties': p}
                                    for c, p in bucket['lines']]})
    if bucket['areas']:
        layers.append({'name': 'area',
                       'features': [{'geometry': Polygon(c), 'properties': p}
                                    for c, p in bucket['areas']]})
    if not layers:
        return b''
    # ⭐ y_coord_down=True 必须显式传：mapbox_vector_tile 编码端默认会在写入时
    #    把 y 翻成 extent-y（见 utils.DEFAULT_ENCODE_OPTIONS），而我们的 local 坐标
    #    已由 world_px/to_local 生成为「y 向下」，再翻一次就会让每块瓦片上下镜像。
    #    症状：地图上每瓦片内几何垂直翻转，拼起来呈锯齿/「上左偏下右偏」的平行四边形扭曲。
    return mapbox_vector_tile.encode(layers, default_options={
        'extents': EXTENT, 'quantize_bounds': None, 'y_coord_down': True})

# ============================ 读取校验 ============================
def read_varint(buf, pos):
    shift = 0; val = 0
    while True:
        b = buf[pos]; pos += 1
        val |= (b & 0x7f) << shift
        if not (b & 0x80): break
        shift += 7
    return val, pos

def verify_pmtiles(path, probe_zxy):
    """解析 header+root 目录，取一个瓦片 gunzip 并确认是合法 MVT。"""
    data = open(path, 'rb').read()
    assert data[:7] == b'PMTiles' and data[7] == 3, 'bad magic/version'
    root_off, root_len = struct.unpack_from('<Q', data, 8)[0], struct.unpack_from('<Q', data, 16)[0]
    data_off = struct.unpack_from('<Q', data, 56)[0]
    z, x, y = probe_zxy
    want = zxy_to_tileid(z, x, y)
    entries_raw = gzip.decompress(data[root_off:root_off+root_len])
    n, pos = read_varint(entries_raw, 0)
    ids = []; rls = []; lens = []; offs = []
    last = 0
    for _ in range(n):
        d, pos = read_varint(entries_raw, pos); last += d; ids.append(last)
    for _ in range(n): v, pos = read_varint(entries_raw, pos); rls.append(v)
    for _ in range(n): v, pos = read_varint(entries_raw, pos); lens.append(v)
    prev_end = 0
    for i in range(n):
        v, pos = read_varint(entries_raw, pos)
        off = prev_end if v == 0 else (v - 1)
        offs.append(off)
        prev_end = off + lens[i]
    hit = None
    for i in range(n):
        if ids[i] <= want < ids[i] + rls[i]:
            hit = (offs[i], lens[i]); break
    if hit is None:
        return False, 'tile %r not in directory' % (probe_zxy,)
    off, ln = hit
    raw = data[data_off+off: data_off+off+ln]
    mvt = gzip.decompress(raw) if data[98] == 2 else raw
    return len(mvt) > 0, 'MVT %d bytes, dir entries=%d' % (len(mvt), n)

# ============================ 主流程 ============================
WORK_DIR = 'tools/.work'


def gen_city_pmtiles(src_pbf, cities, outdir, chunk, osmium=None, keep_clip=False,
                     max_grow=CLUSTER_MAX_GROW, max_area=CLUSTER_MAX_AREA,
                     include_relations=True):
    """对一个源 pbf、一批城市：邻近 cluster → osmium extract 小 pbf → 扫小 pbf 逐城生成。

    osmium=None 时回退旧行为（全量扫源 pbf，慢但零依赖）。
    include_relations=True 时额外跑一遍 relation 收集（v3 新增：multipolygon 面）。"""
    os.makedirs(outdir, exist_ok=True)
    os.makedirs(WORK_DIR, exist_ok=True)
    results = {}
    stem = _slug(os.path.splitext(os.path.basename(src_pbf))[0])

    # ---- 断点续跑：已有 .pmtiles 的城市直接跳过（会话重启/中断后重跑不重复劳动）----
    pending = []
    for c in cities:
        slug = city_fname(c)
        path = os.path.join(outdir, slug + '.pmtiles')
        if os.path.exists(path) and os.path.getsize(path) > 0:
            results[c['name']] = {'ok': True, 'file': 'pmtiles/' + slug + '.pmtiles',
                                  'resumed': True, 'bbox': c['bbox'],
                                  'minz': c['minz'], 'maxz': c['maxz'],
                                  'bytes': os.path.getsize(path)}
        else:
            pending.append(c)
    if len(pending) < len(cities):
        print('  [%s] 断点续跑：%d/%d 城已存在，跳过' % (os.path.basename(src_pbf),
              len(cities) - len(pending), len(cities)), flush=True)
    if not pending:
        return results
    cities = pending

    clusters = cluster_cities(cities, max_grow, max_area) if osmium else [cities]
    for gi, batch in enumerate(clusters):
        src = src_pbf
        # osmium 可用时总是 extract：C++ 全扫（~46s/GB级）远快于 pyosmium 全扫（~15min/GB级），
        # 且 clip 后位置索引内存骤降；仅当组 bbox 几乎覆盖整个源 pbf 才考虑跳过（暂不优化）。
        need_extract = bool(osmium)
        if need_extract:
            gb = list(batch[0]['bbox'])
            for c in batch[1:]:
                gb = bbox_union(gb, c['bbox'])
            clip = os.path.join(WORK_DIR, '%s-g%d.clip.osm.pbf' % (stem, gi))
            print('  [%s] cluster %d/%d：%d 城 bbox %.2f,%.2f,%.2f,%.2f → osmium extract'
                  % (os.path.basename(src_pbf), gi + 1, len(clusters), len(batch),
                     gb[0], gb[1], gb[2], gb[3]), flush=True)
            te = time.time()
            if extract_cluster(osmium, src_pbf, gb, clip):
                src = clip
                print('    裁剪 %.0fs → %.1f MB' % (time.time() - te, os.path.getsize(clip) / 1048576), flush=True)
            else:
                print('    回退全扫 %s' % src_pbf, flush=True)

        for start in range(0, len(batch), chunk):
            sub = batch[start:start+chunk]
            names = '、'.join(c['name'] for c in sub[:6]) + ('…' if len(sub) > 6 else '')
            print('  [%s] 批次 %d-%d: %s' % (os.path.basename(src), start, start+len(sub), names), flush=True)
            t0 = time.time()
            zooms = list(range(min(c['minz'] for c in sub), max(c['maxz'] for c in sub) + 1))
            rels = collect_multipolygons(src) if include_relations else {}
            p = MultiCityPass(sub, zooms, rels=rels)
            p.apply_file(src, locations=True)
            if rels:
                tr = time.time()
                p.finish_relations()
                print('    relation 拼环 %.0fs: %d 个 multipolygon 已发面'
                      % (time.time() - tr, p.n_rel), flush=True)
            print('    扫描 %.0fs: %d way, 命中 %d' % (time.time()-t0, p.n_seen, p.n_hit), flush=True)
            for ci, city in enumerate(sub):
                buckets = p.buckets[ci]
                blobs = {}
                for (z, x, y), bk in buckets.items():
                    mvt = encode_tile(bk)
                    if mvt:
                        blobs[(z, x, y)] = gzip.compress(mvt, 6)
                if not blobs:
                    results[city['name']] = {'ok': False, 'reason': 'EMPTY (源pbf未覆盖该点)',
                                             'bbox': city['bbox']}
                    print('    ✗ %-14s EMPTY' % city['name'], flush=True)
                    continue
                center = [(city['bbox'][0]+city['bbox'][2])/2, (city['bbox'][1]+city['bbox'][3])/2]
                pmt, n = build_pmtiles(blobs, city['bbox'], center, city['minz'], city['maxz'], city['name'])
                slug = city_fname(city)
                path = os.path.join(outdir, slug + '.pmtiles')
                open(path, 'wb').write(pmt)
                results[city['name']] = {'ok': True, 'file': 'pmtiles/' + slug + '.pmtiles',
                                         'tiles': n, 'bytes': len(pmt),
                                         'bbox': city['bbox'], 'center': center,
                                         'minz': city['minz'], 'maxz': city['maxz'],
                                         'overview': bool(city['minz'] < city['maxz'])}
                print('    ✓ %-14s %d 瓦片  %.1f MB' % (city['name'], n, len(pmt)/1048576), flush=True)
            # 释放
            p.buckets = None
        if need_extract and not keep_clip and src != src_pbf:
            try: os.remove(src)
            except Exception: pass
    return results

def _slug(name):
    keep = []
    for ch in name:
        if ch.isalnum(): keep.append(ch)
        elif ch in ' -()（）·、': keep.append('_')
    s = ''.join(keep).strip('_')
    return s or 'city'


def city_fname(city):
    """输出文件名（不含扩展名）：大洲-国家-城市（2026-10-26 定案）。
    清单条目带 continent/country 字段时加前缀，便于按地区归类；
    缺字段（--bbox 手动条目）时退回纯城市名。"""
    cont = city.get('continent')
    ctry = city.get('country')
    if cont and ctry and cont != '未知' and ctry != '未知':
        return _slug('%s-%s-%s' % (cont, ctry, city['name']))
    return _slug(city['name'])

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--manifest', default='tools/osm-pmtiles-pipeline/_pmtiles_manifest.json')
    ap.add_argument('--pbfdir', default='public/OSM')
    ap.add_argument('--out', default='public/data/tiles/osm/pmtiles')
    ap.add_argument('--only', default=None, help='只跑某个源 pbf 组（如 china）')
    ap.add_argument('--cities', default=None, help='逗号分隔城市名子集')
    ap.add_argument('--skip', default=None, help='逗号分隔要跳过的源 pbf 组（如 us,russia）')
    ap.add_argument('--manifest-out', default='manifest.json', help='输出 manifest 文件名（并行时按组区分，避免竞争）')
    ap.add_argument('--chunk', type=int, default=16)
    ap.add_argument('--bbox', default=None,
                    help='手动城市条目 name:minlon,minlat,maxlon,maxlat:pbf（不走 manifest；'
                         'pbf 可为 key（如 turkey）或完整路径（如 D:/x/y.osm.pbf））')
    ap.add_argument('--no-extract', action='store_true',
                    help='禁用 osmium extract 预裁剪（回退全量扫源 pbf）')
    ap.add_argument('--keep-clip', action='store_true', help='保留中间裁剪 pbf（调试用）')
    ap.add_argument('--no-relations', action='store_true',
                    help='v3：不为 multipolygon relation 拼环发面（回退 v2 行为，调试对照用）')
    ap.add_argument('--max-grow', type=float, default=CLUSTER_MAX_GROW,
                    help='cluster 合并阈值：组 bbox 面积 ≤ 城内面积和 × 此值。'
                         '源 pbf 越大越该调高（少跑几次全扫），队列默认 150')
    ap.add_argument('--max-area', type=float, default=CLUSTER_MAX_AREA,
                    help='cluster bbox 面积硬上限（平方度）。配合大 --max-grow 使用，'
                         '既少跑几次全扫，又不会框出半块大陆（默认 25 ≈ 5°×5°）')
    args = ap.parse_args()

    osmium = None if args.no_extract else find_osmium()
    if osmium:
        print('✓ osmium-tool: %s（启用 extract 预裁剪）' % osmium, flush=True)
    else:
        print('⚠ 未找到 osmium-tool（tools/osmium-bin/ 或 PATH）→ 全量扫源 pbf（慢）', flush=True)

    # 自检 Hilbert
    assert zxy_to_tileid(8, 40, 87) == 36052, 'Hilbert 自检失败'
    assert zxy_to_tileid(1, 1, 0) == 4 and zxy_to_tileid(2, 0, 0) == 5
    print('✓ Hilbert tile_id 自检通过 (zxy_to_tileid(8,40,87)==36052)', flush=True)

    man = json.load(open(args.manifest, encoding='utf-8'))
    cover = man['coverable']
    os.makedirs(args.out, exist_ok=True)
    skip = set(s.strip() for s in args.skip.split(',')) if args.skip else set()
    if args.cities:
        want = set(args.cities.split(','))
        cover = [c for c in cover if c['name'] in want]
    pbf_file = {'china': 'china-latest.osm.pbf', 'sea': 'sea-latest.osm.pbf',
                'us': 'us-latest.osm.pbf', 'italy': 'italy-latest.osm.pbf',
                'greece': 'greece-latest.osm.pbf', 'spain': 'spain-latest.osm.pbf',
                'france': 'france-latest.osm.pbf', 'great-britain': 'great-britain-latest.osm.pbf',
                'iran': 'iran-latest.osm.pbf', 'iraq': 'iraq-latest.osm.pbf',
                'israel': 'israel-and-palestine-latest.osm.pbf', 'japan': 'japan-latest.osm.pbf',
                'south-korea': 'south-korea-latest.osm.pbf', 'russia': 'russia-latest.osm.pbf',
                'serbia': 'serbia-latest.osm.pbf', 'ukraine': 'ukraine-latest.osm.pbf',
                'georgia': 'georgia-latest.osm.pbf', 'shanghai': 'shanghai.osm.pbf',
                'malta': 'malta-latest.osm.pbf', 'alps': 'alps-latest.osm.pbf',
                'dach': 'dach-latest.osm.pbf', 'turkey': 'turkey-latest.osm.pbf',
                'australia-oceania': 'australia-oceania-latest.osm.pbf',
                'central-america': 'central-america-latest.osm.pbf',
                'africa': 'africa-latest.osm.pbf', 'asia': 'asia-latest.osm.pbf',
                'south-america': 'south-america-latest.osm.pbf',
                'syria': 'syria-latest.osm.pbf', 'india': 'india-latest.osm.pbf',
                'north-korea': 'north-korea-latest.osm.pbf'}

    def resolve_pbf(key):
        """key → 实际路径：完整路径优先，否则 pbfdir/key-latest.osm.pbf。"""
        if os.path.isabs(key) or (len(key) > 2 and key[1] == ':'):
            return key
        return os.path.join(args.pbfdir, pbf_file.get(key, key + '-latest.osm.pbf'))
    groups = {}
    for c in cover:
        groups.setdefault(c['pbf'], []).append(c)

    all_results = {}
    existing = os.path.join(args.out, args.manifest_out)
    if os.path.exists(existing):
        try: all_results = json.load(open(existing, encoding='utf-8'))
        except Exception: all_results = {}

    # --bbox 手动条目：name:minlon,minlat,maxlon,maxlat:pbf（演示城市不在巡礼清单里，用此入口）
    if args.bbox:
        try:
            name, bb, pbf_key = args.bbox.split(':', 2)   # pbf 可为 Windows 绝对路径（含盘符冒号）
            mnlo, mnla, mxlo, mxla = [float(v) for v in bb.split(',')]
        except Exception:
            print('✗ --bbox 格式错误，应为 name:minlon,minlat,maxlon,maxlat:pbf', flush=True)
            return
        if pbf_key in skip:
            print('  跳过 %s（--skip）' % pbf_key, flush=True)
            return
        city = {'name': name, 'bbox': [mnlo, mnla, mxlo, mxla], 'minz': 11, 'maxz': 15}
        src = resolve_pbf(pbf_key)
        if not os.path.exists(src):
            print('✗ 源 pbf 不存在: %s' % src, flush=True)
            return
        print('\n=== %s（--bbox 手动，任意经纬度提取）===' % name, flush=True)
        res = gen_city_pmtiles(src, [city], args.out, args.chunk, osmium=osmium, keep_clip=args.keep_clip,
                               include_relations=not args.no_relations)
        for cname, r in res.items():
            r['pbf'] = pbf_key
            all_results[cname] = r
        json.dump(all_results, open(os.path.join(args.out, args.manifest_out), 'w', encoding='utf-8'),
                  ensure_ascii=False, indent=1)
        return

    t_all = time.time()
    for pbf_key in sorted(groups):
        if args.only and pbf_key != args.only:
            continue
        if pbf_key in skip:
            print('  跳过 %s（--skip）' % pbf_key, flush=True)
            continue
        src = resolve_pbf(pbf_key)
        if not os.path.exists(src):
            print('  跳过 %s（无 %s）' % (pbf_key, src), flush=True)
            continue
        cities = groups[pbf_key]
        print('\n=== %s: %d 城 ===' % (pbf_key, len(cities)), flush=True)
        res = gen_city_pmtiles(src, cities, args.out, args.chunk,
                               osmium=osmium, keep_clip=args.keep_clip,
                               max_grow=args.max_grow, max_area=args.max_area,
                               include_relations=not args.no_relations)
        for name, r in res.items():
            r['pbf'] = pbf_key
            all_results[name] = r

    json.dump(all_results, open(os.path.join(args.out, args.manifest_out), 'w'),
              ensure_ascii=False, indent=1)
    ok = [r for r in all_results.values() if r.get('ok')]
    empty = [r for r in all_results.values() if not r.get('ok')]
    total_mb = sum(r.get('bytes', 0) or 0 for r in ok) / 1048576
    print('\n=== 汇总 ===')
    print('  成功 %d 城 / %.1f MB；EMPTY %d 城；总耗时 %.0fs'
          % (len(ok), total_mb, len(empty), time.time()-t_all))
    if empty:
        print('  EMPTY: ' + '、'.join(r for r in all_results if not all_results[r].get('ok')))

if __name__ == '__main__':
    main()
