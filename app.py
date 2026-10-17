"""山川与天宫 —— Flask 静态服务入口

纯 Flask 方案（无 Vite / 无构建）：
  - /              -> 项目根 index.html（注入 SPHERE_CESIUM_ION_TOKEN）
  - /src/...       -> 项目根 src/（浏览器原生 ESM 源码）
  - /cesium/...    -> public/cesium/（Cesium 官方构建产物 + import map）
  - 其余静态资源    -> public/（tiles / 影像等大文件）
运行：
  python app.py    # http://localhost:5008
环境变量：
  SPHERE_CESIUM_ION_TOKEN  Cesium Ion Token（注入 index.html，勿写进仓库）
"""
import base64
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from datetime import datetime

from flask import Flask, Response, abort, request, send_from_directory

ROOT = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(ROOT, 'public')

# 极简 .env 加载（KEY=VALUE 行；已存在的环境变量优先，不依赖 python-dotenv）
_env_file = os.path.join(ROOT, '.env')
if os.path.isfile(_env_file):
    with open(_env_file, encoding='utf-8') as f:
        for _line in f:
            _line = _line.strip()
            if _line and not _line.startswith('#') and '=' in _line:
                _k, _v = _line.split('=', 1)
                os.environ.setdefault(_k.strip(), _v.strip())

app = Flask(__name__, static_folder=None)  # 不挂 Flask 默认 /static，自己全路由


def render_index():
    """读 index.html 并注入 Ion Token + 资源版本号（cache-busting）。"""
    with open(os.path.join(ROOT, 'index.html'), encoding='utf-8') as f:
        html = f.read()
    token = os.environ.get('SPHERE_CESIUM_ION_TOKEN') or os.environ.get('VITE_CESIUM_ION_TOKEN', '')
    # 天地图 key（中国区高清覆盖层用；.env 的 SPHERE_TIANDITU_KEY，前端 localStorage 可覆盖）
    tianditu_key = os.environ.get('SPHERE_TIANDITU_KEY', '')
    # 资源版本号 = src/ 下所有 .js/.css 的最大 mtime（递归，含 layers/ 等子目录）：
    # 任何源码变动 → index.html 里 main.js/style.css 的 URL 自动换 ?v= →
    # 浏览器必然拉新代码。no-store 只防「本次之后新进的条目」，防不住无 header
    # 时期进来的旧缓存条目（普通重载会复用启发式缓存 → 改了像没生效）；
    # 换 URL = 换缓存键，是唯一不依赖用户硬重载的根治手段。
    stamps = []
    for dirpath, _dirs, files in os.walk(os.path.join(ROOT, 'src')):
        for name in files:
            if name.endswith(('.js', '.css')):
                try:
                    stamps.append(os.path.getmtime(os.path.join(dirpath, name)))
                except OSError:
                    pass
    # index.html 自身也计入：只改 HTML（如加坐标控件）时版本号不变会让用户误判为旧缓存。
    # 该文件走 no-store 不会被缓存，但版本号是给人看的，必须跟着一起动。
    try:
        stamps.append(os.path.getmtime(os.path.join(ROOT, 'index.html')))
    except OSError:
        pass
    build = str(int(max(stamps))) if stamps else '0'
    html = html.replace('__CESIUM_ION_TOKEN__', token).replace('__BUILD__', build)
    if '__TIANDITU_KEY__' in html:
        html = html.replace('__TIANDITU_KEY__', tianditu_key)
    # 源码/入口不走浏览器缓存：改完刷新即生效，避免旧 JS 缓存造成「改了没生效」误判
    resp = Response(html, mimetype='text/html')
    resp.headers['Cache-Control'] = 'no-store'
    return resp


@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def serve(path):
    if not path:
        return render_index()
    # 源码（ESM）
    if path.startswith('src/') and os.path.isfile(os.path.join(ROOT, path)):
        resp = send_from_directory(ROOT, path)
        resp.headers['Cache-Control'] = 'no-store'
        return resp
    # public 静态资源（vendor/cesium/ tiles/ 影像…）
    pub = os.path.join(PUBLIC, path)
    if os.path.isfile(pub):
        return send_from_directory(PUBLIC, path)
    # 本地瓦片缺失 → 统一代理缓存（本地优先、在线兜底、成功后回写本地）：
    # 任意在线源（esri/eox/gibs/tianditu）都走「本地有则直出、无则代理上游、
    # 成功后落盘逐步本地化」；上游不可达返回 1×1 透明 PNG（200），杜绝
    # Cesium 控制台 "Failed to obtain image tile" 报错。esri 沿用双主机兜底逻辑。
    if path.startswith('tiles/'):
        return proxy_tile_cache(path)
    # 其余静态资源目录下的缺失文件直接 404（vendor/ = cesium 构建产物 + cesium-navigation）
    if path.startswith('vendor/'):
        abort(404)
    # API 路径不做 SPA fallback（否则前端 fetch 拿到 HTML 会 JSON 解析失败）
    if path.startswith('api/'):
        abort(404)
    # SPA fallback
    return render_index()


