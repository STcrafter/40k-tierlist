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
import { adaptUnit } from '../src/combat/adapter.ts';
import { isEligibleForCalculations } from '../src/combat/budget.ts';
import { archetypeOf } from '../src/combat/archetypes.ts';
import { tierList, type CombatMode, type TierRow } from '../src/tier/scoring.ts';
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

const started = Date.now();
const { datasheets } = parseBsDatabase(loadBsData(bsFilesFromDir('public/BSData/wh40k-11e')));
console.log(`Даташитов: ${datasheets.length}, прогонов: ${trials}`);

const prepared: Array<{ datasheet: BsDatasheet; unit: CombatUnit; points: number }> = [];
for (const datasheet of datasheets) {
  const adapted = adaptUnit(datasheet, { size: 'min' });
  if (
    adapted.unit.models.length === 0 ||
    !isEligibleForCalculations(datasheet.name, adapted.points)
  ) continue;
  prepared.push({ datasheet, unit: adapted.unit, points: adapted.points });
}
console.log(`Пригодных юнитов: ${prepared.length} (${Date.now() - started} мс на адаптацию)`);

const byMode: Record<string, TierRow[]> = {};
for (const mode of modes) {
  const modeStarted = Date.now();
  byMode[mode] = tierList(prepared, {
    mode,
    combat: { trials, distance },
    survival: { trials, maxRounds: 15, distance },
  });
  console.log(`Режим ${mode}: ${byMode[mode].length} юнитов (${Date.now() - modeStarted} мс)`);
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
  factions: [...new Set(prepared.map((item) => item.datasheet.faction))].sort(),
  units: prepared.map(({ datasheet, unit, points }) => {
    const base = byMode.combined.find((row) => row.id === datasheet.id);
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
      // Сырые метрики по режимам: клиент пересобирает нормировку и тиры сам.
      metrics: Object.fromEntries(
        modes.map((mode) => {
          const row = byMode[mode].find((candidate) => candidate.id === datasheet.id);
          return [
            mode,
            {
              rawMaxDamage: row?.rawMaxDamage ?? 0,
              bestSlot: row?.bestSlot ?? 'universal',
              vsInfantry: row?.vsInfantry ?? 0,
              vsArmor: row?.vsArmor ?? 0,
              universal: row?.universal ?? 0,
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
            },
          ];
        })
      ),
    };
  }),
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(payload), 'utf8');
const sizeMb = (JSON.stringify(payload).length / 1024 / 1024).toFixed(1);
console.log(`\nГотово за ${((Date.now() - started) / 1000).toFixed(1)} с → ${outPath} (${sizeMb} МБ)`);
