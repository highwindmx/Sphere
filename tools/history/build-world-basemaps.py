#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build-world-basemaps.py — 把 aourednik/historical-basemaps 的世界历史国界
转换成 sphere 可直接 fetch 的按年分片数据。

源数据（GPL-3.0）：https://github.com/aourednik/historical-basemaps
  geojson/world_<year>.geojson   每个年份一个国家/文化区面层
  geojson/places.geojson         历史城市点（name / inhabitedSince / inhabitedUntil）

产物（默认 public/data/history/world/）：
  index.json      年份清单 [{year, file, n}]（year 为负 = 公元前）
  w_<year>.json   该年份的 FeatureCollection（已简化 + 降精度）
  places.json     历史城市点（可选，--places）

为什么必须简化：
  源数据 54 个年份合计 71.2 MB / 193 万个坐标点，直接喂浏览器的首屏与内存都不可接受。
  历史边界本身是示意级精度（源仓库自带 BORDERPRECISION 1-3 标注），
  因此 Douglas-Peucker 容差 0.05°（约 5 km）+ 坐标保留 3 位小数（约 110 m）
  在视觉上无损，实测 71.2 MB → 16.9 MB（24%），单年份最大 0.93 MB。

用法：
  # 已有源仓库克隆（推荐）
  python tools/history/build-world-basemaps.py --src D:/tmp/historical-basemaps
  # 只转换指定年份
  python tools/history/build-world-basemaps.py --src ... --years 1900,1914,1945
  # 调整简化强度（eps 越大越粗糙越小）
  python tools/history/build-world-basemaps.py --src ... --eps 0.1
  # 从零获取源数据（需 git；本机 HTTPS 常被 reset，建议用 SSH 或 codeload zip）
  python tools/history/build-world-basemaps.py --clone-to D:/tmp/historical-basemaps

获取源数据（三选一，都不通就手动下载 zip 解压后传 --src）：
  git clone --depth 1 git@github.com:aourednik/historical-basemaps.git
  git clone --depth 1 https://github.com/aourednik/historical-basemaps.git
  curl -L -o hb.zip https://codeload.github.com/aourednik/historical-basemaps/zip/refs/heads/master
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import subprocess
import sys
import time

# 保留的属性（其余字段丢弃，省体积）
KEEP_PROPS = ('NAME', 'SUBJECTO', 'PARTOF', 'BORDERPRECISION')
# 短键映射：产物属性名（保持可读，但去掉冗余的 ABBREVN 之类）
PROP_OUT = {'NAME': 'n', 'SUBJECTO': 's', 'PARTOF': 'f', 'BORDERPRECISION': 'b'}


# ---------- Douglas-Peucker（迭代实现，避免递归爆栈） ----------

def rdp(pts, eps):
    """pts: [(x, y), ...] 闭合折线（首尾可重合）。返回简化后的点列。"""
    n = len(pts)
    if n < 3:
        return list(pts)
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        x1, y1 = pts[i]
        x2, y2 = pts[j]
        dx, dy = x2 - x1, y2 - y1
        norm = (dx * dx + dy * dy) ** 0.5
        best, bi = -1.0, -1
        for k in range(i + 1, j):
            x0, y0 = pts[k]
            if norm == 0.0:
                dist = ((x0 - x1) ** 2 + (y0 - y1) ** 2) ** 0.5
            else:
                dist = abs(dy * (x0 - x1) - dx * (y0 - y1)) / norm
            if dist > best:
                best, bi = dist, k
        if best > eps:
            keep[bi] = True
            stack.append((i, bi))
            stack.append((bi, j))
    return [pts[k] for k in range(n) if keep[k]]


def ring_area(ring):
    """近似面积（度²，仅用于剔除可忽略的小洞），取绝对值。"""
    a = 0.0
    for i in range(len(ring) - 1):
        a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
    return abs(a) * 0.5


# ---------- 几何处理 ----------

