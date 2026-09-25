/**
 * Модель данных тирлиста на клиенте.
 *
 * Файл `web/public/data/tierlist.json` собирается скриптом scripts/build-tierlist.ts
 * и содержит для каждого юнита: боевой профиль (чтобы можно было править
 * характеристики) и готовые метрики по трём режимам боя.
 *
 * Ключевая идея пересчёта: при правке юнита меняется ТОЛЬКО его сырые метрики,
 * а нормировка (min-max) и тиры (перцентили) пересобираются заново по всему
 * набору. Поэтому правка одного юнита честно двигает и соседей по шкале —
 * ровно как при полной пересборке с нуля.
 */

import type { CombatMode, TargetParadigm, Tier } from '../../src/tier/scoring.ts';

export type { CombatMode, TargetParadigm, Tier };

/** Сырая метрика юнита в одном режиме боя. */
export interface UnitMetrics {
  /** Лучшая уничтоженная стоимость на 100 очков атакующего. */
  rawMaxDamage: number;
  bestTarget: string;
  bestTargetName: string;
  destroyedPointsByTarget: Record<string, number>;
  /** Вектор защиты по группам оружия (сырой, до общей нормировки). */
  defenseVector: Record<string, number>;
  /** Вектор атаки после Melee Tax, по типам целей. */
  effectiveOffenseVector: Record<string, number>;
  damagePer100: number;
  /** Универсальное среднее destroyed points по выбранной парадигме. */
  universal: number;
  /** Стоимостная выживаемость: 100 / (1 + takenPer100). */
  baseSurvivability: number;
  takenPer100: number;
  unitType: 'Ranged' | 'Melee';
  taxDamage: number;
  taxSurvivability: number;
  effectiveDamage: number;
  effectiveSurvivability: number;
  normDamage: number;
  normSurvivability: number;
  normUtility: number;
  vectorDamageScore: number;
  vectorSurvivabilityScore: number;
  vectorDamageFloor: number;
  vectorSurvivabilityFloor: number;
  utilityFlags: Array<{ id: string; points: number; reason: string }>;
  utilityScore: number;
  totalScore: number;
  percentile: number;
  tier: Tier;
  /** Опциональные варианты снаряжения, посчитанные на сервере. */
  loadouts?: Array<{
    id: string;
    name: string;
    points: number;
    rawMaxDamage: number;
    bestTarget: string;
    bestTargetName: string;
    tier: Tier;
    totalScore: number;
  }>;
}

export interface UnitProfile {
  id: string;
  name: string;
  /** Стоимость отряда; редактируется вместе с характеристиками. */
  points: number;
  keywords: string[];
  models: Array<{
    id: string;
    name: string;
    toughness: number;
    wounds: number;
    save: number | null;
    invuln: number | null;
    keywords: string[];
    weapons: Array<{
      id: string;
      name: string;
      kind: 'ranged' | 'melee';
      range: number | null;
      attacks: { count: number; sides: number; plus: number } | null;
      skill: number | null;
      strength: number | null;
      ap: number;
      damage: { count: number; sides: number; plus: number } | null;
      keywords: Array<{ name: string; raw: string }>;
    }>;
  }>;
}

export interface UnitEntry {
  id: string;
  name: string;
  /** Основная фракция для отображения. */
  faction: string;
  /** Все фракции из BSData categoryLinks, включая Astartes и чаптер. */
  factions: string[];
  points: number;
  models: number;
  archetype: string;
  utilityFlags: Array<{ id: string; points: number; reason: string }>;
  utilityScore: number;
  unit: UnitProfile;
  metrics: Record<CombatMode, UnitMetrics>;
  /** Метрики по каждой парадигме цели: all, infantry, elite, armor. */
  metricsByParadigm?: Record<TargetParadigm, Record<CombatMode, UnitMetrics>>;
  loadouts?: Array<{ id: string; name: string; points: number; unit: UnitProfile; metrics?: UnitMetrics }>;
}

