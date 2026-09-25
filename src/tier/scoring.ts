/**
 * Итоговый скоринг юнитов и распределение по тирам.
 *
 * Метрика — ВЕКТОРЫ, а не одно число. Урон и живучесть не сворачиваются в
 * максимум или среднее до сравнения: по каждой цели и по каждой группе
 * входящего оружия считается своя компонента, и только потом юнит сравнивается
 * с набором. Подробности:
 *   1. Атака — `effectiveOffenseVector`: уничтоженные очки на 100 очков
 *      атакующего по каждому типу цели (13 архетипов), с Melee Tax.
 *   2. Защита — `defenseVector`: 100 / (1 + takenPer100) по каждой группе
 *      входящего оружия (6 групп).
 *   3. Melee Tax — рукопашный отряд без атаки с фланга/сверху (депт-страйк,
 *      флай) платит за необходимость идти под огонь. В режиме 'ranged' не
 *      применяется: рукопашная фаза там не участвует.
 *   4. Нормализация — ПОРАНГОВАЯ и ПОКОМПОНЕНТНАЯ: у каждой компоненты свой
 *      перцентильный ранг. Раньше был min-max по одному числу, из-за чего
 *      один Titan или один удачный матчап растягивали шкалу и делали всех
 *      остальных «мелкими».
 *   5. Свёртка вектора — 0.60·среднее + 0.25·25-й перцентиль + 0.15·лучшая
 *      компонента. Нижний квартиль не даёт одному матчапу скрыть провалы.
 *   6. Utility — очки за небоевые способности (потолок 20), см. utility.ts.
 *   7. Total = 0.40·урон + 0.35·живучесть + 0.25·полезность.
 *   8. Тиры — по перцентилям Total на всём наборе.
 *
 * Важно про направление шкал: и урон, и полезность «больше = лучше», а живучесть
 * в модуле survival измеряется как «пережитый урон на 100 очков» (меньше =
 * лучше). Поэтому здесь она переворачивается в `100 / (1 + takenPer100)` —
 * чтобы множитель Melee Tax и нормировка работали в одну сторону.
 *
 * Известное ограничение: стоимость входит через «на 100 очков», но НЕ учитывает
 * занятый detachment. Соло-модель за 65 очков занимает столько же места в
 * армии, сколько отряд пехоты за 80, и формула этого не видит.
 */

import { damagePerRound, type PerRoundOptions } from '../combat/perRound.ts';
import { survivabilityAgainstUnit, type SurvivalOptions } from '../combat/survival.ts';
import { archetypeById, archetypeOf, type ArchetypeId } from '../combat/archetypes.ts';
import type { CombatUnit } from '../combat/types.ts';
import { isEligibleForCalculations } from '../combat/budget.ts';
import type { BsDatasheet } from '../bsdata/types.ts';
import { detectUtilityFlags, utilityScoreOf, type UtilityFlag } from './utility.ts';
import { attachLeaderToUnit, leaderCombatOptionsOf, type LeaderDefinition } from './leaders.ts';

/** Тип отряда по тому, что он умеет лучше. */
export type UnitType = 'Ranged' | 'Melee';

/** Тир в тирлисте. */
export type Tier = 'S' | 'A' | 'B' | 'C' | 'D';

/** Парадигма цели, относительно которой строится тирлист. */
export type TargetParadigm = 'all' | 'infantry' | 'elite' | 'armor';

/**
 * Что именно оцениваем: только стрельбу, только рукопашную или обе фазы.
 *
 * От режима зависит и урон, и живучесть: в режиме «melee» стрелковое оружие
 * не участвует (а у отряда без рукопашного оружия результат вырождается в нули —
 * это честный ответ «в ближнем бою он бесполезен»).
 */
export type CombatMode = 'ranged' | 'melee' | 'combined';

/** Какая фаза попадает в расчёт для режима. */
function phaseOf(mode: CombatMode): 'ranged' | 'melee' | 'all' {
  if (mode === 'ranged') return 'ranged';
  if (mode === 'melee') return 'melee';
  return 'all';
}