def simplify_polygon(rings, eps, min_area, round_to):
    """rings: [[[lon,lat], ...], ...]，第 0 个为外环。返回简化后 rings 或 None（退化为无效）。"""
    out = []
    for ri, ring in enumerate(rings):
        if not isinstance(ring, list) or len(ring) < 3:
            if ri == 0:
                return None
            continue
        flat = []
        for p in ring:
            if not isinstance(p, (list, tuple)) or len(p) < 2:
                return None
            flat.append((round(float(p[0]), round_to), round(float(p[1]), round_to)))
        s = rdp(flat, eps)
        if len(s) < 4:
            # 外环退化 → 整个面无效；内环退化 → 直接丢掉这个洞
            if ri == 0:
                return None
            continue
        if ri > 0 and ring_area(s) < min_area:
            continue
        if s[0] != s[-1]:
            s.append(s[0])
        out.append(s)
    return out or None


def convert_geometry(geom, eps, min_area, round_to):
    """只接受 Polygon / MultiPolygon；其余类型返回 None（源数据中不存在，防御用）。"""
    if not isinstance(geom, dict):
        return None
    t = geom.get('type')
    coords = geom.get('coordinates')
    if not coords:
        return None
    if t == 'Polygon':
        polys = [coords]
    elif t == 'MultiPolygon':
        polys = coords
    else:
        return None
    res = []
    for pg in polys:
        if not isinstance(pg, list):
            continue
        r = simplify_polygon(pg, eps, min_area, round_to)
        if r:
            res.append(r)
    if not res:
        return None
    if len(res) == 1:
        return {'type': 'Polygon', 'coordinates': res[0]}
    return {'type': 'MultiPolygon', 'coordinates': res}


def convert_feature(feat, eps, min_area, round_to):
    geom = convert_geometry(feat.get('geometry'), eps, min_area, round_to)
    if geom is None:
        return None
    props = feat.get('properties') or {}
    out = {}
    for k in KEEP_PROPS:
        v = props.get(k)
        if v is None or v == '':
            continue
        out[PROP_OUT[k]] = v
    if not out.get('n'):           # 无名面无展示价值
        return None
    return {'p': out, 'g': geom}


def convert_year(src_file, eps, min_area, round_to):
    with open(src_file, encoding='utf-8') as fh:
        data = json.load(fh)
    feats = []
    for f in data.get('features', []):
        c = convert_feature(f, eps, min_area, round_to)
        if c:
            feats.append(c)
    return feats


def convert_places(src_file, round_to):
    """历史城市点：保留 name / inhabitedSince / inhabitedUntil。"""
    with open(src_file, encoding='utf-8') as fh:
        data = json.load(fh)
    out = []
    for f in data.get('features', []):
        g = f.get('geometry') or {}
        if g.get('type') != 'Point':
            continue
        c = g.get('coordinates')
        if not c or len(c) < 2:
            continue
        p = f.get('properties') or {}
        name = p.get('name')
        if not name:
            continue
        item = {
            'p': {
                'n': name,
                's': p.get('inhabitedSince'),
                'u': p.get('inhabitedUntil'),
            },
            'c': [round(float(c[0]), round_to), round(float(c[1]), round_to)],
        }
        out.append(item)
    return out


# ---------- 年份解析 ----------

YEAR_RE = re.compile(r'^world_(?:bc)?(-?\d+)\.geojson$', re.IGNORECASE)


def year_of(path):
    """world_bc1900.geojson → -1900；world_1900.geojson → 1900。"""
    m = YEAR_RE.match(os.path.basename(path))
    if not m:
        return None
    y = int(m.group(1))
    return -y if 'bc' in os.path.basename(path).lower() else y


def clone_sources(dest):
    if os.path.isdir(dest) and glob.glob(os.path.join(dest, 'geojson', 'world_*.geojson')):
        print('[clone] 源已存在，跳过：%s' % dest)
        return dest
    os.makedirs(dest, exist_ok=True)
    repo = 'https://github.com/aourednik/historical-basemaps.git'
    print('[clone] git clone --depth 1 %s → %s' % (repo, dest))
    r = subprocess.run(['git', 'clone', '--depth', '1', repo, dest])
    if r.returncode != 0:
        print('[clone] 失败。请手动下载 zip 解压后重跑并传 --src：')
        print('        https://codeload.github.com/aourednik/historical-basemaps/zip/refs/heads/master')
        sys.exit(2)
    return dest


