/**
 * Сборщик данных для веб-тирлиста.
 *
 * Считает метрики всех юнитов один раз и выгружает готовый JSON: считать их
 * в браузере при загрузке слишком долго (~90 с), а пересчёт одного юнита
 * после правки характеристик — быстро, поэтому в JSON кладутся и «сырые»
 * метрики, и полный боевой профиль для пересчёта на клиенте.
 *
 *   npm run build:data
 *   node scripts/build-tierlist.ts --trials=40 --out=web/public/data/tierlist.json
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { bsFilesFromDir } from '../src/bsdata/node-source.ts';
import { loadBsData, parseBsDatabase } from '../src/bsdata/index.ts';
import { adaptUnit, loadoutVariantsOf, type LoadoutCandidate } from '../src/combat/adapter.ts';
import { isEligibleForCalculations } from '../src/combat/budget.ts';
import { leaderDefinitionsOf } from '../src/tier/leaders.ts';
import { archetypeOf } from '../src/combat/archetypes.ts';
import { tierList, type CombatMode, type TargetParadigm, type TierRow } from '../src/tier/scoring.ts';
import type { BsDatasheet } from '../src/bsdata/types.ts';
import type { CombatUnit } from '../src/combat/types.ts';

const argv = process.argv.slice(2);
const flagValue = (name: string): string | null => {
  const found = argv.find((arg) => arg.startsWith(`--${name}=`));
  return found === undefined ? null : found.slice(name.length + 3);
};

const trials = Number(flagValue('trials') ?? 40);
const distance = Number(flagValue('distance') ?? 12);
const outPath = resolve(flagValue('out') ?? 'web/public/data/tierlist.json');
const modes: CombatMode[] = ['ranged', 'melee', 'combined'];
const paradigms: TargetParadigm[] = ['all', 'infantry', 'elite', 'armor'];

const started = Date.now();
const { datasheets } = parseBsDatabase(loadBsData(bsFilesFromDir('public/BSData/wh40k-11e')));
console.log(`Даташитов: ${datasheets.length}, прогонов: ${trials}`);

const prepared: Array<{ datasheet: BsDatasheet; unit: CombatUnit; points: number; loadouts: LoadoutCandidate[] }> = [];
for (const datasheet of datasheets) {
  const adapted = adaptUnit(datasheet, { size: 'min' });
  if (
    adapted.unit.models.length === 0 ||
    !isEligibleForCalculations(datasheet.name, adapted.points)
  ) continue;
  const loadouts = loadoutVariantsOf(datasheet, { size: 'min', limit: 4 });
  prepared.push({ datasheet, unit: adapted.unit, points: adapted.points, loadouts });
}
console.log(`Пригодных юнитов: ${prepared.length} (${Date.now() - started} мс на адаптацию)`);

const leaders = leaderDefinitionsOf(datasheets);
if (leaders.length === 0) throw new Error('BSData: не найдено ни одного Leader/Support с допустимыми отрядами');

interface AttachedPayload {
  unitId: string;
  leaderId: string | null;
  name: string;
  faction: string;
  factions: string[];
  models: number;
  points: number;
  tier: TierRow['tier'];
  totalScore: number;
  rawMaxDamage: number;
  bestTarget: string;
  bestTargetName: string;
  effectiveSurvivability: number;
  utilityScore: number;
  utilityFlags: TierRow['utilityFlags'];
}

const byParadigm: Record<string, Record<string, TierRow[]>> = {};
// Сразу сохраняем только компактные поля. Хранить 12 000 полных TierRow
// одновременно не нужно и на практике расходовало всю heap-память процесса.
const attachedByParadigm: Record<string, Record<string, AttachedPayload[]>> = {};
/** Общий Astartes-юнит принадлежит каждому чаптеру через factions, а не через одну строку faction. */
function sharesFaction(unit: BsDatasheet, leader: { factions: string[] }): boolean {
  return leader.factions.some((faction) => unit.factions.includes(faction));
}

