// tools/vendor-cesium.mjs — 把 npm 包构建产物拷贝到 public/ 供浏览器原生 ESM 直接加载
// 纯 Flask 方案无打包器：
//   - Cesium 官方构建产物 -> public/vendor/cesium/（import map: cesium -> /vendor/cesium/index.js）
//   - cesium-navigation-es6 -> public/vendor/cesium-navigation/（需修复源码：去 css import、相对导入补 .js）
// 用法：npm install 后执行 npm run vendor
import { cpSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ====== 1. Cesium 官方构建产物 ======
const CESIUM_SRC = join(ROOT, 'node_modules', 'cesium', 'Build', 'Cesium');
const CESIUM_DST = join(ROOT, 'public', 'vendor', 'cesium');

if (!existsSync(join(CESIUM_SRC, 'index.js'))) {
  console.error('[vendor] 未找到 node_modules/cesium，请先 npm install');
  process.exit(1);
}
mkdirSync(CESIUM_DST, { recursive: true });
copyFileSync(join(CESIUM_SRC, 'index.js'), join(CESIUM_DST, 'index.js'));
for (const dir of ['Workers', 'Assets', 'Widgets', 'ThirdParty']) {
  cpSync(join(CESIUM_SRC, dir), join(CESIUM_DST, dir), { recursive: true });
}
console.log('[vendor] Cesium 构建产物 -> public/vendor/cesium/');

// ====== 2. cesium-navigation-es6 ======
const NAV_SRC = join(ROOT, 'node_modules', 'cesium-navigation-es6', 'dist');
const NAV_DST = join(ROOT, 'public', 'vendor', 'cesium-navigation');

if (!existsSync(NAV_SRC)) {
  console.error('[vendor] 未找到 node_modules/cesium-navigation-es6，请先 npm install');
  process.exit(1);
}
cpSync(NAV_SRC, NAV_DST, { recursive: true });

// 递归列出所有 .js
function* walkJs(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walkJs(p);
    else if (name.endsWith('.js')) yield p;
  }
}

let patched = 0;
for (const file of walkJs(NAV_DST)) {
  let s = readFileSync(file, 'utf8');
  const before = s;
  // a) 浏览器原生 ESM 无法 import css（样式已在 index.html 用 <link> 引入）
  s = s.replace(/^import\s+["']\.\/styles\/cesium-navigation\.css["'];?\s*(\r?\n)?/m, '');
  // b) 相对导入补 .js 扩展（浏览器必须带扩展名；裸标识符 cesium 由 import map 解析，不动）
  s = s.replace(
    /(\bfrom\s*|\bimport\s*)(["'])(\.\.?\/[^"']+?)\2/g,
    (m, kw, q, spec) => (/\.(js|css|json)$/.test(spec) ? m : `${kw}${q}${spec}.js${q}`)
  );
  if (s !== before) {
    writeFileSync(file, s);
    patched++;
  }
}
console.log(`[vendor] cesium-navigation -> public/vendor/cesium-navigation/（修复 ${patched} 个文件）`);