def main():
    ap = argparse.ArgumentParser(description='构建 sphere 世界历史国界数据')
    ap.add_argument('--src', help='historical-basemaps 仓库根目录（含 geojson/）')
    ap.add_argument('--clone-to', help='源目录不存在时自动 git clone 到该路径')
    ap.add_argument('--out', default=None, help='输出目录，默认 <repo>/public/data/history/world')
    ap.add_argument('--eps', type=float, default=0.05, help='DP 简化容差（度），默认 0.05')
    ap.add_argument('--min-area', type=float, default=0.05, help='小于该面积（度²）的洞被丢弃，默认 0.05')
    ap.add_argument('--round', type=int, default=3, dest='round_to', help='坐标小数位，默认 3')
    ap.add_argument('--years', default='', help='只转换这些年份，逗号分隔（默认全部）')
    ap.add_argument('--no-places', action='store_true', help='跳过 places.json')
    args = ap.parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.dirname(os.path.dirname(here))
    out_dir = args.out or os.path.join(repo, 'public', 'data', 'history', 'world')

    src = args.src
    if not src:
        src = args.clone_to or os.path.join(repo, '.cache', 'historical-basemaps')
        clone_sources(src)
    geo = os.path.join(src, 'geojson')
    if not os.path.isdir(geo):
        print('[err] 找不到 geojson/ 目录：%s' % geo)
        sys.exit(2)

    files = sorted(glob.glob(os.path.join(geo, 'world_*.geojson')))
    if not files:
        print('[err] geojson/ 下没有 world_*.geojson')
        sys.exit(2)

    wanted = None
    if args.years:
        wanted = set(int(y) for y in args.years.split(',') if y.strip())

    os.makedirs(out_dir, exist_ok=True)
    index = []
    t0 = time.time()
    size_in = size_out = 0
    for f in files:
        y = year_of(f)
        if y is None:
            continue
        if wanted is not None and y not in wanted:
            continue
        feats = convert_year(f, args.eps, args.min_area, args.round_to)
        name = ('w_bc%d.json' % abs(y)) if y < 0 else ('w_%d.json' % y)
        dst = os.path.join(out_dir, name)
        body = json.dumps({'year': y, 'features': feats},
                          ensure_ascii=False, separators=(',', ':'))
        with open(dst, 'w', encoding='utf-8') as fh:
            fh.write(body)
        size_in += os.path.getsize(f)
        size_out += len(body.encode('utf-8'))
        index.append({'year': y, 'file': name, 'n': len(feats)})
        print('  %-18s %6d 面  %6.2f MB' % (name, len(feats), len(body.encode('utf-8')) / 1e6))

    index.sort(key=lambda r: r['year'])
    meta = {
        'name': 'historical-basemaps (world)',
        'source': 'https://github.com/aourednik/historical-basemaps',
        'license': 'GPL-3.0',
        'note': '历史边界为示意级精度；属性 n=NAME / s=SUBJECTO(宗主国) / f=PARTOF / b=BORDERPRECISION(1模糊-3法定)',
        'simplify': {'eps': args.eps, 'minArea': args.min_area, 'round': args.round_to},
        'years': index,
    }
    with open(os.path.join(out_dir, 'index.json'), 'w', encoding='utf-8') as fh:
        json.dump(meta, fh, ensure_ascii=False, separators=(',', ':'))

    if not args.no_places:
        pf = os.path.join(geo, 'places.geojson')
        if os.path.isfile(pf):
            places = convert_places(pf, args.round_to)
            pj = json.dumps({'name': 'places', 'source': meta['source'], 'license': 'GPL-3.0',
                             'note': 'p.n=地名 / p.s=起始年 / p.u=终止年(null 为至今)', 'places': places},
                            ensure_ascii=False, separators=(',', ':'))
            with open(os.path.join(out_dir, 'places.json'), 'w', encoding='utf-8') as fh:
                fh.write(pj)
            print('  places.json        %6d 点  %6.2f MB' % (len(places), len(pj.encode('utf-8')) / 1e6))

    print('[done] %d 个年份：%.1f MB → %.1f MB (%.0f%%)，%.0fs → %s'
          % (len(index), size_in / 1e6, size_out / 1e6,
             100.0 * size_out / max(size_in, 1), time.time() - t0, out_dir))


if __name__ == '__main__':
    main()
