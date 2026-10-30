/**
 * 标注坐标体检工具
 * ------------------------------------------------------------------
 * 用途：图层数据里点标注的坐标是否与「名称/描述里提到的行政区划」对得上。
 * 起因：用户质疑"葛洲坝怎么落在长江流域"——核对后坐标是对的（宜昌 111.27, 30.73，
 *       葛洲坝本就在长江干流上），但这类"看着不对"的点靠肉眼逐个查不现实，
 *       于是做成可复跑的体检脚本，全库扫描。
 *
 * 检查项：
 *   1. 坐标缺失 / NaN / 越界 / (0,0) 这类明显异常
 *   2. 名称或描述里提到中国省级行政区 → 坐标必须落在该省 bbox 内
 *   3. 名称或描述里提到世界国家/地区 → 坐标必须落在该国 bbox 内
 *
 * 用法：node tools/validate-coords.mjs
 * 说明：bbox 为教学级粗略范围（含周边缓冲区），只用来抓"明显错位"，不做精确判定。
 */

import { readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const LAYER_DIR = path.resolve('src/layers');

// ====== 中国省级行政区 bbox [west, south, east, north]（粗略，含少量缓冲） ======
const CN_PROVINCES = {
  北京: [115.4, 39.4, 117.6, 41.2], 天津: [116.6, 38.4, 118.2, 40.4],
  河北: [113.3, 35.9, 120.0, 42.7], 山西: [110.1, 34.4, 114.7, 40.9],
  内蒙古: [97.1, 37.3, 126.2, 53.5], 辽宁: [118.7, 38.6, 125.9, 43.6],
  吉林: [121.5, 40.8, 131.4, 46.4], 黑龙江: [121.1, 43.3, 135.2, 53.7],
  上海: [120.7, 30.6, 122.2, 32.0], 江苏: [116.2, 30.6, 122.0, 35.2],
  浙江: [118.3, 26.9, 123.1, 31.3], 安徽: [114.8, 29.3, 119.8, 34.8],
  福建: [115.7, 23.4, 120.8, 28.4], 江西: [113.5, 24.4, 118.6, 30.2],
  山东: [114.7, 34.2, 122.8, 38.5], 河南: [110.3, 31.3, 116.8, 36.5],
  湖北: [108.3, 28.9, 116.2, 33.4], 湖南: [108.7, 24.5, 114.4, 30.2],
  广东: [109.6, 20.1, 117.4, 25.7], 广西: [104.4, 20.8, 112.2, 26.5],
  海南: [108.5, 17.9, 111.2, 20.3], 重庆: [105.2, 28.1, 110.3, 32.4],
  四川: [97.3, 26.0, 108.7, 34.4], 贵州: [103.5, 24.5, 109.7, 29.4],
  云南: [97.4, 21.0, 106.3, 29.4], 西藏: [78.1, 26.8, 99.2, 36.6],
  陕西: [105.4, 31.6, 111.4, 39.7], 甘肃: [92.2, 32.5, 108.8, 42.9],
  青海: [89.3, 31.5, 103.2, 39.4], 宁夏: [104.2, 35.1, 107.8, 39.5],
  新疆: [73.4, 34.2, 96.5, 49.3], 台湾: [119.5, 21.8, 122.1, 25.4],
  香港: [113.8, 22.1, 114.5, 22.6], 澳门: [113.5, 22.1, 113.7, 22.3],
};

// ====== 世界国家/地区 bbox（粗略） ======
const COUNTRIES = {
  埃及: [24.6, 21.7, 37.0, 31.8], 希腊: [19.2, 34.7, 28.4, 41.8],
  意大利: [6.5, 35.4, 18.6, 47.2], 土耳其: [25.5, 35.7, 44.9, 42.2],
  伊拉克: [38.7, 28.9, 48.7, 37.5], 伊朗: [43.9, 25.0, 63.4, 39.9],
  印度: [68.0, 6.6, 97.5, 35.6], 日本: [122.8, 23.9, 146.1, 45.7],
  韩国: [124.9, 33.0, 129.7, 38.7], 朝鲜: [124.2, 37.5, 130.7, 43.0],
  英国: [-8.7, 49.8, 1.9, 61.0], 法国: [-5.2, 41.2, 9.7, 51.2],
  德国: [5.8, 47.2, 15.1, 55.2], 西班牙: [-9.4, 35.8, 4.4, 43.9],
  葡萄牙: [-9.7, 36.8, -6.1, 42.3], 俄罗斯: [19.5, 41.1, 191.0, 82.0],
  美国: [-125.1, 24.3, -66.8, 49.5], 加拿大: [-141.1, 41.6, -52.5, 83.2],
  墨西哥: [-117.2, 14.4, -86.6, 32.8], 巴西: [-74.1, -33.9, -34.7, 5.4],
  阿根廷: [-73.7, -55.2, -53.5, -21.7], 智利: [-75.8, -55.7, -66.3, -17.4],
  秘鲁: [-81.4, -18.5, -68.6, 0.1], 澳大利亚: [112.8, -43.7, 153.7, -10.0],
  新西兰: [166.3, -47.4, 178.7, -34.3], 南非: [16.4, -34.9, 33.0, -22.0],
  埃塞俄比亚: [32.9, 3.3, 48.1, 15.0], 肯尼亚: [33.8, -4.8, 42.0, 4.7],
  摩洛哥: [-13.3, 27.6, -0.9, 36.0], 阿尔及利亚: [-5.1, 18.8, 12.1, 37.2],
  突尼斯: [7.4, 30.1, 11.6, 37.5], 利比亚: [9.2, 19.4, 25.3, 33.3],
  苏丹: [21.7, 3.4, 39.1, 22.3], 沙特: [34.4, 16.3, 55.8, 32.3],
  以色列: [34.2, 29.4, 36.0, 33.4], 叙利亚: [35.0, 32.2, 42.5, 37.4],
  哈萨克斯坦: [46.4, 40.5, 87.4, 55.6], 乌兹别克斯坦: [55.8, 37.1, 71.3, 45.7],
  蒙古: [87.7, 41.5, 120.0, 52.3], 巴基斯坦: [60.8, 23.5, 77.9, 37.2],
  阿富汗: [60.4, 29.3, 75.1, 38.6], 孟加拉国: [87.9, 20.5, 92.8, 26.7],
  泰国: [97.2, 5.5, 105.7, 20.6], 越南: [102.0, 8.3, 109.6, 23.5],
  印度尼西亚: [94.9, -11.1, 141.1, 6.2], 菲律宾: [116.8, 4.5, 126.7, 21.2],
  马来西亚: [99.6, 0.8, 119.3, 7.4], 缅甸: [92.2, 7.9, 101.2, 28.5],
  柬埔寨: [102.3, 10.4, 107.7, 14.7], 老挝: [100.1, 13.9, 107.7, 22.5],
  尼泊尔: [80.0, 26.3, 88.2, 30.5], 斯里兰卡: [79.6, 5.9, 81.9, 9.9],
};

// 历史国名/政区名：与现代国家或省份同名，出现在"战国/诸侯/朝代"语境里要跳过，
// 否则"郑国渠（战国韩国水工郑国）"会被误判成坐标应在朝鲜半岛。
const HISTORICAL_HINT = /(战国|诸侯|春秋|先秦|秦末|楚汉|三国|十六国|南北朝|五代十国|古国|王朝|汗国|帝国|大汗国|苏丹国|王国|公国|城邦|藩国|属国|西域|安息|贵霜|罗马|波斯|亚历山大|蒙古|突厥|秦王|秦王政|秦始皇|汉武帝|唐|宋|元|明|清|公元前|前\d{2,4}年)/;
const HISTORICAL_NAMES = new Set(['韩国', '魏国', '赵国', '楚国', '燕国', '齐国', '秦国', '吴国', '越国', '蜀国', '陈国', '蔡国', '鲁国', '宋国', '郑国', '卫国', '中山']);

// 经度归一到 [base, base+360)，兼顾俄罗斯这类跨 ±180 的 bbox
function normLon(lon, base = -180) {
  let x = lon;
  while (x < base) x += 360;
  while (x >= base + 360) x -= 360;
  return x;
}

function inBox(lon, lat, box) {
  const [w, s, e, n] = box;
  if (lat < s || lat > n) return false;
  // bbox 用连续经度表达（如俄罗斯 19.5→191），把待判经度也转到同一区间
  const x = normLon(lon, w);
  return x >= w && x <= (w < e ? e : e + 360);
}

// 海洋/海底地物：坐标本来就在公海，描述里提到邻国属正常（如"马里亚纳海沟：菲律宾以东"），
// 区域匹配对它们没有意义，降级为跳过。
const OCEAN_HINT = /(海峡|海沟|海盆|海岭|海脊|洋|海域|深海|海底|海沟|海湾|海角|岛屿以东|以东|以西)/;

function checkPoint(name, desc, lon, lat, where) {
  const issues = [];
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return [{ level: 'error', msg: '坐标缺失或非法', where }];
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) issues.push({ level: 'error', msg: `坐标越界 (${lon}, ${lat})`, where });
  if (lon === 0 && lat === 0) issues.push({ level: 'warn', msg: '坐标恰为 (0,0)，多半没填', where });

  // 只拿「本点自己的文字」判定：路线 stops 会继承整条线路的描述
  // （如"海上丝路主线（南海→波斯湾/红海）"里提到印度，若沿用则会把每个航点都误报）。
  const text = `${name} ${desc ?? ''}`;
  const historical = HISTORICAL_HINT.test(text);
  if (OCEAN_HINT.test(name) || (desc && OCEAN_HINT.test(desc))) return issues; // 海洋地物不做区域判定
  // "太行山东麓"里的"山东"不是山东省；"太湖南岸"里的"湖南"不是湖南省
  const shandongIsProvince = !/山(?=东麓)/.test(text);
  const hunanIsProvince = !/湖(?=南岸)/.test(text);
  // 省级（含"四川-云南交界"这类写法）
  const cnHits = Object.keys(CN_PROVINCES).filter(
    (k) =>
      text.includes(k) &&
      (k !== '山东' || shandongIsProvince) &&
      (k !== '湖南' || hunanIsProvince)
  );
  if (cnHits.length && !cnHits.some((k) => inBox(lon, lat, CN_PROVINCES[k]))) {
    issues.push({ level: 'warn', msg: `文字提到【${cnHits.join('/')}】但坐标 (${lon}, ${lat}) 不在其范围内`, where });
  }
  let cHits = Object.keys(COUNTRIES).filter((k) => text.includes(k));
  if (historical) cHits = cHits.filter((k) => !HISTORICAL_NAMES.has(k));
  if (cHits.length && !cHits.some((k) => inBox(lon, lat, COUNTRIES[k]))) {
    issues.push({ level: 'warn', msg: `文字提到【${cHits.join('/')}】但坐标 (${lon}, ${lat}) 不在其范围内`, where });
  }
  return issues;
}

