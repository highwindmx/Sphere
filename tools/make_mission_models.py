#!/usr/bin/env python3
# tools/make_mission_models.py — 生成探月任务 glTF 2.0（.glb）模型资产
#   public/models/longmarch5.glb      长征五号整箭（静态；Y-up，原点=发动机喷口面，单位米）
#   public/models/longmarch5_core.glb 芯级+整流罩（助推器分离后形态）
#   public/models/spacecraft.glb      飞船上面级 = 卫星形态（服务舱+设备舱+碟形天线+双臂太阳翼；
#                                     整流罩分离后即此形态，保留到第三幕离轨）
#   public/models/booster.glb         捆绑助推器（分离件）
#   public/models/fairing.glb         整流罩半瓣（分离件，半壳）
#   public/models/moon_lander.glb     月面着陆器（4 腿 + 喷口，Y-up，接地 y=0）
#   public/models/yutu_rover.glb      玉兔号月球车（6 轮滚动节点动画；前进 +X，接地 y=0，单位米）
#   public/models/flame.glb           发动机火焰锥（三层嵌套；原点=喷口，焰柱 +Y，半透明）
#   public/models/rcs.glb             RCS 姿控喷气（短锥；原点=喷口，喷柱 +Y，半透明）
# 纯标准库手写 glTF/GLB，无第三方依赖。重新生成：./.venv/Scripts/python.exe tools/make_mission_models.py
import json
import math
import os
import struct

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'models')
os.makedirs(ROOT, exist_ok=True)


# ---------- 几何生成（Y-up，右手系） ----------
def cylinder(r_top, r_bot, h, seg=20, capped=True):
    """圆台/圆柱/圆锥（r_top=0 即圆锥）。返回 (pos, nrm, idx)。"""
    pos, nrm, idx = [], [], []
    k = (r_top - r_bot) / h if h else 0.0
    for i in range(seg + 1):
        th = 2 * math.pi * i / seg
        c, s = math.cos(th), math.sin(th)
        pos += [r_bot * c, 0.0, r_bot * s]
        nrm += [c, -k, s]
        pos += [r_top * c, h, r_top * s]
        nrm += [c, -k, s]
    for i in range(seg):
        a, b, c, d = 2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 3
        idx += [a, c, b, b, c, d]
    if capped:
        if r_bot > 0:
            base = len(pos) // 3
            pos += [0.0, 0.0, 0.0]
            nrm += [0.0, -1.0, 0.0]
            for i in range(seg + 1):
                th = 2 * math.pi * i / seg
                pos += [r_bot * math.cos(th), 0.0, r_bot * math.sin(th)]
                nrm += [0.0, -1.0, 0.0]
            for i in range(seg):
                idx += [base, base + 1 + i, base + 2 + i]
        if r_top > 0:
            base = len(pos) // 3
            pos += [0.0, h, 0.0]
            nrm += [0.0, 1.0, 0.0]
            for i in range(seg + 1):
                th = 2 * math.pi * i / seg
                pos += [r_top * math.cos(th), h, r_top * math.sin(th)]
                nrm += [0.0, 1.0, 0.0]
            for i in range(seg):
                idx += [base, base + 2 + i, base + 1 + i]
    return pos, nrm, idx


def box(w, h, d):
    x, y, z = w / 2, h / 2, d / 2
    faces = [
        ((0, 0, 1), [(-x, -y, z), (x, -y, z), (x, y, z), (-x, y, z)]),
        ((0, 0, -1), [(x, -y, -z), (-x, -y, -z), (-x, y, -z), (x, y, -z)]),
        ((1, 0, 0), [(x, -y, z), (x, -y, -z), (x, y, -z), (x, y, z)]),
        ((-1, 0, 0), [(-x, -y, -z), (-x, -y, z), (-x, y, z), (-x, y, -z)]),
        ((0, 1, 0), [(-x, y, z), (x, y, z), (x, y, -z), (-x, y, -z)]),
        ((0, -1, 0), [(-x, -y, -z), (x, -y, -z), (x, -y, z), (-x, -y, z)]),
    ]
    pos, nrm, idx = [], [], []
    for n, pts in faces:
        base = len(pos) // 3
        for p in pts:
            pos += list(p)
            nrm += list(n)
        idx += [base, base + 1, base + 2, base, base + 2, base + 3]
    return pos, nrm, idx


