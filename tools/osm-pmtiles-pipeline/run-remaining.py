#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
全量城市单批串行跑批器（容错版）

用途：一条命令把清单里**所有**未完成的城市一次跑完。

设计（2026-10-26 改版：取消分批/多车道，改为单批串行）：
  · 单批串行 = 只有一组在跑，内存占用恒定，不会因插入任务而 OOM
  · 每组用**独立子进程**跑 → 单组崩溃不影响其他组，且内存彻底回收（避免累积泄漏）
  · 自动跳过已完成的城市（pbf-to-pmtiles.py 内建断点续跑）
  · 按源 pbf 大小升序排队：小组先出成果，大组（asia/africa）放最后
  · ⭐ 遇到活跃 extract 残留时**等待冷却**而不是跳过——跳过会漏组，等待不会
  · 已完成的组记入状态文件；中断后重跑本脚本即可接着跑
  · 子进程秒退（rc≠0 且 <0.2 分钟）→ 判定参数/环境问题，立即中止以免白跑

用法：
    ./.venv/Scripts/python.exe tools/run-remaining.py                # 单批跑完所有未完成组
    ./.venv/Scripts/python.exe tools/run-remaining.py --plan         # 只列完整清单
    ./.venv/Scripts/python.exe tools/run-remaining.py --dry-run      # 只看计划不执行
    ./.venv/Scripts/python.exe tools/run-remaining.py --groups china,sea