/** Типы целей, делящиеся на «пехоту» и «броню» для Best in Slot. */
const INFANTRY_TARGETS: ArchetypeId[] = [
  'infantry',
  'infantry-veteran',
  'swarm',
  'terminator',
  'jetpack',
  'cavalry',
];

const ARMOR_TARGETS: ArchetypeId[] = [
  'monster',
  'walker',
  'vehicle',
  'transport',
  'flyer',
  'battlesuit',
  'fortification',
];

/** Цели для выбранной парадигмы. */
export function targetsForParadigm(paradigm: TargetParadigm = 'all'): ArchetypeId[] {
  if (paradigm === 'infantry') return [...INFANTRY_TARGETS];
  if (paradigm === 'elite') return ['infantry-veteran', 'terminator', 'jetpack', 'monster'];
  if (paradigm === 'armor') return [...ARMOR_TARGETS];
  return [...INFANTRY_TARGETS, ...ARMOR_TARGETS];
}

/** Веса итогового скора. */
export const SCORE_WEIGHTS = { damage: 0.4, survivability: 0.35, utility: 0.25 } as const;

/** Границы тиров по перцентилям. */
export const TIER_PERCENTILES = { S: 0.9, A: 0.75, B: 0.5, C: 0.25 } as const;

/** Множители Melee Tax. */
export interface MeleeTax {
  damage: number;
  survivability: number;
}

export function meleeTax(unitType: UnitType, hasFlyOrDeepStrike: boolean): MeleeTax {
  if (unitType === 'Ranged') return { damage: 1, survivability: 1 };
  if (hasFlyOrDeepStrike) return { damage: 0.85, survivability: 0.85 };
  return { damage: 0.7, survivability: 0.6 };
}

/** Сырые метрики юнита — до нормировки (нормировка общая для набора). */
export interface RawScore {
  /** Лучшее количество уничтоженных очков цели на 100 очков атакующего. */
  rawMaxDamage: number;
  /** Что именно оказалось лучшим — для отчёта. */
  bestSlot: 'infantry' | 'armor' | 'universal';
  /** Конкретный архетип-противник с максимальным destroyed points. */
  bestTarget: ArchetypeId;
  bestTargetName: string;
  /** Уничтоженные очки по каждому типу цели, на 100 очков атакующего. */
  destroyedPointsByTarget: Record<string, number>;
  /** Вектор защиты: 100 / (1 + takenPer100) по каждой группе оружия. */
  defenseVector: Record<string, number>;
  /** Вектор атаки после Melee Tax, по каждой цели. */
  effectiveOffenseVector: Record<string, number>;
  /** Средние destroyed points по пехоте/броне — оставлены для совместимости с отчётами. */
  vsInfantry: number;
  vsArmor: number;
  /** Средние destroyed points по всем выбранным целям. */
  universal: number;
  /** Оставлено для совместимости с отчётами: урон, а не уничтоженные очки. */
  damagePer100: number;
  /** Стоимостная выживаемость: 100 / (1 + takenPer100). */
  baseSurvivability: number;
  /** Пережитый урон на 100 очков (для справки). */
  takenPer100: number;
  unitType: UnitType;
  hasFlyOrDeepStrike: boolean;
  tax: MeleeTax;
  effectiveDamage: number;
  effectiveSurvivability: number;
  utilityFlags: UtilityFlag[];
  utilityScore: number;
}

/** Итоговая строка тирлиста. */
export interface TierRow extends RawScore {
  id: string;
  name: string;
  faction: string;
  points: number;
  models: number;
  archetype: ArchetypeId | 'unknown';
  normDamage: number;
  normSurvivability: number;
  normUtility: number;
  /** Векторные агрегаты: среднее + нижний перцентиль + лучшая компонента. */
  vectorDamageScore: number;
  vectorSurvivabilityScore: number;
  /** 25-й перцентиль нормированных компонент — защита от одного выброса. */
  vectorDamageFloor: number;
  vectorSurvivabilityFloor: number;
  totalScore: number;
  /** Перцентиль Total в наборе (0–100). */
  percentile: number;
  tier: Tier;
}

