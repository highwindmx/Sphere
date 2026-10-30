# -*- coding: utf-8 -*-
"""
tools/osm-pmtiles-pipeline/verify-pmtiles-index.py

**独立实现**的极简 PMTiles v3 读取器（不依赖 public/vendor/pmtiles-reader.js）。

存在理由：跨瓦片接缝校验与地理锚定都只能证明「内容自洽 / 内容吻合」，
都无法排除「我们的 JS 读取器把瓦片放错位置」。用一份**按规范另写**的解析器把同一
(z,x,y) 的字节取出来，与 JS 读取器取出的字节逐字节比对，就能一锤定音：
   字节相同 → 读取器没问题，错位在别处；
   字节不同 → 目录/tile_id(Hilbert) 映射有 bug，前端自然整块错位。

用法：
    .venv/Scripts/python.exe tools/osm-pmtiles-pipeline/verify-pmtiles-index.py <file.pmtiles> <z> <x> <y> [out.mvt]
    .venv/Scripts/python.exe tools/osm-pmtiles-pipeline/verify-pmtiles-index.py <file.pmtiles> --stats
"""
import sys, struct, gzip, json


def read_varint(b, p):
    val = 0
    shift = 0
    while True:
        byte = b[p]
        p += 1
        val |= (byte & 0x7f) << shift
        if not (byte & 0x80):
            return val, p
        shift += 7


def zxy_to_tile_id(z, x, y):
    """PMTiles v3 的 tile_id = 全局 Hilbert 曲线序号"""
    acc = 0
    for t in range(z):
        acc += (1 << t) * (1 << t)          # (4^z - 1) / 3
    n = 1 << z
    d = 0
    xx, yy = x, y
    s = n // 2
    while s > 0:
        rx = 1 if (xx & s) > 0 else 0
        ry = 1 if (yy & s) > 0 else 0
        d += s * s * ((3 * rx) ^ ry)
        if ry == 0:
            if rx == 1:
                xx = s - 1 - xx
                yy = s - 1 - yy
            xx, yy = yy, xx
        s //= 2
    return acc + d


