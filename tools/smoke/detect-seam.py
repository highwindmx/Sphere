# -*- coding: utf-8 -*-
"""
tools/smoke/detect-seam.py  （图像侧接缝检测，不属于 osm-pmtiles-pipeline）

对一张地图截图逐行带做「最佳水平位移」估计：
  - 把地图区域切成高 STRIP 的水平条带
  - 对每条带，与下方相隔 GAP 的条带做归一化互相关，在 ±MAXDX 内找最佳 dx
  - 正常情况下同一片连贯地图的 dx 序列应当平滑、接近 0
  - 瓦片纵向错位 → 在某一 y 处 dx 突然跳到非零常数（整块平移）

用法：
    uv run --no-project --with numpy --with pillow python tools/smoke/detect-seam.py <png> [x0 y0 x1 y1]
"""
import sys
import numpy as np
from PIL import Image

STRIP = 6          # 条带高度（px）
GAP = 6            # 参与比较的两条带间隔（px）
MAXDX = 40         # 最大搜索水平位移
MIN_CORR = 0.55    # 相关度过低视为不可比（内容变化/纯色区）


def load(p, box=None):
    im = Image.open(p).convert('L')
    if box:
        im = im.crop(box)
    return np.asarray(im, dtype=np.float32)


def best_dx(a, b, maxdx=MAXDX):
    """返回 (dx, corr)；a/b 是等高的条带（h,w）"""
    h, w = a.shape
    if w <= 2 * maxdx + 8:
        return 0, 0.0
    a = a - a.mean()
    b = b - b.mean()
    na = np.linalg.norm(a)
    nb = np.linalg.norm(b)
    if na < 1e-6 or nb < 1e-6:
        return 0, 0.0
    best = (0, -1.0)
    for dx in range(-maxdx, maxdx + 1):
        if dx >= 0:
            aa = a[:, dx:]
            bb = b[:, :w - dx]
        else:
            aa = a[:, :w + dx]
            bb = b[:, -dx:]
        num = float((aa * bb).sum())
        den = float(np.linalg.norm(aa) * np.linalg.norm(bb))
        if den < 1e-6:
            continue
        c = num / den
        if c > best[1]:
            best = (dx, c)
    return best


def main():
    p = sys.argv[1]
    box = None
    if len(sys.argv) >= 6:
        box = tuple(int(v) for v in sys.argv[2:6])
    g = load(p, box)
    H, W = g.shape
    rows = []
    for y in range(0, H - STRIP - GAP - 1, STRIP):
        a = g[y:y + STRIP, :]
        b = g[y + GAP:y + GAP + STRIP, :]
        dx, c = best_dx(a, b)
        rows.append((y, dx, round(c, 3)))
    # 找 dx 突变：|dx| 连续 >=2 条带且 > 2px，前后为 ~0
    print(f'区域 {W}x{H}  条带 {len(rows)}')
    print('y     dx    corr')
    for (y, dx, c) in rows:
        flag = ''
        if abs(dx) >= 3:
            flag = '   <== 水平位移'
        print(f'{y:4d} {dx:5d}  {c:5.3f}{flag}')
    # 汇总
    big = [(y, dx) for (y, dx, c) in rows if abs(dx) >= 3 and c >= MIN_CORR]
    print('\n可疑条带数:', len(big))
    if big:
        ys = [y for y, _ in big]
        dxs = [dx for _, dx in big]
        print('y 范围:', min(ys), '~', max(ys), ' dx 中位:', int(np.median(dxs)))
    else:
        print('未检测到整块水平平移的接缝（dx 全程接近 0）')


if __name__ == '__main__':
    main()