# 1×1 透明 PNG（上游不可达时返回，避免瓦片请求报错）
_TRANSPARENT_PNG = base64.b64decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
)
# Esri World Imagery 瓦片地址模板（注意顺序为 z / y / x；两个主机互为备份）
# 顺序即优先级：server. 与 tools/download-satellite-tiles.mjs 一致（实测可达），
# services. 放第二位兜底（部分网络下前者不可达时再试）
_ESRI_TILE = (
    'https://{host}/ArcGIS/rest/services/'
    'World_Imagery/MapServer/tile/{z}/{y}/{x}'
)
_ESRI_HOSTS = ('server.arcgisonline.com', 'services.arcgisonline.com')
_PROXY_FAIL_COUNT = {'n': 0}  # 失败计数：控制台只打前 20 条 + 之后每 100 条，避免刷屏


def proxy_esri_tile(path):
    # path 形如 tiles/esri/{z}/{x}/{y}.jpg
    parts = path.split('/')
    if len(parts) != 5 or not parts[4].endswith('.jpg'):
        abort(404)
    z, x, y = parts[2], parts[3], parts[4][:-4]
    last_err = None
    for host in _ESRI_HOSTS:
        url = _ESRI_TILE.format(host=host, z=z, y=y, x=x)
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Sphere/1.0'})
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = resp.read()
            # 回写本地：把看过的区域逐步本地化（后续直接走本地、无需联网）
            try:
                local = os.path.join(PUBLIC, path)
                os.makedirs(os.path.dirname(local), exist_ok=True)
                with open(local, 'wb') as fh:
                    fh.write(data)
                _scan_invalidate()
            except OSError:
                pass
            return Response(data, mimetype='image/jpeg')
        except Exception as e:  # 换下一个主机重试
            last_err = e
            continue
    # 全部主机失败：打印真实原因到 Flask 控制台（便于本机诊断网络/SSL），
    # 同时返回 1×1 透明 PNG（HTTP 200）避免 Cesium "Failed to obtain image tile" 报错
    _PROXY_FAIL_COUNT['n'] += 1
    cnt = _PROXY_FAIL_COUNT['n']
    if cnt <= 20 or cnt % 100 == 0:
        print(
            f'[esri-proxy] {path} 失败({cnt}): '
            f'{type(last_err).__name__}: {last_err}',
            flush=True,
        )
    return Response(_TRANSPARENT_PNG, mimetype='image/png')


# =====================================================================
# 在线瓦片统一代理缓存（本地优先 / 在线兜底 / 成功后回写本地）
# ---------------------------------------------------------------------
# 除 esri（双主机兜底，见上方 proxy_esri_tile）外，EOX / GIBS /
# 天地图 等在线源原本由浏览器直连上游、无缓存。现统一改为：
#   前端源 URL 指向本地端点 /tiles/<源>/...，命中本地直出（send_from_directory），
#   缺失则本函数代理上游、成功后回写 public/tiles/<源>/...，逐步本地化。
# 因为是逐请求「顺手回写」，浏览器只等一次响应，天然不阻塞渲染。
# =====================================================================

_PROXY_FAIL = {'n': 0}

# scan 结果缓存：遍历 30 万+ 瓦片文件实测 ~2.3s/次，不能每次请求都全盘 walk。
# 策略：TTL 30s + 代理回写时 bump 版本号（浏览即缓存后近乎准实时刷新）。
_SCAN_CACHE = {'at': 0.0, 'ver': -1, 'data': None}
_SCAN_TTL = 30.0
_SCAN_VER = {'v': 0}


def _scan_invalidate():
    """代理成功回写瓦片后调用：让 /api/downloader/scan 立即重算。"""
    _SCAN_VER['v'] += 1


def _log_proxy_fail(path, err):
    _PROXY_FAIL['n'] += 1
    cnt = _PROXY_FAIL['n']
    if cnt <= 20 or cnt % 100 == 0:
        print(f'[tile-proxy] {path} 失败({cnt}): {type(err).__name__}: {err}', flush=True)


def _fetch_bytes(url, timeout=20, extra_headers=None):
    headers = {'User-Agent': 'Sphere/1.0'}
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def _transparent_response():
    return Response(_TRANSPARENT_PNG, mimetype='image/png')


