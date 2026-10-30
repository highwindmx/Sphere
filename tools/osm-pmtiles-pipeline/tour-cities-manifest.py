#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把 tools/osm-pmtiles-pipeline/_tour_cities.json 的巡礼城市按「源 pbf 覆盖范围」对号入座，
生成 tools/osm-pmtiles-pipeline/_pmtiles_manifest.json（可生成清单：城市→pbf+bbox）与 blocked 清单。

要点：
  · 中国用**真实轮廓多边形**判定（避免 china 大矩形把印度/东南亚城市误吞）；
  · 其余区域用矩形，小区域优先；
  · 输出 bbox = 城市中心 ± HALF_DEG（可按城微调），minz/maxz 供切片用。
数据 © OpenStreetMap contributors (ODbL)
"""
import json

HALF_DEG = 0.12          # 城市中心 ±0.12°（≈13km），够看街区+地标
MINZ, MAXZ = 11, 15

# ---- 中国轮廓粗多边形（lon,lat），逆时针；正确含西藏/新疆/云南，排除印度/东南亚/中亚 ----
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

# ---- 其余区域矩形（minlon,minlat,maxlon,maxlat）----
RECT = {
    "japan":       (122.9,20.4,154.0,45.6),
    "south-korea": (124.3,32.9,131.9,38.6),
    "sea":         (92.0,-11.0,141.0,28.5),
    "iran":        (44.0,24.5,63.5,40.0),
    "iraq":        (38.7,29.0,48.6,37.4),
    "israel":      (34.20,29.45,35.55,33.30),
    "italy":       (6.5,36.5,18.6,47.2),
    "spain":       (-9.4,35.9,4.6,43.9),
    "greece":      (19.3,34.7,29.7,41.8),
    "serbia":      (18.8,42.2,23.0,46.2),
    "ukraine":     (22.1,44.3,40.3,52.4),
    "russia":      (19.6,41.1,180.0,81.9),
    "georgia":     (40.0,41.0,46.7,43.7),
    "france":      (-5.2,41.3,9.6,51.1),
    "great-britain":(-8.7,49.9,1.9,60.9),
    "alps":        (5.9,42.9,16.5,48.3),
    "dach":        (5.8,45.7,17.1,55.1),
    "malta":       (14.18,35.78,14.58,36.09),
    "shanghai":    (120.85,30.67,121.97,31.88),
    "us":          (-179.2,17.9,-65.5,71.5),
}
# 小区域优先（矩形互含时取更精细的）
RECT_ORDER = ["malta","shanghai","israel","iraq","iran","georgia","serbia",
              "south-korea","japan","greece","spain","italy","alps","dach",
              "great-britain","france","sea","ukraine","russia","us"]

def assign(lon, lat):
    if in_poly(lon, lat, CHINA_POLY):
        return "china"
    for r in RECT_ORDER:
        a,b,c,d = RECT[r]
        if a <= lon <= c and b <= lat <= d:
            return r
    return None

def main():
    cities = json.load(open("tools/osm-pmtiles-pipeline/_tour_cities.json"))
    seen = {}
    coverable, blocked = [], []
    for e in cities:
        key = (e["name"], round(e["lon"],3), round(e["lat"],3))
        if key in seen:
            continue
        seen[key] = 1
        r = assign(e["lon"], e["lat"])
        rec = {"name": e["name"], "lon": e["lon"], "lat": e["lat"], "layer": e["layer"]}
        if r:
            lon, lat = e["lon"], e["lat"]
            rec.update(pbf=r,
                       bbox=[lon-HALF_DEG, lat-HALF_DEG, lon+HALF_DEG, lat+HALF_DEG],
                       minz=MINZ, maxz=MAXZ)
            coverable.append(rec)
        else:
            blocked.append(rec)
    out = {"coverable": coverable, "blocked": blocked}
    json.dump(out, open("tools/osm-pmtiles-pipeline/_pmtiles_manifest.json","w"), ensure_ascii=False, indent=1)
    # 统计
    from collections import Counter
    cp = Counter(c["pbf"] for c in coverable)
    print("去重城市:", len(seen), " 可生成:", len(coverable), " 缺pbf:", len(blocked))
    print("按源pbf:", dict(cp))
    print("\n可生成城市（按pbf）:")
    for r in ["china","sea","us","italy","greece","spain","france","great-britain",
              "iran","iraq","israel","japan","south-korea","russia","serbia","ukraine",
              "georgia","shanghai","alps","dach","malta"]:
        names = [c["name"] for c in coverable if c["pbf"]==r]
        if names:
            print(f"  [{r}] {len(names)}: {'、'.join(names)}")
    print("\n缺 pbf 城市:")
    for b in blocked:
        print("   %-16s %.2f,%.2f (%s)" % (b["name"], b["lon"], b["lat"], b["layer"]))

if __name__ == "__main__":
    main()
