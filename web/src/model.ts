/**
 * Модель данных тирлиста на клиенте.
 *
 * Файл `web/public/data/tierlist.json` собирается скриптом scripts/build-tierlist.ts.
 * Здесь описана только форма этих данных — никаких расчётов.
 *
 * Раньше в файле была вторая копия всей нормализации (min-max, ранг по ценовым
 * корзинам, natural breaks, тиры), чтобы пересчитывать тирлист в браузере после
 * правки юнита. С правкой редактор убран, а вместе с ней и дублирование: держать
 * две реализации одного правила означало бы, что цифры на сайте и в отчётах
 * расходятся при первой же правке весов. Теперь единственный источник правды —
 * сборка, а метрики приходят готовыми, включая нормы, Total, перцентиль и тир.
 *
 * Боевой профиль (`UnitProfile`) остался: по нему панель деталей показывает
 * состав отряда и оружие.
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
}

export interface UnitProfile {
  id: string;
  name: string;
  /** Стоимость отряда. */
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

/**
 * Ячейка индекса — ровно те величины, что видны в строке таблицы.
 *
 * Собиратель отдаёт полную метрику в файле юнита, а здесь оставлено девять
 * чисел на каждую пару «парадигма × режим». Имена полей совпадают с полными
 * метриками, поэтому код рендера не различает источник.
 */
export type UnitCell = Pick<
  UnitMetrics,
  | 'tier'
  | 'totalScore'
  | 'percentile'
  | 'rawMaxDamage'
  | 'universal'
  | 'damagePer100'
  | 'effectiveSurvivability'
  | 'absorbedPer100'
  | 'utilityScore'
  | 'unitType'
  | 'normDamage'
  | 'normSurvivability'
  | 'normUtility'
  | 'bestTarget'
  | 'bestTargetName'
>;

/** Строка таблицы: всё, что нужно для отрисовки и сортировки, без деталей. */
export interface UnitIndexEntry {
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
   * Лидер или Support-юнит: в листе он существует только рядом с отрядом,
   * которому присоединён, и в самостоятельной ротации не ставится.
   *
   * Флаг чисто интерфейсный: он прячет такие строки из основной вкладки по
   * умолчанию, но НЕ меняет расчёт — тиры считаются по всем строкам. Иначе
   * скрытие сдвинуло бы положение настоящих боевых юнитов.
   */
  isLeader: boolean;
  /**
   * Дельты одноразовых способностей — справочные величины, в Total и нормы
   * они не входят.
   *
   * Две цифры, а не одна: способности делятся на классы, которые видны в разных
   * величинах. Боевые (Trajann, повторный залп Custodian Guard) проявляются в
   * `damage`, защитные (Allarus-щит) — в `survivability`. Одно число заставило бы
   * складывать несравнимые сущности или молча терять половину эффектов.
   */
  onceEffectDeltas?: {
    /** Дополнительные уничтоженные очки на 100 очков юнита. */
    damage: number;
    /** Дополнительные прожитые боевые фазы. */
    survivability: number;
  };
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
  cells: Record<TargetParadigm, Record<CombatMode, UnitCell>>;
}

/**
 * Полная запись юнита — грузится по клику из `data/units/<id>.json`.
 *
 * Держит боевой профиль и сетку метрик по всем парадигмам: панель деталей
 * показывает разбивку урона, живучесть, налоги и loadouts, а в индексе их нет
 * — они весили бы 16 МБ на набор ради одного открытого юнита.
 */
export interface UnitDetail {
  id: string;
  name: string;
  faction: string;
  factions: string[];
  points: number;
  models: number;
  archetype: string;
  onceEffectDeltas?: { damage: number; survivability: number };
  sensitivity?: { spread: number; high: boolean; medium: boolean; tierChangeProbability: number };
  utilityFlags: Array<{ id: string; points: number; reason: string; category: string }>;
  utilityScore: number;
  unit: UnitProfile;
  metricsByParadigm: Record<TargetParadigm, Record<CombatMode, UnitMetrics>>;
  loadouts?: Array<{ id: string; name: string; points: number; unit: UnitProfile }>;
}

/**
 * Лидер в индексе — только то, чем пользуется интерфейс.
 *
 * Раньше здесь были `bonuses`, `abilities` и полный `unit` (модели и оружие):
 * 0.70 МБ балласта в файле, который грузится сразу. Убрано при сборке индекса;
 * расчёту эти поля не нужны, он идёт по полным LeaderDefinition.
 */
export interface LeaderSummary {
  id: string;
  name: string;
  faction: string;
  factions: string[];
  points: number;
  keywords: string[];
  /** Сколько отрядов берёт лидер: видно, насколько он универсален. */
  allowedUnitIds: string[];
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
  /**
   * Перцентиль в объединённой сетке: голые отряды и пары считаются вместе,
   * поэтому пара сравнима с обычным юнитом из основной вкладки.
   */
  percentile: number;
  /**
   * Дельты пары относительно голого отряда в той же объединённой сетке.
   *
   * `deltaPercentile` — главная из них: на сколько мест в общей шкале лидер
   * поднял (или опустил) отряд. Проверяется по файлу как
   * `percentile − barePercentile`.
   */
  deltaPercentile: number;
  deltaTotal: number;
  deltaDamage: number;
  deltaSurvivability: number;
  /** Перцентиль и тир того же отряда без лидера, в той же сетке. */
  barePercentile: number;
  bareTier: Tier;
  /** Сколько очков стоит лидер и какую долю цены пары он забирает. */
  leaderPoints: number;
  leaderCostShare: number;
  rawMaxDamage: number;
  bestTarget: string;
  bestTargetName: string;
  effectiveSurvivability: number;
  utilityScore: number;
  utilityFlags: Array<{ id: string; points: number; reason: string }>;
}

/**
 * `data/tierlist.json` — индекс, единственный файл, который грузится сразу.
 *
 * Раньше здесь лежало всё, включая полные метрики по каждой паре
 * «парадигма × режим» и строки «юнит + лидер»: 36 МБ, из которых 4.6 МБ —
 * побайтовая копия `metricsByParadigm.all`. Теперь индекс несёт только то, что
 * рисует таблица, а остальное едет отдельными файлами по требованию.
 */
export interface IndexData {
  generatedAt: string;
  trials: number;
  distance: number;
  modes: CombatMode[];
  paradigms: TargetParadigm[];
  factions: string[];
  units: UnitIndexEntry[];
  leaders: LeaderSummary[];
}

/** `data/attached.json` — вкладка «с лидерами», грузится при переключении. */
export interface AttachedData {
  generatedAt: string;
  attached: Record<TargetParadigm, Record<CombatMode, AttachedRow[]>>;
}

/**
 * Принадлежит ли строка типу TargetParadigm.
 *
 * Существует из-за одного бага: проверка стояла на Object.keys по массиву
 * парадигм, а Object.keys(['all']) — это ['0'], а не ['all']. Проверка всегда
 * была ложна, `cellOf` отдавал null, и выбор парадигмы цели молча показывал
 * данные парадигмы all: 3279 из 4372 ячеек в сборке отличаются от all.
 *
 * Список берётся из данных, а не из типа: набор парадигм задаёт сборщик, и
 * TypeScript ничего не знает о его содержимом.
 */
export function isTargetParadigm(
  value: string,
  paradigms: readonly TargetParadigm[]
): value is TargetParadigm {
  return paradigms.includes(value as TargetParadigm);
}

