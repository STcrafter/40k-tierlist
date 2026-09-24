// Ищет определения правил кейвордов в gameSystem (Warhammer 40,000.json).
import { readFileSync, writeFileSync } from 'node:fs';

const doc = JSON.parse(readFileSync('public/BSData/wh40k-11e/Warhammer 40,000.json', 'utf8'));
const wanted = [
  'rapid fire', 'sustained hits', 'lethal hits', 'devastating wounds', 'torrent',
  'heavy', 'blast', 'melta', 'twin', 'pistol', 'close quarters', 'close-quarters',
  'assault', 'indirect', 'lance', 'extra attacks', 'ignores cover', 'precision',
  'one shot', 'hazardous', 'anti-', 'cleave',
];
const found = new Map();

function walk(node) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const name = typeof node.name === 'string' ? node.name : '';
  const desc = typeof node.description === 'string' ? node.description : '';
  if (name && name.length < 70 && desc.length > 20) {
    const lname = name.toLowerCase();
    if (wanted.some((w) => lname.includes(w)) && !found.has(name)) {
      found.set(name, { name, description: desc });
    }
  }
  for (const key of Object.keys(node)) walk(node[key]);
}

walk(doc);
const out = [...found.values()].map((r) => `=== ${r.name} ===\n${r.description}`).join('\n\n');
writeFileSync('core-rules.txt', out.slice(0, 60000), 'utf8');
console.log('found: ' + found.size);