export interface LeaderSummary {
  id: string;
  name: string;
  faction: string;
  factions: string[];
  points: number;
  keywords: string[];
  allowedUnitIds: string[];
  bonuses: import('../../src/tier/leaders.ts').LeaderBonuses;
  abilities: Array<{ name: string; description: string }>;
  unit: UnitProfile;
}

export interface AttachedRow {
  unitId: string;
  leaderId: string | null;
  name: string;
  /** Все фракции пары: основная faction отряда и faction лидера. */
  faction: string;
  factions: string[];
  models: number;
  points: number;
  tier: Tier;
  totalScore: number;
  rawMaxDamage: number;
  bestTarget: string;
  bestTargetName: string;
  effectiveSurvivability: number;
  utilityScore: number;
  utilityFlags: Array<{ id: string; points: number; reason: string }>;
}

export interface TierlistData {
  generatedAt: string;
  trials: number;
  distance: number;
  modes: CombatMode[];
  paradigms: TargetParadigm[];
  factions: string[];
  units: UnitEntry[];
  leaders: LeaderSummary[];
  attached: Record<TargetParadigm, Record<CombatMode, AttachedRow[]>>;
}

/** Минимальный набор для пересчёта нормировки и тиров на клиенте. */
export interface ScoredRow {
  effectiveDamage: number;
  effectiveSurvivability: number;
  utilityScore: number;
  normDamage: number;
  normSurvivability: number;
  normUtility: number;
  vectorDamageScore: number;
  vectorSurvivabilityScore: number;
  vectorDamageFloor: number;
  vectorSurvivabilityFloor: number;
  totalScore: number;
  percentile: number;
  tier: Tier;
}

export const SCORE_WEIGHTS = { damage: 0.4, survivability: 0.35, utility: 0.25 } as const;
export const TIER_PERCENTILES = { S: 0.9, A: 0.75, B: 0.5, C: 0.25 } as const;

/**
 * Min-Max нормализация на шкалу 0–100. При Max == Min все получают 50 —
 * иначе при вырожденном наборе (все отредактированы одинаково) появились бы NaN.
 */
export function minMaxNormalize(values: number[]): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 50);
  return values.map((value) => ((value - min) / (max - min)) * 100);
}

/**
 * Перцентиль значения ПО РАНГУ: какой процент набора не превосходит его.
 * Именно ранг, а не само значение: Total_Score редко достигает 100, потому что
 * никто не лучший сразу по урону, живучести и полезности. (Такая ошибка была
 * в первой версии — весь набор съезжал в тир D.)
 */
export function percentileOf(sorted: number[], value: number): number {
  if (sorted.length === 0) return 50;
  if (sorted.length === 1) return 50;
  let below = 0;
  let equal = 0;
  for (const item of sorted) {
    if (item < value) below += 1;
    else if (item === value) equal += 1;
    else break;
  }
  if (equal > 1) return ((below + (equal - 1) / 2) / (sorted.length - 1)) * 100;
  return (below / (sorted.length - 1)) * 100;
}

/** Тир по перцентилю Total. */
export function tierOf(percentile: number): Tier {
  if (percentile > TIER_PERCENTILES.S * 100) return 'S';
  if (percentile > TIER_PERCENTILES.A * 100) return 'A';
  if (percentile > TIER_PERCENTILES.B * 100) return 'B';
  if (percentile > TIER_PERCENTILES.C * 100) return 'C';
  return 'D';
}

/** Среднее по списку. */
function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Перцентиль по отсортированному набору (доля элементов не выше значения).
 * 0.25 — нижний квартиль: он показывает, насколько юнит слаб там, где слаб.
 */
