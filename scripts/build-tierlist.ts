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
import { archetypeOf } from '../src/combat/archetypes.ts';
import { tierList, rawScoreOf, type CombatMode, type RawScore, type TargetParadigm, type TierRow } from '../src/tier/scoring.ts';
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

const byMode: Record<string, TierRow[]> = {};
const byParadigm: Record<string, Record<string, TierRow[]>> = {};
for (const paradigm of paradigms) {
  byParadigm[paradigm] = {};
  for (const mode of modes) {
    const modeStarted = Date.now();
    byParadigm[paradigm][mode] = tierList(prepared, {
      mode,
      targetParadigm: paradigm,
      combat: { trials, distance },
      survival: { trials, maxRounds: 15, distance },
    });
    if (paradigm === 'all') byMode[mode] = byParadigm[paradigm][mode];
    console.log(`Парадигма ${paradigm}/${mode}: ${byParadigm[paradigm][mode].length} юнитов (${Date.now() - modeStarted} мс)`);
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
  factions: [...new Set(prepared.map((item) => item.datasheet.faction))].sort(),
  units: prepared.map(({ datasheet, unit, points, loadouts }) => {
    const base = byMode.combined.find((row) => row.id === datasheet.id);
    const metricsFor = (paradigm: TargetParadigm, mode: CombatMode) => {
      const row = byParadigm[paradigm][mode].find((candidate) => candidate.id === datasheet.id);
      return {
        rawMaxDamage: row?.rawMaxDamage ?? 0,
        bestTarget: row?.bestTarget ?? 'infantry',
        bestTargetName: row?.bestTargetName ?? 'Пехота',
        destroyedPointsByTarget: row?.destroyedPointsByTarget ?? {},
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
    const loadoutMetrics = loadouts.map((loadout) => {
      const raw: RawScore = rawScoreOf(datasheet, loadout.unit, loadout.points, {
        mode: 'combined',
        targetParadigm: 'all',
        combat: { trials: Math.min(trials, 8), distance },
        survival: { trials: Math.min(trials, 6), maxRounds: 6, distance },
      });
      return { id: loadout.id, name: loadout.name, points: loadout.points, rawMaxDamage: raw.rawMaxDamage, bestTarget: raw.bestTarget, bestTargetName: raw.bestTargetName, unit: unitProfileOf(loadout.unit, loadout.points) };
    });
    return {
      id: datasheet.id,
      name: datasheet.name,
      faction: datasheet.faction,
      points,
      models: unit.models.length,
      archetype: archetypeOf(unit)?.id ?? 'unknown',
      utilityFlags: base?.utilityFlags ?? [],
      utilityScore: base?.utilityScore ?? 0,
      unit: unitProfileOf(unit, points),
      metrics: metricsByParadigm.all as unknown as Record<CombatMode, ReturnType<typeof metricsFor>>,
      metricsByParadigm,
      loadouts: loadoutMetrics.map((loadout) => ({
        id: loadout.id,
        name: loadout.name,
        points: loadout.points,
        unit: loadout.unit,
        metrics: {
          ...metricsFor('all', 'combined'),
          rawMaxDamage: loadout.rawMaxDamage,
          bestTarget: loadout.bestTarget,
          bestTargetName: loadout.bestTargetName,
        },
      })),
    };
  }),
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(payload), 'utf8');
const sizeMb = (JSON.stringify(payload).length / 1024 / 1024).toFixed(1);
console.log(`\nГотово за ${((Date.now() - started) / 1000).toFixed(1)} с → ${outPath} (${sizeMb} МБ)`);
