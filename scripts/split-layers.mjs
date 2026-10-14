// 把 extracted-layers.json 拆成 src/layers/<id>.js
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const layers = JSON.parse(readFileSync('extracted-layers.json', 'utf-8'));
const outDir = 'src/layers';
mkdirSync(outDir, { recursive: true });

for (const LAYER of layers) {
  const code = `// Auto-rebuilt from extracted-layers.json — DO NOT HAND-EDIT
export const LAYER = ${JSON.stringify(LAYER, null, 2)};
`;
  writeFileSync(join(outDir, `${LAYER.id}.js`), code);
}

console.log(`Wrote ${layers.length} layer files to ${outDir}/`);
console.log(`IDs: ${layers.map(l => l.id).join(', ')}`);