function percentileAt(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 50;
  const index = (sorted.length - 1) * fraction;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

/** «Сырые» величины юнита — всё, что нужно для нормировки и тиров. */
export interface RawRow {
  effectiveDamage: number;
  effectiveSurvivability: number;
  defenseVector: Record<string, number>;
  effectiveOffenseVector: Record<string, number>;
  utilityScore: number;
  /** Остальные поля метрики (для показа) — не участвуют в скоре. */
  [key: string]: unknown;
}

/**
 * Пересчитывает нормировку, Total и тиры для всего набора.
 *
 * На вход — «сырые» величины каждого юнита. Выход — полные строки тирлиста.
 * Так правка одного юнита корректно сдвигает шкалу для всех: ровно так же,
 * как если бы пересобрать тирлист с нуля.
 */
export function rebuildTierlist<T extends {
  defenseVector: Record<string, number>;
  effectiveOffenseVector: Record<string, number>;
  utilityScore: number;
}>(units: Array<{ id: string; raw: T }>): Map<string, T & {
  normDamage: number;
  normSurvivability: number;
  normUtility: number;
  vectorDamageScore: number;
  vectorSurvivabilityScore: number;
  vectorDamageFloor: number;
  vectorSurvivabilityFloor: number;
  totalScore: number;
  percentile: number;
  tier: Tier;
}> {
  const rankVector = (
    keys: string[],
    pick: (raw: T, key: string) => number
  ): { scores: number[]; floors: number[] } => {
    if (keys.length === 0) {
      return { scores: units.map(() => 50), floors: units.map(() => 50) };
    }
    const ranks = keys.map((key) => {
      const sorted = units
        .map((unit) => pick(unit.raw, key))
        .sort((a, b) => a - b);
      return units.map((unit) => percentileOf(sorted, pick(unit.raw, key)));
    });
    return {
      scores: units.map((_, index) => {
        const components = ranks.map((component) => component[index]).sort((a, b) => a - b);
        // Свёртка та же, что на сервере: универсальность + нижний квартиль
        // + собственная лучшая компонента юнита (не лучшая по всему набору).
        return (
          mean(components) * 0.6 +
          percentileAt(components, 0.25) * 0.25 +
          (components[components.length - 1] ?? 0) * 0.15
        );
      }),
      floors: units.map((_, index) => percentileAt(ranks.map((component) => component[index]), 0.25)),
    };
  };
  const offenseKeys = Object.keys(units[0]?.raw.effectiveOffenseVector ?? {});
  const defenseKeys = Object.keys(units[0]?.raw.defenseVector ?? {});
  const offense = rankVector(offenseKeys, (raw, key) => raw.effectiveOffenseVector[key] ?? 0);
  const defense = rankVector(defenseKeys, (raw, key) => raw.defenseVector[key] ?? 0);
  const normDamage = offense.scores;
  const normSurvivability = defense.scores;
  const normUtility = minMaxNormalize(units.map((unit) => unit.raw.utilityScore));

  const totals = units.map((unit, index) => ({
    id: unit.id,
    totalScore:
      normDamage[index] * SCORE_WEIGHTS.damage +
      normSurvivability[index] * SCORE_WEIGHTS.survivability +
      normUtility[index] * SCORE_WEIGHTS.utility,
    normDamage: normDamage[index],
    normSurvivability: normSurvivability[index],
    normUtility: normUtility[index],
    vectorDamageScore: offense.scores[index],
    vectorSurvivabilityScore: defense.scores[index],
    vectorDamageFloor: offense.floors[index],
    vectorSurvivabilityFloor: defense.floors[index],
  }));

  const sorted = totals.map((row) => row.totalScore).sort((a, b) => a - b);
  type Scored = T & {
    normDamage: number;
    normSurvivability: number;
    normUtility: number;
    vectorDamageScore: number;
    vectorSurvivabilityScore: number;
    vectorDamageFloor: number;
    vectorSurvivabilityFloor: number;
    totalScore: number;
    percentile: number;
    tier: Tier;
  };
  const result = new Map<string, Scored>();
  totals.forEach((row, index) => {
    const percentile = percentileOf(sorted, row.totalScore);
    result.set(row.id, { ...units[index].raw, ...row, percentile, tier: tierOf(percentile) } as Scored);
  });
  return result;
}

