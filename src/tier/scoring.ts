/**
 * Итоговый скоринг юнитов и распределение по тирам.
 *
 * Формула ровно по ТЗ:
 *   1. Best in Slot — берём лучшую из трёх величин урона на 100 очков
 *      (по пехоте / по броне / универсальную): юнит оценивается по сильнейшей
 *      стороне, а не по «средней температуре по больнице».
 *   2. Melee Tax — рукопашный отряд без возможности атаковать с фланга
 *      (депт-страйк/флай) платит за необходимость идти под огонь.
 *   3. Utility — очки за небоевые способности (потолок 20).
 *   4. Min-Max нормализация каждой из трёх величин на шкалу 0–100.
 *   5. Total = 0.40·урон + 0.35·живучесть + 0.25·полезность.
 *   6. Тиры — по перцентилям Total на всём наборе.
 *
 * Важно про направление шкал: и урон, и полезность «больше = лучше», а живучесть
 * в модуле survival измеряется как «пережитый урон на 100 очков» (меньше =
 * лучше). Поэтому здесь она переворачивается в `base_survivability = 100 /
 * takenPer100Points` — чтобы множитель Melee Tax и нормировка работали в
 * одну сторону. Это единственное нелинейное преобразование в цепочке.
 */

import { damagePerRound, type PerRoundOptions } from '../combat/perRound.ts';
import { survivabilityAgainstUnit, type SurvivalOptions } from '../combat/survival.ts';
import { archetypeOf, type ArchetypeId } from '../combat/archetypes.ts';
import type { CombatUnit } from '../combat/types.ts';
import type { BsDatasheet } from '../bsdata/types.ts';
import { detectUtilityFlags, utilityScoreOf, type UtilityFlag } from './utility.ts';

/** Тип отряда по тому, что он умеет лучше. */
export type UnitType = 'Ranged' | 'Melee';

/** Тир в тирлисте. */
export type Tier = 'S' | 'A' | 'B' | 'C' | 'D';

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
  /** Лучшая из трёх величин урона на 100 очков. */
  rawMaxDamage: number;
  /** Что именно оказалось лучшим — для отчёта. */
  bestSlot: 'infantry' | 'armor' | 'universal';
  vsInfantry: number;
  vsArmor: number;
  universal: number;
  /** Сырая живучесть: 100 / (пережитый урон на 100 очков). */
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
  /** Общие настройки Монте-Карло для выживаемости. */
  survival?: SurvivalOptions;
  /** Дополнительный признак «флай/депт-страйк» (снаружи — по данным). */
  hasFlyOrDeepStrike?: (datasheet: BsDatasheet) => boolean;
}

/** Среднее по списку. */
function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
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
  const combat = { ...(options.combat ?? {}) };
  const mode = options.mode ?? 'combined';
  const survival = { ...(options.survival ?? {}), phase: phaseOf(mode) };

  // Урон по трём срезам целей: пехота, броня и все архетипы сразу.
  // ВАЖНО: все три величины приводятся к одной шкале — «урон на 100 очков».
  // Иначе сравнение бессмысленно: универсальная уже нормирована, а срезы по
  // пехоте/броне остались бы сырыми, и «best slot» всегда выигрывал бы у
  // дешёвых юнитов с большим абсолютным уроном.
  const damage = damagePerRound(unit, { ...combat, targets: [...INFANTRY_TARGETS, ...ARMOR_TARGETS] });
  const scale = points > 0 ? 100 / points : 0;
  // Режим боя выбирает, из какой ветки разбивки берём цифры: в «ranged»
  // рукопашная часть просто не участвует в оценке.
  const slice = mode === 'ranged' ? damage.ranged : mode === 'melee' ? damage.melee : damage.total;
  const per100 = (ids: ArchetypeId[]): number =>
    mean(ids.map((id) => slice.byArchetype[id]?.mean ?? 0)) * scale;
  const vsInfantry = per100(INFANTRY_TARGETS);
  const vsArmor = per100(ARMOR_TARGETS);
  const universal = slice.overall.mean * scale;

  // Best in Slot: лучшая из трёх величин.
  const candidates: Array<[RawScore['bestSlot'], number]> = [
    ['infantry', vsInfantry],
    ['armor', vsArmor],
    ['universal', universal],
  ];
  const [bestSlot, rawMaxDamage] = candidates.reduce((best, current) =>
    current[1] > best[1] ? current : best
  );

  // Тип отряда — по тому, что фактически наносит больше урона на 100 очков.
  const rangedPer100 = damage.ranged.overall.mean * scale;
  const meleePer100 = damage.melee.overall.mean * scale;
  const unitType: UnitType = meleePer100 > rangedPer100 ? 'Melee' : 'Ranged';
  const hasFlyOrDeepStrike = options.hasFlyOrDeepStrike?.(datasheet) ?? detectFlyOrDeepStrike(datasheet);
  const tax = meleeTax(unitType, hasFlyOrDeepStrike);

  // Выживаемость: в survival «пережитый урон на 100 очков» — чем меньше, тем
  // лучше; для складывания с уроном переворачиваем в 100 / taken.
  const surv = survivabilityAgainstUnit(unit, points, survival);
  const takenPer100 = surv.overall.takenPer100Points.mean;
  const baseSurvivability = takenPer100 > 0 ? 100 / takenPer100 : 100;

  const utilityFlags = detectUtilityFlags(datasheet, { meleePer100 });
  const utilityScore = utilityScoreOf(utilityFlags);

  return {
    rawMaxDamage,
    bestSlot,
    vsInfantry,
    vsArmor,
    universal,
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
  entries: Array<{ datasheet: BsDatasheet; unit: CombatUnit; points: number }>,
  options: TieringOptions = {}
): TierRow[] {
  const drafts: DraftRow[] = entries.map(({ datasheet, unit, points }) => ({
    ...rawScoreOf(datasheet, unit, points, options),
    id: datasheet.id,
    name: datasheet.name,
    faction: datasheet.faction,
    points,
    models: unit.models.length,
    archetype: archetypeOf(unit)?.id ?? 'unknown',
  }));

  const normDamage = minMaxNormalize(drafts.map((row) => row.effectiveDamage));
  const normSurvivability = minMaxNormalize(drafts.map((row) => row.effectiveSurvivability));
  const normUtility = minMaxNormalize(drafts.map((row) => row.utilityScore));

  const totals = drafts.map((_, index) => {
    const total =
      normDamage[index] * SCORE_WEIGHTS.damage +
      normSurvivability[index] * SCORE_WEIGHTS.survivability +
      normUtility[index] * SCORE_WEIGHTS.utility;
    return { ...drafts[index], normDamage: normDamage[index], normSurvivability: normSurvivability[index], normUtility: normUtility[index], totalScore: total };
  });

  const sorted = totals.map((row) => row.totalScore).sort((a, b) => a - b);
  return totals
    .map((row) => {
      const percentile = percentileOf(sorted, row.totalScore);
      return { ...row, percentile, tier: tierOf(percentile) };
    })
    .sort((a, b) => b.totalScore - a.totalScore);
}

