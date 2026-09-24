// Пробник: структура распарсенных даташитов для адаптера боя.
import { writeFileSync } from 'node:fs';
const { loadBsData } = await import('../src/bsdata/load.ts');
const { bsFilesFromDir } = await import('../src/bsdata/node-source.ts');
const { parseBsDatabase } = await import('../src/bsdata/units.ts');
const { sizeRangeOf } = await import('../src/bsdata/points.ts');

const db = loadBsData(bsFilesFromDir('public/BSData/wh40k-11e'));
const { datasheets } = parseBsDatabase(db);

const names = ['Boyz', 'Intercessor Squad', 'Deff Dread', 'Warboss', 'Necron Warriors'];
const out = [];
for (const name of names) {
  const ds = datasheets.find((d) => d.name === name);
  if (!ds) {
    out.push(`${name}: НЕ НАЙДЕН`);
    continue;
  }
  out.push(`=== ${name} kind=${ds.kind} size=${JSON.stringify(sizeRangeOf(ds))} keywords=${ds.keywords.slice(0, 8).join('|')} ===`);
  for (const group of ds.modelGroups) {
    out.push(` group ${group.name} [${group.min}-${group.max}]`);
    for (const v of group.variants) {
      out.push(`  variant ${v.name} [${v.min}-${v.max}] profile=${JSON.stringify(v.profile)}`);
      const dump = (items, pad) => {
        for (const it of items) {
          out.push(
            `${pad}${it.kind} "${it.name}" [${it.min}-${it.max}] unitMax=${it.unitWideMax} cost=${it.cost} weapons=${it.profiles
              .map((p) => `${p.kind}:${p.name}(A=${p.attacks},${p.skill},S=${p.strength},AP=${p.ap},D=${p.damage},${p.keywords.join('/')})`)
              .join(' ')}`,
          );
          dump(it.nested, `${pad}  `);
        }
      };
      dump(v.defaultWargear, '   def ');
      dump(v.optionalWargear, '   opt ');
      for (const cg of v.choiceGroups) {
        out.push(`   choiceGroup "${cg.name}" [${cg.min}-${cg.max}]`);
        dump(cg.choices, '    c ');
      }
    }
  }
}
writeFileSync('adapt-probe.txt', out.join('\n'), 'utf8');
console.log('done');
