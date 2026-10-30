#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
修正 OSM-TODO D 类遗留的「错误国别名」城市（2026-10-27 续收尾）。

背景：geo-country.py 在边境/高原用「面积最小框」判国别会错，导致 24 座城被贴上错误的
国别标签（西藏/新疆/云南边境城被误判印度/尼泊尔/缅甸/越南/哈萨克/吉尔吉斯；美国南部被误判
墨西哥；欧洲数城互错）。瓦片覆盖本身是正确的（bbox 是真实坐标），所以**只改名、不重抽**。

做法：
  1. 按权威修正表 CORRECT（name -> (continent, country)）匹配 manifest.json 键名；
  2. 在磁盘上把 旧国别名.pmtiles 改名为 正确国别名.pmtiles（shutil.move，不删除）；
  3. 同步更新所有 m_*.json 中对应条目的 `file` 字段（merge 只读 m_*.json，这是关键）；
  4. 同步更新 manifest.json 的 `file` 字段；
  5. 顺手把 V3 主清单的 `country` 改对（避免将来重抽又错），并把里斯本/都拉基乌姆的
     `pbf` 指向 portugal/albania（这两个源包用户已下好，下一步重抽用）。

用法：
  ./.venv/Scripts/python.exe tools/osm-pmtiles-pipeline/fix-wrong-country.py [--dry-run]
