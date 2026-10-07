import { bsFilesFromDir } from '../src/bsdata/node-source.ts';
import { loadBsData } from '../src/bsdata/load.ts';
import { parseBsDatabase } from '../src/bsdata/units.ts';
import { fnpOf } from '../src/bsdata/fnp.ts';
import { detectUtilityFlags } from '../src/tier/utility.ts';

const { datasheets } = parseBsDatabase(loadBsData(bsFilesFromDir('public/BSData/wh40k-11e')));

// Условный FNP 5+/6+: в отчёте виден, в бою нет.
const conditional = datasheets.filter((d) => {
  const r = fnpOf(d);
  return r.reported !== null && r.reported.threshold >= 5 && r.permanent === null;
});
console.log('условный 5+ (отчёт есть, боя нет):', conditional.length, '→', conditional.slice(0, 8).map((d) => d.name).join(' | '));

for (const name of ['Arco-Flagellants', 'Penitent Engines']) {
  const sheet = datasheets.find((d) => d.name === name);
  if (!sheet) { console.log(name, '— нет'); continue; }
  console.log(`${name}: bs=${JSON.stringify(fnpOf(sheet))} флаги=${detectUtilityFlags(sheet).filter((f) => f.id.startsWith('FNP')).map((f) => f.id).join(',') || '—'}`);
}