def rot_x_90(geo):
    """(x,y,z) -> (x,-z,y)：把 Y 轴向几何绕到 Z 轴（轮子滚动轴）。"""
    pos, nrm, idx = geo
    p2 = [None] * len(pos)
    for i in range(0, len(pos), 3):
        p2[i], p2[i + 1], p2[i + 2] = pos[i], -pos[i + 2], pos[i + 1]
    n2 = [None] * len(nrm)
    for i in range(0, len(nrm), 3):
        n2[i], n2[i + 1], n2[i + 2] = nrm[i], -nrm[i + 2], nrm[i + 1]
    return p2, n2, idx


# ---------- GLB 组装 ----------
class Glb:
    def __init__(self):
        self.accessors, self.views, self.meshes = [], [], []
        self.nodes, self.materials, self.anims = [], [], []
        self.bin = bytearray()

    def _view(self, data, target=None):
        while len(self.bin) % 4:
            self.bin.append(0)
        off = len(self.bin)
        self.bin += data
        v = {'buffer': 0, 'byteOffset': off, 'byteLength': len(data)}
        if target:
            v['target'] = target
        self.views.append(v)
        return len(self.views) - 1

    def accessor(self, data, ctype, count, atype, mn=None, mx=None, target=None):
        vi = self._view(data, target)
        a = {'bufferView': vi, 'componentType': ctype, 'count': count, 'type': atype}
        if mn is not None:
            a['min'], a['max'] = mn, mx
        self.accessors.append(a)
        return len(self.accessors) - 1

    def mesh(self, geo, mat):
        pos, nrm, idx = geo
        pv = struct.pack(f'<{len(pos)}f', *pos)
        nv = struct.pack(f'<{len(nrm)}f', *nrm)
        iv = struct.pack(f'<{len(idx)}H', *idx)
        mn = [min(pos[i::3]) for i in range(3)]
        mx = [max(pos[i::3]) for i in range(3)]
        ai = self.accessor(iv, 5123, len(idx), 'SCALAR', target=34963)
        ap = self.accessor(pv, 5126, len(pos) // 3, 'VEC3', mn, mx, target=34962)
        an = self.accessor(nv, 5126, len(nrm) // 3, 'VEC3', target=34962)
        self.meshes.append({'primitives': [{
            'attributes': {'POSITION': ap, 'NORMAL': an},
            'indices': ai, 'material': mat, 'mode': 4,
        }]})
        return len(self.meshes) - 1

    def raw_accessor(self, data, ctype, count, atype, mn=None, mx=None):
        """直接登记一块已打包的原始数据（用于动画 sampler 的 times/quats）。"""
        while len(self.bin) % 4:
            self.bin.append(0)
        off = len(self.bin)
        self.bin += data
        self.views.append({'buffer': 0, 'byteOffset': off, 'byteLength': len(data)})
        a = {'bufferView': len(self.views) - 1, 'componentType': ctype,
             'count': count, 'type': atype}
        if mn is not None:
            a['min'], a['max'] = mn, mx
        self.accessors.append(a)
        return len(self.accessors) - 1

    def node(self, mesh=None, translation=None, name='', children=None):
        n = {'name': name}
        if mesh is not None:
            n['mesh'] = mesh
        if translation:
            n['translation'] = translation
        if children:
            n['children'] = children
        self.nodes.append(n)
        return len(self.nodes) - 1

    def material(self, rgba, metallic=0.1, roughness=0.65):
        self.materials.append({
            'pbrMetallicRoughness': {
                'baseColorFactor': rgba, 'metallicFactor': metallic, 'roughnessFactor': roughness,
            },
            'doubleSided': True,
        })
        return len(self.materials) - 1

    def save(self, path, roots, animations=None):
        gltf = {
            'asset': {'version': '2.0', 'generator': 'sphere make_mission_models.py'},
            'scene': 0, 'scenes': [{'nodes': roots}],
        }
        if self.nodes:
            gltf['nodes'] = self.nodes
        if self.meshes:
            gltf['meshes'] = self.meshes
        if self.materials:
            gltf['materials'] = self.materials
        if self.accessors:
            gltf['accessors'] = self.accessors
        if self.views:
            gltf['bufferViews'] = self.views
        gltf['buffers'] = [{'byteLength': len(self.bin)}]
        if animations:
            gltf['animations'] = animations
        js = json.dumps(gltf, separators=(',', ':')).encode()
        while len(js) % 4:
            js += b' '
        while len(self.bin) % 4:
            self.bin.append(0)
        total = 12 + 8 + len(js) + 8 + len(self.bin)
        with open(path, 'wb') as f:
            f.write(struct.pack('<III', 0x46546C67, 2, total))
            f.write(struct.pack('<II', len(js), 0x4E4F534A))
            f.write(js)
            f.write(struct.pack('<II', len(self.bin), 0x004E4942))
            f.write(self.bin)
        return total


# ---------- 长征五号 / 飞船上面级 ----------
def build_rocket(with_boosters=True, with_fairing=True, filename='longmarch5.glb', name='长征五号'):
    """长征五号整箭（Y-up，原点=发动机喷口面，单位米）。
    with_boosters/with_fairing=False 时生成飞船上面级（芯级+设备舱，无助推无整流罩）。"""
    g = Glb()
    white = g.material([0.93, 0.94, 0.96, 1.0], 0.05, 0.55)
    dark = g.material([0.20, 0.22, 0.25, 1.0], 0.3, 0.6)
    red = g.material([0.82, 0.18, 0.14, 1.0], 0.05, 0.6)
    gold = g.material([0.80, 0.62, 0.22, 1.0], 0.35, 0.5)
    grey = g.material([0.55, 0.58, 0.62, 1.0], 0.45, 0.45)
    panel = g.material([0.10, 0.17, 0.38, 1.0], 0.35, 0.45)   # 太阳翼（深蓝）
    parts = []
    parts.append(g.node(g.mesh(cylinder(1.65, 2.25, 2.6), dark), [0, 0, 0], '尾裙'))
    parts.append(g.node(g.mesh(cylinder(1.65, 1.65, 1.1), red), [0, 2.6, 0], '红色环带'))
    parts.append(g.node(g.mesh(cylinder(1.65, 1.65, 24.3), white), [0, 3.7, 0], '芯级'))
    if with_fairing:
        parts.append(g.node(g.mesh(cylinder(0.05, 1.65, 8.0), dark), [0, 28.0, 0], '整流罩'))
    if with_boosters:
        for i in range(4):  # 4 枚助推器（斜 45° 均布）
            th = math.pi / 4 + i * math.pi / 2
            r = 3.35
            x, z = r * math.cos(th), r * math.sin(th)
            parts.append(g.node(g.mesh(cylinder(0.62, 0.62, 14.5), white), [x, 3.7, z], f'助推器{i}'))
            parts.append(g.node(g.mesh(cylinder(0.05, 0.62, 2.8), dark), [x, 18.2, z], f'助推器头{i}'))
    else:
        # 飞船上面级 = 卫星形态（2026-10-17 用户反馈：「之后火箭的形态就不可能还是圆柱体，
        # 分级助推器已被抛弃，应该是卫星形态，而且要保留到第三幕」）：
        # 服务舱 + 设备舱 + 碟形天线 + 双臂太阳翼。此模型自整流罩分离起一路用到
        # 第三幕离轨（rocket.js 的 craft / loiCraft 两个槽位同 URL）。
        parts.append(g.node(g.mesh(cylinder(1.65, 1.65, 12.0), white), [0, 3.7, 0], '服务舱'))
        parts.append(g.node(g.mesh(cylinder(0.90, 1.20, 1.6), gold), [0, 15.7, 0], '设备舱'))
        parts.append(g.node(g.mesh(cylinder(1.25, 0.18, 0.5, seg=24), dark), [0, 17.3, 0], '碟形天线'))
        parts.append(g.node(g.mesh(cylinder(0.03, 0.03, 0.9), dark), [0, 17.8, 0], '馈源杆'))
        parts.append(g.node(g.mesh(box(2.4, 0.10, 2.4), white), [0, 18.7, 0], '对接环'))
        # 太阳翼 ×2：沿 ±X 展开（Cesium Y→Z 校正后 ±X = ENU 东西向，垂直于飞行方向）
        for sx in (1, -1):
            parts.append(g.node(g.mesh(box(1.0, 0.10, 0.5), grey), [sx * 2.2, 9.6, 0], f'翼根{sx}'))
            parts.append(g.node(g.mesh(box(5.6, 0.05, 2.8), panel), [sx * 5.5, 9.6, 0], f'太阳翼{sx}'))
    root = g.node(name=name, children=parts)
    total = g.save(os.path.join(ROOT, filename), [root])
    print(f'{filename:<18s}{total/1024:6.1f} KB  nodes={len(g.nodes)} meshes={len(g.meshes)}')


# ---------- 分离件：助推器 / 整流罩半壳 ----------
def build_booster():
    g = Glb()
    white = g.material([0.93, 0.94, 0.96, 1.0], 0.05, 0.55)
    dark = g.material([0.20, 0.22, 0.25, 1.0], 0.3, 0.6)
    parts = [
        g.node(g.mesh(cylinder(0.62, 0.62, 14.5), white), [0, 0, 0], '助推器体'),
        g.node(g.mesh(cylinder(0.05, 0.62, 2.8), dark), [0, 14.5, 0], '助推器头'),
    ]
    root = g.node(name='捆绑助推器', children=parts)
    total = g.save(os.path.join(ROOT, 'booster.glb'), [root])
    print(f'{"booster.glb":<18s}{total/1024:6.1f} KB  nodes={len(g.nodes)} meshes={len(g.meshes)}')


def half_shell(geo):
    """只保留质心 x>0 的三角形 → 半壳（整流罩半瓣，切口过轴线）。"""
    pos, nrm, idx = geo
    keep = []
    for i in range(0, len(idx), 3):
        cx = (pos[idx[i] * 3] + pos[idx[i + 1] * 3] + pos[idx[i + 2] * 3]) / 3
        if cx > 0:
            keep += [idx[i], idx[i + 1], idx[i + 2]]
    return pos, nrm, keep


def build_fairing():
    g = Glb()
    white = g.material([0.93, 0.94, 0.96, 1.0], 0.05, 0.55)
    root = g.node(g.mesh(half_shell(cylinder(0.05, 1.65, 8.0)), white), name='整流罩半瓣')
    total = g.save(os.path.join(ROOT, 'fairing.glb'), [root])
    print(f'{"fairing.glb":<18s}{total/1024:6.1f} KB  nodes={len(g.nodes)} meshes={len(g.meshes)}')


# ---------- 月面着陆器（4 直腿 + 喷口 + 设备舱 + 天线，Y-up，接地 y=0） ----------
def build_lander():
    g = Glb()
    gold = g.material([0.82, 0.66, 0.30, 1.0], 0.3, 0.5)
    grey = g.material([0.55, 0.58, 0.62, 1.0], 0.45, 0.45)
    dark = g.material([0.18, 0.19, 0.22, 1.0], 0.3, 0.6)
    parts = [
        g.node(g.mesh(cylinder(0.62, 0.16, 0.9), dark), [0, 0.6, 0], '发动机喷口'),
        g.node(g.mesh(cylinder(0.85, 1.05, 1.5), gold), [0, 1.5, 0], '机身'),
        g.node(g.mesh(box(1.6, 0.5, 1.6), grey), [0, 3.0, 0], '设备舱'),
        g.node(g.mesh(cylinder(0.03, 0.03, 0.9), grey), [0, 3.5, 0], '天线杆'),
        g.node(g.mesh(cylinder(0.26, 0.03, 0.20), grey), [0, 4.4, 0], '天线碟'),
    ]
    for i in range(4):  # 4 条直着陆腿（斜 45° 均布）+ 脚垫
        th = math.pi / 4 + i * math.pi / 2
        x, z = 1.05 * math.cos(th), 1.05 * math.sin(th)
        parts.append(g.node(g.mesh(cylinder(0.06, 0.10, 1.5), grey), [x, 0, z], f'着陆腿{i}'))
        parts.append(g.node(g.mesh(box(0.42, 0.06, 0.42), dark), [x * 1.12, 0.03, z * 1.12], f'脚垫{i}'))
    root = g.node(name='月面着陆器', children=parts)
    total = g.save(os.path.join(ROOT, 'moon_lander.glb'), [root])
    print(f'{"moon_lander.glb":<18s}{total/1024:6.1f} KB  nodes={len(g.nodes)} meshes={len(g.meshes)}')


# ---------- 玉兔号月球车（6 轮滚动节点动画） ----------
def build_rover():
    g = Glb()
    body = g.material([0.82, 0.84, 0.87, 1.0], 0.2, 0.55)
    panel = g.material([0.80, 0.62, 0.22, 1.0], 0.35, 0.5)
    wheel = g.material([0.16, 0.16, 0.18, 1.0], 0.1, 0.85)
    silver = g.material([0.55, 0.58, 0.62, 1.0], 0.5, 0.4)
    dark = g.material([0.18, 0.19, 0.22, 1.0], 0.3, 0.6)
    kids = [
        g.node(g.mesh(box(1.55, 0.30, 1.05), body), [0, 0.45, 0], '车体'),
        g.node(g.mesh(box(1.70, 0.05, 1.00), panel), [-0.05, 0.66, 0], '太阳翼'),
        g.node(g.mesh(box(0.70, 0.26, 0.62), silver), [-0.25, 0.73, 0], '设备舱'),
        g.node(g.mesh(cylinder(0.03, 0.03, 0.52), silver), [0.72, 0.42, 0], '桅杆'),
        g.node(g.mesh(box(0.14, 0.12, 0.14), dark), [0.72, 1.00, 0], '相机头'),
    ]
    # 6 轮：滚动 = 绕轮轴（Z）的节点动画。
    # 轮辐：每轮 3 根银色小辐条作为轮子节点的子节点——纯色光滑圆柱绕自身轴旋转
    #       视觉上几乎不变（2026-10-17 冒烟实测 animDiff≈0.10 假阴性），辐条让旋转可判读。
    wheel_nodes = []
    for wx in (0.60, 0.0, -0.60):
        for wz in (0.62, -0.62):
            spokes = [g.node(g.mesh(box(0.08, 0.08, 0.22), silver),
                             [0.13 * math.cos(math.pi * 2 * k / 3), 0.13 * math.sin(math.pi * 2 * k / 3), 0.0],
                             f'轮辐{xz(wx, wz)}-{k}') for k in range(3)]
            wheel_nodes.append(g.node(
                g.mesh(rot_x_90(cylinder(0.16, 0.16, 0.14, seg=16)), wheel),
                [wx, 0.16, wz], f'轮{xz(wx, wz)}', children=spokes))
    # 动画：绕 -Z 整圈（4 关键帧 0 / -120° / -240° / -360°，一圈 0.86s ≈ 1.16 转/秒，
    #       匹配 1.17 m/s 车速与 R=0.16 m 轮半径）。
    # ⚠ 方向铁律（2026-10-17 用户实测「轮子方向不正常」修正）：前进 +X、轮轴 +Z 的右手系里，
    #   正确滚动是绕 **-Z** 旋转（接触点速度 = v_center + ω×r = 0 → ω_z<0）；
    #   旧版「绕 +Z 半圈」= 轮子倒转。整圈首尾恒等（q(-360°)=(0,0,0,-1) 与 identity 同姿态）
    #   → REPEAT 无缝；中间两帧把旋转方向钉死（只有 0/180° 两帧时 slerp 方向二义）。
    #   相邻关键帧点积均 = 0.5 > 0，slerp 全程走短弧、方向一致。
    times = (0.0, 0.287, 0.573, 0.86)
    quats = (
        (0.0, 0.0, 0.0, 1.0),          #   0°
        (0.0, 0.0, -0.8660254, 0.5),   # -120°
        (0.0, 0.0, -0.8660254, -0.5),  # -240°
        (0.0, 0.0, 0.0, -1.0),         # -360°（与 identity 同姿态，循环无缝）
    )
    tv = struct.pack('<4f', *times)
    qv = struct.pack('<16f', *[c for q in quats for c in q])
    t_idx = g.raw_accessor(tv, 5126, 4, 'SCALAR', [0.0], [0.86])
    q_idx = g.raw_accessor(qv, 5126, 4, 'VEC4')
    channels = [{'sampler': 0, 'target': {'path': 'rotation', 'node': n}} for n in wheel_nodes]
    anims = [{'channels': channels, 'samplers': [
        {'input': t_idx, 'output': q_idx, 'interpolation': 'LINEAR'}]}]
    root = g.node(name='玉兔号', children=kids + wheel_nodes)
    total = g.save(os.path.join(ROOT, 'yutu_rover.glb'), [root], animations=anims)
    print(f'yutu_rover.glb  {total/1024:.1f} KB  nodes={len(g.nodes)} meshes={len(g.meshes)} anim_channels={len(channels)}')


def xz(x, z):
    return f'{x:+.2f},{z:+.2f}'


# ---------- 特效模型：发动机火焰 / RCS 姿控喷气 ----------
def build_flame():
    """发动机火焰锥：原点=喷口，焰柱沿 +Y（放置时 quatUpTo(喷气方向) 即对准）。
    三层锥嵌套（外焰/中焰/焰心）+ 半透明材质；运行时按油门缩放（placeModelS）。"""
    g = Glb()
    outer = g.material([1.0, 0.42, 0.10, 0.30], 0.0, 1.0)
    mid = g.material([1.0, 0.70, 0.22, 0.50], 0.0, 1.0)
    core = g.material([1.0, 0.96, 0.82, 0.85], 0.0, 1.0)
    parts = [
        g.node(g.mesh(cylinder(0.12, 1.00, 7.0, seg=18), outer), [0, 0, 0], '外焰'),
        g.node(g.mesh(cylinder(0.06, 0.58, 4.6, seg=18), mid), [0, 0, 0], '中焰'),
        g.node(g.mesh(cylinder(0.02, 0.30, 2.4, seg=16), core), [0, 0, 0], '焰心'),
    ]
    root = g.node(name='发动机火焰', children=parts)
    total = g.save(os.path.join(ROOT, 'flame.glb'), [root])
    print(f'{"flame.glb":<22s}{total/1024:6.1f} KB  nodes={len(g.nodes)} meshes={len(g.meshes)}')


def build_rcs():
    """RCS 姿控喷气：原点=喷口，喷柱沿 +Y（蓝白半透明，两级锥）。"""
    g = Glb()
    jet = g.material([0.72, 0.85, 1.0, 0.75], 0.0, 1.0)
    parts = [
        g.node(g.mesh(cylinder(0.02, 0.14, 1.4, seg=12), jet), [0, 0, 0], '喷柱'),
        g.node(g.mesh(cylinder(0.02, 0.07, 0.8, seg=12), jet), [0, 0, 0], '焰心'),
    ]
    root = g.node(name='RCS喷气', children=parts)
    total = g.save(os.path.join(ROOT, 'rcs.glb'), [root])
    print(f'{"rcs.glb":<22s}{total/1024:6.1f} KB  nodes={len(g.nodes)} meshes={len(g.meshes)}')


if __name__ == '__main__':
    build_rocket(with_boosters=True, with_fairing=True, filename='longmarch5.glb', name='长征五号')
    build_rocket(with_boosters=False, with_fairing=True, filename='longmarch5_core.glb', name='长征五号·芯级')
    build_rocket(with_boosters=False, with_fairing=False, filename='spacecraft.glb', name='探月飞船')
    build_booster()
    build_fairing()
    build_lander()
    build_rover()
    build_flame()
    build_rcs()
    print('OK ->', ROOT)