def _proxy_fetch_and_cache(path, url, mimetype):
    """拉取上游瓦片并回写本地；成功返回 bytes，失败返回 None（调用方回透明 PNG）。"""
    try:
        data = _fetch_bytes(url)
    except Exception as e:
        _log_proxy_fail(path, e)
        return None
    try:
        local = os.path.join(PUBLIC, path)
        os.makedirs(os.path.dirname(local), exist_ok=True)
        with open(local, 'wb') as fh:
            fh.write(data)
        _scan_invalidate()  # 新瓦片落盘 → scan 缓存失效，下次统计即准实时
    except OSError:
        pass  # 磁盘写入失败不致命：本次仍返回上游数据，仅不本地化
    return data


def proxy_tile_cache(path):
    """tiles/<源>/... 缺失瓦片的分派入口（本地文件已在 serve() 中优先直出）。"""
    parts = path.split('/')
    if len(parts) < 3 or parts[0] != 'tiles':
        abort(404)
    source = parts[1]
    if source == 'esri':
        return proxy_esri_tile(path)
    if source == 'eox':
        return proxy_eox_tile(path)
    if source == 'gibs':
        return proxy_gibs_tile(path)
    if source == 'tianditu':
        return proxy_tianditu_tile(path)
    if source == 'terrain':
        return proxy_terrain_tile(path)
    if source == 'lunar':
        return proxy_lunar_tile(path)
    abort(404)


# EOX Sentinel-2 无云合成（3857 XYZ，注意顺序为 z/y/x）
_EOX_TILE = 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/{z}/{y}/{x}.jpg'


def proxy_eox_tile(path):
    # tiles/eox/{z}/{x}/{y}.jpg
    parts = path.split('/')
    if len(parts) != 5 or not parts[4].endswith('.jpg'):
        abort(404)
    z, x, y = parts[2], parts[3], parts[4][:-4]
    url = _EOX_TILE.format(z=z, y=y, x=x)
    data = _proxy_fetch_and_cache(path, url, 'image/jpeg')
    if data is None:
        return _transparent_response()
    return Response(data, mimetype='image/jpeg')


# NASA GIBS Blue Marble（EPSG:4326 非二分网格，源 URL 顺序为 level/row/col）
_GIBS_PREFIX = 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/BlueMarble_NextGeneration/default/500m/'


def proxy_gibs_tile(path):
    # tiles/gibs/{g}/{r}/{c}.jpeg
    parts = path.split('/')
    if len(parts) != 5 or not parts[4].endswith('.jpeg'):
        abort(404)
    g, r, c = parts[2], parts[3], parts[4][:-5]
    url = f'{_GIBS_PREFIX}{g}/{r}/{c}.jpeg'
    data = _proxy_fetch_and_cache(path, url, 'image/jpeg')
    if data is None:
        return _transparent_response()
    return Response(data, mimetype='image/jpeg')


def proxy_tianditu_tile(path):
    # tiles/tianditu/{s}/{z}/{x}/{y}.jpg?tk=...
    parts = path.split('/')
    if len(parts) != 6 or not parts[5].endswith('.jpg'):
        abort(404)
    s, z, x, y = parts[2], parts[3], parts[4], parts[5][:-4]
    key = request.args.get('tk') or os.environ.get('SPHERE_TIANDITU_KEY', '')
    if not key:
        return _transparent_response()
    url = ('https://t%s.tianditu.gov.cn/DataServer?T=img_w&x=%s&y=%s&l=%s&tk=%s'
           % (s, x, y, z, urllib.parse.quote(key, safe='')))
    # ⚠ 天地图 key 权限类型为「浏览器端」时（code 301012），必须携带浏览器
    # UA + Referer 才放行；裸服务端请求一律 403。
    try:
        data = _fetch_bytes(url, extra_headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                          '(KHTML, like Gecko) Chrome/126.0 Safari/537.36',
            'Referer': 'http://127.0.0.1:5008/',
        })
    except Exception as e:
        # 天地图失败不回透明 PNG：透明瓦片会在覆盖层区域形成遮住底图的
        # 「黑块」（用户实测 2026-10-16）。回 404 让 Cesium 跳过该瓦片、
        # 透出下层底图，同时前端 errorEvent 计数提示「检查 key」。
        _log_proxy_fail(path, e)
        abort(404)
    try:
        local = os.path.join(PUBLIC, path)
        os.makedirs(os.path.dirname(local), exist_ok=True)
        with open(local, 'wb') as fh:
            fh.write(data)
        _scan_invalidate()
    except OSError:
        pass  # 磁盘写入失败不致命：本次仍返回上游数据，仅不本地化
    return Response(data, mimetype='image/jpeg')


# AWS Terrain Tiles（Terrarium 编码高程；全球公共数据集，单一源，z/x/y 顺序）
_AWS_TERRAIN = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'