"""
import argparse
import json
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
P2P = os.path.join(ROOT, 'tools/osm-pmtiles-pipeline/pbf-to-pmtiles.py')
MANIFEST = os.path.join(ROOT, 'tools/osm-pmtiles-pipeline/_bgroup_manifest.v3.json')  # 448 城版（合并龟兹错点 + 新疆丝路点国别改中国）
OUTDIR = os.path.join(ROOT, 'public/data/osm/pmtiles')
WORK = os.path.join(ROOT, 'tools/.work')
STATE = os.path.join(ROOT, 'tools/.work/queue-state.json')
PY = os.path.join(ROOT, '.venv/Scripts/python.exe')

# 源 pbf 大小（GB），仅用于排序：小组先跑，大组后跑
PBFSIZE = {
    'malta': 0.01, 'shanghai': 0.03, 'georgia': 0.10, 'israel-and-palestine': 0.11,
    'iraq': 0.08, 'iran': 0.21, 'serbia': 0.22, 'south-korea': 0.27, 'greece': 0.32,
    'central-america': 0.74, 'turkey': 0.61, 'ukraine': 0.82, 'australia-oceania': 1.47,
    'china': 1.50, 'spain': 1.39, 'great-britain': 2.04, 'italy': 2.09, 'alps': 2.17,
    'japan': 2.38, 'sea': 3.43, 'south-america': 3.86, 'russia': 3.90, 'france': 4.75,
    'dach': 5.83, 'africa': 7.40, 'us': 11.39, 'asia': 15.29,
}
DEFAULT_SIZE = 5.0   # 未知大小按中等处理


def _slug(name):
    keep = []
    for ch in name:
        if ch.isalnum():
            keep.append(ch)
        elif ch in ' -()（）·、':
            keep.append('_')
    return ''.join(keep).strip('_') or 'city'


def _fname(city):
    """与 pbf-to-pmtiles.city_fname 保持一致：大洲-国家-城市"""
    cont, ctry = city.get('continent'), city.get('country')
    if cont and ctry and cont != '未知' and ctry != '未知':
        return _slug('%s-%s-%s' % (cont, ctry, city['name']))
    return _slug(city['name'])


def group_progress():
    """返回 {组名: (清单数, 已有数, 最近产出时间戳)}"""
    m = json.load(open(MANIFEST, encoding='utf-8'))
    groups = {}
    for c in m['coverable']:
        groups.setdefault(c['pbf'], []).append(c)
    info = {}
    for g, names in groups.items():
        have, latest = 0, 0
        for n in names:
            # 磁盘文件名 = 「大洲-国家-城市」slug 化（城市名里的 ·、（、）、空格 → _）
            p = os.path.join(OUTDIR, '%s.pmtiles' % _fname(n))
            if os.path.exists(p) and os.path.getsize(p) > 0:
                have += 1
                latest = max(latest, os.path.getmtime(p))
        info[g] = (len(names), have, latest)
    return info


def active_extracts(max_age_min=25):
    """正在被别处任务使用的 clip 文件（近 max_age_min 分钟内写过）→ 返回 stem 集合"""
    if not os.path.isdir(WORK):
        return set()
    now = time.time()
    stems = set()
    for f in os.listdir(WORK):
        if f.endswith('.clip.osm.pbf'):
            if now - os.path.getmtime(os.path.join(WORK, f)) < max_age_min * 60:
                stems.add(f)
    return stems


def print_plan():
    """打印完整清单：按源 pbf 大小升序，每组列出城市全名 + 档位 + 输出文件名"""
    m = json.load(open(MANIFEST, encoding='utf-8'))
    groups = {}
    for c in m['coverable']:
        groups.setdefault(c['pbf'], []).append(c)
    print('=== 完整清单：%d 城 / %d 组（按源 pbf 升序排列）==='
          % (len(m['coverable']), len(groups)))
    print('档位：T1=±0.50° 都会大框  T2=±0.24°  T3=±0.12° 遗址/奇观\n')
    for g in sorted(groups, key=lambda k: PBFSIZE.get(k, DEFAULT_SIZE)):
        items = sorted(groups[g], key=lambda c: c['name'])
        print('[%s]  %d 城   源 %5.2f GB' % (g, len(items), PBFSIZE.get(g, DEFAULT_SIZE)))
        cells = ['%-20s' % ('%s·%s' % (c['name'], c.get('tier', '?'))) for c in items]
        for i in range(0, len(cells), 4):
            print('   ' + ''.join(cells[i:i + 4]))
        print()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--groups', default=None, help='逗号分隔的组名，默认跑所有未完成组')
    ap.add_argument('--dry-run', action='store_true', help='只打印计划不执行')
    ap.add_argument('--plan', action='store_true', help='打印每组城市全名清单')
    args = ap.parse_args()

    if args.plan:
        print_plan()
        return

    info = group_progress()
    pending = {g: v for g, v in info.items() if v[1] < v[0]}
    if args.groups:
        want = set(args.groups.split(','))
        pending = {g: v for g, v in pending.items() if g in want}

    order = sorted(pending.items(), key=lambda kv: PBFSIZE.get(kv[0], DEFAULT_SIZE))
    total_city = sum(v[0] for v in info.values())

    print('=== 单批串行队列：%d 组待跑 / %d 城（清单共 %d 城）==='
          % (len(order), sum(v[0] - v[1] for v in pending.values()), total_city))
    for g, (n, have, _) in order:
        print('  %-22s %3d/%3d  (源 %5.2f GB)' % (g, have, n, PBFSIZE.get(g, DEFAULT_SIZE)))
    if args.dry_run:
        return
    if not order:
        print('全部完成，无需续跑。')
        return

    state = {}
    if os.path.exists(STATE):
        try:
            state = json.load(open(STATE, encoding='utf-8'))
        except Exception:
            state = {}

    print('\n=== 开始执行（每组独立子进程）===')
    for g, (n, have, _) in order:
        # 单批串行：遇到残留 clip 文件**等待冷却**而不是跳过（跳过 = 漏组）
        waited = 0
        while any(g.split('-')[0] in f for f in active_extracts()) and waited < 900:
            if waited == 0:
                print('    （检测到残留 clip，等待冷却…）', flush=True)
            time.sleep(30)
            waited += 30
        t0 = time.time()
        mout = 'm_%s.json' % g.replace('-', '_')
        # 大源文件：放宽 cluster 合并阈值，减少「全扫一次源 pbf」的次数；
        # 同时用 16 平方度（≈4°×4°）硬上限兜住，避免框出半个大洲反而更慢更吃内存。
        # 实测模型：43 cluster → 17~19 cluster，总耗时腰斩（569 → ~320 分钟）
        cmd = [PY, P2P, '--manifest', MANIFEST, '--only', g,
               '--out', OUTDIR, '--manifest-out', mout,
               '--max-grow', '150', '--max-area', '16']
        print('\n--- %s (%d 城)：启动 %s' % (g, n - have, ' '.join(cmd[1:])), flush=True)
        rc = subprocess.call(cmd, cwd=ROOT)
        minutes = (time.time() - t0) / 60
        state[g] = {'rc': rc, 'minutes': round(minutes, 1), 'at': time.strftime('%m-%d %H:%M')}
        json.dump(state, open(STATE, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        flag = '✓' if rc == 0 else '✗ rc=%d' % rc
        print('--- %s %s  耗时 %.1f 分钟' % (g, flag, minutes), flush=True)
        if rc != 0 and minutes < 0.2:
            # 秒退 = 参数/环境类错误（不是城市数据问题），继续跑下去只会一路失败
            print('\n!!! %s 在 %.1f 分钟内退出（rc=%d），判定为参数或环境问题，'
                  '中止队列以免白跑。修正后重跑本脚本即可（已产出的城市会自动跳过）。'
                  % (g, minutes, rc), flush=True)
            return 1

    print('\n=== 队列结束 ===')
    print('状态文件：%s' % STATE)
    gp = group_progress()
    done = sum(v[1] for v in gp.values())
    total = sum(v[0] for v in gp.values())
    remain = {g: v for g, v in gp.items() if v[1] < v[0]}
    print('进度：%d / %d 城' % (done, total))
    if remain:
        print('仍未完成 %d 组：%s' % (len(remain), '、'.join(sorted(remain))))
        print('重跑本脚本即可继续（已产出城市自动跳过）。')
    else:
        print('全部 %d 城已完成。下一步：./.venv/Scripts/python.exe tools/merge-manifests.py'
              % total)


if __name__ == '__main__':
    main()
