/**
 * Типы модуля симуляции боя.
 *
 * Домен намеренно отделён от парсеров: парсеры конвертируют свои даташиты в
 * CombatUnit (см. adapters/), а симуляция работает только с этими типами.
 * Расширяемость — через цепочки модификаторов (CombatRules) в rules.ts.
 */

export type Phase = 'ranged' | 'melee' | 'all';

/** Спецификация кубов: '2D6+3' → { count: 2, sides: 6, plus: 3 }; фикс. число → sides: 1. */
export interface DiceSpec {
  count: number;
  sides: number;
  plus: number;
}

/** Условие на кейворды цели ('non-MONSTER/VEHICLE' → { keywords: [MONSTER, VEHICLE], negate: true }). */
export interface KeywordCondition {
  keywords: string[];
  negate: boolean;
}

/** Кейворд оружия, приведённый к каноническому виду. */
export interface ParsedKeyword {
  /** 'sustained', 'lethal', 'devastating', 'rapid-fire', 'melta', 'blast', 'cleave', 'anti'… */
  name: string;
  /** Исходная строка ('Sustained Hits 1'). */
  raw: string;
  /** Значение X для [SUSTAINED HITS X], [RAPID FIRE X], [MELTA X], [ANTI-X Y+] (Y). */
  value: DiceSpec | null;
  /** Для ANTI: список ключевых слов цели ('Infantry', 'Monster/Vehicle' → [MONSTER, VEHICLE]). */
  target: string[] | null;
  /** Условие после двоеточия ('non-MONSTER/VEHICLE'). */
  condition: KeywordCondition | null;
}

export interface CombatWeapon {
  id: string;
  name: string;
  kind: 'ranged' | 'melee';
  /** Дистанция в дюймах; null для рукопашного/неизвестной. */
  range: number | null;
  attacks: DiceSpec | null;
  /** BS/WS '3+' → 3; null — атаковать не может ('-'). */
  skill: number | null;
  strength: number | null;
  /** AP '-2' → -2. */
  ap: number;
  damage: DiceSpec | null;
  keywords: ParsedKeyword[];
}

/** Одна модель отряда (уже развёрнутая до экземпляра, без поля count). */
export interface CombatModel {
  id: string;
  name: string;
  toughness: number;
  wounds: number;
  /** '3+' → 3; null — сейва нет. */
  save: number | null;
  invuln: number | null;
  keywords: string[];
  weapons: CombatWeapon[];
}

export interface CombatUnit {
  id: string;
  name: string;
  /** Кейворды отряда в верхнем регистре ('INFANTRY', 'VEHICLE'…). */
  keywords: string[];
  models: CombatModel[];
}

/** Генератор случайных чисел: возвращает число в [0, 1). */
export type Rng = () => number;

/**
 * Контекст одного применения оружия. Прокидывается во все модификаторы
 * правил — из него доступны и атакующий, и защитник, и текущая цель.
 */
export interface CombatContext {
  phase: 'ranged' | 'melee';
  /** Дистанция до цели в дюймах; null — неизвестна (бонусы половинной дальности не действуют). */
  distance: number | null;
  weapon: CombatWeapon;
  attacker: CombatUnit;
  attackerModel: CombatModel;
  defender: CombatUnit;
  /** Текущая цель (экземпляр модели защитника). */
  target: CombatModel;
  /** Живых моделей в отряде цели на момент сбора дайсов (для Blast/Cleave). */
  defenderModelCount: number;
  /** Атакующий отряд заряжал в этот ход (Lance). */
  charged: boolean;
  /** Атакующий не двигался (Heavy). */
  stationary: boolean;
  /** Стрельба вслепую (штраф попадания). */
  indirect: boolean;
  /** Цель в укрытии: +1 к спасброску от дальнобойных атак (кроме [IGNORES COVER]). */
  cover: boolean;
  /** Атакующий в зоне боя: стрелять могут только [PISTOL]/[CLOSE-QUARTERS]. */
  engaged: boolean;
  rng: Rng;
}

/**
 * Цепочки модификаторов боевой последовательности. Каждая функция цепочки
 * получает текущее значение и контекст и возвращает новое. Порядок: сначала
 * стандартные правила кейвордов (rules.ts), затем пользовательские расширения.
 *
 *  - extraAttackDice:       доп. дайсы атак (Rapid Fire, Blast, Cleave);
 *  - hitTarget:             порог попадания; null = автопопадание (Torrent);
 *  - extraHits:             доп. попадания за крит. попадания (Sustained Hits);
 *  - lethalCritHits:        крит. попадание автопоражает (Lethal Hits);
 *  - woundTarget:           порог ранения (по S/T); null = ранить нельзя;
 *  - criticalWoundTarget:   порог критического ранения (Anti-X Y+);
 *  - rerollWounds:          переброс неудачных ранений (Twin-linked);
 *  - devastatingCritWounds: крит. ранение → мортиды (Devastating Wounds);
 *  - saveTarget:            порог сейва после AP; null = сейва нет;
 *  - damage:                урон за ранение (Melta X добавляет к D).
 */
export interface CombatRules {
  extraAttackDice: Array<(ctx: CombatContext, rolled: number) => number>;
  hitTarget: Array<(ctx: CombatContext, base: number | null) => number | null>;
  extraHits: Array<(ctx: CombatContext, critHits: number) => number>;
  lethalCritHits: Array<(ctx: CombatContext) => boolean>;
  woundTarget: Array<(ctx: CombatContext, base: number | null) => number | null>;
  criticalWoundTarget: Array<(ctx: CombatContext, base: number) => number>;
  rerollWounds: Array<(ctx: CombatContext) => boolean>;
  devastatingCritWounds: Array<(ctx: CombatContext) => boolean>;
  saveTarget: Array<(ctx: CombatContext, base: number | null) => number | null>;
  damage: Array<(ctx: CombatContext, base: DiceSpec) => DiceSpec>;
}

/** Частичное правило для extendRules: можно передать только нужные хуки. */
export type RuleFragment = Partial<CombatRules>;

export interface WeaponUsageResult {
  weaponId: string;
  weaponName: string;
  kind: 'ranged' | 'melee';
  /** Моделей, стрелявших/бивших этим оружием. */
  models: number;
  /** Собрано дайсов атак (после Rapid Fire/Blast/Cleave). */
  attacks: number;
  hits: number;
  wounds: number;
  /** Ранений, дошедших до сейва (или мортид). */
  unsaved: number;
  mortals: number;
  damage: number;
  kills: number;
}

/** Результат одного прогона симуляции. */
export interface TrialResult {
  phase: Phase;
  /** Суммарный урон, доведённый до моделей защитника. */
  damage: number;
  /** Уничтожено моделей защитника. */
  kills: number;
  /** Осталось живых моделей защитника. */
  survivors: number;
  weapons: WeaponUsageResult[];
}

/** Агрегат Монте-Карло. */
export interface MonteCarloResult {
  trials: number;
  damage: { mean: number; stdev: number };
  kills: { mean: number; stdev: number };
  /** Доля прогонов, где убита хотя бы одна модель. */
  killProbability: number;
  /** Среднее по каждому оружию (в порядке первого появления). */
  weapons: Array<WeaponUsageResult & { damageMean: number; damageStdev: number }>;
}