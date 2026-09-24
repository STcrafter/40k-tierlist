/**
 * CLI: тирлист — damage / survivability / utility → Total Score → тиры.
 *
 *   node scripts/tier-report.ts                          — весь набор
 *   node scripts/tier-report.ts --faction=Orks            — только орки
 *   node scripts/tier-report.ts --tier=S                 — только один тир
 *   node scripts/tier-report.ts --limit=40 --size=max    — топ-40 полных отрядов
 *   node scripts/tier-report.ts --trials=100 --size=max
 *   node scripts/tier-report.ts --json=tiers.json --flags — с флагами полезности
 */

import { writeFileSync } from 'node:fs';
import { bsFilesFromDir } from '../src/bsdata/node-source.ts';
import { loadBsData, parseBsDatabase } from '../src/bsdata/index.ts';
import { adaptUnit } from '../src/combat/adapter.ts';
import { isEligibleForCalculations } from '../src/combat/budget.ts';
import { tierList, type TierRow } from '../src/tier/scoring.ts';
import type { BsDatasheet } from '../src/bsdata/types.ts';

const argv = process.argv.slice(2);
const flagValue = (name: string): string | null => {
  const found = argv.find((arg) => arg.startsWith(`--${name}=`));
  return found === undefined ? null : found.slice(name.length + 3);
};

const trials = Number(flagValue('trials') ?? 60);
const size = (flagValue('size') ?? 'min') as 'min' | 'max';
const distance = Number(flagValue('distance') ?? 12);
const factionFilter = flagValue('faction');
const tierFilter = flagValue('tier');
const limit = Number(flagValue('limit') ?? 0);
const showFlags = argv.includes('--flags');
const jsonOut = flagValue('json');

const { datasheets } = parseBsDatabase(loadBsData(bsFilesFromDir('public/BSData/wh40k-11e')));
const selected = factionFilter
  ? datasheets.filter((d) => d.faction.toLowerCase().includes(factionFilter.toLowerCase()))
  : datasheets;

console.log(`Прогонов на замер: ${trials}, размер отряда: ${size}, дистанция: ${distance}"`);
console.log('Считаю метрики (это надолго: три Монте-Карло на юнит)…');

const started = Date.now();
const entries: Array<{ datasheet: BsDatasheet; unit: ReturnType<typeof adaptUnit>['unit']; points: number }> = [];
for (const datasheet of selected) {
  const adapted = adaptUnit(datasheet, { size });
  if (adapted.unit.models.length === 0 || !isEligibleForCalculations(datasheet.name, adapted.points)) continue;
  entries.push({ datasheet, unit: adapted.unit, points: adapted.points });
}

const rows: TierRow[] = tierList(entries, {
  combat: { trials, distance },
  survival: { trials, maxRounds: 20, distance },
});
console.log(`Готово за ${((Date.now() - started) / 1000).toFixed(1)} с, юнитов: ${rows.length}`);

const fmt = (value: number): string => value.toFixed(1).padStart(6);
const visible = rows
  .filter((row) => tierFilter === null || row.tier === tierFilter.toUpperCase())
  .slice(0, limit > 0 ? limit : undefined);

console.log('');
console.log('=== ТИРЛИСТ ===');
console.log(
  '  юнит'.padEnd(30) +
    'тир'.padEnd(4) +
    'тип'.padEnd(7) +
    'лот'.padEnd(11) +
    'очки'.padStart(5) +
    'урон'.padStart(7) +
    'живуч'.padStart(7) +
    'утил'.padStart(6) +
    'TOTAL'.padStart(8) +
    'проц'.padStart(6)
);
for (const row of visible) {
  console.log(
    `  ${row.name.slice(0, 28).padEnd(30)}${row.tier.padEnd(4)}${row.unitType.padEnd(7)}` +
      `${row.bestSlot.padEnd(11)}${String(row.points).padStart(5)}` +
      `${fmt(row.normDamage)}${fmt(row.normSurvivability)}${fmt(row.normUtility)}` +
      `${fmt(row.totalScore)}${fmt(row.percentile)}`
  );
  if (showFlags) {
    console.log(
      `      флаги: ${row.utilityFlags.map((f) => `${f.id}(+${f.points})`).join(', ') || '—'}` +
        `  [${row.utilityScore} из 20]  штраф: ×${row.tax.damage}/${row.tax.survivability}`
    );
  }
}

const counts: Record<string, number> = {};
for (const row of rows) counts[row.tier] = (counts[row.tier] ?? 0) + 1;
console.log('');
console.log('=== Распределение по тирам ===');
for (const tier of ['S', 'A', 'B', 'C', 'D'] as const) {
  const n = counts[tier] ?? 0;
  console.log(`  ${tier}: ${n} (${((n / Math.max(1, rows.length)) * 100).toFixed(1)}%)`);
}

if (jsonOut !== null) {
  writeFileSync(jsonOut, JSON.stringify(rows, null, 2), 'utf8');
  console.log(`\nJSON: ${jsonOut}`);
}
