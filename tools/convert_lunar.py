"""月球 TIF → JPG 转换脚本
将 LROC WAC 全球影像（109164×54582 灰度 TIF）缩成 8192×4096 JPG，
供 Cesium SingleTileImageryProvider 直接加载。
"""
from PIL import Image

Image.MAX_IMAGE_PIXELS = None  # 禁用解炸弹保护（文件已知安全）

SRC = r'd:\Share\Scripts\Explore\sphere\public\lunar\Lunar_LRO_LROC-WAC_Mosaic_global_100m_June2013.tif'
DST = r'd:\Share\Scripts\Explore\sphere\public\lunar\lunar_wac.jpg'

print("Opening TIF...")
img = Image.open(SRC)
print(f"  original: {img.size}, mode={img.mode}")

# reduce() 在解码阶段降采样，避免加载全分辨率到内存
# 109164/13 ≈ 8397, 54582/13 ≈ 4199 → 再 resize 到 8192×4096
print("Reducing...")
img = img.reduce(13)
print(f"  reduced: {img.size}")

# 转为 RGB（Cesium 纹理需要 RGB/RGBA）
if img.mode != 'RGB':
    img = img.convert('RGB')

# 精确缩放到 8192×4096
print("Resizing to 8192x4096...")
img = img.resize((8192, 4096), Image.LANCZOS)

print(f"Saving JPEG to {DST}...")
img.save(DST, 'JPEG', quality=88)
print(f"Done. Output: {img.size}")

import os
size_mb = os.path.getsize(DST) / (1024 * 1024)
print(f"File size: {size_mb:.1f} MB")