/** Настройки расчёта. */
export interface TieringOptions {
  size?: 'min' | 'max';
  /** Что оцениваем: стрельба, рукопашная или обе фазы (по умолчанию — combined). */
  mode?: CombatMode;
  /** Общие настройки Монте-Карло для урона. */
  combat?: PerRoundOptions;
  /** Целевые архетипы для режима «против X»: all — все, armor — броня. */
  targets?: ArchetypeId[] | null;
  /** Парадигма цели для сайта; all — все типы. */
  targetParadigm?: TargetParadigm;
  /** Общие настройки Монте-Карло для выживаемости. */
  survival?: SurvivalOptions;
  /** Присоединённый leader/support для расчёта отдельной строки. */
  leader?: LeaderDefinition;
  /** Дополнительный признак «флай/депт-страйк» (снаружи — по данным). */
  hasFlyOrDeepStrike?: (datasheet: BsDatasheet) => boolean;
}

/** Среднее по списку. */
function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Перцентиль по отсортированному набору (с интерполяцией).
 * fraction 0.25 — нижний квартиль: показывает, насколько юнит слаб ТАМ, где слаб.
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
 * Летит ли отряд / входит ли с депт-страйка: и то и другое снимает штраф
 * рукопашного отряда (атака с фланга не требует идти под огонь).
 */
function detectFlyOrDeepStrike(datasheet: BsDatasheet): boolean {
  if (datasheet.keywords.some((keyword) => keyword.toLowerCase() === 'fly')) return true;
  if (datasheet.transportCapacity !== null) return true;
  return [...datasheet.abilities, ...datasheet.rules].some((ability) =>
    /deep strike|reserves|cult ambush|drop pod/i.test(`${ability.name} ${ability.description}`)
  );
}

