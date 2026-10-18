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
  // c) 巡游 MANUAL 跟随补丁（2026-10-18 用户反馈：右上角控件须绕「巡游物」而非球体）：
  //    相机 lookAt(巡游物) 时 transform≠单位阵，cesium-navigation 原版用 globe.pick 取焦点会绕球体。
  //    以下三处让 getCameraFocus / zoom / reset 在 lookAt 帧改取参考系原点(巡游物)。
  s = patchNavLookAt(file, s);
  if (s !== before) {
    writeFileSync(file, s);
    patched++;
  }
}
console.log(`[vendor] cesium-navigation -> public/vendor/cesium-navigation/（修复 ${patched} 个文件）`);

/**
 * 巡游 MANUAL 跟随补丁：仅对 cesium-navigation 的三个文件做精准字符串替换。
 * 全部针对 node_modules 原始文本（cpSync 已还原），每次 npm run vendor 都重新生成+重打，幂等。
 * @param {string} file 目标文件路径
 * @param {string} s 当前文件内容
 * @returns {string} 打过补丁的内容
 */
function patchNavLookAt(file, s) {
  const base = file.split(/[\\/]/).pop();
  if (base === 'Utils.js') {
    // 导入 Matrix4（锚点：SceneMode } 结尾的 cesium 导入）
    s = s.replace(/SceneMode } from 'cesium'/, "SceneMode, Matrix4 } from 'cesium'");
    // getCameraFocus：在 lookAt 参考系下返回参考系原点(巡游物)而非球面子拾取。
    // 锚点：getCameraFocus 内唯一的 `if (defined(terria.trackedEntity)) {`。
    const LOOKAT_BRANCH =
      "  // === 巡游 MANUAL 跟随：相机处于 lookAt 参考系（transform≠单位阵，由 rocket.js 每帧\n" +
      "  //     camera.lookAt(巡游物) 维持）时，焦点必须是参考系原点（巡游物本体），而非球体表面\n" +
      "  //     拾取点。否则指南针/缩放会绕球体转、巡游物跑偏；常态/AUTO(transform=单位阵)仍走原逻辑。\n" +
      "  if (!Matrix4.equalsEpsilon(camera.transform, Matrix4.IDENTITY, 1e-8)) {\n" +
      "    Matrix4.getTranslation(camera.transform, result)\n" +
      "    if (scene.mode === SceneMode.SCENE2D || scene.mode === SceneMode.COLUMBUS_VIEW) {\n" +
      "      result = camera.worldToCameraCoordinatesPoint(result, result)\n" +
      "      if (inWorldCoordinates) {\n" +
      "        result = scene.globe.ellipsoid.cartographicToCartesian(scene.mapProjection.unproject(result, unprojectedScratch), result)\n" +
      "      }\n" +
      "    } else if (!inWorldCoordinates) {\n" +
      "      result = camera.worldToCameraCoordinatesPoint(result, result)\n" +
      "    }\n" +
      "    return result\n" +
      "  }\n\n";
    s = s.replace("  if (defined(terria.trackedEntity)) {", LOOKAT_BRANCH + "  if (defined(terria.trackedEntity)) {");
  } else if (base === 'ZoomNavigationControl.js') {
    // 导入 Matrix4（锚点：SceneMode } 结尾的 cesium 导入）
    s = s.replace(/SceneMode } from 'cesium'/, "SceneMode, Matrix4 } from 'cesium'");
    // zoom：lookAt 帧与 trackedEntity 同理——相机位置是「相对巡游物的局部偏移」，直接改 camera.position
    // （局部帧），不要 flyTo（世界坐标会错）；下一帧 applyManualFollow 从新 range 复算并保留反穿球钳制。
    s = s.replace(
      /if \(defined\(this\.terria\.trackedEntity\) \|\| scene\.mode === SceneMode\.COLUMBUS_VIEW\) \{/,
      "var inLookAtFrame = !Matrix4.equalsEpsilon(camera.transform, Matrix4.IDENTITY, 1e-8)\n" +
      "        if (defined(this.terria.trackedEntity) || scene.mode === SceneMode.COLUMBUS_VIEW || inLookAtFrame) {"
    );
  } else if (base === 'ResetViewNavigationControl.js') {
    // 导入 Matrix4（锚点：import 块末尾的 Math as CesiumMath, }）
    s = s.replace(/Math as CesiumMath,\n\}/, "Math as CesiumMath,\n  Matrix4,\n}");
    // reset：lookAt 帧下 flyTo 世界坐标默认视角会与 rocket.js 每帧 applyManualFollow 抢相机抖动，
    // 直接释放参考系回到自由机位（下一帧 applyManualFollow 仍把关注点钉回巡游物，故为安全 no-op）。
    s = s.replace(
      "  var camera = scene.camera;",
      "  var camera = scene.camera;\n\n" +
      "  if (!Matrix4.equalsEpsilon(camera.transform, Matrix4.IDENTITY, 1e-8)) {\n" +
      "    camera.lookAtTransform(Matrix4.IDENTITY);\n" +
      "    this.isActive = false;\n" +
      "    return;\n" +
      "  }"
    );
  }
  return s;
}
