#!/usr/bin/env node
/**
 * build-china-atlas.mjs — 把 DeanChensj/jiangshan-map 的中国历代疆域数据
 * 搬进 sphere，做成「一次加载、按年惰性解码」的前端资产。
 *
 * 源数据（GPL-3.0）：https://github.com/DeanChensj/jiangshan-map
 *   其中府州级边界与战国疆域派生自 CHGIS V6（Harvard-Yenching & 复旦）
 *   与 Robert M. Hartwell 数据集，保留原始「学术、非商业使用」条款。
 *
 * 为什么不直接用它官方的 export_geojson.js：
 *   那份脚本会展开 181 个阶段快照为 63 MB GeoJSON。而 atlas_snapshots.js 本身
 *   只有 1.67 MB——它是拓扑去重 + VLQ 编码的惰性解码包（访问 shape.coordinates
 *   时才展开单个面）。本脚本只搬这个包 + 生成年份→快照的索引，
 *   由前端在切年份时按需解码，资产体积差 37 倍。
 *
 * 产物（默认 public/data/history/china/）：
 *   map_data.js          17 朝代定义 + 阶段(phase)划分 + 城邑 + 里程碑 + 廊道（507 KB）
 *   atlas_snapshots.js   181 个阶段快照的 VLQ 惰性解码包（1.67 MB）
 *   china_geo_data.js    现代水文底图（河流/湖泊/注记，83 KB）
 *   i18n_dict.js         中英地名/朝代名词典（382 KB）
 *   index.json           朝代 → 阶段 → 快照 的年份映射（本脚本生成）
 *
 * 用法：
 *   node tools/history/build-china-atlas.mjs --src D:/tmp/jiangshan-map
 *   node tools/history/build-china-atlas.mjs --src ... --no-i18n   # 省掉英汉词典
 *
 * 获取源数据（三选一；本机 HTTPS 常被 reset，推荐 SSH 或 codeload zip）：
 *   git clone --depth 1 git@github.com:DeanChensj/jiangshan-map.git
 *   curl -L -o jm.zip https://codeload.github.com/DeanChensj/jiangshan-map/zip/refs/heads/main
 *   或只下这 4 个 js（jsDelivr 单文件可用，网络慢需耐心）：
 *     https://cdn.jsdelivr.net/gh/DeanChensj/jiangshan-map@main/js/map_data.js
 *     https://cdn.jsdelivr.net/gh/DeanChensj/jiangshan-map@main/js/atlas_snapshots.js
 *     https://cdn.jsdelivr.net/gh/DeanChensj/jiangshan-map@main/js/china_geo_data.js
 *     https://cdn.jsdelivr.net/gh/DeanChensj/jiangshan-map@main/js/i18n_dict.js
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(path.dirname(HERE));

// 1949 年起（PRC）快照为空，官方导出也在此截止；边界年份归属后一个朝代。
const CUTOFF = 1949;

function parseArgs(argv) {
  const a = { src: null, out: null, i18n: true };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--src') a.src = argv[++i];
    else if (v === '--out') a.out = argv[++i];
    else if (v === '--no-i18n') a.i18n = false;
    else if (v === '--help' || v === '-h') {
      console.log('用法: node build-china-atlas.mjs --src <jiangshan-map 根目录> [--out <输出目录>] [--no-i18n]');
      process.exit(0);
    }
  }
  return a;
}

function die(msg) {
  console.error('[err] ' + msg);
  process.exit(2);
}

const args = parseArgs(process.argv);
const src = args.src;
if (!src) die('缺少 --src（jiangshan-map 仓库根目录）');
const outDir = args.out || path.join(REPO, 'public', 'data', 'history', 'china');

const jsDir = path.join(src, 'js');
if (!fs.existsSync(path.join(jsDir, 'atlas_snapshots.js'))) {
  die('找不到 js/atlas_snapshots.js：' + jsDir);
}

// ---------- 在隔离上下文里加载源数据（与原项目一致的 window.* 挂载方式） ----------
const ctx = { window: {} };
vm.createContext(ctx);
const load = ['map_data.js', 'china_geo_data.js', 'atlas_snapshots.js'];
if (args.i18n) load.push('i18n_dict.js');
for (const f of load) {
  const p = path.join(jsDir, f);
  if (!fs.existsSync(p)) die('缺少源文件 ' + f);
  vm.runInContext(fs.readFileSync(p, 'utf8'), ctx, { filename: f });
}
const W = ctx.window;
const DYNASTY_DATA = W.DYNASTY_DATA;
const SNAPSHOTS = W.ATLAS_SNAPSHOTS;
const EN = W.EN_LOCALE || {};
const DICT = EN.dict || {};
if (!Array.isArray(DYNASTY_DATA)) die('map_data.js 未导出 DYNASTY_DATA');
if (!SNAPSHOTS) die('atlas_snapshots.js 未导出 ATLAS_SNAPSHOTS');

const en = (zh) => (zh && DICT[zh]) || undefined;
const dynastyName = (d) => (EN.dynasties && EN.dynasties[d.key] && EN.dynasties[d.key].name) || undefined;

// ---------- 朝代 → 阶段 → 快照 的年份映射（与官方 export_geojson.js 同规则） ----------
const snapUse = {}; // snap → [{dynasty, from, to}]
const dynasties = DYNASTY_DATA.map((d, di, all) => {
  const phases = d.phases && d.phases.length ? d.phases : [{ until: d.toYear, snap: `s_${d.key}` }];
  const end = Math.min(di < all.length - 1 ? all[di + 1].fromYear - 1 : d.toYear, CUTOFF - 1);
  const out = phases
    .map((ph, i) => {
      const from = i === 0 ? d.fromYear : phases[i - 1].until;
      const to = Math.min(i === phases.length - 1 ? end : ph.until - 1, end);
      if (from > to) return null;
      const rec = { from, to, snap: ph.snap };
      if (ph.overview) rec.overview = ph.overview;
      (snapUse[ph.snap] = snapUse[ph.snap] || []).push({ dynasty: d.key, from, to });
      return rec;
    })
    .filter(Boolean);
  if (!out.length) return null;
  const o = { key: d.key, title: d.title, from: d.fromYear, to: end, tint: d.tint, phases: out };
  const enName = dynastyName(d);
  if (enName) o.title_en = enName;
  if (d.seat) o.seat = d.seat;
  return o;
}).filter(Boolean);

// ---------- 快照可用性 + prefRef/regionRef 继承链 ----------
// 与官方 _hydrateSnapshots 一致：按 key 顺序解析，使链式引用结果相同。
const lists = {};
for (const [key, s] of Object.entries(SNAPSHOTS)) {
  if (key !== 'neighbors') lists[key] = { polities: s.polities, prefectures: s.prefectures, regions: s.regions };
}
for (const [key, s] of Object.entries(SNAPSHOTS)) {
  if (key === 'neighbors') continue;
  const l = lists[key];
  if (s.prefRef && (!l.prefectures || !l.prefectures.length) && lists[s.prefRef]) {
    l.prefectures = lists[s.prefRef].prefectures || [];
  }
  if (s.regionRef && (!l.regions || !l.regions.length) && lists[s.regionRef]) {
    l.regions = lists[s.regionRef].regions || [];
  }
}

const snapshots = {};
for (const [key, l] of Object.entries(lists)) {
  if (!snapUse[key]) continue; // 1949 之后的阶段不导出
  snapshots[key] = {
    polities: (l.polities || []).length,
    regions: (l.regions || []).length,
    prefectures: (l.prefectures || []).length,
  };
  const s = SNAPSHOTS[key];
  if (s.prefRef) snapshots[key].prefRef = s.prefRef;
  if (s.regionRef) snapshots[key].regionRef = s.regionRef;
  if (s.caption) snapshots[key].caption = s.caption;
}

// ---------- 写产物 ----------
fs.mkdirSync(outDir, { recursive: true });
const files = ['map_data.js', 'china_geo_data.js', 'atlas_snapshots.js'];
if (args.i18n) files.push('i18n_dict.js');
let bytes = 0;
for (const f of files) {
  const b = fs.readFileSync(path.join(jsDir, f));
  fs.writeFileSync(path.join(outDir, f), b);
  bytes += b.length;
  console.log(`  ${f.padEnd(22)} ${(b.length / 1024).toFixed(0).padStart(6)} KB`);
}

let nSettle = 0;
let nMilestone = 0;
for (const d of DYNASTY_DATA) {
  nSettle += (d.settlements || []).length;
  nMilestone += (d.milestones || []).length;
}

const index = {
  name: 'jiangshan-map (china)',
  source: 'https://github.com/DeanChensj/jiangshan-map',
  license: 'GPL-3.0；府州级边界与战国疆域派生自 CHGIS V6 与 Hartwell 数据集，保留学术、非商业使用条款',
  note: '历史疆域与政区边界为示意级近似，非测绘级国界。年份为负 = 公元前（无公元 0 年）',
  crs: 'EPSG:4326 (lon, lat)',
  coverage: `${DYNASTY_DATA[0].fromYear} .. ${CUTOFF - 1}`,
  files: {
    dynasties: 'map_data.js',
    snapshots: 'atlas_snapshots.js',
    hydro: 'china_geo_data.js',
    i18n: args.i18n ? 'i18n_dict.js' : null,
  },
  layers: {
    polity: '政权（王朝 / 并立政权）',
    region: '高层政区（道 / 路 / 省）',
    prefecture: '府州',
    settlements: `历代城邑点 ${nSettle} 个（古今名对照 + 都城标记）`,
    milestones: `历史事件点 ${nMilestone} 个`,
    corridors: `长城 / 运河 / 道路 / 海路 ${(W.CORRIDOR_DATA || []).length} 条`,
  },
  dynasties,
  snapshots,
};
const idxPath = path.join(outDir, 'index.json');
fs.writeFileSync(idxPath, JSON.stringify(index, null, 1) + '\n');
bytes += fs.statSync(idxPath).size;
console.log(`  ${'index.json'.padEnd(22)} ${(fs.statSync(idxPath).size / 1024).toFixed(0).padStart(6)} KB`);

const nPhases = dynasties.reduce((a, d) => a + d.phases.length, 0);
console.log(
  `[done] ${dynasties.length} 朝代 / ${nPhases} 阶段 / ${Object.keys(snapshots).length} 快照，` +
  `资产 ${(bytes / 1e6).toFixed(2)} MB → ${outDir}`
);