"""
import argparse
import glob
import json
import os
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, 'public', 'data', 'osm', 'pmtiles')
V3 = os.path.join(ROOT, 'tools', 'pmtiles', '_bgroup_manifest.v3.json')


def slug(s):
    out = []
    for ch in s:
        if ch.isalnum():
            out.append(ch)
        elif ch in ' -()（）·、':
            out.append('_')
    return ''.join(out).strip('_') or 'x'


def parse(fn):
    b = os.path.basename(fn).replace('.pmtiles', '')
    parts = b.split('_')
    if len(parts) >= 3:
        return parts[0], parts[1], '_'.join(parts[2:])
    return None


# 权威修正表（仅 D 类；真印度/尼泊尔/缅甸/越南/新加坡城市不在此列）
CORRECT = {
    # 中国（西藏/新疆/云南边境被误判为邻国）
    '布达拉宫': ('亚洲', '中国'), '八宿': ('亚洲', '中国'), '日喀则': ('亚洲', '中国'),
    '林芝': ('亚洲', '中国'), '波密': ('亚洲', '中国'), '南宁': ('亚洲', '中国'),
    '昆仑关': ('亚洲', '中国'), '马关': ('亚洲', '中国'),
    '疏勒（喀什）': ('亚洲', '中国'), '跋禄迦（阿克苏）': ('亚洲', '中国'),
    '定日': ('亚洲', '中国'), '聂拉木': ('亚洲', '中国'), '樟木口岸': ('亚洲', '中国'),
    '丽江古城': ('亚洲', '中国'),
    # 美国南部（被误判墨西哥）
    '休斯顿': ('北美洲', '美国'), '圣安东尼奥': ('北美洲', '美国'), '圣迭戈': ('北美洲', '美国'),
    '奥斯汀': ('北美洲', '美国'), '新奥尔良': ('北美洲', '美国'), '达拉斯': ('北美洲', '美国'),
    # 欧洲
    '维也纳': ('欧洲', '奥地利'), '慕尼黑': ('欧洲', '德国'), '德累斯顿': ('欧洲', '德国'),
    '斯特拉斯堡': ('欧洲', '法国'),
    # 东南亚（跨国：新山属马来西亚，曾被误标新加坡）
    '新山': ('亚洲', '马来西亚'),
}

# 需要改 pbf 源的城市（用户已下好对应源包）
PBF_OVERRIDE = {
    '里斯本': 'portugal',
    '都拉基乌姆（都拉斯）': 'albania',
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    mani_path = os.path.join(OUT, 'manifest.json')
    mani = json.load(open(mani_path, encoding='utf-8'))

    # ---- 1) 改名：磁盘 + manifest.json ----
    moves = []          # (old_path, new_path, key)
    for key, rec in mani.items():
        if key not in CORRECT:
            continue
        fn = rec.get('file', '')
        p = parse(fn)
        if not p:
            print('  ! 无法解析 %s : %s' % (key, fn)); continue
        cont, ctry, cityslug = p
        ncont, nctry = CORRECT[key]
        if ctry == nctry:
            continue
        newbase = '%s_%s_%s' % (slug(ncont), slug(nctry), cityslug)
        newfn = 'pmtiles/%s.pmtiles' % newbase
        oldp = os.path.join(OUT, os.path.basename(fn))
        newp = os.path.join(OUT, newbase + '.pmtiles')
        if not os.path.exists(oldp):
            print('  ! 旧文件不存在，跳过 %s : %s' % (key, oldp)); continue
        if os.path.exists(newp):
            print('  ! 新文件已存在，跳过 %s : %s' % (key, newp)); continue
        moves.append((oldp, newp, key))
        rec['file'] = newfn

    # ---- 2) 同步所有 m_*.json 的 file 字段 ----
    mfiles = sorted(glob.glob(os.path.join(OUT, 'm_*.json')))
    mchanged = {fp: False for fp in mfiles}
    for fp in mfiles:
        try:
            data = json.load(open(fp, encoding='utf-8'))
        except Exception as e:
            print('  ! 跳过坏清单 %s: %s' % (os.path.basename(fp), e)); continue
        if not isinstance(data, dict):
            continue
        for key, rec in data.items():
            if key in CORRECT and isinstance(rec, dict) and rec.get('file'):
                p = parse(rec['file'])
                if not p:
                    continue
                cont, ctry, cityslug = p
                ncont, nctry = CORRECT[key]
                if ctry == nctry:
                    continue
                newbase = '%s_%s_%s' % (slug(ncont), slug(nctry), cityslug)
                newfn = 'pmtiles/%s.pmtiles' % newbase
                if rec['file'] != newfn:
                    rec['file'] = newfn
                    mchanged[fp] = True

    # ---- 3) 修 V3 的 country（及 pbf override）----
    v3 = json.load(open(V3, encoding='utf-8'))
    v3c = v3['coverable']
    v3changed = False
    for c in v3c:
        if c['name'] in CORRECT:
            ncont, nctry = CORRECT[c['name']]
            if c.get('country') != nctry or c.get('continent') != ncont:
                c['continent'], c['country'] = ncont, nctry
                v3changed = True
        if c['name'] in PBF_OVERRIDE:
            if c.get('pbf') != PBF_OVERRIDE[c['name']]:
                c['pbf'] = PBF_OVERRIDE[c['name']]
                v3changed = True

    # ---- 报告 ----
    print('需磁盘改名：%d 个' % len(moves))
    for oldp, newp, key in moves:
        print('   %s -> %s' % (os.path.basename(oldp), os.path.basename(newp)))
    print('m_*.json 改动：%d 个文件' % sum(1 for v in mchanged.values() if v))
    print('V3 改动：%s' % ('是' if v3changed else '否'))

    if args.dry_run:
        print('\n--dry-run：未落盘')
        return

    # ---- 落盘 ----
    for oldp, newp, key in moves:
        shutil.move(oldp, newp)
    for fp in mfiles:
        if mchanged[fp]:
            # 注意：写的是已修改的 data，切勿重新读盘（否则改动被覆盖）
            data = json.load(open(fp, encoding='utf-8'))
            for key, rec in data.items():
                if key in CORRECT and isinstance(rec, dict) and rec.get('file'):
                    p = parse(rec['file'])
                    if not p:
                        continue
                    cont, ctry, cityslug = p
                    ncont, nctry = CORRECT[key]
                    if ctry == nctry:
                        continue
                    newbase = '%s_%s_%s' % (slug(ncont), slug(nctry), cityslug)
                    newfn = 'pmtiles/%s.pmtiles' % newbase
                    if rec['file'] != newfn:
                        rec['file'] = newfn
            json.dump(data, open(fp, 'w', encoding='utf-8'),
                      ensure_ascii=False, indent=1)
    json.dump(mani, open(mani_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    if v3changed:
        json.dump(v3, open(V3, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('\n已落盘。下一步：重抽里斯本/都拉基乌姆/伊州/海口 → 拜占庭别名 → merge-manifests.py')


if __name__ == '__main__':
    main()
