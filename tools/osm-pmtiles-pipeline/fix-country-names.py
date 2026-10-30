#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
跑批收尾修复脚本（2026-10-26）

解决的问题：
  1. 早期 v2 进程（在我给 pbf-to-pmtiles.py 加 encoding='utf-8' 之前启动）写出的
     m_*.json 全是 GBK 编码 → merge-manifests.py 用 UTF-8 读会挂。本脚本把所有
     m_*.json 转 UTF-8。
  2. 这些进程按 v2 清单生成，部分城市文件名国别是旧的：
       龟兹（库车）  哈萨克斯坦 -> 中国
       焉耆（库尔勒）哈萨克斯坦 -> 中国
       焉耆          哈萨克斯坦 -> 中国
       耶路撒冷      以色列     -> 巴勒斯坦
     （阿拉木图/阿斯塔纳在 v3 里仍是哈萨克斯坦，不动；特拉维夫仍是以色列，不动）
     修正 = 更新 m_*.json 里对应条目的 file 路径 + 重命名磁盘 .pmtiles。

用法：
  ./venv/Scripts/python.exe tools/fix-country-names.py
必须在 run-remaining.py 完全跑完（无活跃进程）后执行，否则会和写入进程抢文件。
"""
import glob
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, 'public', 'data', 'osm', 'pmtiles')
V3 = os.path.join(ROOT, 'tools', 'pmtiles', '_bgroup_manifest.v3.json')

# 需修正国别的目标城市（仅这 4 个，从 v3 取权威 continent/country）
FIX_NAMES = {'龟兹（库车）', '焉耆（库尔勒）', '焉耆', '耶路撒冷'}


def slug(s):
    out = []
    for ch in s:
        if ch.isalnum():
            out.append(ch)
        elif ch in ' -()（）·、':
            out.append('_')
    return ''.join(out).strip('_') or 'x'


def main():
    v3 = json.load(open(V3, encoding='utf-8'))['coverable']
    target = {}
    for c in v3:
        if c['name'] in FIX_NAMES:
            target[c['name']] = (c['continent'], c['country'])

    print('v3 目标国别:', {k: '%s-%s' % v for k, v in target.items()})

    for mj in sorted(glob.glob(os.path.join(OUT, 'm_*.json'))):
        # 编码检测：先按 UTF-8 严格解码（GBK 字节流几乎必有非法 UTF-8 序列，
        # 反之 UTF-8 文件按 GBK 读不报错但中文变乱码——顺序绝不能反）
        try:
            raw = open(mj, encoding='utf-8').read()
            enc = 'utf-8'
        except UnicodeDecodeError:
            raw = open(mj, encoding='gbk').read()
            enc = 'gbk'
        data = json.loads(raw)
        if not isinstance(data, dict):
            print('跳过(非 dict):', os.path.basename(mj))
            continue

        changed = False
        for k, v in data.items():
            if k not in target or not isinstance(v, dict):
                continue
            cont, ctry = target[k]
            newbase = '%s_%s_%s' % (slug(cont), slug(ctry), slug(k))
            newfile = 'pmtiles/%s.pmtiles' % newbase
            oldfile = v.get('file')
            if oldfile == newfile:
                continue
            # 重命名磁盘文件
            if oldfile:
                oldp = os.path.join(OUT, os.path.basename(oldfile))
                newp = os.path.join(OUT, newbase + '.pmtiles')
                if os.path.exists(oldp) and not os.path.exists(newp):
                    os.rename(oldp, newp)
                    print('  重命名 %s -> %s' % (os.path.basename(oldfile), newbase + '.pmtiles'))
                elif not os.path.exists(oldp) and os.path.exists(newp):
                    pass  # 已改过
            v['file'] = newfile
            changed = True

        # 写回 UTF-8（无论是否改国别，都统一转 UTF-8）
        open(mj, 'w', encoding='utf-8').write(json.dumps(data, ensure_ascii=False, indent=1))
        print('%s: %s + 转 UTF-8' % (os.path.basename(mj), '已修正国别' if changed else '仅转码'))

    print('完成。现在可安全执行 merge-manifests.py')


if __name__ == '__main__':
    main()