def proxy_terrain_tile(path):
    # tiles/terrain/{z}/{x}/{y}.png。
    # ⚠ 地形与影像的失败语义不同：缺失/上游失败必须回 404（terrarium-provider
    # 收到 404 会回退父级瓦片）；不能回透明 PNG——透明图会被当成「0 高程瓦片」
    # 把该区域静默压平。
    parts = path.split('/')
    if len(parts) != 5 or not parts[4].endswith('.png'):
        abort(404)
    z, x, y = parts[2], parts[3], parts[4][:-4]
    url = _AWS_TERRAIN.format(z=z, x=x, y=y)
    data = _proxy_fetch_and_cache(path, url, 'image/png')
    if data is None:
        abort(404)  # 交回 provider 做父级回退，绝不回透明瓦片
    return Response(data, mimetype='image/png')


# =====================================================================
# 月面高清瓦片（NASA Moon Trek 官方 RESTful WMTS）
# ---------------------------------------------------------------------
# 本地 public/lunar/lunar_wac.jpg 只有 8192×4096（≈660 m/像素），近距离看不出
# 月面细节；LRO WAC 全局镶嵌 303 ppd ≈ 100 m/像素，量级提升 ~6.6×。
# 官方 apidoc（trek.nasa.gov/tiles/apidoc/trekAPI.html?body=moon）：
#   .../1.0.0/{Style}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.jpg
#   覆盖全球的产品：第 0 级 = 2 列 × 1 行（与 Cesium GeographicTilingScheme 一致）。
# 失败语义：回 1×1 透明 PNG（200）——该层叠在本地底图之上，透明即「透出本地底图」，
#           同时避免 Cesium "Failed to obtain image tile" 报错刷屏。
# =====================================================================
_LUNAR_TILE = (
    'https://trek.nasa.gov/tiles/Moon/EQ/'
    'LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/{z}/{y}/{x}.jpg'
)


def proxy_lunar_tile(path):
    # tiles/lunar/{z}/{x}/{y}.jpg（前端 URL 用 Cesium 约定的 z/x/y；上游是 z/y/x）
    parts = path.split('/')
    if len(parts) != 5 or not parts[4].endswith('.jpg'):
        abort(404)
    z, x, y = parts[2], parts[3], parts[4][:-4]
    # 越界保护：第 0 级只有 2 列 1 行，深层列数 = 2^(z+1)、行数 = 2^z
    try:
        zi = int(z)
        if int(y) >= 2 ** zi or int(x) >= 2 ** (zi + 1) or zi > 12:
            abort(404)
    except ValueError:
        abort(404)
    url = _LUNAR_TILE.format(z=z, y=y, x=x)
    try:
        data = _fetch_bytes(url, timeout=25, extra_headers={
            # 上游对纯服务端 UA 有时会返回非图片内容，带浏览器 UA 更稳
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                          '(KHTML, like Gecko) Chrome/126.0 Safari/537.36',
            'Referer': 'https://trek.nasa.gov/moon/',
        })
    except Exception as e:
        _log_proxy_fail(path, e)
        return _transparent_response()
    if not data or data[:2] != b'\xff\xd8':      # 非 JPEG（HTML 错误页等）→ 当作失败
        _log_proxy_fail(path, ValueError('non-jpeg response'))
        return _transparent_response()
    try:
        local = os.path.join(PUBLIC, path)
        os.makedirs(os.path.dirname(local), exist_ok=True)
        with open(local, 'wb') as fh:
            fh.write(data)
        _scan_invalidate()
    except OSError:
        pass
    return Response(data, mimetype='image/jpeg')


# =====================================================================
# 资源下载器（GUI 配置页 /downloader 的后端）
# ---------------------------------------------------------------------
# 设计：GUI 只做「参数收集 + 状态展示」，真正的下载逻辑一律复用 tools/ 下
# 已有 CLI 脚本（satellite: Node / terrain: Python / lunar: Python），
# 本模块通过 subprocess 起进程、读 stdout 逐行进日志队列、正则提取进度，
# 前端 1s 轮询 /api/downloader/state。同一时刻只允许一个任务在跑。
# =====================================================================

_MANAGED_NODE = 'C:/Users/KaishengMao/.workbuddy/binaries/node/versions/22.22.2-6/node.exe'
_MANAGED_PY = 'C:/Users/KaishengMao/.workbuddy/binaries/python/versions/3.13.12/python.exe'


def _node_exe():
    return shutil.which('node') or (_MANAGED_NODE if os.path.isfile(_MANAGED_NODE) else 'node')


def _py_exe():
    # 地形/月球脚本用项目 venv（PIL/rasterio 装在那里）
    venv_py = os.path.join(ROOT, '.venv', 'Scripts', 'python.exe')
    if os.path.isfile(venv_py):
        return venv_py
    return sys.executable


