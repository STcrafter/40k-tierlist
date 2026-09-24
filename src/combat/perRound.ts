/**
 * Урон в раунд по типам юнитов: Монте-Карло по эталонным целям.
 *
 * Идея: «урон в раунд» — не одна цифра, а набор по типам целей. Стрелок
 * оценивают и по пехоте, и по технике, и по монстру: средняя цифра зависит
 * от состава противника, а тирлист должен показывать, насколько юнит
 * универсален. Поэтому считаем урон отдельно по каждому архетипу
 * (archetypes.ts), а затем усредняем по весам.
 *
 * Внутри одной метрики Монте-Карло считает три величины:
 *  - `ranged` — урон только в фазе стрельбы;
 *  - `melee`  — урон только в фазе рукопашной;
 *  - `total`  — обе фазы в одном раунде (сумма фаз, модели не восстанавливаются).
 *
 * Все три величины независимы по RNG: чтобы «руки» и «ноги» отряда не
 * зависели друг от друга, каждой фазе даётся собственный поток бросков,
 * иначе сумма фаз систематически занижала бы разброс.
 */

import { monteCarlo, type CombatOptions } from './simulate.ts';
import {
  ARCHETYPES,
  archetypeById,
  archetypeOf,
  targetUnitOf,
  type ArchetypeId,
  type UnitArchetype,
} from './archetypes.ts';
import type { CombatUnit, Rng } from './types.ts';
import { mulberry32 } from './dice.ts';

/** Среднее и стандартное отклонение урона за раунд. */
export interface DamageStat {
  mean: number;
  stdev: number;
}

/** Урон одной метрики по всем типам целей. */
export interface DamageBreakdown {
  /** Урон по каждому типу цели (id архетипа → среднее). */
  byArchetype: Record<string, DamageStat>;
  /** Взвешенное среднее по типам целей. */
  overall: DamageStat;
  /** Уничтоженные очки цели за раунд; swarm/дешёвая цель даёт меньше. */
  destroyedPoints: {
    byArchetype: Record<string, DamageStat>;
    overall: DamageStat;
  };
}

/** Урон в раунд: отдельно дальнобойный, рукопашный и общий. */
export interface DamagePerRound {
  ranged: DamageBreakdown;
  melee: DamageBreakdown;
  total: DamageBreakdown;
}

/**
 * Нормировка «урон на 100 очков»: сырой урон делить на очки бессмысленно
 * (10 пехотных болтеров и один лазкан — это разные бюджеты), поэтому
 * приводим к общей единице: сколько урона приходится на 100 очков.
 */
export interface DamagePer100Points {
  ranged: number;
  melee: number;
  total: number;
}

/** Сырой урон в раунд, приведённый к 100 очкам стоимости атакующего. */
export function per100Points(
  damage: DamagePerRound,
  attackerPoints: number
): DamagePer100Points {
  if (attackerPoints <= 0) return { ranged: 0, melee: 0, total: 0 };
  const scale = 100 / attackerPoints;
  return {
    ranged: damage.ranged.overall.mean * scale,
    melee: damage.melee.overall.mean * scale,
    total: damage.total.overall.mean * scale,
  };
}

export interface PerRoundOptions extends CombatOptions {
  /** Число прогонов Монте-Карло на один замер. */
  trials?: number;
  /** Сид для воспроизводимости (если не передан rng). */
  seed?: number;
  /**
   * Веса типов целей в итоговом среднем. По умолчанию — равные:
   * юнит оценивается против всего списка архетипов поровну.
   */
  weights?: Partial<Record<ArchetypeId, number>> | null;
  /** Какие типы целей считать; по умолчанию — все из ARCHETYPES. */
  targets?: ArchetypeId[] | null;
}

/** Среднее и σ с безопасным делением на ноль. */
function stat(values: number[]): DamageStat {
  if (values.length === 0) return { mean: 0, stdev: 0 };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return { mean, stdev: Math.sqrt(variance) };
}

/** Взвешенное среднее по значениям с весами (нулевые веса отбрасываются). */
function weightedMean(values: DamageStat[], weights: number[]): DamageStat {
  const pairs = values
    .map((value, index) => ({ value, weight: weights[index] ?? 0 }))
    .filter((pair) => pair.weight > 0);
  const total = pairs.reduce((sum, pair) => sum + pair.weight, 0);
  if (total === 0) return stat(values.map((value) => value.mean));
  const mean = pairs.reduce((sum, pair) => sum + pair.value.mean * pair.weight, 0) / total;
  // σ усреднённых величин считаем по взвешенной дисперсии средних.
  const variance =
    pairs.reduce((sum, pair) => sum + pair.weight * (pair.value.mean - mean) ** 2, 0) / total;
  return { mean, stdev: Math.sqrt(variance) };
}

