# -*- coding: utf-8 -*-
"""
tools/smoke/seam-v-probe.py

纵向（竖直）接缝检测：
  1) 找「整列都有强边」的列 —— 瓦片边界式直边（自然地物极少出现贯穿全高的直线）
  2) 对每条候补竖缝，测量左右两侧内容的竖向位移 dy（在 ±MAXDY 内做归一化互相关），
     并给出「最佳 dy 处的相关度」与「dy=0 的相关度」对比
  3) 顺带输出横向台阶：蓝色水域（水色阈值）在各行的最右/最左边界，找出跳变行

用法：
    uv run --no-project --with numpy --with pillow python tools/smoke/seam-v-probe.py <png> [x0 y0 x1 y1]
"""
import sys
import numpy as np
from PIL import Image

EDGE_T = 22        # 单像素色差阈值
RUN_MIN = 60       # 视为"直边"的最小连续行数
MAXDY = 60         # 竖向位移搜索范围
HALF = 10          # 左右取样宽度


def load(p, box=None):
    im = Image.open(p).convert('RGB')
    if box:
        im = im.crop(box)
    return np.asarray(im, dtype=np.float32)


def col_run(g):
    """每列：最大连续强边行数"""
    d = np.abs(np.diff(g, axis=1)).sum(axis=2)      # (H, W-1)
    strong = d > EDGE_T
    H, W1 = strong.shape
    best = np.zeros(W1, dtype=np.int32)
    for x in range(W1):
        col = strong[:, x]
        run = cur = 0
        for v in col:
            cur = cur + 1 if v else 0
            if cur > run:
                run = cur
        best[x] = run
    return best


def best_dy(a, b, maxdy=MAXDY):
    """a/b: 等高两块 (h,w) 灰度，找 a 相对 b 的最佳竖向位移"""
    h, w = a.shape
    if h <= 2 * maxdy + 8:
        return 0, 0.0, 0.0
    a0 = a - a.mean()
    b0 = b - b.mean()
    na, nb = np.linalg.norm(a0), np.linalg.norm(b0)
    if na < 1e-6 or nb < 1e-6:
        return 0, 0.0, 0.0

    def corr(dy):
        if dy >= 0:
            aa, bb = a0[dy:, :], b0[:h - dy, :]
        else:
            aa, bb = a0[:h + dy, :], b0[-dy:, :]
        den = np.linalg.norm(aa) * np.linalg.norm(bb)
        return 0.0 if den < 1e-6 else float((aa * bb).sum()) / den

    best = (0, -1.0)
    for dy in range(-maxdy, maxdy + 1):
        c = corr(dy)
        if c > best[1]:
            best = (dy, c)
    return best[0], best[1], corr(0)


def water_mask(g):
    """偏蓝判定：B 明显大于 R"""
    r, gr, b = g[:, :, 0], g[:, :, 1], g[:, :, 2]
    return (b > 180) & (b - r > 40) & (gr > 150)


def main():
    p = sys.argv[1]
    box = tuple(int(v) for v in sys.argv[2:6]) if len(sys.argv) >= 6 else None
    g = load(p, box)
    H, W, _ = g.shape
    print(f'区域 {W}x{H}')

    # ---- 1. 竖直直边 ----
    runs = col_run(g)
    order = np.argsort(runs)[::-1]
    picked, seen = [], -999
    for x in order:
        if runs[x] < RUN_MIN:
            break
        if x - seen <= 12:
            continue
        picked.append(int(x))
        seen = int(x)
        if len(picked) >= 6:
            break
    picked.sort()
    print('\n[竖直候选接缝]  x=边缘左列, run=最大连续强边行数')
    for x in picked:
        print(f'  x={x:5d}  run={runs[x]:4d}')

    # ---- 2. 每条缝的竖向位移 ----
    gray = g.mean(axis=2)
    print('\n[跨缝竖向位移]  dy>0 表示右侧内容比左侧「高」(需下移右侧才能对齐)')
    for x in picked:
        if x - HALF < 0 or x + HALF >= W:
            continue
        a = gray[:, x - HALF:x]
        b = gray[:, x:x + HALF]
        dy, cbest, c0 = best_dy(a, b)
        flag = '  <== 竖向错位' if abs(dy) >= 3 and cbest > 0.5 else ''
        print(f'  x={x:5d}  dy={dy:+4d}px  corr(best)={cbest:.3f}  corr(dy0)={c0:.3f}{flag}')

    # ---- 3. 水域左右边界跳变 ----
    wm = water_mask(g)
    print('\n[水域边界] 逐行统计水体最右/最左像素')
    rows = []
    for y in range(0, H, 4):
        xs = np.flatnonzero(wm[y])
        if len(xs) < 20:
            continue
        rows.append((y, int(xs.min()), int(xs.max())))
    print('  y     left  right')
    prev = None
    jumps = []
    for (y, l, r) in rows:
        tag = ''
        if prev:
            dl, dr = l - prev[1], r - prev[2]
            if abs(dl) >= 12 or abs(dr) >= 12:
                tag = f'   <== 跳变 dl={dl:+d} dr={dr:+d}'
                jumps.append((y, dl, dr))
        prev = (y, l, r)
        print(f'  {y:4d}  {l:5d} {r:5d}{tag}')
    print('\n跳变行数:', len(jumps))
    for (y, dl, dr) in jumps[:12]:
        print(f'  y={y}  dl={dl:+d}  dr={dr:+d}')


if __name__ == '__main__':
    main()
