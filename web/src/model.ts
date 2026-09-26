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

