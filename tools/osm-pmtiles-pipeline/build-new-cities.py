#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""批量构建新增城市离线 pmtiles（基于本地已下载的 geofabrik pbf）。

用法
----
  # 只列出将要构建的城市 + 校验 pbf 是否齐（不构建，不写文件）
  uv run --no-project --with osmium --with pmtiles --with mapbox-vector-tile --with shapely \
      python tools/osm-pmtiles-pipeline/build-new-cities.py --dry-run

  # 正式构建全部（带进度显示，可 Ctrl+C 中断；gen_city_pmtiles 自带"已存在则跳过"续跑）
  uv run --no-project --with osmium --with pmtiles --with mapbox-vector-tile --with shapely \
      python tools/osm-pmtiles-pipeline/build-new-cities.py

  # 只构建某几个城市（按中文名，逗号分隔）
  ... build-new-cities.py --only 布鲁塞尔,阿姆斯特丹

  # 只构建某个 pbf 组的城市（逗号分隔组名，如 dach,italy）
  ... build-new-cities.py --groups dach,italy

  # 指定 pbf 目录 / 输出目录（默认 D:/迅雷下载 与 public/data/osm/pmtiles）
  ... build-new-cities.py --pbfdir "D:/迅雷下载" --out public/data/osm/pmtiles

说明
----
- 写入端 encode_tile 已显式 y_coord_down=True（pbf-to-pmtiles.py L741），
  新建文件几何正确，不再带"每瓦片 y 镜像"缺陷，无需再过 batch-fix-yflip。
- 但后台正在跑的 batch-fix-yflip 按 *.pmtiles 通配处理；为防止它（或将来重启）
  把本脚本产出的"正确"文件再翻回错误，脚本在每城构建成功后把该文件登记进
  yflip 进度日志（name + sha_out 命中即跳过）。
- 构建完自动把新条目合并进 public/data/osm/pmtiles/manifest.json（仅更新成功的）。
- osmium-tool 二进制（tools/osmium-bin/Library/bin/osmium.exe）用于预裁剪；
  找不到则回退全量扫源 pbf（慢）。