# 月球源数据（public/lunar/ 下的 NASA/USGS 原始文件，转换脚本的输入）
_LUNAR_SOURCES = {
    'lunar-image': os.path.join(
        PUBLIC, 'lunar', 'Lunar_LRO_LROC-WAC_Mosaic_global_100m_June2013.tif'),
    'lunar-dem': os.path.join(
        PUBLIC, 'lunar', 'Lunar_LRO_LOLA_Global_LDEM_118m_Mar2014.tif'),
}

# 并发下载进程池（用户定版：影像与高程可各跑各的，互不干扰）
_DL_MAX_JOBS = 2

_dl_lock = threading.Lock()
_dl_jobs = {}          # job_id -> job dict（含运行中与近期结束的，供前端按 key 认领）
_dl_seq = {'n': 0}
_DL_LOGS = deque(maxlen=500)   # 全局日志（downloader.html 页面用）
_dl_progress_re = [
    # 通用瓦片下载器 tools/download-tiles.mjs：1234/5678 (新 1 · 跳过 0 · 失败 0) · 2.3/s · 剩 1m20s
    re.compile(r'(\d+)/(\d+)\s*\(新\s*(\d+)\s*·\s*跳过\s*(\d+)\s*·\s*失败\s*(\d+)\)'
               r'(?:\s*·\s*([\d.]+)/s)?(?:\s*·\s*剩\s*(.+?))?\s*$'),
    # 卫星：\r1234/5678 (✓1 新 ⏭0 🗙0) · 2.3/s · 剩 1m20s
    re.compile(r'(\d+)/(\d+)\s*\(✓(\d+)\s*新\s*⏭(\d+)\s*🗙(\d+)\)\s*·\s*([\d.]+)/s\s*·\s*剩\s*(.+?)\s*$'),
    # 地形：\r1234/5678  (新 12 · 跳过 100 · 失败 0) · 3.1 张/秒 · 剩 4m5s
    re.compile(r'(\d+)/(\d+)\s*\(新\s*(\d+)\s*·\s*跳过\s*(\d+)\s*·\s*失败\s*(\d+)\)'),
]


def _dl_log(text, tag='out'):
    ts = datetime.now().strftime('%H:%M:%S')
    with _dl_lock:
        _DL_LOGS.append({'t': ts, 'tag': tag, 'text': text})


def _dl_parse_progress(line, job):
    for rx in _dl_progress_re:
        m = rx.search(line)
        if m:
            done, total, ok, skip, fail = (int(m.group(i)) for i in range(1, 6))
            extra = {'rate': None, 'eta': None}
            if m.lastindex and m.lastindex >= 7:
                extra['rate'] = m.group(6)
                extra['eta'] = m.group(m.lastindex)
            with _dl_lock:
                job['progress'] = {
                    'done': done, 'total': total, 'ok': ok, 'skip': skip,
                    'fail': fail, 'rate': extra['rate'], 'eta': extra['eta'],
                    'pct': round(done / total * 100, 2) if total else None,
                }
            return


def _dl_reader(proc, job):
    # stdout/stderr 合并；\r 覆盖型进度行按 \r 拆成多条，避免一条日志无限变长
    for raw in iter(proc.stdout.readline, ''):
        for seg in raw.rstrip('\n').split('\r'):
            seg = seg.strip()
            if not seg:
                continue
            _dl_log(seg)
            _dl_parse_progress(seg, job)
    proc.stdout.close()
    proc.wait()
    with _dl_lock:
        job['exitCode'] = proc.returncode
        job['finishedAt'] = time.time()
        job['proc'] = None
    _dl_log(f'—— 任务#{job["id"]}（{job["label"]}）进程结束，退出码 {proc.returncode} ——', tag='end')


