// Скан кейвордов оружейных профилей BSData.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'public/BSData/wh40k-11e';
const counts = new Map();

function walk(node) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const chars = node.characteristics;
  if (Array.isArray(chars)) {
    const kw = chars.find((c) => c.name === 'Keywords');
    if (kw) {
      const text = String(kw.$text ?? kw.value ?? '').trim();
      if (text !== '') {
        for (const k of text.split(',')) {
          const key = k.trim();
          if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
    }
  }
  for (const key of Object.keys(node)) walk(node[key]);
}

for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  walk(JSON.parse(readFileSync(join(dir, file), 'utf8')));
}

const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
writeFileSync('kw-report.txt', sorted.map(([k, v]) => `${k}: ${v}`).join('\n'), 'utf8');
console.log('unique keywords: ' + counts.size);
