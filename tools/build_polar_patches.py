#!/usr/bin/env python
"""极冠补丁图生成器（per-source 色版）
====================================

背景：各在线源极区表现不同（实测 2026-10-16，z5 北极边缘瓦片 79.2°-85.05°）：

    源                北极带均色        南极带均色
    Esri World Imagery (23,84,100) 无冰海水（夏态）   (243,246,254) 白冰
    EOX s2cloudless-2025 (18,34,62) 深蓝（全年无云合成） (250,250,251) 白冰
    bluemarble.jpg（现有补丁） (10,28,63) 深蓝大洋      (237,238,238) 白冰

EOX 与 bluemarble 色差极小（≈+8 亮度）→ 可直接共用；
Esri 偏绿偏亮 → 需要专属色版（本脚本生成）。

色版算法（HSV 空间，保留像素间明暗结构，只整体搬色系）：
    源色 → 目标色 的 H/S/V 三通道线性映射，仅作用于极带（|lat| > POLE_CAP_EDGE_DEG）。
    接缝精调由运行时 recalibratePolarCaps() 逐列对齐完成（采样实际源色），
    图级只做粗调，两者分工不重复。

运行（managed venv 已装 Pillow；项目 .venv 无 pip 不可用）：
    C:/Users/KaishengMao/.workbuddy/binaries/python/envs/default/Scripts/python.exe tools/build_polar_patches.py

产物：
    public/patch/esri.jpg   4096x2048 全球等经纬（北极带=Esri 色系，南极带=白冰微调）
    public/patch/eox.jpg    4096x2048（北极带≈bluemarble 微亮，南极带微调）
"""

import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'public', 'patch', 'bluemarble.jpg')
OUT_DIR = os.path.join(ROOT, 'public', 'patch')

# 与 main.js 的 POLE_CAP_EDGE_DEG 对齐：补丁带覆盖 |lat| > 84.96°
POLE_CAP_EDGE_DEG = 5.04


def band_rows(h: int) -> tuple:
    """等经纬图的南北极带像素行范围（含端点）。"""
    band_px = max(1, round(POLE_CAP_EDGE_DEG / 180.0 * h))
    return (0, band_px), (h - band_px, h)


def mean_rgb(px, w, y0, y1) -> tuple:
    n = 0
    acc = [0, 0, 0]
    for y in range(y0, y1):
        row = px[y * w:(y + 1) * w]
        for c in row:
            acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]
            n += 1
    return tuple(round(a / n) for a in acc) if n else (0, 0, 0)


def hsv_of(rgb: tuple) -> tuple:
    """RGB(0-255) -> HSV(H:0-360, S:0-1, V:0-1)"""
    r, g, b = (c / 255.0 for c in rgb)
    mx, mn = max(r, g, b), min(r, g, b)
    v = mx
    s = 0.0 if mx == 0 else (mx - mn) / mx
    if mx == mn:
        h = 0.0
    else:
        d = mx - mn
        if mx == r:
            h = (g - b) / d % 6
        elif mx == g:
            h = (b - r) / d + 2
        else:
            h = (r - g) / d + 4
        h *= 60
    return (h, s, v)


def build_variant(name: str, north_target: tuple, south_target: tuple) -> None:
    """从 bluemarble.jpg 生成一个源的补丁图（极带色系搬移）。"""
    im = Image.open(SRC).convert('RGB')
    w, h = im.size
    px = list(im.getdata())
    (n0, n1), (s0, s1) = band_rows(h)
    src_north = mean_rgb(px, w, n0, n1)
    src_south = mean_rgb(px, w, s0, s1)
    print(f'[{name}] 源北极带={src_north} -> 目标={north_target} | 源南极带={src_south} -> 目标={south_target}')

    hsv = im.convert('HSV')
    hd, sd, vd = hsv.split()

    def remap(band, src_mean, dst_mean):
        """把 band((y0,y1)) 的 HSV 从 src_mean 搬向 dst_mean（H 环绕、S 线性、V 线性）。"""
        y0, y1 = band
        sh, ss, sv = hsv_of(src_mean)
        dh, ds, dv = hsv_of(dst_mean)
        # H 差取最短弧（-180..180）
        hdiff = (dh - sh + 180) % 360 - 180
        hpix = hd.load()
        spix = sd.load()
        vpix = vd.load()
        for y in range(y0, y1):
            for x in range(w):
                if hdiff:
                    hpix[x, y] = int((hpix[x, y] + hdiff / 360.0 * 255.0) % 256)
                # S/V 线性缩放（目标/源），加钳制；源 S 或 V 为 0 时保持
                s_old, v_old = spix[x, y], vpix[x, y]
                if ss > 0.01:
                    spix[x, y] = min(255, max(0, round(s_old * ds / ss)))
                if sv > 0.01:
                    vpix[x, y] = min(255, max(0, round(v_old * dv / sv)))

    remap((n0, n1), src_north, north_target)
    remap((s0, s1), src_south, south_target)
    # merge 用改过的三个带（hd/sd/vd），模式 'HSV' 再转 RGB——
    # 曾经的 bug：merge('RGB', hsv.split()) 既传了未修改的新带、又把 HSV 数据当 RGB 输出
    out = Image.merge('HSV', (hd, sd, vd)).convert('RGB')
    os.makedirs(OUT_DIR, exist_ok=True)
    dst = os.path.join(OUT_DIR, f'{name}.jpg')
    out.save(dst, 'JPEG', quality=92)
    size_kb = os.path.getsize(dst) // 1024
    print(f'[{name}] -> {dst} ({w}x{h}, {size_kb} KB)')


def main() -> int:
    if not os.path.isfile(SRC):
        print(f'缺少源图: {SRC}', file=sys.stderr)
        return 1
    # 目标色 = 2026-10-16 实测各源极区边缘瓦片均色（详见模块 docstring）
    build_variant('esri', (23, 84, 100), (243, 246, 254))
    build_variant('eox', (18, 34, 62), (250, 250, 251))
    return 0


if __name__ == '__main__':
    sys.exit(main())
