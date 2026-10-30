#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把当前已生成的离线城市清单导出为 CSV 存档。

列：城市名 / 洲名 / 国家 / 经度 / 纬度 / 来源 pbf / pmtiles 文件 / 层级 / 瓦片数 / 体积 / 四至

洲名与国家从 pmtiles 文件名解析（命名规则 `<洲>_<国家>_<城市>`，城市名本身含下划线时
取剩余全部片段）；解析不出的留空并记到 stderr 摘要里，便于后补。
经纬度优先用清单里的 center 字段，缺失则用 bbox 中心（与前端命中判据同源）。

用法：
    ./.venv/Scripts/python.exe tools/osm-pmtiles-pipeline/export-cities-csv.py
    ./.venv/Scripts/python.exe tools/osm-pmtiles-pipeline/export-cities-csv.py --out 路径.csv

输出默认 utf-8-sig（带 BOM），Excel 双击直接打开不乱码。
"""
import argparse
import csv
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
OUTDIR = os.path.join(ROOT, 'public', 'data', 'tiles', 'osm', 'pmtiles')
MANIFEST = os.path.join(OUTDIR, 'manifest.json')

# 已知洲名（用于校验文件名第一段确实是洲，避免把「长城_八达岭」这类误判）
CONTINENTS = {'亚洲', '欧洲', '非洲', '北美洲', '南美洲', '大洋洲', '南极洲'}


def parse_region(fname):
    """`亚洲_中国_上海.pmtiles` → ('亚洲', '中国')；解析不出返回 ('', '')"""
    stem = os.path.splitext(os.path.basename(fname))[0]
    parts = stem.split('_')
    if len(parts) >= 3 and parts[0] in CONTINENTS:
        return parts[0], parts[1]
    return '', ''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--manifest', default=MANIFEST)
    ap.add_argument('--out', default=os.path.join(HERE, 'cities-inventory.csv'))
    args = ap.parse_args()

    data = json.load(open(args.manifest, encoding='utf-8'))
    rows = []
    no_region = []
    for name, v in data.items():
        if not isinstance(v, dict) or not v.get('ok'):
            continue
        bb = v.get('bbox') or [0, 0, 0, 0]
        if len(bb) != 4:
            continue
        center = v.get('center')
        if isinstance(center, (list, tuple)) and len(center) >= 2:
            lon, lat = float(center[0]), float(center[1])
        else:
            lon = round((float(bb[0]) + float(bb[2])) / 2.0, 5)
            lat = round((float(bb[1]) + float(bb[3])) / 2.0, 5)
        cont, ctry = parse_region(v.get('file', ''))
        if not cont:
            no_region.append(name)
        rows.append({
            '城市名': name,
            '洲名': cont,
            '国家': ctry,
            '经度': round(lon, 5),
            '纬度': round(lat, 5),
            '来源pbf文件': v.get('pbf', ''),
            'pmtiles文件': os.path.basename(v.get('file', '')),
            'minz': v.get('minz', ''),
            'maxz': v.get('maxz', ''),
            '瓦片数': v.get('tiles', ''),
            '体积MB': round((v.get('bytes', 0) or 0) / 1048576.0, 2),
            '最小经度': bb[0], '最小纬度': bb[1], '最大经度': bb[2], '最大纬度': bb[3],
        })

    rows.sort(key=lambda r: (r['洲名'], r['国家'], r['城市名']))
    cols = ['城市名', '洲名', '国家', '经度', '纬度', '来源pbf文件', 'pmtiles文件',
            'minz', 'maxz', '瓦片数', '体积MB', '最小经度', '最小纬度', '最大经度', '最大纬度']
    with open(args.out, 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)

    print('已导出 %d 城 → %s' % (len(rows), args.out))
    total_mb = sum(r['体积MB'] for r in rows)
    print('合计 %.1f MB' % total_mb)
    if no_region:
        print('⚠ 洲/国家解析失败 %d 条：%s' % (len(no_region), '、'.join(no_region[:12])))


if __name__ == '__main__':
    main()
