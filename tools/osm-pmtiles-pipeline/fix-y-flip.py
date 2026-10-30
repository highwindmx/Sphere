#!/usr/bin/env python
"""修复 pmtiles 的「每瓦片 y 镜像」缺陷。

根因：`pbf-to-pmtiles.py::encode_tile` 调 `mapbox_vector_tile.encode` 时没传
`y_coord_down`，该库编码端默认会把 y 翻成 `extent - y`（见 utils.DEFAULT_ENCODE_OPTIONS），
而 local 坐标本来已是 y 向下 → 写入即镜像。MapLibre 按规范忠实渲染，于是每块瓦片内几何
上下颠倒，拼接后呈锯齿 / 「上左偏、下右偏」的平行四边形扭曲。

本脚本不需要原始 pbf：逐瓦片 decode（原生 y 向下）→ y' = extent - y → encode(y_coord_down=True)
→ 重新封装 pmtiles。

用法：
  # 小样本自检（只处理 3 个瓦片，打印翻转前后坐标）
  uv run --no-project --with pmtiles --with mapbox-vector-tile --with shapely python \
      tools/osm-pmtiles-pipeline/fix-y-flip.py <in.pmtiles> <out.pmtiles> --limit 3

  # 全量修复
  uv run --no-project --with pmtiles --with mapbox-vector-tile --with shapely python \
      tools/osm-pmtiles-pipeline/fix-y-flip.py <in.pmtiles> <out.pmtiles>
"""
import gzip
import importlib.util
import json
import struct
import sys
import time
from pathlib import Path

import mapbox_vector_tile as mvt
from shapely.geometry import LineString, Polygon
from pmtiles.reader import Reader, MmapSource
from pmtiles.tile import tileid_to_zxy

ROOT = Path(__file__).resolve().parents[2]
EXT = 4096


# ---------------- 复用管线的 pmtiles 封装 ----------------
def load_pipeline():
    p = ROOT / "tools/osm-pmtiles-pipeline/pbf-to-pmtiles.py"
    spec = importlib.util.spec_from_file_location("pbfpipe", str(p))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def read_varint(buf, pos):
    shift = 0
    val = 0
    b = 0
    while True:
        b = buf[pos]
        pos += 1
        val |= (b & 0x7F) << shift
        shift += 7
        if not (b & 0x80):
            break
    return val, pos


def parse_directory(buf):
    """v3 目录 → [(tile_id, run_length, length, offset)]"""
    n, pos = read_varint(buf, 0)
    ids = []
    last = 0
    for _ in range(n):
        d, pos = read_varint(buf, pos)
        last += d
        ids.append(last)
    rl = []
    for _ in range(n):
        v, pos = read_varint(buf, pos)
        rl.append(v)
    ln = []
    for _ in range(n):
        v, pos = read_varint(buf, pos)
        ln.append(v)
    off = []
    prev_end = 0
    for i in range(n):
        v, pos = read_varint(buf, pos)
        o = prev_end if v == 0 else v - 1
        off.append(o)
        prev_end = o + ln[i]
    return list(zip(ids, rl, ln, off))


def enum_tiles(path):
    """枚举 archive 里所有瓦片 id。仅支持单层 root 目录（本项目全部如此）。"""
    raw = Path(path).read_bytes()
    root_off, root_len = struct.unpack_from('<Q', raw, 8)[0], struct.unpack_from('<Q', raw, 16)[0]
    leaf_off, leaf_len = struct.unpack_from('<Q', raw, 40)[0], struct.unpack_from('<Q', raw, 48)[0]
    if leaf_len:
        raise SystemExit(f'该文件含 leaf 目录（{leaf_len} B），本脚本未实现多层目录，'
                         f'请改用 pbf 重跑管线')
    out = []
    entries = parse_directory(gzip.decompress(raw[root_off:root_off + root_len]))
    for tid, run, _ln, _o in entries:
        if run == 0:
            continue
        for k in range(run):
            out.append(tid + k)
    return out


def flip_geom(g):
    """把 y 翻成 EXT - y，返回 shapely 几何。"""
    t = g["type"]
    cs = g["coordinates"]
    if t == "Polygon":
        rings = [[(x, EXT - y) for x, y in ring] for ring in cs]
        if not rings or len(rings[0]) < 3:
            return None
        try:
            return Polygon(rings[0], rings[1:])
        except Exception:
            return None
    if t == "LineString":
        if len(cs) < 2:
            return None
        return LineString([(x, EXT - y) for x, y in cs])
    if t == "MultiLineString":
        parts = [[(x, EXT - y) for x, y in ln] for ln in cs if len(ln) >= 2]
        return parts[0] if parts else None      # 本管线只有单线
    return None


def fix_one(src, dst, limit=0):
    """修复单文件：逐瓦片 decode(原生y)→翻转→encode(y_coord_down=True)→重封装。
    返回 (n_tiles, n_feat, size_out)。注意：本函数会把 y 翻转一次，
    对「已修复」的文件再调用会翻转回去（变回错误），调用方必须用进度日志避免重复！"""
    pipe = load_pipeline()

    with open(src, 'rb') as f:
        h = Reader(MmapSource(f)).header()
        reader = Reader(MmapSource(f))
        tids = enum_tiles(src)
        if limit:
            tids = tids[:limit]

        blobs = {}
        t0 = time.time()
        n_feat = 0
        n_skip = 0
        for i, tid in enumerate(tids):
            z, x, y = tileid_to_zxy(tid)
            raw = reader.get(z, x, y)
            if raw is None:
                n_skip += 1
                continue
            data = gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw
            # 原生 y 向下
            layers = mvt.decode(data, default_options={"y_coord_down": True})
            out_layers = []
            for name, lay in layers.items():
                feats = []
                for ft in lay["features"]:
                    geom = flip_geom(ft["geometry"])
                    if geom is None:
                        continue
                    feats.append({"geometry": geom, "properties": ft["properties"]})
                    n_feat += 1
                if feats:
                    out_layers.append({"name": name, "features": feats})
            if not out_layers:
                blobs[(z, x, y)] = gzip.compress(b'', 6)
                continue
            enc = mvt.encode(out_layers, default_options={
                'extents': EXT, 'quantize_bounds': None, 'y_coord_down': True})
            blobs[(z, x, y)] = gzip.compress(enc, 6)
            if (i + 1) % 500 == 0:
                print(f"  {i+1}/{len(tids)}  {time.time()-t0:.0f}s", flush=True)

        bbox = (h['min_lon_e7'] / 1e7, h['min_lat_e7'] / 1e7,
                h['max_lon_e7'] / 1e7, h['max_lat_e7'] / 1e7)
        center = (h['center_lon_e7'] / 1e7, h['center_lat_e7'] / 1e7)
        name = ''
        try:
            md = reader.metadata()
            name = md.get('name', '') if isinstance(md, dict) else ''
        except Exception:
            pass
        blob, n = pipe.build_pmtiles(blobs, bbox, center,
                                     h['min_zoom'], h['max_zoom'], name)
        Path(dst).write_bytes(blob)
        return n, n_feat, len(blob)


def main():
    src = sys.argv[1]
    dst = sys.argv[2]
    limit = 0
    if '--limit' in sys.argv:
        limit = int(sys.argv[sys.argv.index('--limit') + 1])
    n_tiles, n_feat, size = fix_one(src, dst, limit)
    print(f"已写出 {dst}  {size/1048576:.1f} MB  {n_tiles} 瓦片  {n_feat} 要素")


if __name__ == "__main__":
    main()
