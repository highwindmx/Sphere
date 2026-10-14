import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const distPath = resolve(__dirname, '../dist/assets/index--AIpTfEu.js');
const outputPath = resolve(__dirname, '../extracted-layers.json');

console.log('Reading:', distPath);
const src = readFileSync(distPath, 'utf8');
console.log('File length:', src.length);

// ============ 辅助函数定义（从 minified JS 中提取的 helper 函数）============

// function Nt(e){const t=[];for(let n=-180;n<=180;n+=5)t.push([n,e]);return t}
// 生成一条纬线：经度从 -180 到 180，间隔 5 度
function Nt(lat) {
  const result = [];
  for (let lon = -180; lon <= 180; lon += 5) {
    result.push([lon, lat]);
  }
  return result;
}

// ============ 步骤1: 找到所有图层变量名 ============
const arrayMatch = src.match(/Ke=\[([^\]]+)\]/);
if (!arrayMatch) {
  console.error('ERROR: Could not find Ke array of layer variables');
  process.exit(1);
}
const varNames = arrayMatch[1].split(',').map(s => s.trim()).filter(Boolean);
console.log(`Found ${varNames.length} layer variable names:`, varNames.join(', '));

// ============ 步骤2: 提取每个变量的完整对象字符串 ============
function extractObject(src, varName) {
  const pattern = new RegExp(`\\b${varName}\\s*=`);
  const m = src.match(pattern);
  if (!m) {
    console.warn(`  WARNING: Could not find definition for ${varName}`);
    return null;
  }
  
  let pos = m.index + varName.length;
  while (pos < src.length && (src[pos] === '=' || src[pos] === ' ' || src[pos] === '\t')) {
    pos++;
  }
  
  if (pos >= src.length || src[pos] !== '{') {
    console.warn(`  WARNING: ${varName} definition not followed by { at pos ${pos}`);
    return null;
  }
  
  // 括号匹配（跳过字符串内的括号）
  let depth = 0;
  let endIdx = -1;
  let inString = false;
  let stringChar = '';
  let escaped = false;
  
  for (let i = pos; i < src.length; i++) {
    const ch = src[i];
    
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === stringChar) {
        inString = false;
      }
      continue;
    }
    
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      continue;
    }
    
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  
  if (endIdx === -1) {
    console.warn(`  WARNING: Could not find matching closing brace for ${varName}`);
    return null;
  }
  
  return src.slice(pos, endIdx + 1);
}

// ============ 步骤3: 处理对象字符串 ============

// 预处理: 修复 .数字 → 0.数字
function fixLeadingDots(jsStr) {
  let result = '';
  let i = 0;
  while (i < jsStr.length) {
    if (jsStr[i] === '"' || jsStr[i] === "'") {
      // 字符串原样复制
      const quote = jsStr[i];
      result += quote;
      i++;
      while (i < jsStr.length && jsStr[i] !== quote) {
        if (jsStr[i] === '\\') {
          result += jsStr[i] + jsStr[i + 1];
          i += 2;
        } else {
          result += jsStr[i];
          i++;
        }
      }
      result += quote;
      i++;
    } else if (jsStr[i] === '.' && i + 1 < jsStr.length && /\d/.test(jsStr[i + 1])) {
      const prev = result[result.length - 1];
      if (prev === '-' || prev === '[' || prev === ',' || prev === ' ' || prev === ':') {
        result += '0.';
        i++;
      } else {
        result += '.';
        i++;
      }
    } else if (jsStr[i] === '-' && i + 1 < jsStr.length && jsStr[i + 1] === '.' && i + 2 < jsStr.length && /\d/.test(jsStr[i + 2])) {
      const prev = result[result.length - 1];
      if (prev === '[' || prev === ',' || prev === ' ' || prev === ':' || prev === '(') {
        result += '-0.';
        i += 2; // 跳过 "-" 和 "."
      } else {
        result += jsStr[i];
        i++;
      }
    } else {
      result += jsStr[i];
      i++;
    }
  }
  return result;
}

// 内联替换函数调用: Nt(数字) → 生成的坐标数组
function inlineHelperFunctions(jsStr) {
  let result = '';
  let i = 0;
  while (i < jsStr.length) {
    if (jsStr[i] === '"' || jsStr[i] === "'") {
      // 字符串原样复制
      const quote = jsStr[i];
      result += quote;
      i++;
      while (i < jsStr.length && jsStr[i] !== quote) {
        if (jsStr[i] === '\\') {
          result += jsStr[i] + jsStr[i + 1];
          i += 2;
        } else {
          result += jsStr[i];
          i++;
        }
      }
      result += quote;
      i++;
    } else if (jsStr.substr(i, 3) === 'Nt(') {
      // 找到 Nt( ，解析参数
      i += 3; // 跳过 "Nt("
      // 收集参数直到匹配的 ')'
      let depth = 1;
      let argStart = i;
      while (i < jsStr.length && depth > 0) {
        if (jsStr[i] === '(') depth++;
        else if (jsStr[i] === ')') {
          depth--;
          if (depth === 0) break;
        }
        i++;
      }
      const argStr = jsStr.slice(argStart, i).trim();
      i++; // 跳过 ')'
      
      // 解析参数（应该是一个数字）
      const lat = parseFloat(argStr);
      if (!isNaN(lat)) {
        const coords = Nt(lat);
        result += JSON.stringify(coords);
      } else {
        console.warn(`  WARNING: Could not parse Nt argument: ${argStr}`);
        result += '[]';
      }
    } else {
      result += jsStr[i];
      i++;
    }
  }
  return result;
}