function pairFactions(id: string): string[] {
  const [unitId, leaderId] = id.split('+');
  const unit = prepared.find((item) => item.datasheet.id === unitId)?.datasheet;
  const leader = leaders.find((item) => item.id === leaderId);
  return [...new Set([...(unit?.factions ?? []), ...(leader?.factions ?? [])])];
}

for (const paradigm of paradigms) {
  byParadigm[paradigm] = {};
  attachedByParadigm[paradigm] = {};
  // В BSData один отряд может принимать несколько Leader/Support. Сохраняем
  // каждую пару, которую явно разрешает локальная база BSData; это отдельная
  // вкладка, поэтому здесь не нужно искусственно выбирать одного лидера.
  const attachedEntries = prepared.flatMap(({ datasheet, unit, points }) => {
    const candidates = leaders
      .filter((leader) => sharesFaction(datasheet, leader))
      .filter((leader) => leader.allowedUnitIds.includes(datasheet.id))
      .filter((leader) => points + leader.points <= 2000);
    return candidates.map((leader) => ({
      datasheet,
      unit,
      points,
      leader,
      rowId: `${datasheet.id}+${leader.id}`,
      faction: leader.faction,
      factions: [...new Set([...datasheet.factions, ...leader.factions])],
    }));
  });
  for (const mode of modes) {
    const modeStarted = Date.now();
    byParadigm[paradigm][mode] = tierList(prepared, {
      mode,
      targetParadigm: paradigm,
      combat: { trials, distance },
      survival: { trials, maxRounds: 15, distance },
    });
    const attachedRows = tierList(attachedEntries, {
      mode,
      targetParadigm: paradigm,
      combat: { trials: Math.min(trials, 4), distance },
      survival: { trials: Math.min(trials, 3), maxRounds: 8, distance },
    });
    attachedByParadigm[paradigm][mode] = attachedRows.map((row) => ({
      unitId: row.id.split('+')[0],
      leaderId: row.id.split('+')[1] ?? null,
      name: row.name,
      faction: row.faction,
      factions: pairFactions(row.id),
      models: row.models,
      points: row.points,
      tier: row.tier,
      totalScore: row.totalScore,
      rawMaxDamage: row.rawMaxDamage,
      bestTarget: row.bestTarget,
      bestTargetName: row.bestTargetName,
      effectiveSurvivability: row.effectiveSurvivability,
      utilityScore: row.utilityScore,
      utilityFlags: row.utilityFlags,
    }));
    console.log(`Парадигма ${paradigm}/${mode}: ${byParadigm[paradigm][mode].length} юнитов, ${attachedRows.length} с лидерами (${Date.now() - modeStarted} мс)`);
  }
}

/**
 * Боевой профиль юнита для пересчёта на клиенте: модель целиком, чтобы
 * правка T/W/Sv и оружия пересчитывалась тем же кодом, что и на сервере.
 */
function unitProfileOf(unit: CombatUnit, points: number): unknown {
  return {
    id: unit.id,
    name: unit.name,
    points,
    keywords: unit.keywords,
    models: unit.models.map((model) => ({
      id: model.id,
      name: model.name,
      toughness: model.toughness,
      wounds: model.wounds,
      save: model.save,
      invuln: model.invuln,
      keywords: model.keywords,
      weapons: model.weapons.map((weapon) => ({
        id: weapon.id,
        name: weapon.name,
        kind: weapon.kind,
        range: weapon.range,
        attacks: weapon.attacks,
        skill: weapon.skill,
        strength: weapon.strength,
        ap: weapon.ap,
        damage: weapon.damage,
        keywords: weapon.keywords.map((k) => ({ name: k.name, raw: k.raw })),
      })),
    })),
  };
}

