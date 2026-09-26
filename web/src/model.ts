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
  /** Поглощённый до смерти урон на 100 очков — effective durability. */
  absorbedPer100: number;
  /** Запас ран на 100 очков — только диагностика. */
  bulkPer100: number;
  /** Доля боёв, где юнит не был убит за maxRounds. */
  censoredShare?: number;
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
  /**
   * Дельта одноразовых способностей: насколько юнит дороже стал бы с
   * одноразовым баффом. Справочное поле — в Total и норму урона оно не входит,
   * потому что «once per battle» не действует постоянно.
   */
  onceEffectDelta?: number;
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
    /** Feel No Pain: порог невелирования (5 → '5+'); null — нет. */
    fnp: number | null;
    /** Область FNP: 'all' — любой урон, 'mortals' — только мортиды. */
    fnpScope: 'all' | 'mortals';
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
  /**
   * Дельта одноразовых способностей: насколько юнит дороже стал бы с
   * одноразовым баффом. Справочное поле — в Total и норму урона не входит.
   */
  onceEffectDelta?: number;
  /** Чувствительность тира к произвольным допущениям модели. */
  sensitivity?: {
    spread: number;
    high: boolean;
    medium: boolean;
    /** Доля сценариев возмущения, в которых юнит сменил тир (0–1). */
    tierChangeProbability: number;
  };
  utilityFlags: Array<{ id: string; points: number; reason: string; category: string }>;
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

export const SCORE_WEIGHTS = { damage: 0.55, survivability: 0.35, utility: 0.1 } as const;

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

/**
 * Тир по номеру группы натуральных разрывов.
 *
 * Дублирует src/tier/scoring.ts: клиент пересобирает тирлист сам после правки
 * юнита в редакторе, и разбиение обязано совпадать с серверным, иначе правка
 * одного юнита переставит тиры у всех.
 */
const TIER_BY_GROUP: readonly Tier[] = ['D', 'C', 'B', 'A', 'S'];

