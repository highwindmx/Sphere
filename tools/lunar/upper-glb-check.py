#!/usr/bin/env python3
# tools/upper-glb-check.py — 解析 longmarch5_upper.glb，确认钟形喷管节点与出口几何
import json, struct, os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'public', 'models')
path = os.path.join(ROOT, 'longmarch5_upper.glb')
with open(path, 'rb') as f:
    data = f.read()
# GLB: magic(4) + version(4) + length(4) + [chunk0: len(4)+type(4)+json]
_, _, _ = struct.unpack('<4sII', data[:12])
off = 12
clen, ctype = struct.unpack('<II', data[off:off+8]); off += 8
assert ctype == 0x4E4F534A  # JSON
gltf = json.loads(data[off:off+clen])
nodes = gltf.get('nodes', [])
meshes = gltf.get('meshes', [])
accessors = gltf.get('accessors', [])

print('== 节点名（自上而下，root 不计）==')
for n in nodes:
    print('  -', n.get('name', '(unnamed)'))

def mesh_extent(mesh_idx):
    mn = [1e9,1e9,1e9]; mx = [-1e9,-1e9,-1e9]
    for prim in meshes[mesh_idx].get('primitives', []):
        a = accessors[prim['attributes']['POSITION']]
        for i in range(3):
            mn[i] = min(mn[i], a['min'][i]); mx[i] = max(mx[i], a['max'][i])
    return mn, mx

# 打印每个节点所引用 mesh 的 y 范围（底对齐，y=0 即喷口面）
print('\n== 各节点 mesh 的 y 范围（y=0=喷口面）==')
node_by_name = {n.get('name'): n for n in nodes}
for name in ('尾裙', '喷管', '二级箭体', '整流罩', '卫星'):
    n = node_by_name.get(name)
    if n and 'mesh' in n:
        mn, mx = mesh_extent(n['mesh'])
        print(f'  {name:<6s} mesh#{n["mesh"]:<2d} y=[{mn[1]:.2f}, {mx[1]:.2f}]  r_xz≈[{min(abs(mn[0]),abs(mx[0])):.2f}, {max(abs(mn[0]),abs(mx[0]),abs(mn[2]),abs(mx[2])):.2f}]')
