"""山川与天宫 —— Flask 静态服务入口

纯 Web 服务：serve dist/ 目录 + SPA fallback。
运行：pip install -r requirements.txt && python app.py
默认监听 http://0.0.0.0:5000
"""
import os
from flask import Flask, send_from_directory

DIST = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'dist')

app = Flask(__name__, static_folder=None)  # 不挂 Flask 默认 /static，自己全路由


@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def serve(path):
    """优先返回真实文件，找不到就回退到 index.html（SPA 路由）。"""
    if path:
        full = os.path.join(DIST, path)
        if os.path.isfile(full):
            return send_from_directory(DIST, path)
    return send_from_directory(DIST, 'index.html')


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5008)