/** Один замер урона отряда против одного типа цели, по трём фазам. */
function measureAgainst(
  attacker: CombatUnit,
  archetype: UnitArchetype,
  options: PerRoundOptions,
  seed: number
): {
  ranged: DamageStat;
  melee: DamageStat;
  total: DamageStat;
  destroyed: { ranged: DamageStat; melee: DamageStat; total: DamageStat };
} {
  const trials = options.trials ?? 200;
  const target = targetUnitOf(archetype);
  const pointPerModel = archetype.points / Math.max(1, target.models.length);
  const destroyedFromKills = (value: { mean: number; stdev: number }): DamageStat => ({
    mean: value.mean * pointPerModel,
    stdev: value.stdev * pointPerModel,
  });
  // Отдельный поток бросков на каждую фазу: иначе сумма фаз систематически
  // занижала бы разброс, а «руки» и «ноги» отряда зависели бы друг от друга.
  const phaseRng = (offset: number): Rng => mulberry32((seed + offset) >>> 0);

  const ranged = monteCarlo(attacker, target, trials, {
    ...options,
    phase: 'ranged',
    rng: options.rng ?? phaseRng(0),
  });
  const melee = monteCarlo(attacker, target, trials, {
    ...options,
    phase: 'melee',
    rng: options.rng ?? phaseRng(0x9e37_79b9),
  });
  const total = monteCarlo(attacker, target, trials, {
    ...options,
    phase: 'all',
    rng: options.rng ?? phaseRng(0x517c_c1b7),
  });

  return {
    ranged: ranged.damage,
    melee: melee.damage,
    total: total.damage,
    destroyed: {
      ranged: destroyedFromKills(ranged.kills),
      melee: destroyedFromKills(melee.kills),
      total: destroyedFromKills(total.kills),
    },
  };
}

/** Замер по одному набору целей: собирает разбивку по архетипам и среднее. */
function measure(
  attacker: CombatUnit,
  archetypes: UnitArchetype[],
  options: PerRoundOptions,
  seed: number
): { ranged: DamageBreakdown; melee: DamageBreakdown; total: DamageBreakdown } {
  const byArchetypeRanged: Record<string, DamageStat> = {};
  const byArchetypeMelee: Record<string, DamageStat> = {};
  const byArchetypeTotal: Record<string, DamageStat> = {};
  const destroyedRanged: Record<string, DamageStat> = {};
  const destroyedMelee: Record<string, DamageStat> = {};
  const destroyedTotal: Record<string, DamageStat> = {};
  const weights: number[] = [];
  const rangedValues: DamageStat[] = [];
  const meleeValues: DamageStat[] = [];
  const totalValues: DamageStat[] = [];
  const destroyedRangedValues: DamageStat[] = [];
  const destroyedMeleeValues: DamageStat[] = [];
  const destroyedTotalValues: DamageStat[] = [];

  archetypes.forEach((archetype, index) => {
    const measured = measureAgainst(attacker, archetype, options, (seed + index * 7919) >>> 0);
    byArchetypeRanged[archetype.id] = measured.ranged;
    byArchetypeMelee[archetype.id] = measured.melee;
    byArchetypeTotal[archetype.id] = measured.total;
    destroyedRanged[archetype.id] = measured.destroyed.ranged;
    destroyedMelee[archetype.id] = measured.destroyed.melee;
    destroyedTotal[archetype.id] = measured.destroyed.total;
    rangedValues.push(measured.ranged);
    meleeValues.push(measured.melee);
    totalValues.push(measured.total);
    destroyedRangedValues.push(measured.destroyed.ranged);
    destroyedMeleeValues.push(measured.destroyed.melee);
    destroyedTotalValues.push(measured.destroyed.total);
    weights.push(options.weights?.[archetype.id] ?? 1);
  });

  return {
    ranged: { byArchetype: byArchetypeRanged, overall: weightedMean(rangedValues, weights), destroyedPoints: { byArchetype: destroyedRanged, overall: weightedMean(destroyedRangedValues, weights) } },
    melee: { byArchetype: byArchetypeMelee, overall: weightedMean(meleeValues, weights), destroyedPoints: { byArchetype: destroyedMelee, overall: weightedMean(destroyedMeleeValues, weights) } },
    total: { byArchetype: byArchetypeTotal, overall: weightedMean(totalValues, weights), destroyedPoints: { byArchetype: destroyedTotal, overall: weightedMean(destroyedTotalValues, weights) } },
  };
}

