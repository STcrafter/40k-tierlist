/**
 * CLI: урон в раунд по типам юнитов (тирлист).
 *
 *   node scripts/damage-report.ts                          — все даташиты, таблица
 *   node scripts/damage-report.ts --units                  — только группировка по типам
 *   node scripts/damage-report.ts --datasheet=Boyz         — подробно по одному юниту
 *   node scripts/damage-report.ts --trials=200 --size=max  — больше прогонов, полный отряд
 *   node scripts/damage-report.ts --faction=Orks --limit=20
 *   node scripts/damage-report.ts --json=damage.json      — выгрузка в файл
 *
 * Печатает урон отдельно: дальнобойный, рукопашный и общий — и по каждому
 * типу цели (архетипу), и в среднем.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bsFilesFromDir } from '../src/bsdata/node-source.ts';
import { loadBsData, parseBsDatabase } from '../src/bsdata/index.ts';
import { adaptUnit } from '../src/combat/adapter.ts';
import { ARCHETYPES, archetypeOf } from '../src/combat/archetypes.ts';
import { isEligibleForCalculations } from '../src/combat/budget.ts';
import { damagePerRound, damagePerRoundByType, per100Points } from '../src/combat/perRound.ts';
import type { BsDatasheet } from '../src/bsdata/types.ts';
import type { CombatUnit } from '../src/combat/types.ts';

const argv = process.argv.slice(2);
const positional = argv.filter((arg) => !arg.startsWith('--'));
const flagValue = (name: string): string | null => {
  const found = argv.find((arg) => arg.startsWith(`--${name}=`));
  return found === undefined ? null : found.slice(name.length + 3);
};

const directory = positional.length > 0 ? resolve(positional[0]) : resolve('public/BSData/wh40k-11e');
const trials = Number(flagValue('trials') ?? 200);
const size = (flagValue('size') ?? 'min') as 'min' | 'max';
const distance = Number(flagValue('distance') ?? 12);
const factionFilter = flagValue('faction');
const limit = Number(flagValue('limit') ?? 0);
const datasheetName = flagValue('datasheet');
const jsonOut = flagValue('json');

const { datasheets } = parseBsDatabase(loadBsData(bsFilesFromDir(directory)));
console.log(`База: ${directory}`);
console.log(`Прогонов на замер: ${trials}, размер отряда: ${size}, дистанция: ${distance}"`);

const fmt = (value: number): string => value.toFixed(2).padStart(7);

/**
 * Адаптированный отряд вместе со стоимостью: классификация типа идёт по
 * ближайшему центроиду, и один из признаков — очки на модель, поэтому
 * голого CombatUnit (без цены) недостаточно.
 */
function toEntry(datasheet: BsDatasheet): { unit: CombatUnit; points: number } | null {
  const adapted = adaptUnit(datasheet, { size });
  if (adapted.unit.models.length === 0) return null;
  if (!isEligibleForCalculations(datasheet.name, adapted.points)) return null;
  return { unit: adapted.unit, points: adapted.points };
}

/** Только отряд, без цены — там, где стоимость не нужна. */
function toUnit(datasheet: BsDatasheet): CombatUnit | null {
  return toEntry(datasheet)?.unit ?? null;
}

const rows: Array<{
  faction: string;
  name: string;
  type: string;
  models: number;
  points: number;
  ranged: number;
  melee: number;
  total: number;
  /** Тот же урон, приведённый к 100 очкам стоимости отряда. */
  ranged100: number;
  melee100: number;
  total100: number;
}> = [];

const selected = factionFilter
  ? datasheets.filter((d) => d.faction.toLowerCase().includes(factionFilter.toLowerCase()))
  : datasheets;
const limited = limit > 0 ? selected.slice(0, limit) : selected;

for (const datasheet of limited) {
  const unit = toUnit(datasheet);
  if (unit === null) continue;
  const started = Date.now();
  const damage = damagePerRound(unit, { trials, distance });
  const points = adaptUnit(datasheet, { size }).points;
  const per100 = per100Points(damage, points);
  rows.push({
    faction: datasheet.faction,
    name: datasheet.name,
    type: archetypeOf(unit, points)?.id ?? 'unknown',
    models: unit.models.length,
    points,
    ranged: damage.ranged.overall.mean,
    melee: damage.melee.overall.mean,
    total: damage.total.overall.mean,
    ranged100: per100.ranged,
    melee100: per100.melee,
    total100: per100.total,
  });
  if (datasheetName !== null && datasheet.name === datasheetName) {
    console.log(`\n=== ${datasheet.name} (${Date.now() - started} мс) ===`);
    for (const archetype of ARCHETYPES) {
      const value = damage.ranged.byArchetype[archetype.id]?.mean ?? 0;
      const meleeValue = damage.melee.byArchetype[archetype.id]?.mean ?? 0;
      const totalValue = damage.total.byArchetype[archetype.id]?.mean ?? 0;
      console.log(
        `  ${archetype.name.padEnd(22)} rng=${fmt(value)} mel=${fmt(meleeValue)} tot=${fmt(totalValue)}`
      );
    }
  }
}

console.log('');
console.log('=== Урон в раунд (среднее по всем типам целей) ===');
console.log(
  '  отряд'.padEnd(28) +
    'тип'.padEnd(17) +
    'мод'.padStart(4) +
    'очки'.padStart(5) +
    'стрл'.padStart(7) +
    'рукп'.padStart(7) +
    'всего'.padStart(7) +
    '| урон на 100 очков:'.padStart(21) +
    'стрл'.padStart(7) +
    'рукп'.padStart(7) +
    'всего'.padStart(7)
);
for (const row of rows.sort((a, b) => b.total100 - a.total100)) {
  console.log(
    `  ${row.name.slice(0, 26).padEnd(28)}${row.type.padEnd(17)}${String(row.models).padStart(4)}` +
      `${String(row.points).padStart(5)}${fmt(row.ranged)}${fmt(row.melee)}${fmt(row.total)}` +
      `    |${fmt(row.ranged100)}${fmt(row.melee100)}${fmt(row.total100)}`
  );
}

if (argv.includes('--units')) {
  console.log('');
  console.log('=== Среднее по типам атакующего ===');
  const byType = damagePerRoundByType(
    limited.map(toEntry).filter((entry): entry is { unit: CombatUnit; points: number } => entry !== null),
    { trials, distance }
  );
  for (const row of byType) {
    console.log(
      `  ${row.attackerType.padEnd(20)} rng=${fmt(row.damage.ranged.overall.mean)}` +
        ` mel=${fmt(row.damage.melee.overall.mean)} tot=${fmt(row.damage.total.overall.mean)}` +
        ` (${row.attackerName.split(', ').length} шт.)`
    );
  }
}

if (jsonOut !== null) {
  writeFileSync(jsonOut, JSON.stringify(rows, null, 2), 'utf8');
  console.log(`\nJSON: ${jsonOut}`);
}