/** Сырые метрики одного юнита (без нормировки — она общая для набора). */
export function rawScoreOf(
  datasheet: BsDatasheet,
  unit: CombatUnit,
  points: number,
  options: TieringOptions = {}
): RawScore {
  const baseUnit = options.leader ? attachLeaderToUnit(unit, options.leader) : unit;
  const leaderOptions = options.leader ? leaderCombatOptionsOf(options.leader) : {};
  const combat = { ...(options.combat ?? {}), ...leaderOptions };
  const mode = options.mode ?? 'combined';
  const targets = options.targetParadigm === undefined && options.targets === undefined
    ? [...INFANTRY_TARGETS, ...ARMOR_TARGETS]
    : options.targets ?? targetsForParadigm(options.targetParadigm);
  const survival = { ...(options.survival ?? {}), phase: phaseOf(mode), ...leaderOptions };
  const damage = damagePerRound(baseUnit, { ...combat, targets });
  const scale = points > 0 ? 100 / points : 0;
  // Режим боя выбирает, из какой ветки разбивки берём цифры: в «ranged»
  // рукопашная часть просто не участвует в оценке.
  const slice = mode === 'ranged' ? damage.ranged : mode === 'melee' ? damage.melee : damage.total;
  const destroyedPer100 = (id: ArchetypeId): number =>
    (slice.destroyedPoints.byArchetype[id]?.mean ?? 0) * scale;
  const destroyedPointsByTarget: Record<string, number> = Object.fromEntries(
    targets.map((id) => [id, destroyedPer100(id)])
  );
  const vsInfantry = mean(INFANTRY_TARGETS.map(destroyedPer100));
  const vsArmor = mean(ARMOR_TARGETS.map(destroyedPer100));
  const universal = slice.destroyedPoints.overall.mean * scale;
  const damagePer100 = slice.overall.mean * scale;
  const [bestTarget, rawMaxDamage] = targets.reduce<[ArchetypeId, number]>(
    (best, id) => (destroyedPer100(id) > best[1] ? [id, destroyedPer100(id)] : best),
    [targets[0] ?? 'infantry', 0]
  );
  const bestTargetName = archetypeById(bestTarget).name;
  const bestSlot: RawScore['bestSlot'] = INFANTRY_TARGETS.includes(bestTarget)
    ? 'infantry'
    : ARMOR_TARGETS.includes(bestTarget)
      ? 'armor'
      : 'universal';

  // Тип отряда — по тому, что фактически наносит больше урона на 100 очков.
  const rangedPer100 = damage.ranged.overall.mean * scale;
  const meleePer100 = damage.melee.overall.mean * scale;
  const unitType: UnitType = meleePer100 > rangedPer100 ? 'Melee' : 'Ranged';
  const hasFlyOrDeepStrike = options.hasFlyOrDeepStrike?.(datasheet) ?? detectFlyOrDeepStrike(datasheet);
  // В режиме ranged рукопашная фаза не участвует, поэтому melee-штраф
  // за неё применять нельзя.
  const tax = mode === 'ranged' ? { damage: 1, survivability: 1 } : meleeTax(unitType, hasFlyOrDeepStrike);

  // Выживаемость: в survival «пережитый урон на 100 очков» — чем меньше, тем
  // лучше; для складывания с уроном переворачиваем в 100 / taken.
  const surv = survivabilityAgainstUnit(baseUnit, points, survival);
  const takenPer100 = surv.overall.takenPer100Points.mean;
  const baseSurvivability = 100 / (1 + takenPer100);
  const effectiveOffenseVector = Object.fromEntries(
    Object.entries(destroyedPointsByTarget).map(([id, value]) => [id, value * tax.damage])
  );
  const defenseVector = Object.fromEntries(
    Object.entries(surv.byGroup).map(([group, value]) => [
      group,
      100 / (1 + value.takenPer100Points.mean) * tax.survivability,
    ])
  );

  const utilityFlags = detectUtilityFlags(datasheet);
  const utilityScore = utilityScoreOf(utilityFlags);

  return {
    rawMaxDamage,
    bestSlot,
    bestTarget,
    bestTargetName,
    destroyedPointsByTarget,
    effectiveOffenseVector,
    defenseVector,
    vsInfantry,
    vsArmor,
    universal,
    damagePer100,
    baseSurvivability,
    takenPer100,
    unitType,
    hasFlyOrDeepStrike,
    tax,
    effectiveDamage: rawMaxDamage * tax.damage,
    effectiveSurvivability: baseSurvivability * tax.survivability,
    utilityFlags,
    utilityScore,
  };
}

/**
 * Min-Max нормализация набора значений в шкалу 0–100.
 * Если все значения одинаковы (Max == Min), каждому присваивается 50.
 */
export function minMaxNormalize(values: number[]): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 50);
  return values.map((value) => ((value - min) / (max - min)) * 100);
}

/**
 * Перцентиль значения в наборе: какой процент набора не превосходит его.
 *
 * Считается ПО РАНГУ, а не самим значением: Total_Score нормирован по трём
 * независимым осям, поэтому его максимум по набору редко достигает 100
 * (никто не бывает лучшим сразу по урону, живучести и полезности). Если
 * вернуть само значение, почти всё стянулось бы в нижние тиры.
 *
 * @param sorted отсортированный по возрастанию массив значений набора
 */
