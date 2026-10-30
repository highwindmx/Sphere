#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
B 组城市分配（2026-10-25）：把 _all_cities.json（489 城：巡礼169 + 世界史384 去重）
按「源 pbf 覆盖范围」对号入座，产出 tools/osm-pmtiles-pipeline/_bgroup_manifest.json。

与 tour-cities-manifest.py 的区别：
  · 覆盖全部区域（含 B 组新下载的 turkey / australia-oceania / central-america，
    以及待下载的 africa / india / syria）；
  · 跳过已生成城市（public/data/osm/pmtiles/manifest.json 里 ok=true）
    与 A 组正在跑的城市（tools/osm-pmtiles-pipeline/_pmtiles_manifest.json coverable）；
  · blocked = 本地无对应 pbf 的城市（走在线兜底）。

数据 © OpenStreetMap contributors (ODbL)
"""
import importlib.util
import json
import os

_spec = importlib.util.spec_from_file_location('geo_country', 'tools/osm-pmtiles-pipeline/geo-country.py')
_gc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_gc)
geo_label = _gc.geo_label

# ---- 抽取框分档（2026-10-26 定案）----
# 旧口径所有城市一律 ±0.12°（≈20×27km），实测北京连大兴机场/通州/首都机场都切在外面。
# 实测 ±0.50°（≈85×111km）体积只涨 4.2 倍（5.3MB → 22.4MB），因为数据密度随离市中心衰减。
HALF_DEG = 0.12          # T3 默认：遗址/奇观/文明/丝路等看单体
HALF_BIG = 0.24          # T2：世界城市（覆盖主城区+近郊）
HALF_MEGA = 0.50         # T1：首都/省会/千万级都会（覆盖整座城市+机场+新区）
MINZ, MAXZ = 11, 15
# 走 T1 大框的层（首都 + 中国省会 + 全球前列大城）
LAYER_MEGA = {"worldcapitals", "cncapital", "megacities"}
# 走 T3 小框的层（单体景点/古迹，大框只会塞进无关郊区）
LAYER_SMALL = {"heritage", "wonders", "civilizations", "silkroad",
               "xuanzang", "zhenghe", "rome", "ageofsail",
               "passes", "longmarch", "g318"}   # 关隘/长征地名/318 沿线小镇：看单体即可
# 同名/近重复合并时的保留优先级（数字小的胜出，其余并入）
LAYER_RANK = {"worldcapitals": 0, "megacities": 1, "cncapital": 1, "worldcities": 2,
              "heritage": 3, "wonders": 4, "civilizations": 5, "ageofsail": 6,
              "silkroad": 7, "xuanzang": 8, "zhenghe": 9, "rome": 10,
              "passes": 11, "longmarch": 12, "g318": 13}
DEDUP_DIST = 0.08        # 同 pbf、中心距 < 0.08°（≈9km）视为重复，合并保留优先级高的那条
DEDUP_SAME_NAME = True   # 同 pbf 且**同名**直接合并（丝路/玄奘层常有同名条目，坐标略有出入）
DEDUP_CONTAIN_MAX = 0.12  # 小框完全落在大框内 + 中心距 < 0.12° + 同国家 → 合并（杭州西湖 ⊂ 杭州）
                          # 距离放宽到 0.20 会误伤跨国（新山→新加坡）与独立都会（埼玉/川崎→东京）

# ---- 中国轮廓粗多边形（lon,lat），逆时针；正确含西藏/新疆/云南，排除印度/东南亚/中亚 ----
# （与 tour-cities-manifest.py 同源，避免 china 大矩形误吞印度/东南亚城市）
CHINA_POLY = [
    (73.30,39.40),(73.10,38.60),(74.30,37.20),(74.90,37.30),(76.50,36.00),(78.20,35.50),(79.50,33.50),
    (80.50,32.00),(81.50,30.30),(84.00,29.00),(85.10,27.90),(88.10,27.40),(89.50,27.90),(92.00,27.70),(94.50,29.00),(96.50,29.00),(97.50,28.50),
    (98.80,27.80),(99.80,25.80),(100.80,23.50),(101.80,21.90),(102.90,22.50),
    (104.00,22.70),(105.80,22.90),(106.80,21.70),(107.90,21.60),(109.50,21.40),
    (110.20,20.30),(110.60,19.90),(111.00,21.50),(112.50,21.70),(114.30,22.50),
    (116.50,23.00),(117.50,23.70),(119.50,25.50),(120.50,26.50),(121.50,28.50),
    (121.90,30.90),(120.30,32.50),(120.80,34.30),(119.30,35.00),(120.00,35.90),
    (121.00,37.50),(119.00,37.80),(118.00,38.90),(117.70,39.00),(119.00,39.20),
    (121.00,39.60),(122.00,40.50),(123.50,39.80),(124.40,40.00),(126.50,41.00),
    (128.50,42.00),(130.50,42.70),(133.00,45.00),(134.50,48.30),(132.50,47.70),
    (130.70,48.90),(128.50,50.00),(126.00,52.50),(124.00,53.30),(121.00,53.30),
    (119.50,50.50),(117.50,49.50),(116.00,47.50),(115.50,45.50),(113.00,44.50),
    (111.00,43.50),(109.50,42.50),(107.00,42.50),(105.50,41.80),(103.50,41.80),
    (100.00,42.50),(96.50,42.80),(91.00,45.00),(88.00,48.00),(85.50,47.00),
    (83.00,47.00),(82.50,45.30),(80.50,45.00),(80.00,42.50),(76.50,43.00),
    (75.00,40.50),
]

def in_poly(lon, lat, poly):
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]; xj, yj = poly[j]
        if ((yi > lat) != (yj > lat)) and \
           (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside

# ---- 手动纠偏：矩形互含/大矩形误吞，按已知 Extract 覆盖强制路由 ----
# 值 = pbf_key（存在）或 None（记入 missing_pbf，标注待下载区域名）
OVERRIDE = {
    # 土耳其（被 asia 大矩形误吞——Geofabrik 把土耳其归 europe，asia 实测 0 way）
    "伊斯坦布尔": "turkey", "阿尔忒弥斯神庙": "turkey", "摩索拉斯陵墓": "turkey",
    # 罗德岛是希腊领土（被 turkey 矩形误吞）
    "罗德岛太阳神巨像": "greece",
    # 瑞士/法国城市（被邻区矩形误吞）
    "伯尔尼": "dach", "苏黎世": "dach", "慕尼黑": "dach",
    "斯特拉斯堡": "france", "图卢兹": "france",
    # ---- 2026-10-25 新增下载后的大陆 extract 修正 ----
    # 非洲城市（被 asia 大矩形误吞；africa extract 含北非/东非/南非）
    "阿尔及尔": "africa", "突尼斯": "africa",
    # 日韩隔海互吞（south-korea 矩形含日本西海岸城市）
    "福冈": "japan", "北九州": "japan", "大分": "japan", "长崎": "japan",
    # 台湾/香港（sea extract 不含；台湾在 Geofabrik 归 asia，港澳归 china）
    "香港": "china", "澳门": "china",
    "台北": "asia", "高雄": "asia", "台中": "asia",
    # 海湾国家（iran/iraq 矩形误吞；沙特/阿联酋/卡塔尔在 Geofabrik 归 asia）
    "迪拜": "asia", "多哈": "asia", "利雅得": "asia", "吉达": "asia",
    "麦加": "asia", "安曼": "asia", "科威特城": "asia", "红海（吉达）": "asia",
    # 约旦（israel 矩形误吞）
    "佩特拉古城": "asia", "佩特拉": "asia",
    # 朝鲜/中亚/印度/叙利亚：官方 extract 未下载，asia 大陆 extract 含其数据
    # （2026-10-25 实测：平壤 382K way / 孟买 315K way）
    "平壤": "asia", "元山": "asia", "罗先": "asia",
    "乌兰巴托": "asia", "阿拉木图": "asia", "阿斯塔纳": "asia",
    "塔什干": "asia", "比什凯克": "asia",
    "大马士革": "asia", "贝鲁特": "asia", "巴尔米拉": "asia",
    "关岛": "asia",
    # 俄罗斯城市（asia 大矩形误吞西伯利亚/俄欧部分；海参崴被 japan 矩形误吞）
    "哈巴罗夫斯克": "russia", "伊尔库茨克": "russia", "新西伯利亚": "russia",
    "海参崴": "russia",
    # 无对应 extract → missing（在线兜底；可选下载 europe 小国/canada/mexico）
    "莫斯科": "russia", "圣彼得堡": "russia",   # russia-latest 已下载（3.9GB）
    "摩尔曼斯克": "russia", "布加勒斯特": None,
    "都柏林": None, "布鲁塞尔": None, "阿姆斯特丹": None, "鹿特丹": None,
    "波尔图": None, "布达佩斯": None, "布拉迪斯拉发": None, "哥本哈根": None,
    "格但斯克": None, "华沙": None, "克拉科夫": None, "萨格勒布": None, "布拉格": None,
    "赫尔辛基": None, "塔林": None, "里加": None, "维尔纽斯": None, "明斯克": None, "索菲亚": None,
    "墨西哥城": None, "瓜达拉哈拉": None, "蒙特雷": None,
    "坎昆": None, "奇琴伊察": None, "莫桑比克岛": "africa",
    "多伦多": None, "蒙特利尔": None, "温哥华": None, "卡尔加里": None,
    "魁北克城": None, "渥太华": None, "哈瓦那": None,
}
OVERRIDE_NEED = {
    "萨格勒布": "croatia", "布拉格": "czechia",
    "华沙": "poland", "克拉科夫": "poland", "赫尔辛基": "finland", "塔林": "estonia",
    "里加": "latvia", "维尔纽斯": "lithuania", "明斯克": "belarus", "索菲亚": "bulgaria",
    "布达佩斯": "hungary", "哥本哈根": "denmark", "格但斯克": "poland",
    "阿姆斯特丹": "netherlands", "鹿特丹": "netherlands", "布鲁塞尔": "belgium",
    "都柏林": "ireland", "波尔图": "portugal", "布拉迪斯拉发": "slovakia",
    "墨西哥城": "mexico", "瓜达拉哈拉": "mexico", "蒙特雷": "mexico",
    "多伦多": "canada", "蒙特利尔": "canada", "温哥华": "canada", "卡尔加里": "canada",
    "魁北克城": "canada", "渥太华": "canada", "哈瓦那": "cuba",
    "莫斯科": "russia", "圣彼得堡": "russia", "摩尔曼斯克": "russia",
    "布加勒斯特": "romania",
}

# ---- 区域矩形（minlon,minlat,maxlon,maxlat）；小区域在前（互含时取精细）----
# 值 = (bbox, pbf_key 或 None[无pbf→blocked])
RECT = [
    ("malta",            (14.18, 35.78, 14.58, 36.09),  "malta"),
    ("shanghai",         (120.85, 30.67, 121.97, 31.88), "shanghai"),
    ("israel",           (34.20, 29.45, 35.55, 33.30),  "israel-and-palestine"),
    ("iraq",             (38.7, 29.0, 48.6, 37.4),      "iraq"),
    ("iran",             (44.0, 24.5, 63.5, 40.0),      "iran"),
    ("georgia",          (40.0, 41.0, 46.7, 43.7),      "georgia"),
    ("serbia",           (18.8, 42.2, 23.0, 46.2),      "serbia"),
    ("south-korea",      (124.3, 32.9, 131.9, 38.6),    "south-korea"),
    ("japan",            (122.9, 20.4, 154.0, 45.6),    "japan"),
    ("italy",            (6.5, 36.5, 18.6, 47.2),       "italy"),
    ("greece",           (19.3, 34.7, 29.7, 41.8),      "greece"),
    ("spain",            (-9.4, 35.9, 4.6, 43.9),       "spain"),
    ("alps",             (5.9, 42.9, 16.5, 48.3),       "alps"),
    ("dach",             (5.8, 45.7, 17.1, 55.1),       "dach"),
    ("great-britain",    (-8.7, 49.9, 1.9, 60.9),       "great-britain"),
    ("france",           (-5.2, 41.3, 9.6, 51.1),       "france"),
    # africa 上限 42E：含东非（亚的斯亚贝巴 38.7/达累斯萨拉姆 39.3/莫桑比克岛 40.7），
    # 沙特/科威特（39-48E）靠 OVERRIDE 全部路由到 asia，巴士拉靠 iraq 矩形先行
    ("africa",           (-20.0, -37.0, 42.0, 37.5),    "africa"),
    ("sea",              (92.5, -11.6, 141.0, 28.6),    "sea"),   # 东南亚：小文件优先（比 asia 快 4 倍）
    # ukraine 必须早于 asia（asia 大矩形含乌克兰全境但不含其数据）
    ("ukraine",          (22.1, 44.3, 40.3, 52.4),      "ukraine"),
    # asia（16.4GB 大陆 extract）：实测含中国/日本/印度/朝鲜/韩国/以色列/伊拉克/东南亚/中亚，
    # 但**不含土耳其/俄罗斯/乌克兰**（Geofabrik 归 europe，伊斯坦布尔实测 0 way）
    ("asia",             (26.0, -13.0, 154.0, 84.5),    "asia"),
    ("russia",           (19.6, 41.1, 180.0, 81.9),     "russia"),
    ("us",               (-179.2, 17.9, -65.5, 71.5),   "us"),
    ("australia-oceania",(110.0, -50.0, 180.0, 10.0),   "australia-oceania"),
    ("central-america",  (-99.5, 5.5, -77.0, 18.5),     "central-america"),
    ("south-america",    (-82.0, -56.0, -33.0, 13.5),   "south-america"),
]

# 本地实际存在（且验证过）的 pbf —— 不在此表的区域即使分配了也标 missing
HAVE_PBF = {
    "china", "malta", "shanghai", "israel-and-palestine", "iraq", "iran", "georgia",
    "serbia", "south-korea", "japan", "greece", "spain", "italy", "turkey",
    "alps", "dach", "great-britain", "france", "sea", "ukraine", "russia",
    "us", "australia-oceania", "central-america", "africa", "asia", "south-america",
}

# ---- 国别归属纠偏（2026-10-26）----
# geo-country.py 的国家粗矩形在高原/边境互有重叠，实测 20 条中国城市被判错国：
#   拉萨/日喀则/林芝/波密/八宿 → 印度；南宁/昆仑关/马关 → 越南；
#   焉耆/龟兹/疏勒/跋禄迦 → 哈萨克/吉尔吉斯；定日/聂拉木/樟木口岸 → 尼泊尔；丽江古城 → 缅甸。
# 修正顺序：CN_OVERRIDE（明确非中国）> CN_FORCE（轮廓外的中国城市）> 中国真实轮廓多边形。
CN_OVERRIDE = {
    "那霸": ("亚洲", "琉球"),          # 冲绳/琉球，矩形判定会被中国框吃掉（用户指定归属「琉球」）
}
CN_FORCE = {"大连", "青岛", "海口", "香港", "澳门", "台北", "高雄", "台中",
            "基隆", "三亚", "舟山", "烟台", "温州"}


def bbox_in(inner, outer):
    """inner 的 bbox 是否完整落在 outer 内"""
    return (outer[0] <= inner[0] and outer[1] <= inner[1]
            and inner[2] <= outer[2] and inner[3] <= outer[3])


def assign(lon, lat):
    """返回 (region_name, pbf_key 或 None)。china 用真实轮廓多边形判定。"""
    if in_poly(lon, lat, CHINA_POLY):
        return "china", "china"
    for name, (a, b, c, d), key in RECT:
        if a <= lon <= c and b <= lat <= d:
            return name, key
    return None, None

def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('--keep-done', action='store_true',
                    help='保留旧行为：跳过早期已生成/A组在跑的城市（默认不跳，全部重出）')
    args = ap.parse_args()
    cities = json.load(open("tools/osm-pmtiles-pipeline/_all_cities.json"))
    # ---- 补城：中国省会+计划单列市、全球前列大城（tools/osm-pmtiles-pipeline/extra-cities.json）----
    extra_p = "tools/osm-pmtiles-pipeline/extra-cities.json"
    if os.path.exists(extra_p):
        extra = json.load(open(extra_p))["cities"]
        by_name = {}
        for e in cities:
            by_name.setdefault(e["name"], []).append(e)
        add = []
        for e in extra:
            old = by_name.get(e["name"])
            if old is None:
                add.append(e)                       # 新增城市
                continue
            # 同名：坐标接近就都留下（后面的近重复合并会按层优先级二选一，
            # megacities 优先级高于 worldcities → 该城自动升到 T1 大框）；
            # 坐标很远则是异城同名，跳过避免 pmtiles 文件名撞车
            if any(abs(o["lon"] - e["lon"]) < 0.3 and abs(o["lat"] - e["lat"]) < 0.3 for o in old):
                add.append(e)
        cities = cities + add
    # ---- 异城同名去重/改名（pmtiles 文件名与 manifest 均按 name，同名会互相覆盖）----
    # 圣何塞：加州(-121.9) vs 哥斯达黎加(-84.1) → 后者改名
    for e in cities:
        if e["name"] == "圣何塞" and e["lon"] > -100:
            e["name"] = "圣何塞（哥斯达黎加）"
    # 雅加达 ageofsail 条目坐标 105.3 在海上（巽他海峡，错误数据）→ 丢弃，保留 worldcities 市区
    cities = [e for e in cities if not (e["layer"] == "ageofsail" and e["name"] == "雅加达")]
    # ⚠ 旧行为：跳过「早期已生成 / A组在跑」的城市。2026-10-26 实测这个规则把
    # 上海/广州/成都/武汉/重庆/兰州/拉萨 7 座中国大城市全滤掉了（早期产物还是 ±0.12° 小框），
    # 导致清单里中国只剩北京+港澳台。默认不再跳过（--keep-done 可恢复旧行为）。
    done = set()
    if args.keep_done:
        p = "public/data/osm/pmtiles/manifest.json"
        if os.path.exists(p):
            for k, v in json.load(open(p)).items():
                if v.get("ok"):
                    done.add(k)
    a_running = set()
    if args.keep_done:
        p2 = "tools/osm-pmtiles-pipeline/_pmtiles_manifest.json"
        if os.path.exists(p2):
            for c in json.load(open(p2)).get("coverable", []):
                a_running.add(c["name"])

    coverable, blocked, missing_pbf, skipped = [], [], [], []
    for e in cities:
        name, lon, lat = e["name"], e["lon"], e["lat"]
        if name in done or name in a_running:
            skipped.append(name)
            continue
        region, key = assign(lon, lat)
        # 手动纠偏优先于矩形
        if name in OVERRIDE:
            key = OVERRIDE[name]
            region = OVERRIDE_NEED.get(name, region)
        rec = {"name": name, "lon": lon, "lat": lat, "layer": e["layer"]}
        if key is None:
            blocked.append(rec)
            continue
        if key not in HAVE_PBF:
            rec["need"] = OVERRIDE_NEED.get(name, key)
            missing_pbf.append(rec)
            continue
        # ---- 抽取框分档 ----
        if e["layer"] in LAYER_MEGA:
            half, minz = HALF_MEGA, 10          # 都会：整城+机场；最低 zoom 降一级便于远景
        elif e["layer"] in LAYER_SMALL:
            half, minz = HALF_DEG, MINZ         # 遗址/奇观：看单体
        else:
            half, minz = HALF_BIG, MINZ         # 世界城市：主城+近郊
        cont, country = geo_label(name, lon, lat)
        if name in CN_OVERRIDE:
            cont, country = CN_OVERRIDE[name]
        elif name in CN_FORCE or in_poly(lon, lat, CHINA_POLY):
            cont, country = "亚洲", "中国"
        rec.update(pbf=key,
                   bbox=[lon - half, lat - half, lon + half, lat + half],
                   minz=minz, maxz=MAXZ,
                   continent=cont, country=country, tier={HALF_MEGA: 'T1', HALF_BIG: 'T2'}.get(half, 'T3'))
        coverable.append(rec)

    # ---- 近重复合并：同 pbf、中心距 < DEDUP_DIST 视为一座城，保留层优先级高的那条 ----
    import math
    merged_log = []
    by_pbf = {}
    for r in coverable:
        by_pbf.setdefault(r["pbf"], []).append(r)
    keep = []
    for pbf, items in by_pbf.items():
        items = sorted(items, key=lambda r: (LAYER_RANK.get(r["layer"], 99), r["name"]))
        taken = []
        for r in items:
            dup_of = None
            for t in taken:
                same = DEDUP_SAME_NAME and r["name"] == t["name"]
                d = math.hypot(r["lon"] - t["lon"], r["lat"] - t["lat"])
                if same or d < DEDUP_DIST:
                    dup_of = t
                    break
                # 小框被同城同国的大框完整包含（如 杭州西湖 ⊂ 杭州）→ 也是重复
                if (d < DEDUP_CONTAIN_MAX and r.get("country") == t.get("country")
                        and bbox_in(r["bbox"], t["bbox"])):
                    dup_of = t
                    break
            if dup_of is None:
                taken.append(r)
                keep.append(r)
            else:
                merged_log.append("%s(%s) → %s(%s)" % (r["name"], r["layer"], dup_of["name"], dup_of["layer"]))
    print("近重复合并：%d 条并入同级城市，清单 %d → %d" % (len(merged_log), len(coverable), len(keep)))
    for s in merged_log:
        print("   " + s)
    coverable = keep

    out = {"coverable": coverable, "blocked": blocked, "missing_pbf": missing_pbf}
    json.dump(out, open("tools/osm-pmtiles-pipeline/_bgroup_manifest.json", "w"), ensure_ascii=False, indent=1)

    from collections import Counter
    cp = Counter(c["pbf"] for c in coverable)
    print("总城市 489；跳过（已生成/A组在跑）%d；可生成 %d；缺pbf %d；无区域 %d"
          % (len(skipped), len(coverable), len(missing_pbf), len(blocked)))
    print("\n按源 pbf：")
    for k in sorted(cp):
        names = [c["name"] for c in coverable if c["pbf"] == k]
        print("  [%-18s] %3d: %s" % (k, len(names), "、".join(names)))
    print("\n缺 pbf（待下载）：")
    for r in missing_pbf:
        print("   %-16s %.2f,%.2f (%s) → %s" % (r["name"], r["lon"], r["lat"], r["layer"], r["need"]))
    print("\n无区域 pbf（走在线）：")
    for r in blocked:
        print("   %-16s %.2f,%.2f (%s)" % (r["name"], r["lon"], r["lat"], r["layer"]))

if __name__ == "__main__":
    main()
