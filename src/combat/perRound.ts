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

import { countSimulations } from './counters.ts';
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
  /**
   * Замена набора эталонов целей (для sensitivity-анализа).
   * По умолчанию — ARCHETYPES. Используется, чтобы пересчитать тирлист с
   * другим размером целей и сравнить ранги: см. scaleArchetypeModels.
   */
  archetypes?: readonly UnitArchetype[] | null;
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

/** Замер отряда против одного типа цели, по трём фазам. */
export interface ArchetypeMeasure {
  ranged: DamageStat;
  melee: DamageStat;
  total: DamageStat;
  destroyed: { ranged: DamageStat; melee: DamageStat; total: DamageStat };
}

/** Тот же замер, посчитанный для одного архетипа. */
function measureAgainst(
  attacker: CombatUnit,
  archetype: UnitArchetype,
  options: PerRoundOptions,
  seed: number
): ArchetypeMeasure {
  const trials = options.trials ?? 200;
  countSimulations('archetypeRuns');
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

/**
 * Сид замера по архетипу: привязан к САМОМУ архетипу, а не к его позиции.
 *
 * Раньше здесь стояло `(seed + index * 7919)`, где index — место в списке целей.
 * Это было ошибкой: наборы целей у парадигм отсортированы по-разному, поэтому
 * один и тот же тип цели в разных вкладках тирлиста измерялся РАЗНЫМ шумом. На
 * данных это выглядело так, будто методики различаются: cluster-1 давал 49.5
 * уничтоженных очков в «все» и 47.7 в «элита» — при одинаковых правилах.
 *
 * Теперь шум привязан к id, и два свойства выполняются сразу: цифры типа цели
 * совпадают во всех вкладках, а замер можно переиспользовать вместо
 * пересчёта под каждую парадигму.
 *
 * Хэш — FNV-1a по id: без зависимостей и без ограничения на длину строки.
 */
function seedOfArchetype(archetype: UnitArchetype, seed: number): number {
  let hash = 2166136261;
  for (let i = 0; i < archetype.id.length; i += 1) {
    hash ^= archetype.id.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return (seed + hash) >>> 0;
}

/**
 * Кэш замеров: отряд → таблица «тип цели → замер».
 *
 * Замер по паре (отряд, тип цели) НЕ зависит от того, в каком наборе целей он
 * считается — это и проверяет тест «замер не зависит от парадигмы». Значит, все
 * парадигмы могут пользоваться одним замером на юнита, вместо того чтобы
 * считать одно и то же четыре раза: замер «все» уже содержит и пехоту, и
 * технику, и «элиту» как подмножества.
 *
 * Ключ — идентичность отряда (WeakMap) плюс параметры расчёта. Отряд с теми же
 * характеристиками, но собранный заново, измеряется снова: это верно, потому что
 * у копии могут быть другие кейворды, а кэш о глубине структуры не знает.
 */
const measureCache = new WeakMap<CombatUnit, Map<string, Map<string, ArchetypeMeasure>>>();

/**
 * Ключ параметров расчёта; null — кэш использовать нельзя.
 *
 * Свой `rng` и свои `rules` кэш выключают: чужой поток бросков нельзя
 * переиспользовать между вызовами, а правила не сериализуются. Остальное —
 * плоские величины, собранные в строку. Пул целей входит по составу: у
 * sensitivity это масштабированные типы, и их замер нельзя выдать за замер
 * обычного (у них другая цена и другие статы).
 */
function cacheKeyOf(
  options: PerRoundOptions,
  seed: number,
  pool: readonly UnitArchetype[]
): string | null {
  if (options.rng !== undefined || options.rules !== undefined) return null;
  return [
    seed,
    options.trials ?? 200,
    options.phase ?? 'ranged',
    options.distance ?? 'null',
    options.charged ?? true,
    options.stationary ?? true,
    options.indirect ?? false,
    options.cover ?? false,
    options.engaged ?? false,
    (options.rerollHitOn ?? []).join('.'),
    (options.rerollWoundOn ?? []).join('.'),
    (options.rerollSaveOn ?? []).join('.'),
    options.melee ?? 'primary',
    options.closeQuarters ?? 'auto',
    options.allocation ?? 'first',
    pool
      .map(
        (archetype) =>
          `${archetype.id}/${archetype.toughness}/${archetype.wounds}/${archetype.models}/${archetype.points}`
      )
      .join('|'),
  ].join(',');
}

/** Таблица замеров отряда по ключу параметров; создаётся при первом обращении. */
function tableFor(attacker: CombatUnit, key: string): Map<string, ArchetypeMeasure> {
  let byKey = measureCache.get(attacker);
  if (byKey === undefined) {
    byKey = new Map<string, Map<string, ArchetypeMeasure>>();
    measureCache.set(attacker, byKey);
  }
  const table = byKey.get(key) ?? new Map<string, ArchetypeMeasure>();
  if (!byKey.has(key)) byKey.set(key, table);
  return table;
}

/**
 * Средние по подмножеству замеров.
 *
 * Отдельно от самого замера, потому что от набора целей зависит только это: по
 * архетипу цифры одинаковы в любой парадигме, а среднее и веса у каждой свои.
 */
function aggregate(
  table: Map<string, ArchetypeMeasure>,
  archetypes: UnitArchetype[],
  options: PerRoundOptions
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

  for (const archetype of archetypes) {
    const measured = table.get(archetype.id);
    if (measured === undefined) {
      // Случиться не может: measure() домеривает всё недостающее. Но молчать
      // нельзя — молча выкинутый тип цели тихо меняет среднее.
      throw new Error(`замер для «${archetype.id}» не посчитан`);
    }
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
  }

  return {
    ranged: { byArchetype: byArchetypeRanged, overall: weightedMean(rangedValues, weights), destroyedPoints: { byArchetype: destroyedRanged, overall: weightedMean(destroyedRangedValues, weights) } },
    melee: { byArchetype: byArchetypeMelee, overall: weightedMean(meleeValues, weights), destroyedPoints: { byArchetype: destroyedMelee, overall: weightedMean(destroyedMeleeValues, weights) } },
    total: { byArchetype: byArchetypeTotal, overall: weightedMean(totalValues, weights), destroyedPoints: { byArchetype: destroyedTotal, overall: weightedMean(destroyedTotalValues, weights) } },
  };
}

/**
 * Замер по одному набору целей: достаёт из кэша что уже посчитано, меряет
 * недостающее и собирает средние по своему набору.
 *
 * Замеров по архетипу получается столько, сколько РАЗНЫХ типов целей просили за
 * всё время жизни отряда в процессе, а не сколько раз звали damagePerRound:
 * первую парадигму меряет, остальные берут из таблицы.
 */
function measure(
  attacker: CombatUnit,
  archetypes: UnitArchetype[],
  options: PerRoundOptions,
  seed: number
): { ranged: DamageBreakdown; melee: DamageBreakdown; total: DamageBreakdown } {
  const key = cacheKeyOf(options, seed, options.archetypes ?? ARCHETYPES);
  const table = key === null ? new Map<string, ArchetypeMeasure>() : tableFor(attacker, key);
  for (const archetype of archetypes) {
    if (table.has(archetype.id)) continue;
    table.set(
      archetype.id,
      measureAgainst(attacker, archetype, options, seedOfArchetype(archetype, seed))
    );
  }
  return aggregate(table, archetypes, options);
}

/** Типы целей из опций: по умолчанию — все архетипы. */
function targetsOf(options: PerRoundOptions): UnitArchetype[] {
  const pool = options.archetypes ?? ARCHETYPES;
  const ids = options.targets;
  if (ids === null || ids === undefined) return [...pool];
  // Ищем в переопределённом наборе, а не в глобальном ARCHETYPES: при
  // sensitivity-запуске именно там лежат масштабированные цели.
  return ids.map((id) => pool.find((archetype) => archetype.id === id) ?? archetypeById(id));
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
  entries: Array<{ unit: CombatUnit; points: number }>,
  options: PerRoundOptions = {}
): ArchetypeDamageRow[] {
  const grouped = new Map<string, { type: ArchetypeId | 'unknown'; units: CombatUnit[] }>();

  for (const { unit, points } of entries) {
    // Классификация идёт по ближайшему центроиду, и один из признаков —
    // очки на модель, поэтому без стоимости тип не определяется.
    const archetype = archetypeOf(unit, points);
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