export function percentileOf(sorted: number[], value: number): number {
  if (sorted.length === 0) return 50;
  if (sorted.length === 1) return 50;
  // Доля значений строго меньших + половина равных (середина диапазона).
  let below = 0;
  let equal = 0;
  for (const item of sorted) {
    if (item < value) below += 1;
    else if (item === value) equal += 1;
    else break; // массив отсортирован — дальше только большие
  }
  if (equal > 1) {
    // При совпадении с несколькими юнитами берём середину их «плато».
    return ((below + (equal - 1) / 2) / (sorted.length - 1)) * 100;
  }
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

/** Сырые строки без тиров — внутренний шаг сборки тирлиста. */
interface DraftRow extends RawScore {
  id: string;
  name: string;
  faction: string;
  points: number;
  models: number;
  archetype: ArchetypeId | 'unknown';
}

/**
 * Полный тирлист: считает сырые метрики, нормирует их относительно всего
 * набора, считает Total и расставляет тиры по перцентилям.
 *
 * Порядок строк — по убыванию Total (готовый вид тирлиста).
 */
export function tierList(
  entries: Array<{ datasheet: BsDatasheet; unit: CombatUnit; points: number; leader?: LeaderDefinition; rowId?: string; faction?: string }>,
  options: TieringOptions = {}
): TierRow[] {
  const eligibleEntries = entries.filter(({ datasheet, points, leader }) =>
    isEligibleForCalculations(datasheet.name, points + (leader?.points ?? 0))
  );
  const drafts: DraftRow[] = eligibleEntries.map(({ datasheet, unit, points, leader, rowId, faction }) => {
    const totalPoints = points + (leader?.points ?? 0);
    return {
    ...rawScoreOf(datasheet, unit, totalPoints, { ...options, leader }),
    id: rowId ?? datasheet.id,
    name: leader ? `${datasheet.name} + ${leader.name}` : datasheet.name,
    faction: faction ?? datasheet.faction,
    points: totalPoints,
    models: (leader ? attachLeaderToUnit(unit, leader) : unit).models.length,
    archetype: archetypeOf(unit)?.id ?? 'unknown',
    };
  });

  const offenseKeys = Object.keys(drafts[0]?.effectiveOffenseVector ?? {});
  const defenseKeys = Object.keys(drafts[0]?.defenseVector ?? {});
  const rankComponent = (pick: (row: DraftRow) => number | undefined): number[] => {
    const sorted = drafts.map((row) => pick(row) ?? 0).sort((a, b) => a - b);
    return drafts.map((row) => percentileOf(sorted, pick(row) ?? 0));
  };
  const offenseRanks = offenseKeys.map((key) => rankComponent((row) => row.effectiveOffenseVector[key]));
  const defenseRanks = defenseKeys.map((key) => rankComponent((row) => row.defenseVector[key]));
  const aggregate = (ranks: number[][], index: number): { score: number; floor: number } => {
    if (ranks.length === 0) return { score: 50, floor: 50 };
    const values = ranks.map((component) => component[index]).sort((a, b) => a - b);
    const floor = percentileAt(values, 0.25);
    const best = values[values.length - 1] ?? 0;
    // Взвешенная свёртка: универсальность (среднее) весит больше всего,
    // нижний квартиль не даёт одному удачному матчапу скрыть провалы,
    // а лучшая компонента сохраняет информацию о специализации.
    return { score: mean(values) * 0.6 + floor * 0.25 + best * 0.15, floor };
  };
  const vectorRows = drafts.map((_, index) => ({
    damageVector: aggregate(offenseRanks, index),
    defenseVector: aggregate(defenseRanks, index),
  }));
  const normDamage = vectorRows.map((value) => value.damageVector.score);
  const normSurvivability = vectorRows.map((value) => value.defenseVector.score);
  const normUtility = minMaxNormalize(drafts.map((row) => row.utilityScore));

  const totals = drafts.map((_, index) => {
    const total =
      normDamage[index] * SCORE_WEIGHTS.damage +
      normSurvivability[index] * SCORE_WEIGHTS.survivability +
      normUtility[index] * SCORE_WEIGHTS.utility;
    return { ...drafts[index], normDamage: normDamage[index], normSurvivability: normSurvivability[index], normUtility: normUtility[index], vectorDamageScore: vectorRows[index].damageVector.score, vectorSurvivabilityScore: vectorRows[index].defenseVector.score, vectorDamageFloor: vectorRows[index].damageVector.floor, vectorSurvivabilityFloor: vectorRows[index].defenseVector.floor, totalScore: total };
  });

  const sorted = totals.map((row) => row.totalScore).sort((a, b) => a - b);
  return totals
    .map((row) => {
      const percentile = percentileOf(sorted, row.totalScore);
      return { ...row, percentile, tier: tierOf(percentile) };
    })
    .sort((a, b) => b.totalScore - a.totalScore);
}

