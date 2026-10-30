"""生成用于地月场景「月球示意球」的提亮版月面贴图。

背景（2026-10-19 用户反馈「第二幕的月球需要有月面图片蒙皮」）：
  moonEnt（半径 ×MOON_EXAG_FAR 的示意球）原本直接用 lunar_wac.jpg，但该图是 WAC
  反照率产品，整体偏暗（headless 实测球体区域像素均值仅 ~28），且原图 10 MB /
  高分辨率，压到屏幕上十几像素后既暗又糊，看起来就像「没有蒙皮的灰点」。

处理口径（与 src/lunar.js LUNAR_LAYER_OPTS 同一套，保持一致）：
    out = clamp(src ^ (1/gamma) × brightness)      gamma=1.45 → 指数 0.69；brightness=1.35
  ⚠ gamma>1 才是提亮（指数<1），写反会变暗——这是本项目踩过的坑（见 lunar.js 注释）。

输出：public/data/lunar/lunar_wac_bright_2k.jpg（等距圆柱 2:1，2048×1024，质量 88）。
用法：.venv/Scripts/python.exe tools/make-lunar-bright.py
"""

import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(ROOT, 'public', 'lunar', 'lunar_wac.jpg')
DST = os.path.join(ROOT, 'public', 'lunar', 'lunar_wac_bright_2k.jpg')

GAMMA = 1.45
BRIGHTNESS = 1.35
OUT_W, OUT_H = 2048, 1024


def build_lut(gamma: float, brightness: float) -> list:
    """256 级查找表：out = clamp(v^(1/gamma) × brightness) × 255。"""
    exp = 1.0 / gamma
    return [min(255, max(0, int(round(((v / 255.0) ** exp) * brightness * 255))))
            for v in range(256)]


def main() -> int:
    if not os.path.isfile(SRC):
        print(f'ERROR: source not found: {SRC}', file=sys.stderr)
        return 1
    img = Image.open(SRC)
    print(f'source: {img.size[0]}x{img.size[1]} mode={img.mode}')
    rgb = img.convert('RGB')
    # 保持等距圆柱 2:1，降采样到 2K（原图 10MB，作为 entity 贴图过重）
    rgb = rgb.resize((OUT_W, OUT_H), Image.LANCZOS)
    lut = build_lut(GAMMA, BRIGHTNESS)
    # R/G/B 三通道共用同一 LUT（灰度拉伸，不引入色偏）
    out = rgb.point(lut * 3)
    out.save(DST, 'JPEG', quality=88, optimize=True)
    size_kb = os.path.getsize(DST) / 1024.0
    print(f'wrote: {DST}  {OUT_W}x{OUT_H}  {size_kb:.0f} KB  gamma={GAMMA} brightness={BRIGHTNESS}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