// JS 对象字符串 → JSON
function jsObjectToJson(jsStr) {
  let result = '';
  let i = 0;
  
  while (i < jsStr.length) {
    const ch = jsStr[i];
    
    // 压缩布尔值 !0→true, !1→false
    if (ch === '!' && i + 1 < jsStr.length && (jsStr[i + 1] === '0' || jsStr[i + 1] === '1')) {
      result += jsStr[i + 1] === '0' ? 'true' : 'false';
      i += 2;
      continue;
    }
    
    if (ch === '"') {
      result += ch;
      i++;
      while (i < jsStr.length && jsStr[i] !== '"') {
        if (jsStr[i] === '\\') {
          result += jsStr[i] + jsStr[i + 1];
          i += 2;
        } else {
          result += jsStr[i];
          i++;
        }
      }
      result += '"';
      i++;
    } else if (ch === "'") {
      // 单引号 → 双引号
      result += '"';
      i++;
      while (i < jsStr.length && jsStr[i] !== "'") {
        if (jsStr[i] === '\\') {
          const next = jsStr[i + 1];
          if (next === '"') result += '"';
          else if (next === "'") result += "'";
          else if (next === 'n') result += '\\n';
          else if (next === 't') result += '\\t';
          else if (next === 'r') result += '\\r';
          else if (next === '\\') result += '\\\\';
          else result += '\\' + next;
          i += 2;
        } else if (jsStr[i] === '"') {
          result += '\\"';
          i++;
        } else {
          result += jsStr[i];
          i++;
        }
      }
      result += '"';
      i++;
    } else if (/[a-zA-Z_$]/.test(ch)) {
      // 收集标识符
      let ident = '';
      while (i < jsStr.length && /[a-zA-Z0-9_$]/.test(jsStr[i])) {
        ident += jsStr[i];
        i++;
      }
      
      let j = i;
      while (j < jsStr.length && jsStr[j] === ' ') j++;
      
      if (j < jsStr.length && jsStr[j] === ':') {
        result += '"' + ident + '"';
      } else {
        if (ident === 'undefined') result += 'null';
        else result += ident;
      }
    } else {
      result += ch;
      i++;
    }
  }
  
  return result;
}

// ============ 步骤4: 提取所有图层 ============
const layers = [];

for (const varName of varNames) {
  console.log(`Extracting ${varName}...`);
  const objStr = extractObject(src, varName);
  if (!objStr) continue;
  
  const idMatch = objStr.match(/id:"([^"]+)"/);
  const nameMatch = objStr.match(/name:"([^"]+)"/);
  const id = idMatch ? idMatch[1] : '(unknown)';
  const name = nameMatch ? nameMatch[1] : '(unknown)';
  console.log(`  Layer: id="${id}", name="${name}", size=${objStr.length}`);
  
  // 处理链: 内联函数调用 → 修复前导点 → 转 JSON
  const inlined = inlineHelperFunctions(objStr);
  const fixed = fixLeadingDots(inlined);
  const jsonStr = jsObjectToJson(fixed);
  
  try {
    const parsed = JSON.parse(jsonStr);
    layers.push(parsed);
    console.log(`  ✓ Parsed OK`);
  } catch (err) {
    console.error(`  ✗ JSON parse error for ${varName} (${id}/${name}):`, err.message);
    console.error(`  First 500 chars:`, jsonStr.slice(0, 500));
    throw err;
  }
}

// ============ 步骤5: 输出结果 ============
console.log(`\n=== Summary ===`);
console.log(`Total layers extracted: ${layers.length}`);

let totalEntities = 0;
let totalGroups = 0;
for (const layer of layers) {
  const groups = layer.groups || [];
  totalGroups += groups.length;
  for (const g of groups) {
    totalEntities += (g.entities || []).length;
  }
}
console.log(`Total groups: ${totalGroups}`);
console.log(`Total entities: ${totalEntities}`);

writeFileSync(outputPath, JSON.stringify(layers, null, 2), 'utf8');
console.log(`\n✓ Written to: ${outputPath}`);

console.log(`\n=== Layer Overview ===`);
for (const layer of layers) {
  const entityCount = (layer.groups || []).reduce((sum, g) => sum + (g.entities?.length || 0), 0);
  const entityTypes = {};
  for (const g of (layer.groups || [])) {
    for (const e of (g.entities || [])) {
      entityTypes[e.type] = (entityTypes[e.type] || 0) + 1;
    }
  }
  const typeStr = Object.entries(entityTypes).map(([t, c]) => `${t}:${c}`).join(', ');
  console.log(`  ${layer.id}: ${layer.name} (${layer.groups?.length || 0} groups, ${entityCount} entities [${typeStr}])`);
}
