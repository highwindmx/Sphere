// 卫星影像瓦片下载进度监控
// 用法（cwd 任意都可，会自动解析 sphere 根目录）：
//   node scripts/check-sat-progress.mjs [列表文件] [输出目录]
//   node scripts/check-sat-progress.mjs satellite-tiles-aria2.txt
//
// 默认自动探测：
//   列表文件: satellite-tiles-aria2.txt / satellite-tiles-url.txt / all-urls.txt（sphere 根目录）
//   输出目录: <sphere>/public/tiles/satellite
//   sphere 根目录: 取本脚本所在目录的上两级（scripts/check-sat-progress.mjs → sphere）

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 自动定位 sphere 根目录（脚本在 sphere/scripts/ 下）
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SPHERE_ROOT = resolve(SCRIPT_DIR, '..');

const OUT_DEFAULT_ABS = join(SPHERE_ROOT, 'public', 'tiles', 'satellite');
const CANDIDATE_LISTS = [
  'satellite-tiles-aria2.txt',
  'satellite-tiles-url.txt',
  'all-urls.txt'
];

function resolveAbs(p, base) {
  return resolve(base, p);
}

function findListFile(arg) {
  const candidates = [];
  if (arg) candidates.push(resolveAbs(arg, process.cwd()));
  for (const f of CANDIDATE_LISTS) candidates.push(join(SPHERE_ROOT, f));
  for (const c of candidates) if (existsSync(c)) return c;
  console.error('找不到列表文件。用法: node scripts/check-sat-progress.mjs <listfile>');
  process.exit(1);
}

// URL 尾部 /tile/{z}/{y}/{x} → 期望保存路径 {z}/{x}/{y}.jpg
// ArcGIS tile URL 是 {z}/{y}/{x}，和 Cesium {z}/{x}/{y} 顺序相反
function urlToSaveRelPath(url) {
  const m = url.match(/tile\/(\d+)\/(\d+)\/(\d+)/);
  if (!m) return null;
  const [, z, y, x] = m;
  return `${z}/${x}/${y}.jpg`;
}

function listAllFiles(root) {
  const files = [];
  if (!existsSync(root)) return files;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(root);
  return files;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmt(n) { return n.toLocaleString(); }

// ---------- main ----------
const listFile = findListFile(process.argv[2]);
const outDirAbs = process.argv[3] ? resolve(process.argv[3]) : OUT_DEFAULT_ABS;

console.log(`📋 列表文件: ${listFile}`);
console.log(`📁 输出目录: ${outDirAbs}`);
console.log(`🌐 sphere根: ${SPHERE_ROOT}`);

// 解析列表
const raw = readFileSync(listFile, 'utf-8');
const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

// 两种格式：
//   aria2: URL + 下一行 out=完整路径（Windows 反斜杠或正斜杠）
//   url-only: 每行一个 URL
// 我们统一抽 URL 列表
const urls = [];
for (let i = 0; i < lines.length; i++) {
  if (lines[i].startsWith('http')) urls.push(lines[i]);
}
const total = urls.length;
console.log(`🎯 总任务数: ${fmt(total)}`);

// 全部目标
const allTargets = new Set(urls.map(urlToSaveRelPath).filter(Boolean));

// 扫描输出目录所有文件
const localAll = listAllFiles(outDirAbs);
const localMap = new Map(); // relPath → size
for (const p of localAll) {
  const rel = resolveOutDirPath(p);
  if (rel) localMap.set(rel, statSync(p).size);
}

function resolveOutDirPath(absP) {
  // 把绝对路径转成相对于 outDirAbs 的 {z}/{x}/{y}.jpg
  const rel = absP.slice(outDirAbs.length).replace(/\\/g, '/').replace(/^\//, '');
  // 处理 aria2 半成品文件名 out=path.jpg + 后缀
  if (rel.endsWith('.aria2')) {
    const core = rel.replace(/\.aria2$/, '');
    if (core.endsWith('.jpg')) return core;
  }
  if (rel.endsWith('.jpg')) return rel;
  return null; // 不是 jpg 或 aria2-jpg，跳过
}

let done = 0, doneBytes = 0, partial = 0;
const missing = [];
for (const target of allTargets) {
  if (localMap.has(target)) { done++; doneBytes += localMap.get(target); }
  else missing.push(target);
}
// 数半成品：本地有 xxx.jpg.aria2 但 xxx.jpg 不完整
partial = localAll.filter(p => p.endsWith('.jpg.aria2')).length;

const pct = total > 0 ? ((done / total) * 100).toFixed(1) : '0.0';
const barWidth = 30;
const filled = Math.round((done / Math.max(total, 1)) * barWidth);
const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
const etaHint = done > 0 ? `≈ ${Math.round(doneBytes / done * (total - done) / 1024 / 1024)} MB 剩余` : '';

console.log('\n═══════════════════════════════════════════════');
console.log(`  进度: ${bar}  ${pct}%`);
console.log(`  ✓ 已下载: ${fmt(done)} / ${fmt(total)}   ${formatSize(doneBytes)}`);
console.log(`  ✗ 未完成: ${fmt(total - done)}   ${etaHint}`);
console.log(`  ⚠  半成品(.aria2): ${partial}`);
console.log('═══════════════════════════════════════════════');

if (partial > 0) {
  console.log('\n💡 重跑 aria2c -i 同一列表，自动续传半成品 + 覆盖完整文件。');
}
if (missing.length > 0 && missing.length <= 15) {
  console.log('\n缺失示例（前 15）:');
  for (const m of missing.slice(0, 15)) console.log(`  ${m}`);
}