/** Типы целей из опций: по умолчанию — все архетипы. */
function targetsOf(options: PerRoundOptions): UnitArchetype[] {
  const ids = options.targets;
  if (ids === null || ids === undefined) return [...ARCHETYPES];
  return ids.map((id) => archetypeById(id));
}

/**
 * Урон отряда в раунд: дальнобойный, рукопашный и общий — по каждому типу цели
 * и в среднем. При одинаковом `seed` результат воспроизводим.
 */
export function damagePerRound(attacker: CombatUnit, options: PerRoundOptions = {}): DamagePerRound {
  const seed = options.seed ?? 0x40_4b;
  return measure(attacker, targetsOf(options), options, seed);
}

/**
 * Урон в раунд, разложенный по типам целей, — готовая строка тирлиста.
 *
 * Усреднение по типу атакующего живёт отдельной функцией
 * `damagePerRoundByType`: здесь считается только один отряд.
 */
export interface ArchetypeDamageRow {
  /** Тип атакующего: 'unknown', если отряд не классифицирован. */
  attackerType: ArchetypeId | 'unknown';
  attackerName: string;
  damage: DamagePerRound;
}

/**
 * Урон в раунд, сгруппированный по типу атакующего: один ряд на архетип.
 * Это и есть «шаблоны основных типов юнитов» в применении — сначала
 * классифицируем юниты, потом усредняем внутри типа, чтобы пехота не
 * перебивала монстров и наоборот.
 */
export function damagePerRoundByType(
  units: CombatUnit[],
  options: PerRoundOptions = {}
): ArchetypeDamageRow[] {
  const grouped = new Map<string, { type: ArchetypeId | 'unknown'; units: CombatUnit[] }>();

  for (const unit of units) {
    const archetype = archetypeOf(unit);
    const type = archetype?.id ?? 'unknown';
    const bucket = grouped.get(type) ?? { type, units: [] };
    bucket.units.push(unit);
    grouped.set(type, bucket);
  }

  return [...grouped.values()]
    .sort((a, b) => a.type.localeCompare(b.type))
    .map((bucket) => {
      // Внутри типа усредняем по юнитам: каждый получает одинаковый вес.
      const perUnit = bucket.units.map((unit) => damagePerRound(unit, options));
      return {
        attackerType: bucket.type,
        attackerName: bucket.units.map((unit) => unit.name).join(', '),
        damage: averageDamage(perUnit),
      };
    });
}

/** Среднее по набору замеров: и по типам целей, и по метрикам. */
function averageDamage(measurements: DamagePerRound[]): DamagePerRound {
  // Среднее по типам целей, затем среднее по самим метрикам: так каждый тип
  // цели вносит одинаковый вклад независимо от числа юнитов этого типа.
  const averageBreakdown = (pick: (value: DamagePerRound) => DamageBreakdown): DamageBreakdown => {
    const parts = measurements.map(pick);
    const ids = [...new Set(parts.flatMap((part) => Object.keys(part.byArchetype)))];
    const byArchetype: Record<string, DamageStat> = {};
    for (const id of ids) {
      byArchetype[id] = stat(parts.map((part) => part.byArchetype[id]?.mean ?? 0));
    }
    const destroyedByArchetype: Record<string, DamageStat> = {};
    for (const id of ids) {
      destroyedByArchetype[id] = stat(parts.map((part) => part.destroyedPoints.byArchetype[id]?.mean ?? 0));
    }
    return {
      byArchetype,
      overall: stat(parts.map((part) => part.overall.mean)),
      destroyedPoints: {
        byArchetype: destroyedByArchetype,
        overall: stat(parts.map((part) => part.destroyedPoints.overall.mean)),
      },
    };
  };
  return {
    ranged: averageBreakdown((value) => value.ranged),
    melee: averageBreakdown((value) => value.melee),
    total: averageBreakdown((value) => value.total),
  };
}