export function tierByGroup(group: number): Tier {
  return TIER_BY_GROUP[Math.max(0, Math.min(TIER_BY_GROUP.length - 1, group))];
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

/**
 * Ранг по ЦЕНОВЫМ КОРЗИНАМ, смешанный с глобальным рангом.
 *
 * Дублирует src/tier/scoring.ts: клиент пересобирает тирлист сам после правки
 * юнита в редакторе, и нормализация обязана совпадать с серверной, иначе
 * правка одного юнита сдвинет шкалу иначе, чем при полной пересборке.
 */
export function rankWithinPriceBins(
  points: number[],
  values: number[],
  binWeight = 0.5,
  minBinSize = 8
): number[] {
  const n = values.length;
  if (n === 0) return [];
  const globalSorted = [...values].sort((a, b) => a - b);
  const globalRank = values.map((value) => percentileOf(globalSorted, value));
  if (n < minBinSize * 2) return globalRank;
  const sortedPoints = [...points].sort((a, b) => a - b);
  const quantile = (q: number): number => sortedPoints[Math.min(n - 1, Math.floor(q * n))];
  const edges = [0, quantile(0.2), quantile(0.4), quantile(0.6), quantile(0.8), 1];
  const binOf = (point: number): number => {
    for (let i = edges.length - 1; i >= 1; i -= 1) {
      if (point >= edges[i - 1]) return i - 1;
    }
    return 0;
  };
  const bins = new Map<number, number[]>();
  for (let i = 0; i < n; i += 1) {
    const bin = binOf(points[i]);
    const list = bins.get(bin);
    if (list) list.push(i);
    else bins.set(bin, [i]);
  }
  const labelOf = new Map<number, number>();
  for (const bin of bins.keys()) labelOf.set(bin, bin);
  const bySize = [...bins.entries()].sort((a, b) => a[1].length - b[1].length);
  for (const [bin, indices] of bySize) {
    if (indices.length >= minBinSize) continue;
    const left = labelOf.get(bin - 1) ?? null;
    const right = labelOf.get(bin + 1) ?? null;
    let target: number | null = null;
    if (left !== null && right !== null) {
      target = (bins.get(right)?.length ?? 0) >= (bins.get(left)?.length ?? 0) ? right : left;
    } else {
      target = left ?? right;
    }
    if (target === null) continue;
    const host = bins.get(target) ?? [];
    host.push(...indices);
    bins.set(target, [...new Set(host)]);
    bins.delete(bin);
    labelOf.set(target, target);
  }
  const binRank = new Map<number, number>();
  for (const indices of bins.values()) {
    if (indices.length === 0) continue;
    const sorted = indices.map((i) => values[i]).sort((a, b) => a - b);
    for (const i of indices) binRank.set(i, percentileOf(sorted, values[i]));
  }
  return values.map((_value, i) => {
    const local = binRank.get(i);
    if (local === undefined) return globalRank[i];
    return local * binWeight + globalRank[i] * (1 - binWeight);
  });
}

/**
 * Натуральные разрывы (Fisher–Jenks) для одномерного набора.
 *
 * Дублирует src/combat/clustering.ts — по той же причине, что и регрессия:
 * клиент обязан получить ровно те же тиры, что и серверная сборка.
 */
export function naturalBreaks(values: number[], requestedGroups: number): {
  labels: number[];
  boundaries: number[];
  sizes: number[];
} {
  const n = values.length;
  const groups = Math.max(1, Math.min(requestedGroups, n));
  if (n === 0) return { labels: [], boundaries: [], sizes: [] };
  if (groups === 1) return { labels: values.map(() => 0), boundaries: [], sizes: [n] };

  const sorted = [...values].sort((a, b) => a - b);
  const prefix = new Float64Array(n + 1);
  const prefixSq = new Float64Array(n + 1);
  for (let i = 0; i < n; i += 1) {
    prefix[i + 1] = prefix[i] + sorted[i];
    prefixSq[i + 1] = prefixSq[i] + sorted[i] * sorted[i];
  }
  const sseOf = (lo: number, hi: number): number => {
    const count = hi - lo;
    if (count <= 1) return 0;
    const sum = prefix[hi] - prefix[lo];
    const sumSq = prefixSq[hi] - prefixSq[lo];
    return Math.max(0, sumSq - (sum * sum) / count);
  };

  const best: Float64Array[] = [];
  const back: Int32Array[] = [];
  for (let g = 0; g <= groups; g += 1) {
    best.push(new Float64Array(n + 1).fill(Number.POSITIVE_INFINITY));
    back.push(new Int32Array(n + 1));
  }
  best[0][0] = 0;
  for (let g = 1; g <= groups; g += 1) {
    for (let i = g; i <= n; i += 1) {
      for (let j = g - 1; j < i; j += 1) {
        if (best[g - 1][j] === Number.POSITIVE_INFINITY) continue;
        const candidate = best[g - 1][j] + sseOf(j, i);
        if (candidate < best[g][i]) {
          best[g][i] = candidate;
          back[g][i] = j;
        }
      }
    }
  }

  const cuts: number[] = [];
  let cursor = n;
  for (let g = groups; g >= 1; g -= 1) {
    const j = back[g][cursor];
    if (g > 1) cuts.push(j);
    cursor = j;
  }
  cuts.reverse();

  // Сдвиг вправо до конца серии одинаковых значений: одинаковые Total не должны
  // попадать в разные тиры (см. комментарий в src/combat/clustering.ts).
  const adjusted: number[] = [];
  let previous = 0;
  for (const cut of cuts) {
    let moved = Math.max(cut, previous);
    while (moved < n && sorted[moved] === sorted[moved - 1]) moved += 1;
    adjusted.push(moved);
    previous = moved;
  }

  const labels = values.map((value) => {
    let group = 0;
    for (const cut of adjusted) if (value >= sorted[cut]) group += 1;
    return group;
  });
  const sizes = new Array<number>(groups).fill(0);
  for (const label of labels) sizes[label] += 1;
  const boundaries = adjusted.map((cut) => {
    const below = sorted[cut - 1];
    const above = sorted[cut];
    return below + (above - below) / 2;
  });
  return { labels, boundaries, sizes };
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
}>(units: Array<{ id: string; raw: T; points: number }>): Map<string, T & {
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
    pick: (raw: T, key: string) => number,
    residual: boolean
  ): { scores: number[]; floors: number[] } => {
    if (keys.length === 0) {
      return { scores: units.map(() => 50), floors: units.map(() => 50) };
    }
    const costs = units.map((unit) => unit.points);
    const ranks = keys.map((key) => {
      const values = units.map((unit) => pick(unit.raw, key));
      // Защита ранжируется по ценовым корзинам, как на сервере.
      if (residual) return rankWithinPriceBins(costs, values);
      const sorted = [...values].sort((a, b) => a - b);
      return values.map((value) => percentileOf(sorted, value));
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
  const offense = rankVector(offenseKeys, (raw, key) => raw.effectiveOffenseVector[key] ?? 0, false);
  const defense = rankVector(defenseKeys, (raw, key) => raw.defenseVector[key] ?? 0, true);
  const normDamage = offense.scores;
  const normSurvivability = defense.scores;
  // Utility нормируется РАНГОМ, как на сервере: при грубой дискретной шкале
  // min-max давал ±25 итоговых баллов и двигал тир у 42% набора.
  const utilityValues = units.map((unit) => unit.raw.utilityScore);
  const utilitySorted = [...utilityValues].sort((a, b) => a - b);
  const normUtility = utilityValues.map((value) => percentileOf(utilitySorted, value));

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

  const breaks = naturalBreaks(
    totals.map((row) => row.totalScore),
    TIER_BY_GROUP.length
  );
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
    result.set(row.id, {
      ...units[index].raw,
      ...row,
      percentile,
      tier: tierByGroup(breaks.labels[index] ?? 0),
    } as Scored);
  });
  return result;
}