def _dl_build_argv(kind, p):
    """按任务类型组装命令行。p 为前端传来的参数 dict。"""
    if kind == 'satellite':
        argv = [_node_exe(), 'tools/download-satellite-tiles.mjs']
        mode = p.get('mode', 'china')
        if mode == 'china':
            argv += ['--region', 'china']
        elif mode == 'places':
            argv += ['--region', 'places']
        elif mode == 'cities':
            argv += ['--region', 'cities']
        elif mode == 'bbox':
            bbox = p.get('bbox')
            if not (isinstance(bbox, list) and len(bbox) == 4):
                raise ValueError('自定义范围需要 4 个数字 [西, 南, 东, 北]')
            w, s, e, n = (float(v) for v in bbox)
            for v, lo, hi, name in ((w, -180, 180, '西经'), (e, -180, 180, '东经'),
                                    (s, -90, 90, '南纬'), (n, -90, 90, '北纬')):
                if not (lo <= v <= hi):
                    raise ValueError(f'{name}越界：{v}')
            if w >= e or s >= n:
                raise ValueError('范围不合法：西<东、南<北 需同时满足')
            zmin, zmax = int(p.get('minZ', 0)), int(p.get('maxZ', 5))
            if not (0 <= zmin <= zmax <= 18):
                raise ValueError('层级需满足 0 ≤ minZ ≤ maxZ ≤ 18')
            argv += ['--bbox', f'{w},{s},{e},{n}',
                     '--min-z', str(zmin), '--max-z', str(zmax)]
        else:
            raise ValueError(f'未知范围模式：{mode}')
        return argv

    if kind == 'terrain':
        argv = [_py_exe(), 'tools/download_terrain_tiles.py']
        profile = p.get('profile', 'full')
        if profile == 'quick':
            argv += ['--quick']
        elif profile == 'china':
            argv += ['--region', 'china']
        elif profile == 'places':
            argv += ['--region', 'places']
        elif profile == 'full':
            pass
        else:
            raise ValueError(f'未知地形方案：{profile}')
        if p.get('force'):
            argv += ['--force']
        return argv

    if kind in ('lunar-image', 'lunar-dem'):
        src = _LUNAR_SOURCES[kind]
        if not os.path.isfile(src):
            raise ValueError(f'缺少源数据：{src}（请先把 NASA/USGS 原始文件放进 public/lunar/）')
        script = 'tools/convert_lunar.py' if kind == 'lunar-image' else 'tools/convert_lunar_dem.py'
        return [_py_exe(), script]

    if kind == 'tiles':
        # 通用瓦片下载（tools/download-tiles.mjs，走本地代理端点，覆盖 esri/eox/
        # gibs/tianditu/terrain 全部图源；与「浏览即缓存」落盘路径一致）
        source = p.get('source')
        maxz_by_src = {'esri': 19, 'eox': 18, 'tianditu': 18, 'gibs': 7, 'terrain': 15}
        if source not in maxz_by_src:
            raise ValueError(f'未知图源：{source}')
        zmin, zmax = int(p.get('minZ', 0)), int(p.get('maxZ', 5))
        if not (0 <= zmin <= zmax <= maxz_by_src[source]):
            raise ValueError(f'层级需满足 0 ≤ minZ ≤ maxZ ≤ {maxz_by_src[source]}（{source}）')
        argv = [_node_exe(), 'tools/download-tiles.mjs',
                '--source', source, '--min-z', str(zmin), '--max-z', str(zmax)]
        bbox = p.get('bbox')
        if bbox:
            if not (isinstance(bbox, list) and len(bbox) == 4):
                raise ValueError('自定义范围需要 4 个数字 [西, 南, 东, 北]')
            w, s, e, n = (float(v) for v in bbox)
            for v, lo, hi, name in ((w, -180, 180, '西经'), (e, -180, 180, '东经'),
                                    (s, -90, 90, '南纬'), (n, -90, 90, '北纬')):
                if not (lo <= v <= hi):
                    raise ValueError(f'{name}越界：{v}')
            if w >= e or s >= n:
                raise ValueError('范围不合法：西<东、南<北 需同时满足')
            argv += ['--bbox', f'{w},{s},{e},{n}']
        # 范围子集：full=全部（全球/bbox）；points=左侧栏标注点周边（半径 radiusKm）
        mode = p.get('mode', 'full')
        if mode == 'points':
            # 与 bbox 同时给出时按交集裁剪（天地图只有中国区，落在区外的点自动剔除）
            rk = p.get('radiusKm', 25)
            try:
                rk = float(rk)
            except (TypeError, ValueError):
                raise ValueError('radiusKm 需为数字')
            if not (0 < rk <= 500):
                raise ValueError('radiusKm 需在 (0, 500] km 之间')
            argv += ['--points', '--radius-km', f'{rk:g}']
            if p.get('withLines'):
                argv += ['--with-lines']   # 线路顶点也算兴趣点
        elif mode != 'full':
            raise ValueError(f'未知下载范围：{mode}')
        if p.get('force'):
            argv += ['--force']
        return argv

    raise ValueError(f'未知任务类型：{kind}')


_DL_LABELS = {
    'tiles': '图源瓦片下载',
    'satellite': '卫星影像瓦片',
    'terrain': '地形瓦片',
    'lunar-image': '月球影像转换（WAC TIF → JPG）',
    'lunar-dem': '月球地形转换（LOLA DEM → Terrarium PNG）',
}


@app.route('/downloader')
def downloader_page():
    with open(os.path.join(PUBLIC, 'downloader.html'), encoding='utf-8') as f:
        html = f.read()
    resp = Response(html, mimetype='text/html')
    resp.headers['Cache-Control'] = 'no-store'
    return resp