const payload = {
  generatedAt: new Date().toISOString(),
  trials,
  distance,
  modes,
  paradigms,
  attached: Object.fromEntries(
    paradigms.map((paradigm) => [paradigm, attachedByParadigm[paradigm]])
  ),
  leaders: leaders.map((leader) => ({
    id: leader.id,
    name: leader.name,
    faction: leader.faction,
    factions: leader.factions,
    points: leader.points,
    keywords: leader.keywords,
    allowedUnitIds: leader.allowedUnitIds,
    bonuses: leader.bonuses,
    abilities: leader.abilities,
    unit: unitProfileOf(leader.unit, leader.points),
  })),
  factions: [...new Set(prepared.flatMap((item) => item.datasheet.factions))].sort(),
  units: prepared.map(({ datasheet, unit, points, loadouts }) => {
    const base = byParadigm.all.combined.find((row) => row.id === datasheet.id);
    const metricsFor = (paradigm: TargetParadigm, mode: CombatMode) => {
      const row = byParadigm[paradigm][mode].find((candidate) => candidate.id === datasheet.id);
      return {
        rawMaxDamage: row?.rawMaxDamage ?? 0,
        bestTarget: row?.bestTarget ?? 'infantry',
        bestTargetName: row?.bestTargetName ?? 'Пехота',
        destroyedPointsByTarget: row?.destroyedPointsByTarget ?? {},
        effectiveOffenseVector: row?.effectiveOffenseVector ?? {},
        defenseVector: row?.defenseVector ?? {},
        universal: row?.universal ?? 0,
        damagePer100: row?.damagePer100 ?? 0,
        baseSurvivability: row?.baseSurvivability ?? 0,
        takenPer100: row?.takenPer100 ?? 0,
        unitType: row?.unitType ?? 'Ranged',
        taxDamage: row?.tax.damage ?? 1,
        taxSurvivability: row?.tax.survivability ?? 1,
        effectiveDamage: row?.effectiveDamage ?? 0,
        effectiveSurvivability: row?.effectiveSurvivability ?? 0,
        normDamage: row?.normDamage ?? 0,
        normSurvivability: row?.normSurvivability ?? 0,
        normUtility: row?.normUtility ?? 0,
        vectorDamageScore: row?.vectorDamageScore ?? 0,
        vectorSurvivabilityScore: row?.vectorSurvivabilityScore ?? 0,
        vectorDamageFloor: row?.vectorDamageFloor ?? 0,
        vectorSurvivabilityFloor: row?.vectorSurvivabilityFloor ?? 0,
        utilityFlags: row?.utilityFlags ?? [],
        utilityScore: row?.utilityScore ?? 0,
        totalScore: row?.totalScore ?? 0,
        percentile: row?.percentile ?? 50,
        tier: row?.tier ?? 'D',
      };
    };
    const metricsByParadigm = Object.fromEntries(
      paradigms.map((paradigm) => [paradigm, Object.fromEntries(modes.map((mode) => [mode, metricsFor(paradigm, mode)]))])
    ) as Record<TargetParadigm, Record<CombatMode, ReturnType<typeof metricsFor>>>;
    // Профили loadout остаются в JSON, а числовые метрики пересчитываются в
    // браузере при выборе варианта. Считать их здесь для тысяч юнитов не нужно.
    const loadoutMetrics = loadouts.map((loadout) => ({
      id: loadout.id,
      name: loadout.name,
      points: loadout.points,
      unit: unitProfileOf(loadout.unit, loadout.points),
    }));
    return {
      id: datasheet.id,
      name: datasheet.name,
      faction: datasheet.faction,
      factions: datasheet.factions,
      points,
      models: unit.models.length,
      archetype: archetypeOf(unit)?.id ?? 'unknown',
      utilityFlags: base?.utilityFlags ?? [],
      utilityScore: base?.utilityScore ?? 0,
      unit: unitProfileOf(unit, points),
      metrics: metricsByParadigm.all as unknown as Record<CombatMode, ReturnType<typeof metricsFor>>,
      metricsByParadigm,
      loadouts: loadoutMetrics,
    };
  }),
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(payload), 'utf8');
const sizeMb = (JSON.stringify(payload).length / 1024 / 1024).toFixed(1);
console.log(`\nГотово за ${((Date.now() - started) / 1000).toFixed(1)} с → ${outPath} (${sizeMb} МБ)`);
