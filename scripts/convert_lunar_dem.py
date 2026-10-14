"""月球 LOLA DEM → Terrarium PNG 转换脚本（rasterio 版）
rasterio 可高效读取大 GeoTIFF 的 overview/窗口，无需全量加载。
"""
import numpy as np

try:
    import rasterio
except ImportError:
    raise SystemExit("需要 rasterio：uv run --with rasterio --with numpy python 此脚本")

SRC = r'd:\Share\Scripts\Explore\sphere\public\lunar\Lunar_LRO_LOLA_Global_LDEM_118m_Mar2014.tif'
DST = r'd:\Share\Scripts\Explore\sphere\public\lunar_dem.png'
TARGET_W, TARGET_H = 4096, 2048

print("Opening DEM with rasterio...")
ds = rasterio.open(SRC)
print(f"  size: {ds.width}x{ds.height}, bands: {ds.count}, dtype: {ds.dtypes}")

# 检查 overviews
print(f"  overviews: {ds.overviews(1)}")

# 读取降采样：用 out_shape 让 rasterio 内部降采样
from rasterio.enums import Resampling
dem = ds.read(
    1,
    out_shape=(TARGET_H, TARGET_W),
    resampling=Resampling.bilinear
).astype(np.int32)

print(f"  dem shape={dem.shape}, min={dem.min()}, max={dem.max()}, mean={dem.mean():.1f}")
ds.close()

# Terrarium 编码：height → R, G, B
# height = R*256 + G + B/256 - 32768
# val = height + 32768, R = val>>8, G = val&0xFF, B = 0
print("Encoding to Terrarium RGB...")
val = np.clip(dem + 32768, 0, 16777215).astype(np.uint32)

r = ((val >> 8) & 0xFF).astype(np.uint8)
g = (val & 0xFF).astype(np.uint8)
b = np.zeros_like(r)
rgb = np.dstack([r, g, b])

from PIL import Image
out = Image.fromarray(rgb, mode='RGB')
print(f"Saving PNG to {DST}...")
out.save(DST, 'PNG')

import os
size_mb = os.path.getsize(DST) / (1024 * 1024)
print(f"Done. Output: {out.size}, File size: {size_mb:.1f} MB")
