#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
PMTiles Studio —— OSM 离线瓦片「可视化提取工作台」

独立 Flask 服务（默认 127.0.0.1:5011），让用户可以：
  ① 指定本地 .osm.pbf 路径
  ② 手动录入（或 JSON 导入）若干「城市 = 名称 + 四至 bbox + 层级」
  ③ 一键抽取成 PMTiles 单文件
  ④ 实时观察进度（SSE 流式：整体进度 / 逐城状态 / 原始日志）

实现策略：本服务**不修改**核心脚本 pbf-to-pmtiles.py，而是把它作为子进程调用，
把 stdout 行实时转发成进度事件。cwd 设为项目根，使核心脚本内置的 osmium.exe
相对路径可以解析。

数据 © OpenStreetMap contributors (ODbL)
"""
import json
import os
import sys
import time
import uuid
import shutil
import tempfile
import contextlib
import subprocess
import threading
import datetime

from flask import Flask, request, Response, send_from_directory, jsonify

# ----------------------------- 路径 -----------------------------
HERE = os.path.dirname(os.path.abspath(__file__))                 # tools/osm-pmtiles-pipeline
PIPELINE = HERE
ROOT = os.path.dirname(os.path.dirname(HERE))                     # sphere 项目根
CORE_SCRIPT = os.path.join(PIPELINE, 'pbf-to-pmtiles.py')
MERGE_SCRIPT = os.path.join(PIPELINE, 'merge-manifests.py')
DEFAULT_OUT = os.path.join(ROOT, 'public', 'data', 'tiles', 'osm', 'pmtiles')
STUDIO_MANIFEST = 'm_studio.json'   # 工作室抽取结果累积清单，供 merge-manifests 识别并入
PORT = 5011

app = Flask(__name__)

# ----------------------------- 任务状态 -----------------------------
# jobs[job_id] = {
#   status: 'queued'|'running'|'done'|'error'|'stopped',
#   pbf, outdir, started, finished, total, done, osmium:bool|None,
#   cities: [{name, status, tiles, mb, reason}],   # 完成后由结果 JSON 填充
#   log: [str],
#   q: queue.Queue,            # SSE 事件队列
#   proc: subprocess.Popen|None,
# }
jobs = {}
jobs_lock = threading.Lock()


# ----------------------------- osmium 探测 -----------------------------
def find_osmium():
    candidates = [
        os.path.join(ROOT, 'tools', 'osmium-bin', 'Library', 'bin', 'osmium.exe'),
        'osmium',
    ]
    for p in candidates:
        try:
            r = subprocess.run([p, '--version'], capture_output=True, timeout=15)
            if r.returncode == 0:
                return p
        except Exception:
            pass
    return None


# ----------------------------- 行解析 → 进度 -----------------------------
def _classify(line, job):
    """把核心脚本的一行 stdout 解析成结构化进度，更新 job。返回是否更新了整体计数。"""
    s = line.strip()
    if not s:
        return False
    # 任务开始：=== <pbf>: N 城 ===
    if s.startswith('===') and '城' in s:
        try:
            n = int(s.split(':')[-1].replace('城', '').replace('=', '').strip())
            job['total'] = n
        except Exception:
            pass
        return False
    # 断点续跑
    if '断点续跑' in s or '已存在，跳过' in s:
        job['resumed'] = True
        return False
    # osmium 缺失警告
    if '未找到 osmium-tool' in s:
        job['osmium'] = False
        return False
    if 'osmium-tool:' in s and '启用' in s:
        job['osmium'] = True
        return False
    # 逐城完成：✓ 名称 1234 瓦片  12.3 MB（须含「瓦片」，排除 ✓ osmium-tool / ✓ Hilbert 自检行）
    if s.startswith('✓') and '瓦片' in s:
        job['done'] += 1
        return True
    # 逐城空：✗ 名称 EMPTY
    if s.startswith('✗') and 'EMPTY' in s:
        job['done'] += 1
        return True
    return False


# ----------------------------- 并入前端 manifest -----------------------------
def _save_studio_manifest(outdir, res):
    """把本次抽取结果累积写入 outdir/m_studio.json（与已有合并，新结果覆盖同名项）。
    merge-manifests.py 会自动扫描此文件，从而把工作室城市并入前端 manifest.json。"""
    path = os.path.join(outdir, STUDIO_MANIFEST)
    existing = {}
    if os.path.exists(path):
        try:
            existing = json.load(open(path, encoding='utf-8'))
        except Exception:
            existing = {}
    if not isinstance(existing, dict):
        existing = {}
    for name, rec in (res or {}).items():
        if isinstance(rec, dict) and rec.get('ok'):
            existing[name] = rec
    json.dump(existing, open(path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    return len(existing)


YFLIP_SCRIPT = os.path.join(PIPELINE, 'batch-fix-yflip.py')

# 离线工具链的额外依赖：.venv 里没装 pmtiles（fix-y-flip.py 裸 import），
# 平时跑批靠 uv 临时带。工具页照抄这条命令，否则点「翻转修复」会在 import 阶段就崩。
# ⚠ PyPI 包名是 osmium（不是 pyosmium）——build-new-cities.py 的用法注释里写的
#   `--with pyosmium` 会让 uv 直接报 "No solution found"。这里用正确的包名。
UV_WITH = ['--no-project', '--with', 'osmium', '--with', 'pmtiles',
           '--with', 'mapbox-vector-tile', '--with', 'shapely']


def toolchain_cmd(script, extra=None):
    """返回 [可执行命令...]；有 uv 就走 uv run（依赖齐），否则退回当前解释器。"""
    uv = shutil.which('uv')
    if uv:
        return [uv, 'run'] + UV_WITH + ['python', script] + (extra or [])
    return [sys.executable, script] + (extra or [])


def _yflip_stats():
    """统计 y-flip 进度：已处理文件数 / 记录条数。"""
    import glob
    names = set()
    n = 0
    for fp in glob.glob(os.path.join(PIPELINE, 'work', 'yflip-progress*.jsonl')):
        try:
            for line in open(fp, encoding='utf-8'):
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except Exception:
                    continue
                n += 1
                if r.get('name'):
                    names.add(r['name'])
        except Exception:
            pass
    total = len(glob.glob(os.path.join(DEFAULT_OUT, '*.pmtiles')))
    return {'records': n, 'done': len(names), 'total_files': total,
            'pending': max(0, total - len(names))}


def _run_merge():
    """调用 merge-manifests.py 重建前端 manifest.json；返回 (ok, summary_str)。"""
    if not os.path.exists(MERGE_SCRIPT):
        return False, 'merge 脚本缺失: %s' % MERGE_SCRIPT
    try:
        r = subprocess.run([sys.executable, MERGE_SCRIPT], cwd=ROOT,
                           capture_output=True, encoding='utf-8', errors='replace', timeout=300)
        ok = r.returncode == 0
        tail = [l for l in r.stdout.splitlines() if l.strip()][-6:]
        summary = '\n'.join(tail) or (r.stderr[-500:] if r.stderr else '（无输出）')
        return ok, summary
    except Exception as e:
        return False, 'merge 调用异常: %s' % e


# ----------------------------- 核心模块（与 build-new-cities.py 同源） -----------------------------
# 2026-10-30 起：不再用子进程调 CLI（`pbf-to-pmtiles.py --manifest ...`）。
# CLI 只把结果写进 manifest-out 文件，既不登记 y-flip 进度（后台 y-flip 会把新产物再翻回镜像），
# 也不直接合并前端 manifest.json —— 与最近的实际生成流程（build-new-cities.py）不一致。
# 改为把核心脚本当模块加载，走 gen_city_pmtiles 这条完全相同的代码路径。
_CORE_MOD = None


def _load_core():
    global _CORE_MOD
    if _CORE_MOD is None:
        import importlib.util
        spec = importlib.util.spec_from_file_location('pbf_to_pmtiles_studio', CORE_SCRIPT)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _CORE_MOD = mod
    return _CORE_MOD


class _LogWriter:
    """把核心模块的 print 转发进 job['log']（SSE 逐行推送 + _classify 进度解析）。"""

    def __init__(self, job):
        self.job = job
        self.buf = ''

    def write(self, s):
        if not s:
            return
        self.buf += s
        while '\n' in self.buf:
            line, self.buf = self.buf.split('\n', 1)
            line = line.rstrip('\r')
            self.job['log'].append(line)
            _classify(line, self.job)

    def flush(self):
        pass

    def isatty(self):
        return False


YFLIP_LOG = os.path.join(PIPELINE, 'work', 'yflip-progress.built-correct.jsonl')


def _yflip_register(path, name, r):
    """把「本就按正确编码生成」的文件登记进 y-flip 进度日志（与 build-new-cities.py 同款）。
    batch-fix-yflip.py 的续跑判据是「文件名 ∈ done」或「sha256 命中 sha_out」，
    登记后即便后台仍在跑翻转，也不会把这些新产物再翻回镜像。"""
    import hashlib
    try:
        h = hashlib.sha256()
        with open(path, 'rb') as f:
            for blk in iter(lambda: f.read(1 << 20), b''):
                h.update(blk)
        rec = {'name': os.path.basename(path), 'status': 'ok', 'sha_out': h.hexdigest(),
               'built_correct': True, 'tiles': r.get('tiles'), 'bytes': r.get('bytes'),
               'sec': r.get('sec'), 'ts': time.time(), 'src': 'studio:' + str(name)}
        os.makedirs(os.path.dirname(YFLIP_LOG), exist_ok=True)
        with open(YFLIP_LOG, 'a', encoding='utf-8') as f:
            f.write(json.dumps(rec, ensure_ascii=False) + '\n')
        return True
    except Exception as e:
        print('[studio] y-flip 登记失败(%s): %s' % (path, e))
        return False


def _merge_frontend_manifest(res):
    """把成功条目直接写进前端 manifest.json（与 build-new-cities.py 同款：读旧 → 更新 → 写回）。
    不再依赖 m_studio.json + merge-manifests.py 那条老路径（那会把「只在 manifest 里的
    新城市」整批抹掉，见 merge-manifests.py 2026-10-30 修复说明）。"""
    target = os.path.join(DEFAULT_OUT, 'manifest.json')
    man = {}
    if os.path.exists(target):
        try:
            man = json.load(open(target, encoding='utf-8'))
        except Exception:
            man = {}
    n = 0
    for name, r in (res or {}).items():
        if isinstance(r, dict) and r.get('ok'):
            man[name] = r
            n += 1
    json.dump(man, open(target, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    return n, len(man)


# ----------------------------- 抽取工作线程 -----------------------------
def _run_job(job_id, pbf, cities, outdir, chunk):
    job = jobs.get(job_id)
    if job is None:
        return
    job['status'] = 'running'
    job['started'] = datetime.datetime.now().isoformat(timespec='seconds')

    try:
        P = _load_core()
    except Exception as e:
        job['log'].append('核心脚本加载失败: %s' % e)
        job['status'] = 'error'
        job['finished'] = datetime.datetime.now().isoformat(timespec='seconds')
        return

    osmium = P.find_osmium()
    job['osmium'] = bool(osmium)
    job['log'].append('▶ 开始抽取：%d 城 · chunk=%d · 源 pbf=%s' % (len(cities), chunk, pbf))
    job['log'].append('  osmium-tool: %s' % (osmium or '未找到 → 回退全量扫源 pbf（慢）'))

    # ⚠ 停止语义：gen_city_pmtiles 一次处理整批（邻近城市共享一次 osmium 预裁剪，快 5~150 倍），
    #   中途无法安全中断（会留下半成品 pmtiles 且断点续跑会把它当已完成）。
    #   故「停止」在**批次之间**生效——本工具一次通常只提交一个 pbf，即点停后跑完当前批即止。
    res = {}
    rc = 0
    try:
        if job.get('_stop'):
            job['log'].append('■ 任务开始前已收到停止请求')
        else:
            with contextlib.redirect_stdout(_LogWriter(job)):
                res = P.gen_city_pmtiles(
                    os.path.abspath(pbf), cities, outdir, chunk,
                    osmium=osmium,
                    max_grow=P.CLUSTER_MAX_GROW, max_area=P.CLUSTER_MAX_AREA,
                    include_relations=True)
    except Exception as e:
        job['log'].append('抽取异常: %s' % e)
        rc = -1

    # 2) 逐城状态（权威来源是 gen_city_pmtiles 的返回值，不再读落盘 JSON）
    cities_out = []
    summary = {}
    for name, r in (res or {}).items():
        if not isinstance(r, dict):
            continue
        cities_out.append({
            'name': name,
            'status': 'done' if r.get('ok') else 'empty',
            'tiles': r.get('tiles'),
            'mb': round((r.get('bytes', 0) or 0) / 1048576.0, 2),
            'resumed': bool(r.get('resumed')),
            'reason': r.get('reason', ''),
            'file': os.path.basename(r.get('file', '')) if r.get('file') else '',
        })
    ok = [c for c in cities_out if c['status'] == 'done']
    empty = [c for c in cities_out if c['status'] == 'empty']
    summary = {'ok': len(ok), 'empty': len(empty), 'mb': round(sum(c['mb'] for c in ok), 1)}
    job['cities'] = cities_out
    job['summary'] = summary

    # 3) 新产物登记 y-flip 进度（防止后台/将来的翻转把它们翻回镜像）+ 直接并入前端 manifest.json
    nreg = 0
    try:
        for name, r in (res or {}).items():
            if not isinstance(r, dict) or not r.get('ok') or r.get('resumed'):
                continue
            spec = next((c for c in cities if c['name'] == name), None)
            if not spec:
                continue
            path = os.path.join(outdir, P.city_fname(spec) + '.pmtiles')
            if os.path.exists(path) and _yflip_register(path, name, r):
                nreg += 1
        if nreg:
            job['log'].append('■ 已登记 y-flip 进度 %d 个新文件（后台翻转不会误翻）' % nreg)
    except Exception as e:
        job['log'].append('y-flip 登记失败: %s' % e)

    try:
        n_man, total_man = _merge_frontend_manifest(res)
        job['log'].append('■ 前端 manifest.json 已并入 %d 条（现共 %d 城）' % (n_man, total_man))
    except Exception as e:
        job['log'].append('并入前端 manifest 失败: %s' % e)

    # 4) 可选：自动并入前端 manifest.json
    merge_result = None
    if job.get('_auto_merge'):
        mok, msum = _run_merge()
        merge_result = {'ok': mok, 'summary': msum}
        job['log'].append(('■ 已自动并入前端 manifest' if mok else '■ 自动并入失败') +
                          ('：' + msum.splitlines()[0] if msum else ''))

    if rc == 0 and not job.get('_stop'):
        job['status'] = 'done'
    elif job.get('_stop'):
        job['status'] = 'stopped'
    else:
        job['status'] = 'error'
    job['finished'] = datetime.datetime.now().isoformat(timespec='seconds')
    job['returncode'] = rc
    job['merge'] = merge_result
    job['log'].append('■ 任务结束：%s（rc=%s）' % (job['status'], rc))


# ----------------------------- 路由 -----------------------------
@app.route('/')
def index():
    return send_from_directory(PIPELINE, 'studio.html')


@app.route('/api/info')
def api_info():
    osmium = find_osmium()
    return jsonify({
        'osmium': bool(osmium),
        'osmium_path': osmium,
        'default_out': DEFAULT_OUT,
        'core_script': CORE_SCRIPT,
        'toolchain': ('uv' if shutil.which('uv') else sys.executable),
        'yflip': _yflip_stats(),
    })


@app.route('/api/check', methods=['POST'])
def api_check():
    pbf = (request.json or {}).get('pbf', '')
    if not pbf:
        return jsonify({'exists': False, 'size': 0, 'error': '路径为空'})
    p = os.path.abspath(pbf)
    if os.path.exists(p) and os.path.isfile(p):
        return jsonify({'exists': True, 'size': os.path.getsize(p),
                        'size_mb': round(os.path.getsize(p) / 1048576.0, 1)})
    return jsonify({'exists': False, 'size': 0, 'error': '文件不存在'})


@app.route('/api/run', methods=['POST'])
def api_run():
    data = request.json or {}
    pbf = (data.get('pbf') or '').strip()
    cities = data.get('cities') or []
    outdir = (data.get('outdir') or DEFAULT_OUT).strip()
    try:
        chunk = int(data.get('chunk', 16))
    except Exception:
        chunk = 16
    auto_merge = bool(data.get('auto_merge'))

    if not pbf:
        return jsonify({'error': '请指定源 pbf 路径'}), 400
    if not os.path.exists(pbf):
        return jsonify({'error': '源 pbf 不存在: %s' % pbf}), 400
    if not cities:
        return jsonify({'error': '请至少添加一个城市（名称 + 四至）'}), 400
    # 校验每个城市 bbox
    clean = []
    for c in cities:
        try:
            bbox = [float(c['bbox'][i]) for i in range(4)]
            if bbox[0] >= bbox[2] or bbox[1] >= bbox[3]:
                return jsonify({'error': '城市「%s」四至不合法（最小须<最大）' % c.get('name')}), 400
            clean.append({
                'name': c.get('name', '').strip() or '未命名',
                'continent': c.get('continent', '').strip(),
                'country': c.get('country', '').strip(),
                'bbox': bbox,
                'minz': int(c.get('minz', 11)),
                'maxz': int(c.get('maxz', 15)),
            })
        except Exception:
            return jsonify({'error': '城市「%s」四至格式错误' % c.get('name')}), 400

    os.makedirs(outdir, exist_ok=True)
    job_id = uuid.uuid4().hex[:12]
    with jobs_lock:
      jobs[job_id] = {
        'status': 'queued', 'pbf': pbf, 'outdir': outdir,
        'total': len(clean), 'done': 0, 'resumed': False, 'osmium': None,
        'log': [], 'cities': [], 'summary': {}, 'returncode': None,
        'started': None, 'finished': None, 'proc': None, '_stop': False,
        '_auto_merge': auto_merge,
    }
    t = threading.Thread(target=_run_job, args=(job_id, pbf, clean, outdir, chunk), daemon=True)
    t.start()
    return jsonify({'job_id': job_id, 'total': len(clean)})


@app.route('/api/stop/<job_id>', methods=['POST'])
def api_stop(job_id):
    job = jobs.get(job_id)
    if not job:
        return jsonify({'error': '未知任务'}), 404
    job['_stop'] = True
    proc = job.get('proc')
    if proc and proc.poll() is None:
        try:
            proc.terminate()
        except Exception:
            pass
    return jsonify({'ok': True})


@app.route('/api/merge', methods=['POST'])
def api_merge():
    """手动把工作室累积清单并入前端 manifest.json（重建整表，幂等安全）。"""
    ok, summary = _run_merge()
    return jsonify({'ok': ok, 'summary': summary})


@app.route('/api/progress/<job_id>')
def api_progress(job_id):
    job = jobs.get(job_id)
    if not job:
        return jsonify({'error': '未知任务'}), 404

    def gen():
        idx = 0
        sent_end = False
        # 先发一次快照（让迟到客户端也能拿到当前状态）
        yield 'data: %s\n\n' % json.dumps({
            'type': 'state', 'status': job['status'], 'done': job['done'],
            'total': job['total'], 'osmium': job.get('osmium'), 'resumed': job.get('resumed'),
            'started': job.get('started'), 'finished': job.get('finished'),
            'log': job['log'][:], 'cities': job.get('cities', []),
            'summary': job.get('summary', {}),
        }, ensure_ascii=False)
        while True:
            # 把新增日志逐行发出
            while idx < len(job['log']):
                line = job['log'][idx]
                idx += 1
                yield 'data: %s\n\n' % json.dumps({
                    'type': 'log', 'line': line, 'done': job['done'], 'total': job['total'],
                }, ensure_ascii=False)
            # 末态处理
            if job['status'] in ('done', 'error', 'stopped'):
                if not sent_end:
                    yield 'data: %s\n\n' % json.dumps({
                        'type': 'end', 'status': job['status'], 'done': job['done'],
                        'total': job['total'], 'osmium': job.get('osmium'),
                        'cities': job.get('cities', []), 'summary': job.get('summary', {}),
                        'merge': job.get('merge'),
                    }, ensure_ascii=False)
                    sent_end = True
                break
            time.sleep(0.4)

    return Response(gen(), mimetype='text/event-stream',
                    headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})


@app.route('/api/yflip', methods=['POST'])
def api_yflip():
    """y 镜像翻转修复（batch-fix-yflip.py）：
    mode=dry-run 只列出待处理；mode=run 真跑（可 --workers 并行）；
    mode=seed 把指定文件登记为「已正确」，避免被重复翻转。"""
    data = request.json or {}
    mode = (data.get('mode') or 'dry-run').strip()
    if not os.path.exists(YFLIP_SCRIPT):
        return jsonify({'error': '脚本缺失: %s' % YFLIP_SCRIPT}), 500
    if mode == 'seed':
        name = (data.get('name') or '').strip()
        if not name:
            return jsonify({'error': '请填要登记的文件名（如 亚洲_中国_上海.pmtiles）'}), 400
        cmd = toolchain_cmd(YFLIP_SCRIPT, ['--seed-done', name])
    elif mode == 'run':
        try:
            workers = max(1, min(8, int(data.get('workers', 1))))
        except Exception:
            workers = 1
        cmd = toolchain_cmd(YFLIP_SCRIPT, (['--workers', str(workers)] if workers > 1 else []))
    else:
        cmd = toolchain_cmd(YFLIP_SCRIPT, ['--dry-run'])
    try:
        r = subprocess.run(cmd, cwd=ROOT, capture_output=True,
                           encoding='utf-8', errors='replace', timeout=3600)
        lines = [l for l in (r.stdout or '').splitlines() if l.strip()]
        return jsonify({'ok': r.returncode == 0, 'rc': r.returncode,
                        'cmd': ' '.join(cmd[:6]) + ' …',
                        'lines': lines[-60:], 'err': (r.stderr or '')[-600:],
                        'stats': _yflip_stats()})
    except subprocess.TimeoutExpired:
        return jsonify({'error': '执行超时（>60min）'}), 500
    except Exception as e:
        return jsonify({'error': '执行异常: %s' % e}), 500


@app.route('/api/jobs', methods=['GET'])
def api_jobs():
    out = []
    for jid, j in jobs.items():
        out.append({'job_id': jid, 'status': j['status'], 'pbf': j['pbf'],
                    'done': j['done'], 'total': j['total'], 'started': j['started'],
                    'finished': j['finished']})
    return jsonify(out)


def main():
    print('PMTiles Studio → http://127.0.0.1:%d/' % PORT)
    print('  核心脚本: %s' % CORE_SCRIPT)
    print('  默认输出: %s' % DEFAULT_OUT)
    app.run(host='127.0.0.1', port=PORT, threaded=True)


if __name__ == '__main__':
    main()