"""
import sys
import os
import json
import time
import glob
import hashlib
import importlib.util
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORK = HERE / "work"
WORK.mkdir(exist_ok=True)


def _load_pipeline():
    cands = [
        HERE / "pbf-to-pmtiles.py",
        Path.cwd() / "tools/osm-pmtiles-pipeline/pbf-to-pmtiles.py",
    ]
    for c in cands:
        if c.exists():
            spec = importlib.util.spec_from_file_location("pbf_to_pmtiles", str(c))
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            return mod
    raise SystemExit("找不到 pbf-to-pmtiles.py")


P = _load_pipeline()

# 与 pbf-to-pmtiles.main 同款的 pbf key → 实际文件名映射（fallback 会自动补 -latest.osm.pbf）
PBF_FILE = {
    'china': 'china-latest.osm.pbf', 'sea': 'sea-latest.osm.pbf',
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
    'north-korea': 'north-korea-latest.osm.pbf',
    # 新增组（仅下载了分区文件，无整美单一文件）：靠 fallback 自动拼 -latest.osm.pbf
    'us-west': 'us-west-latest.osm.pbf', 'us-south': 'us-south-latest.osm.pbf',
    'us-northeast': 'us-northeast-latest.osm.pbf', 'us-pacific': 'us-pacific-latest.osm.pbf',
    'us-midwest': 'us-midwest-latest.osm.pbf',
    'belgium': 'belgium-latest.osm.pbf', 'netherlands': 'netherlands-latest.osm.pbf',
    'hungary': 'hungary-latest.osm.pbf', 'portugal': 'portugal-latest.osm.pbf',
    'austria': 'austria-latest.osm.pbf', 'bulgaria': 'bulgaria-latest.osm.pbf',
}


def resolve_pbf(key, pbfdir):
    if os.path.isabs(key) or (len(key) > 2 and key[1] == ':'):
        return key
    return os.path.join(pbfdir, PBF_FILE.get(key, key + '-latest.osm.pbf'))


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


# ---- 新增城市清单（bbox = [minlon, minlat, maxlon, maxlat]）----
# continent/country 仅用于文件名前缀（欧洲_比利时_布鲁塞尔），不影响功能。
CITIES = [
    # 比利时
    dict(name='布鲁塞尔', continent='欧洲', country='比利时', pbf='belgium', bbox=[4.28, 50.80, 4.43, 50.90]),
    dict(name='安特卫普', continent='欧洲', country='比利时', pbf='belgium', bbox=[4.33, 51.17, 4.48, 51.27]),
    dict(name='根特',     continent='欧洲', country='比利时', pbf='belgium', bbox=[3.66, 51.00, 3.81, 51.10]),
    dict(name='布鲁日',   continent='欧洲', country='比利时', pbf='belgium', bbox=[3.15, 51.16, 3.30, 51.26]),
    # 荷兰
    dict(name='阿姆斯特丹', continent='欧洲', country='荷兰', pbf='netherlands', bbox=[4.82, 52.32, 4.98, 52.42]),
    dict(name='鹿特丹',     continent='欧洲', country='荷兰', pbf='netherlands', bbox=[4.40, 51.87, 4.56, 51.97]),
    dict(name='海牙',       continent='欧洲', country='荷兰', pbf='netherlands', bbox=[4.23, 52.02, 4.39, 52.12]),
    dict(name='乌得勒支',   continent='欧洲', country='荷兰', pbf='netherlands', bbox=[5.03, 52.04, 5.19, 52.14]),
    dict(name='埃因霍温',   continent='欧洲', country='荷兰', pbf='netherlands', bbox=[5.38, 51.37, 5.54, 51.47]),
    # 匈牙利
    dict(name='布达佩斯', continent='欧洲', country='匈牙利', pbf='hungary', bbox=[18.95, 47.40, 19.15, 47.57]),
    # 葡萄牙
    dict(name='波尔图', continent='欧洲', country='葡萄牙', pbf='portugal', bbox=[-8.70, 41.11, -8.54, 41.21]),
    # 德国 / 瑞士（dach）
    dict(name='海德堡', continent='欧洲', country='德国', pbf='dach', bbox=[8.63, 49.35, 8.78, 49.45]),
    dict(name='巴塞尔', continent='欧洲', country='瑞士', pbf='dach', bbox=[7.53, 47.51, 7.68, 47.61]),
    dict(name='卢塞恩', continent='欧洲', country='瑞士', pbf='dach', bbox=[8.24, 47.00, 8.38, 47.10]),
    dict(name='弗赖堡', continent='欧洲', country='德国', pbf='dach', bbox=[7.78, 47.95, 7.92, 48.05]),
    dict(name='波恩',   continent='欧洲', country='德国', pbf='dach', bbox=[7.03, 50.68, 7.17, 50.78]),
    dict(name='汉诺威', continent='欧洲', country='德国', pbf='dach', bbox=[9.66, 52.33, 9.82, 52.43]),
    dict(name='莱比锡', continent='欧洲', country='德国', pbf='dach', bbox=[12.30, 51.29, 12.46, 51.39]),
    # 意大利
    dict(name='巴勒莫', continent='欧洲', country='意大利', pbf='italy', bbox=[13.28, 38.07, 13.44, 38.17]),
    dict(name='卡塔尼亚', continent='欧洲', country='意大利', pbf='italy', bbox=[15.01, 37.45, 15.17, 37.55]),
    dict(name='比萨',   continent='欧洲', country='意大利', pbf='italy', bbox=[10.32, 43.67, 10.48, 43.77]),
    dict(name='维罗纳', continent='欧洲', country='意大利', pbf='italy', bbox=[10.92, 45.39, 11.08, 45.49]),
    dict(name='锡耶纳', continent='欧洲', country='意大利', pbf='italy', bbox=[11.25, 43.27, 11.41, 43.37]),
    dict(name='博洛尼亚', continent='欧洲', country='意大利', pbf='italy', bbox=[11.26, 44.45, 11.42, 44.55]),
    # 西班牙
    dict(name='托莱多', continent='欧洲', country='西班牙', pbf='spain', bbox=[-4.10, 39.81, -3.94, 39.91]),
    dict(name='科尔多瓦', continent='欧洲', country='西班牙', pbf='spain', bbox=[-4.85, 37.84, -4.69, 37.94]),
    # 英国
    dict(name='牛津',     continent='欧洲', country='英国', pbf='great-britain', bbox=[-1.32, 51.70, -1.16, 51.80]),
    dict(name='剑桥',     continent='欧洲', country='英国', pbf='great-britain', bbox=[0.04, 52.15, 0.20, 52.25]),
    dict(name='卡迪夫',   continent='欧洲', country='英国', pbf='great-britain', bbox=[-3.26, 51.43, -3.10, 51.53]),
    dict(name='贝尔法斯特', continent='欧洲', country='英国', pbf='great-britain', bbox=[-6.00, 54.55, -5.84, 54.65]),
    # 土耳其（沿用现有 亚洲_土耳其_伊斯坦布尔 前缀）
    dict(name='安卡拉', continent='亚洲', country='土耳其', pbf='turkey', bbox=[32.78, 39.88, 32.94, 39.98]),
    dict(name='安塔利亚', continent='亚洲', country='土耳其', pbf='turkey', bbox=[30.62, 36.85, 30.78, 36.95]),
    dict(name='伊兹密尔', continent='亚洲', country='土耳其', pbf='turkey', bbox=[27.05, 38.37, 27.21, 38.47]),
    # 俄罗斯（沿用现有 欧洲_俄罗斯_莫斯科 前缀）
    dict(name='喀山',       continent='欧洲', country='俄罗斯', pbf='russia', bbox=[49.04, 55.74, 49.20, 55.84]),
    dict(name='叶卡捷琳堡', continent='欧洲', country='俄罗斯', pbf='russia', bbox=[60.55, 56.78, 60.71, 56.88]),
    dict(name='索契',       continent='欧洲', country='俄罗斯', pbf='russia', bbox=[39.66, 43.54, 39.82, 43.64]),
    dict(name='加里宁格勒', continent='欧洲', country='俄罗斯', pbf='russia', bbox=[20.38, 54.66, 20.54, 54.76]),
    # 伊朗
    dict(name='设拉子', continent='亚洲', country='伊朗', pbf='iran', bbox=[52.48, 29.56, 52.64, 29.66]),
    dict(name='马什哈德', continent='亚洲', country='伊朗', pbf='iran', bbox=[59.50, 36.25, 59.66, 36.35]),
    dict(name='大不里士', continent='亚洲', country='伊朗', pbf='iran', bbox=[46.19, 38.02, 46.35, 38.12]),
    # 美国（用分区 pbf：萨克拉门托→us-west，俄克拉荷马城→us-south）
    dict(name='萨克拉门托',   continent='北美洲', country='美国', pbf='us-west', bbox=[-121.57, 38.53, -121.41, 38.63]),
    dict(name='俄克拉荷马城', continent='北美洲', country='美国', pbf='us-south', bbox=[-97.58, 35.42, -97.42, 35.52]),
]

for _c in CITIES:
    _c.setdefault('minz', 11)
    _c.setdefault('maxz', 15)


def main():
    args = sys.argv[1:]
    d = dict(pbfdir='D:/迅雷下载',
             out=str(Path('public/data/osm/pmtiles')),
             manifest=str(Path('public/data/osm/pmtiles/manifest.json')))
    i = 0
    only = groups_filter = None
    dry = False
    while i < len(args):
        a = args[i]
        if a == '--pbfdir':
            d['pbfdir'] = args[i + 1]; i += 2
        elif a == '--out':
            d['out'] = args[i + 1]; i += 2
        elif a == '--manifest':
            d['manifest'] = args[i + 1]; i += 2
        elif a == '--only':
            only = set(args[i + 1].split(',')); i += 2
        elif a == '--groups':
            groups_filter = set(args[i + 1].split(',')); i += 2
        elif a == '--dry-run':
            dry = True; i += 1
        else:
            i += 1

    want = [c for c in CITIES
            if (only is None or c['name'] in only)
            and (groups_filter is None or c['pbf'] in groups_filter)]
    if not want:
        print('没有匹配的城市（--only/--groups 过滤后为空）。')
        return

    # 按 pbf 组聚合
    by_group = {}
    for c in want:
        by_group.setdefault(c['pbf'], []).append(c)

    # pbf 可用性预检
    print('=' * 70)
    print('新增城市构建（共 %d 城 / %d 个 pbf 组）' % (len(want), len(by_group)))
    print('pbf 目录: %s' % d['pbfdir'])
    print('输出目录: %s' % d['out'])
    print('=' * 70)
    missing_groups = []
    for key in sorted(by_group):
        src = resolve_pbf(key, d['pbfdir'])
        ok = os.path.exists(src)
        if not ok:
            missing_groups.append(key)
        print('  [%s] %2d 城  pbf=%s  %s' % (key, len(by_group[key]), src, '✓' if ok else '✗ 缺失'))
    if missing_groups and not dry:
        print('\n以下组缺少 pbf，将跳过: ' + ', '.join(missing_groups))

    if dry:
        print('\n[dry-run] 仅预检，未构建、未写文件。')
        return

    osmium = P.find_osmium()
    if osmium:
        print('\n✓ osmium-tool: %s（启用 extract 预裁剪）' % osmium)
    else:
        print('\n⚠ 未找到 osmium-tool → 全量扫源 pbf（慢）')

    print('开始构建…\n')
    t_all = time.time()
    n_ok = n_resume = n_empty = n_skip = 0
    all_results = {}

    # 读现有 manifest 以便合并（不覆盖已有条目）
    man = {}
    if os.path.exists(d['manifest']):
        try:
            man = json.load(open(d['manifest'], encoding='utf-8'))
        except Exception:
            man = {}

    yflip_log = WORK / 'yflip-progress.built-correct.jsonl'
    yflip_lf = open(str(yflip_log), 'a', encoding='utf-8')

    total = len(want)
    done_cnt = 0
    for key in sorted(by_group):
        if key in missing_groups:
            continue
        cities = by_group[key]
        src = resolve_pbf(key, d['pbfdir'])
        done_cnt += len(cities)
        print('—' * 60)
        print('组 %s：%d 城  (%d/%d)' % (key, len(cities), done_cnt, total))
        print('—' * 60)
        res = P.gen_city_pmtiles(
            src, cities, d['out'], 16,
            osmium=osmium,
            max_grow=P.CLUSTER_MAX_GROW, max_area=P.CLUSTER_MAX_AREA,
            include_relations=True)
        for name, r in res.items():
            r['pbf'] = key
            all_results[name] = r
            slug = P.city_fname(next(c for c in cities if c['name'] == name))
            path = os.path.join(d['out'], slug + '.pmtiles')
            if r.get('ok'):
                if r.get('resumed'):
                    n_resume += 1
                    print('  ↺ %-14s 已存在，跳过' % name)
                else:
                    n_ok += 1
                    # 登记到 yflip 进度日志：防止后台/将来 y-flip 把正确文件再翻回
                    rec = {
                        'name': slug + '.pmtiles', 'status': 'ok',
                        'sha_out': sha256(path), 'built_correct': True,
                        'tiles': r.get('tiles'), 'bytes': r.get('bytes'),
                        'sec': r.get('sec'), 'ts': time.time(),
                    }
                    yflip_lf.write(json.dumps(rec, ensure_ascii=False) + '\n')
                    yflip_lf.flush()
                    print('  ✓ %-14s %d 瓦片  %.1f MB' % (name, r.get('tiles', 0), (r.get('bytes', 0) or 0) / 1048576))
            else:
                n_empty += 1
                print('  ✗ %-14s %s' % (name, r.get('reason', 'EMPTY')))
            # 合并进 manifest（仅成功项）
            if r.get('ok'):
                man[name] = r

    yflip_lf.close()

    # 写回 manifest
    json.dump(man, open(d['manifest'], 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

    print('\n' + '=' * 70)
    print('完成：构建 %d / 续跑跳过 %d / EMPTY %d' % (n_ok, n_resume, n_empty))
    print('总耗时 %.0fs' % (time.time() - t_all))
    print('manifest 已合并 %d 个新条目 → %s' % (len(all_results), d['manifest']))
    print('新建正确文件已登记到 %s（后台 y-flip 不会误翻）' % yflip_log.name)
    if n_empty:
        print('注意 EMPTY 城市（源 pbf 未覆盖该点，多半是 bbox 超出 pbf 范围）：' +
              '、'.join(n for n, r in all_results.items() if not r.get('ok')))


if __name__ == '__main__':
    main()