const files = (await readdir(LAYER_DIR)).filter((f) => f.endsWith('.js'));
const all = [];
let pointCount = 0;

for (const f of files) {
  let mod;
  try { mod = await import(pathToFileURL(path.join(LAYER_DIR, f)).href); }
  catch { continue; }
  const layer = mod.LAYER;
  if (!layer || !Array.isArray(layer.groups)) continue;
  for (const g of layer.groups) {
    for (const e of g.entities) {
      const where = `${f} › ${g.name} › ${e.name}`;
      if (e.type === 'point') {
        pointCount++;
        all.push(...checkPoint(e.name, e.description, e.lon, e.lat, where));
      }
      if (Array.isArray(e.stops)) {
        for (const st of e.stops) {
          pointCount++;
          // 站点只用自身名称/描述，不继承整条线路描述（见 checkPoint 说明）
          all.push(...checkPoint(st.name ?? e.name, st.description, st.lon, st.lat, where));
        }
      }
    }
  }
}

const errors = all.filter((i) => i.level === 'error');
const warns = all.filter((i) => i.level === 'warn');
console.log(`扫描 ${files.length} 个图层文件，${pointCount} 个点标注`);
console.log(`错误 ${errors.length} · 可疑 ${warns.length}\n`);
for (const i of errors) console.log(`❌ ${i.msg}  @ ${i.where}`);
for (const i of warns) console.log(`⚠️  ${i.msg}  @ ${i.where}`);
if (!errors.length && !warns.length) console.log('✅ 未发现明显错位');