@app.route('/api/downloader/state')
def downloader_state():
    with _dl_lock:
        jobs = []
        for j in _dl_jobs.values():
            proc = j['proc']
            running = proc is not None and proc.poll() is None
            jobs.append({
                'id': j['id'], 'key': j['key'], 'kind': j['kind'], 'label': j['label'],
                'running': running,
                'startedAt': j['startedAt'],
                'elapsed': round(time.time() - j['startedAt'], 1) if j['startedAt'] and running else None,
                'exitCode': j['exitCode'],
                'progress': j['progress'],
            })
        logs = list(_DL_LOGS)[-160:]
    jobs.sort(key=lambda x: x['startedAt'])
    # primary = 第一个运行中的任务（无则取最近一个），兼容旧版单任务字段
    primary = next((j for j in jobs if j['running']), jobs[-1] if jobs else None)
    return {
        'running': any(j['running'] for j in jobs),
        'kind': primary['kind'] if primary else None,
        'label': primary['label'] if primary else '',
        'startedAt': primary['startedAt'] if primary else 0.0,
        'elapsed': primary['elapsed'] if primary else None,
        'exitCode': primary['exitCode'] if primary else None,
        'progress': primary['progress'] if primary else None,
        'logs': logs,
        'jobs': jobs,
        'maxJobs': _DL_MAX_JOBS,
    }


@app.route('/api/downloader/start', methods=['POST'])
def downloader_start():
    payload = request.get_json(silent=True) or {}
    kind = payload.get('kind')
    params = payload.get('params') or {}
    key = payload.get('key') or params.get('key')    # 前端任务标识（用于把进度回写到对应档位行）
    label = payload.get('label') or _DL_LABELS.get(kind, kind)
    with _dl_lock:
        running = [j for j in _dl_jobs.values()
                   if j['proc'] is not None and j['proc'].poll() is None]
        if len(running) >= _DL_MAX_JOBS:
            return {'error': f'并发任务已满（{_DL_MAX_JOBS} 个在跑），请等待或取消'}, 409
        # 顺手清理已结束超 10 分钟的旧任务记录，防止字典无限增长
        now = time.time()
        for jid in [jid for jid, j in _dl_jobs.items()
                    if j['proc'] is None and j['finishedAt'] and now - j['finishedAt'] > 600]:
            del _dl_jobs[jid]
        try:
            argv = _dl_build_argv(kind, params)
        except ValueError as e:
            return {'error': str(e)}, 400
        _dl_seq['n'] += 1
        job = {
            'id': _dl_seq['n'], 'key': key, 'kind': kind, 'label': label,
            'proc': None, 'startedAt': time.time(), 'finishedAt': 0.0,
            'exitCode': None, 'progress': None,
        }
        _dl_jobs[job['id']] = job
    _dl_log('$ ' + ' '.join(argv) + f'  （任务#{job["id"]} {label}）', tag='cmd')
    try:
        proc = subprocess.Popen(
            argv, cwd=ROOT,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            bufsize=1, text=True, encoding='utf-8', errors='replace',
            creationflags=getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0),
        )
    except Exception as e:
        with _dl_lock:
            job['proc'] = None
            job['exitCode'] = -1
            job['finishedAt'] = time.time()
        _dl_log(f'启动失败：{type(e).__name__}: {e}', tag='err')
        return {'error': f'启动失败：{e}'}, 500
    with _dl_lock:
        job['proc'] = proc
    threading.Thread(target=_dl_reader, args=(proc, job), daemon=True).start()
    return {'ok': True, 'id': job['id'], 'label': label}


@app.route('/api/downloader/cancel', methods=['POST'])
def downloader_cancel():
    payload = request.get_json(silent=True) or {}
    jid = payload.get('id')
    key = payload.get('key')
    with _dl_lock:
        targets = [j for j in _dl_jobs.values()
                   if j['proc'] is not None and j['proc'].poll() is None
                   and ((jid is None and key is None) or j['id'] == jid
                        or (key is not None and j['key'] == key))]
    if not targets:
        return {'ok': False, 'error': '当前没有运行中的任务'}
    for job in targets:
        proc = job['proc']
        # Windows：先 CTRL_BREAK 进程组（脚本可感知后自行清理），再退化为 terminate
        try:
            os.kill(proc.pid, signal.CTRL_BREAK_EVENT)
        except Exception:
            try:
                proc.terminate()
            except Exception:
                pass
        _dl_log(f'—— 任务#{job["id"]}（{job["label"]}）已发送取消信号 ——', tag='cmd')

        def _force_kill(proc=proc):
            time.sleep(3)
            if proc.poll() is None:
                try:
                    proc.kill()
                except Exception:
                    pass

        threading.Thread(target=_force_kill, daemon=True).start()
    return {'ok': True, 'cancelled': len(targets)}