class Pmtiles:
    def __init__(self, path):
        self.buf = open(path, 'rb').read()
        b = self.buf
        if b[:7] != b'PMTiles':
            raise ValueError('不是 PMTiles 文件（magic=%r）' % b[:7])
        self.version = b[7]
        (self.root_off, self.root_len) = struct.unpack_from('<QQ', b, 8)
        (self.meta_off, self.meta_len) = struct.unpack_from('<QQ', b, 24)
        (self.leaf_off, self.leaf_len) = struct.unpack_from('<QQ', b, 40)
        (self.data_off, self.data_len) = struct.unpack_from('<QQ', b, 56)
        self.addressed = struct.unpack_from('<Q', b, 72)[0]
        self.n_entries = struct.unpack_from('<Q', b, 80)[0]
        self.n_contents = struct.unpack_from('<Q', b, 88)[0]
        self.clustered = b[96]
        self.internal_comp = b[97]
        self.tile_comp = b[98]
        self.tile_type = b[99]
        self.min_zoom = b[100]
        self.max_zoom = b[101]
        self.bounds = struct.unpack_from('<iiii', b, 102)   # E7
        self.entries = self._parse_dir(self.root_off, self.root_len)

    def _dir_bytes(self, off, ln):
        raw = self.buf[off:off + ln]
        # ⭐ 目录按 header 的 internal_compression 压缩（本文件是 2 = gzip）。
        #   不解压直接解析会读到垃圾：表现为条目数离谱、tile_id 大到 1e14、offset 天文数字。
        if self.internal_comp == 2:
            raw = gzip.decompress(raw)
        elif self.internal_comp == 3:
            import brotli
            raw = brotli.decompress(raw)
        elif self.internal_comp == 4:
            import zstandard
            raw = zstandard.ZstdDecompressor().decompress(raw)
        return raw

    def _parse_dir(self, off, ln):
        """→ [(tile_id, offset, length, run_length)]。

        ⚠ 目录是**列式** varint（先 n 个 tile_id 增量，再 n 个 run_length，再 n 个 length，
        最后 n 个 offset），不是交错存放 —— 按交错解析会得到垃圾并导致递归爆炸。
        offset 也是增量编码：值为 0 表示「紧接上一个块」，否则实际值 = 值 - 1。
        run_length == 0 的条目是**叶子目录引用**，其偏移相对 header 的 leaf_offset。
        """
        b = self._dir_bytes(off, ln)
        p = 0
        cnt, p = read_varint(b, p)
        ids, last = [], 0
        for _ in range(cnt):
            d, p = read_varint(b, p)
            last += d
            ids.append(last)
        rls = []
        for _ in range(cnt):
            v, p = read_varint(b, p)
            rls.append(v)
        lens = []
        for _ in range(cnt):
            v, p = read_varint(b, p)
            lens.append(v)
        out, prev_end = [], 0
        for i in range(cnt):
            v, p = read_varint(b, p)
            o = prev_end if v == 0 else v - 1
            prev_end = o + lens[i]
            if rls[i] == 0:
                out.extend(self._parse_dir(self.leaf_off + o, lens[i]))
            else:
                out.append((ids[i], o, lens[i], rls[i]))
        return out

    def get_tile(self, z, x, y):
        tid = zxy_to_tile_id(z, x, y)
        lo, hi = 0, len(self.entries) - 1
        while lo <= hi:
            mid = (lo + hi) // 2
            e = self.entries[mid]
            if e[0] <= tid < e[0] + e[3]:
                # ⭐ 同一 run 内的 run_length 个 tile **共享同一份数据**（不是各自偏移）
                if self.clustered:
                    off = e[1]
                else:
                    off = e[1]
                raw = self.buf[self.data_off + off: self.data_off + off + e[2]]
                # 瓦片按 header 的 tile_compression 压缩（本文件 2 = gzip）
                if self.tile_comp == 2:
                    raw = gzip.decompress(raw)
                return raw
            if tid < e[0]:
                hi = mid - 1
            else:
                lo = mid + 1
        return None


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 1
    path = sys.argv[1]
    pm = Pmtiles(path)
    print('version=%d  zoom %d..%d  addressed=%d entries=%d contents=%d clustered=%d tile_type=%d comp=%d'
          % (pm.version, pm.min_zoom, pm.max_zoom, pm.addressed, pm.n_entries,
             pm.n_contents, pm.clustered, pm.tile_type, pm.tile_comp))
    print('bounds(E7)=', pm.bounds, ' → ',
          [round(v / 1e7, 4) for v in pm.bounds])
    if '--stats' in sys.argv:
        ids = [e[0] for e in pm.entries]
        print('目录条目 %d  tile_id 范围 %d..%d' % (len(ids), min(ids), max(ids)))
        print('前 5 条:', pm.entries[:5])
        print('后 3 条:', pm.entries[-3:])
        for (z, x, y) in [(11, 1076, 733), (12, 2152, 1466), (13, 4305, 2932),
                          (14, 8610, 5864), (15, 17220, 11728)]:
            tid = zxy_to_tile_id(z, x, y)
            t = pm.get_tile(z, x, y)
            print('  z%-2d (%5d,%5d) tile_id=%-12d → %s' % (z, x, y, tid,
                  ('%d 字节' % len(t)) if t else '❌ 查不到'))
        return 0
    z, x, y = int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
    t = pm.get_tile(z, x, y)
    print('tile_id(%d,%d,%d) = %d' % (z, x, y, zxy_to_tile_id(z, x, y)))
    if t is None:
        print('❌ 目录里查不到该瓦片')
        return 2
    print('✅ 取到 %d 字节' % len(t))
    if len(sys.argv) > 5:
        open(sys.argv[5], 'wb').write(t)
        print('已写出', sys.argv[5])
    return 0


if __name__ == '__main__':
    sys.exit(main())
