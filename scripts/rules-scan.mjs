// Ищет описания правил кейвордов в Library-файлах BSData.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'public/BSData/wh40k-11e';
const wanted = [
  'rapid fire', 'sustained hits', 'lethal hits', 'devastating wounds', 'torrent',
  'heavy', 'blast', 'melta', 'twin-linked', 'twin linked', 'pistol', 'close quarters',
  'close-quarters', 'assault', 'indirect fire', 'lance', 'extra attacks',
  'ignores cover', 'precision', 'one shot', 'hazardous', 'anti-', 'cleave',
];
const found = new Map();

function walk(node) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child);
    return;
  }
  if (!node || typeof node !== 'object') return;
  if (typeof node.description === 'string' && node.description.length > 30) {
    const text = node.description.toLowerCase();
    for (const w of wanted) {
      if (text.includes(w) && typeof node.name === 'string' && node.name.length < 60) {
        const key = `${node.name} :: ${node.description.slice(0, 200)}`;
        if (!found.has(key)) found.set(key, node.description);
      }
    }
  }
  for (const key of Object.keys(node)) walk(node[key]);
}

for (const file of readdirSync(dir).filter((f) => f.includes('Library'))) {
  walk(JSON.parse(readFileSync(join(dir, file), 'utf8')));
}

writeFileSync('rules-report.txt', [...found.entries()].map(([k]) => k).join('\n'), 'utf8');
console.log('found: ' + found.size);