_PLAN_CACHE = {}


@app.route('/api/downloader/plan', methods=['POST'])
def downloader_plan():
    """只数不下载：调下载脚本 --dry-run，返回该范围下的真实瓦片数。

    仅用于「标注点子集」这类无法用公式秒算的范围；全球/大 bbox 的完整枚举
    会生成百万级任务对象（内存吃不消），前端那里仍按公式估算即可。
    """
    body = request.get_json(silent=True) or {}
    kind = body.get('kind', 'tiles')
    params = body.get('params') or {}
    if kind != 'tiles' or params.get('mode') != 'points':
        return {'error': 'plan 只支持 tiles 的标注点子集（mode=points）'}, 400
    try:
        argv = _dl_build_argv(kind, params)
    except Exception as e:                      # noqa: BLE001 - 参数错误统一回 400
        return {'error': str(e)}, 400
    argv += ['--dry-run']
    key = ' '.join(argv)
    if key in _PLAN_CACHE:
        return _PLAN_CACHE[key]
    try:
        r = subprocess.run(argv, cwd=ROOT, capture_output=True, timeout=180,
                           encoding='utf-8', errors='replace')
    except subprocess.TimeoutExpired:
        return {'error': '枚举超时（>180s）'}, 504
    for line in (r.stdout or '').splitlines():
        if line.startswith('PLAN '):
            try:
                data = json.loads(line[5:])
            except ValueError:
                continue
            _PLAN_CACHE[key] = data
            return data
    return {'error': '脚本未返回 PLAN', 'stderr': (r.stderr or '')[-400:]}, 500


@app.route('/api/downloader/scan')
def downloader_scan():
    """统计 public/tiles 下已下载的瓦片数量与体积，以及月球/火星产物。

    缓存策略（2026-10-16）：全盘遍历 30 万+ 文件实测 ~2.3s/次，故加
    TTL 30s + 版本号双保险；代理回写瓦片会 bump 版本号立即使缓存失效，
    做到「浏览即缓存」后统计近乎准实时，同时消除轮询遍历开销。
    """
    import time as _time
    now = _time.time()
    if (_SCAN_CACHE['data'] is not None
            and _SCAN_CACHE['ver'] == _SCAN_VER['v']
            and now - _SCAN_CACHE['at'] < _SCAN_TTL):
        return _SCAN_CACHE['data']

    def scan_dir(base, ext):
        out = {'total': 0, 'bytes': 0, 'levels': {}}
        if not os.path.isdir(base):
            return out
        for z in sorted(os.listdir(base), key=lambda s: (len(s), s)):
            zdir = os.path.join(base, z)
            if not os.path.isdir(zdir):
                continue
            cnt, size = 0, 0
            for root, _dirs, files in os.walk(zdir):
                for f in files:
                    if f.endswith(ext):
                        cnt += 1
                        try:
                            size += os.path.getsize(os.path.join(root, f))
                        except OSError:
                            pass
            if cnt:
                out['levels'][z] = {'count': cnt, 'bytes': size}
                out['total'] += cnt
                out['bytes'] += size
        return out

    lunar = {}
    for name, rel in (('lunar_wac.jpg', os.path.join('lunar', 'lunar_wac.jpg')),
                      ('lunar_dem.png', os.path.join('lunar', 'lunar_dem.png')),
                      ('bluemarble.jpg', os.path.join('patch', 'bluemarble.jpg'))):
        fp = os.path.join(PUBLIC, rel)
        if os.path.isfile(fp):
            lunar[name] = os.path.getsize(fp)
    result = {
        'esri': scan_dir(os.path.join(PUBLIC, 'tiles', 'esri'), '.jpg'),
        'eox': scan_dir(os.path.join(PUBLIC, 'tiles', 'eox'), '.jpg'),
        'gibs': scan_dir(os.path.join(PUBLIC, 'tiles', 'gibs'), '.jpeg'),
        'tianditu': scan_dir(os.path.join(PUBLIC, 'tiles', 'tianditu'), '.jpg'),
        'terrain': scan_dir(os.path.join(PUBLIC, 'tiles', 'terrain'), '.png'),
        'lunar': lunar,
        'lunarSources': {k: os.path.isfile(v) for k, v in _LUNAR_SOURCES.items()},
    }
    _SCAN_CACHE['at'] = now
    _SCAN_CACHE['ver'] = _SCAN_VER['v']
    _SCAN_CACHE['data'] = result
    return result


if __name__ == '__main__':
    # threaded=True：Cesium 会并发请求几十个瓦片，单线程串行响应会导致整体加载迟钝
    app.run(host='0.0.0.0', port=5008, threaded=True)
