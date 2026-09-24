/**
 * CLI: выживаемость юнитов — насколько трудно их убить шаблонным оружием.
 *
 *   node scripts/survival-report.ts                        — таблица по типам юнитов
 *   node scripts/survival-report.ts --archetype=vehicle    — подробно по одному типу
 *   node scripts/survival-report.ts --trials=200 --maxRounds=20
 *   node scripts/survival-report.ts --groups=melee-infantry,monster-melee
 *   node scripts/survival-report.ts --faction=Orks --sort=rounds
 *   node scripts/survival-report.ts --json=survival.json
 *
 * Печатает отдельно: сколько урона цель принимает за раунд, сколько раундов
 * она держится и сколько урона приходится на 100 её очков (меньше — живучее).
 */

import { writeFileSync } from 'node:fs';
import { bsFilesFromDir } from '../src/bsdata/node-source.ts';
import { loadBsData, parseBsDatabase } from '../src/bsdata/index.ts';
import { adaptUnit } from '../src/combat/adapter.ts';
import { archetypeById, archetypeOf } from '../src/combat/archetypes.ts';
import { withinCalculationBudget } from '../src/combat/budget.ts';
import { WEAPON_GROUPS, WEAPON_GROUP_NAMES, type WeaponGroupId } from '../src/combat/weapons.ts';
import {
  survivabilityAgainstArchetype,
  survivabilityAgainstUnit,
  survivabilityTable,
  type SurvivalRow,
} from '../src/combat/survival.ts';

const argv = process.argv.slice(2);
const flagValue = (name: string): string | null => {
  const found = argv.find((arg) => arg.startsWith(`--${name}=`));
  return found === undefined ? null : found.slice(name.length + 3);
};

const trials = Number(flagValue('trials') ?? 150);
const maxRounds = Number(flagValue('maxRounds') ?? 20);
const distance = Number(flagValue('distance') ?? 12);
const archetypeFlag = flagValue('archetype');
const factionFlag = flagValue('faction');
const sortKey = flagValue('sort') ?? 'taken';
const jsonOut = flagValue('json');
const groups = flagValue('groups');
const groupFilter: WeaponGroupId[] | null =
  groups === null ? null : (groups.split(',') as WeaponGroupId[]);

const options = { trials, maxRounds, distance, groups: groupFilter };
const fmt = (value: number): string => value.toFixed(2).padStart(7);

console.log(`Прогонов на замер: ${trials}, потолок раундов: ${maxRounds}, дистанция: ${distance}"`);
console.log(
  `Группы оружия: ${(groupFilter ?? WEAPON_GROUPS).map((g) => WEAPON_GROUP_NAMES[g]).join(', ')}`
);

const table = survivabilityTable(options);

console.log('');
console.log('=== Выживаемость по типам юнитов ===');
console.log(
  '  тип юнита'.padEnd(24) +
    'мод'.padStart(4) +
    'ран'.padStart(5) +
    'очки'.padStart(6) +
    'урон/раунд'.padStart(12) +
    'раундов'.padStart(10) +
    'убито%'.padStart(8) +
    '| на 100 очков'.padStart(15)
);
for (const row of table) {
  console.log(
    `  ${row.name.slice(0, 22).padEnd(24)}${String(row.models).padStart(4)}` +
      `${String(row.totalWounds).padStart(5)}${String(row.points).padStart(6)}` +
      `${fmt(row.damagePerRound.mean)}${fmt(row.roundsToKill.mean).padStart(10)}` +
      `${(row.killProbability * 100).toFixed(0).padStart(8)}` +
      `  ${fmt(row.takenPer100Points.mean)}`
  );
}

if (archetypeFlag !== null) {
  const archetype = archetypeById(archetypeFlag as never);
  const result = survivabilityAgainstArchetype(archetype, options);
  console.log(`\n=== ${archetype.name} (${archetype.id}) ===`);
  console.log(
    `  моделей: ${result.target.models}, ран: ${result.target.totalWounds}, очки: ${result.target.points}`
  );
  console.log('');
  console.log(
    '  оружие'.padEnd(24) +
      'группа'.padEnd(18) +
      'урон/раунд'.padStart(12) +
      'раундов'.padStart(10) +
      'убито%'.padStart(8) +
      'на 100 очков'.padStart(14)
  );
  for (const threat of result.weapons) {
    console.log(
      `  ${threat.weaponName.slice(0, 22).padEnd(24)}${threat.group.padEnd(18)}` +
        `${fmt(threat.damagePerRound.mean)}${fmt(threat.roundsToKill.mean).padStart(10)}` +
        `${(threat.killProbability * 100).toFixed(0).padStart(8)}${fmt(threat.takenPer100Points.mean)}`
    );
  }
  console.log('');
  console.log('  По группам оружия:');
  for (const [group, value] of Object.entries(result.byGroup)) {
    console.log(
      `    ${(WEAPON_GROUP_NAMES[group as WeaponGroupId] ?? group).padEnd(24)}` +
        `урон/раунд=${value.damagePerRound.mean.toFixed(2)}  раундов=${value.roundsToKill.mean.toFixed(2)}`
    );
  }
}

if (jsonOut !== null) {
  writeFileSync(jsonOut, JSON.stringify(table, null, 2), 'utf8');
  console.log(`\nJSON: ${jsonOut}`);
}

if (factionFlag !== null) {
  const { datasheets } = parseBsDatabase(loadBsData(bsFilesFromDir('public/BSData/wh40k-11e')));
  console.log('');
  console.log(`=== Реальные отряды: ${factionFlag} ===`);
  console.log(
    '  отряд'.padEnd(30) +
      'тип'.padEnd(17) +
      'мод'.padStart(4) +
      'очки'.padStart(6) +
      'урон/раунд'.padStart(12) +
      'живёт'.padStart(8) +
      'урон на 100 очков'.padStart(19)
  );
  const rows: SurvivalRow[] = [];
  for (const datasheet of datasheets) {
    if (!datasheet.faction.toLowerCase().includes(factionFlag.toLowerCase())) continue;
    const adapted = adaptUnit(datasheet, { size: 'min' });
    if (adapted.unit.models.length === 0 || !withinCalculationBudget(adapted.points)) continue;
    const type = archetypeOf(adapted.unit)?.id ?? 'unknown';
    const result = survivabilityAgainstUnit(adapted.unit, adapted.points, {
      ...options,
      archetypeLabel: type,
      archetypeName: adapted.unit.name,
    });
    rows.push({
      archetype: type as SurvivalRow['archetype'],
      name: datasheet.name,
      points: adapted.points,
      models: adapted.unit.models.length,
      totalWounds: result.target.totalWounds,
      damagePerRound: result.overall.damagePerRound,
      roundsToKill: result.overall.roundsToKill,
      killProbability: result.overall.killProbability,
      takenPer100Points: result.overall.takenPer100Points,
      byGroup: result.byGroup,
    });
  }
  const sorted = rows.sort((a, b) =>
    sortKey === 'rounds'
      ? b.roundsToKill.mean - a.roundsToKill.mean
      : a.takenPer100Points.mean - b.takenPer100Points.mean
  );
  for (const row of sorted.slice(0, 25)) {
    console.log(
      `  ${row.name.slice(0, 28).padEnd(30)}${row.archetype.padEnd(17)}` +
        `${String(row.models).padStart(4)}${String(row.points).padStart(6)}` +
        `${fmt(row.damagePerRound.mean)}${fmt(row.roundsToKill.mean).padStart(8)}` +
        `${fmt(row.takenPer100Points.mean).padStart(19)}`
    );
  }
}


