/**
 * Выживаемость — обратная задача к perRound.
 *
 * Там считалось, сколько юнит НАНОСИТ. Здесь — сколько он ПОЛУЧАЕТ и
 * насколько трудно его убить шаблонными профилями оружия (weapons.ts).
 * Три величины, каждая и в ближнем, и в дальнем бою, и в комбинированном:
 *
 *  - `damagePerRound` — сколько урона цель принимает за раунд;
 *  - `roundsToKill`  — сколько раундов цель держится (больше = живучее);
 *  - `takenPer100Points` — пережитый урон на 100 очков стоимости цели:
 *    именно эта величина делает оценки сравнимыми между 80-очковым отрядом
 *    пехоты и 250-очковыми терминаторами.
 *
 * Нормировка нужна в обе стороны, и обе считаются от урона ПЕРВОГО раунда
 * (по неповреждённой цели): `dealtPer100Points` — сколько атакующий наносит
 * на 100 своих очков (насколько выгодна покупка), `takenPer100Points` —
 * сколько цель принимает на 100 своих очков (насколько она живуча).
 *
 * Важно: `roundsToKill` цензурирована сверху потолком `maxRounds`, поэтому за
 * глубину живучести отвечает `takenPer100Points`, а не число раундов.
 */

import { simulateBattle } from './simulate.ts';
import {
  WEAPON_ARCHETYPES,
  WEAPON_GROUPS,
  weaponPointsOf,
  weaponUnitOf,
  type WeaponArchetype,
  type WeaponGroupId,
} from './weapons.ts';
import {
  ARCHETYPES,
  targetUnitOf,
  type ArchetypeId,
  type UnitArchetype,
} from './archetypes.ts';
import type { CombatUnit, Rng } from './types.ts';
import { mulberry32 } from './dice.ts';

/** Среднее и σ. */
export interface SurvivalStat {
  mean: number;
  stdev: number;
}

/** Что шаблон оружия делает с целью за раунд. */
export interface WeaponThreat {
  weaponId: string;
  weaponName: string;
  group: WeaponGroupId;
  kind: 'ranged' | 'melee';
  /** Моделей в типовом стрельющем отряде. */
  models: number;
  /** Стоимость типового стрельющего в очках. */
  points: number;
  /** Урон за раунд. */
  damagePerRound: SurvivalStat;
  /** Сколько раундов нужно на уничтожение цели (больше = живучее цели). */
  roundsToKill: SurvivalStat;
  /** Доля боёв, в которых цель была уничтожена за maxRounds. */
  killProbability: number;
  /** Урон, который наносит стрельющий, на 100 своих очков. */
  dealtPer100Points: SurvivalStat;
  /** Урон, который цель принимает, на 100 своих очков. */
  takenPer100Points: SurvivalStat;
}

/** Сводка по одной цели. */
export interface SurvivalResult {
  target: {
    /** Тип цели; 'unknown', если отряд не классифицирован. */
    archetype: ArchetypeId | 'unknown';
    name: string;
    points: number;
    models: number;
    /** Полный запас ран цели. */
    totalWounds: number;
  };
  /** По каждому шаблону оружия. */
  weapons: WeaponThreat[];
  /** По группам оружия (стрелковое / рукопашное / тяжёлое / …). */
  byGroup: Record<string, {
    damagePerRound: SurvivalStat;
    roundsToKill: SurvivalStat;
    /** Пережитый урон на 100 очков цели; меньше = живучее. */
    takenPer100Points: SurvivalStat;
  }>;
  /** Усреднение по всем шаблонам оружия — итоговая живучесть. */
  overall: {
    damagePerRound: SurvivalStat;
    roundsToKill: SurvivalStat;
    /** Доля боёв, в которых цель была уничтожена за maxRounds. */
    killProbability: number;
    /** Пережитый урон на 100 очков цели: меньше = живучее. */
    takenPer100Points: SurvivalStat;
  };
}

export interface SurvivalOptions {
  /** Прогонов Монте-Карло на один замер (по умолчанию 200). */
  trials?: number;
  /** Сид для воспроизводимости. */
  seed?: number;
  /**
   * Какая фаза атаки учитывается. По умолчанию 'all' (обе): при 'ranged'
   * рукопашное оружие не наносит урона, при 'melee' — стрелковое.
   */
  phase?: 'ranged' | 'melee' | 'all';
  /** Какие группы оружия считать; по умолчанию — все. */
  groups?: WeaponGroupId[] | null;
  /** Какие шаблоны оружия считать; по умолчанию — все из выбранных групп. */
  weapons?: string[] | null;
  /** Потолок раундов в бою (по умолчанию 20). */
  maxRounds?: number;
  /** Дистанция для стрельбы (для Rapid Fire/Melta). */
  distance?: number | null;
  /** Явно заданный генератор бросков (иначе строится из seed). */
  rng?: Rng;
  /** Подпись типа цели в отчёте. */
  archetypeLabel?: ArchetypeId | 'unknown';
  /** Человекочитаемое имя цели. */
  archetypeName?: string;
}

/** Среднее и σ с безопасным делением. */
function stat(values: number[]): SurvivalStat {
  if (values.length === 0) return { mean: 0, stdev: 0 };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return { mean, stdev: Math.sqrt(variance) };
}

/** Нормировка величины на 100 очков. */
function per100Points(values: number[], points: number): SurvivalStat {
  if (points <= 0) return { mean: 0, stdev: 0 };
  return stat(values.map((value) => (value / points) * 100));
}

/** Шаблоны оружия по опциям: по умолчанию — все из выбранных групп. */
function weaponsOf(options: SurvivalOptions): WeaponArchetype[] {
  const groups = options.groups;
  const inGroup = (weapon: WeaponArchetype): boolean =>
    groups === null || groups === undefined || groups.includes(weapon.group);
  const ids = options.weapons;
  return WEAPON_ARCHETYPES.filter(
    (weapon) => inGroup(weapon) && (ids === null || ids === undefined || ids.includes(weapon.id))
  );
}

/** Замер одного шаблона оружия против одной цели. */
function threatAgainst(
  weapon: WeaponArchetype,
  target: CombatUnit,
  targetPoints: number,
  options: SurvivalOptions,
  seed: number
): WeaponThreat {
  const trials = options.trials ?? 200;
  const maxRounds = options.maxRounds ?? 20;
  const attacker = weaponUnitOf(weapon);
  const attackerPoints = weaponPointsOf(weapon);
  // Общий поток бросков на прогон: имитация нескольких боёв подряд.
  const rng = options.rng ?? mulberry32(seed >>> 0);

  const damage: number[] = [];
  const rounds: number[] = [];
  // Урон ПЕРВОГО раунда: цель ещё не ранена, поэтому обе нормировки
  // (нанесённый и пережитый) считаются от «чистого» выстрела, а не от
  // последнего раунда, где отряд может бить в умирающую цель впустую.
  const firstRound: number[] = [];
  let killed = 0;

  for (let i = 0; i < trials; i += 1) {
    const battle = simulateBattle(attacker, target, {
      // phase 'all' по умолчанию: без него resolveCombatOptions берёт 'ranged',
      // и рукопашные шаблоны не нанесли бы ни одного удара. В режиме 'ranged'
      // или 'melee' считается только соответствующая фаза.
      phase: options.phase ?? 'all',
      rng,
      distance: options.distance ?? null,
      maxRounds,
    });
    rounds.push(battle.rounds);
    if (battle.damageByRound.length > 0) {
      firstRound.push(battle.damageByRound[0]);
    }
    // Средний урон за раунд боя: полный урон делим на число сыгранных раундов,
    // иначе цель, убитая за один выстрел, «набирала» бы завышенный урон/раунд.
    damage.push(battle.damage / Math.max(1, battle.rounds));
    if (battle.targetDestroyed) killed += 1;
  }

  return {
    weaponId: weapon.id,
    weaponName: weapon.name,
    group: weapon.group,
    kind: weapon.kind,
    models: weapon.models,
    points: attackerPoints,
    damagePerRound: stat(damage),
    roundsToKill: stat(rounds),
    killProbability: trials > 0 ? killed / trials : 0,
    dealtPer100Points: per100Points(firstRound, attackerPoints),
    takenPer100Points: per100Points(firstRound, targetPoints),
  };
}

/**
 * Выживаемость цели против шаблонных профилей оружия.
 * Цель задаётся архетипом: его T/W/Sv, численность и очки.
 */
export function survivabilityAgainstArchetype(
  archetype: UnitArchetype,
  options: SurvivalOptions = {}
): SurvivalResult {
  const target = targetUnitOf(archetype);
  return survivabilityAgainstUnit(target, archetype.points, {
    ...options,
    archetypeLabel: archetype.id,
    archetypeName: archetype.name,
  });
}

/** Выживаемость произвольного отряда-цели. */
export function survivabilityAgainstUnit(
  target: CombatUnit,
  targetPoints: number,
  options: SurvivalOptions = {}
): SurvivalResult {
  const seed = options.seed ?? 0x5_1c_e;
  const weapons = weaponsOf(options);

  const threats = weapons.map((weapon, index) =>
    threatAgainst(weapon, target, targetPoints, options, (seed + index * 7919) >>> 0)
  );

  // Свод по группам: среднее по шаблонам внутри группы.
  const byGroup: SurvivalResult['byGroup'] = {};
  for (const group of WEAPON_GROUPS) {
    const inGroup = threats.filter((threat) => threat.group === group);
    if (inGroup.length === 0) continue;
    byGroup[group] = {
      damagePerRound: stat(inGroup.map((threat) => threat.damagePerRound.mean)),
      roundsToKill: stat(inGroup.map((threat) => threat.roundsToKill.mean)),
      takenPer100Points: stat(inGroup.map((threat) => threat.takenPer100Points.mean)),
    };
  }

  return {
    target: {
      archetype: options.archetypeLabel ?? 'unknown',
      name: options.archetypeName ?? target.name,
      points: targetPoints,
      models: target.models.length,
      totalWounds: target.models.reduce((sum, model) => sum + model.wounds, 0),
    },
    weapons: threats,
    byGroup,
    overall: {
      damagePerRound: stat(threats.map((threat) => threat.damagePerRound.mean)),
      roundsToKill: stat(threats.map((threat) => threat.roundsToKill.mean)),
      killProbability: stat(threats.map((threat) => threat.killProbability)).mean,
      takenPer100Points: stat(threats.map((threat) => threat.takenPer100Points.mean)),
    },
  };
}


/** Одна строка сводной таблицы живучести. */
export interface SurvivalRow {
  archetype: ArchetypeId;
  name: string;
  points: number;
  models: number;
  totalWounds: number;
  /** Средний урон за раунд по всем шаблонам оружия. */
  damagePerRound: SurvivalStat;
  /**
   * Среднее число раундов до уничтожения (больше = живучее).
   * ВНИМАНИЕ: величина цензурирована сверху потолком `maxRounds` — если цель
   * не убита, в счёт идёт весь потолок. Поэтому `roundsToKill` показывает
   * «хватило ли времени», а за глубину отвечает `takenPer100Points`.
   */
  roundsToKill: SurvivalStat;
  /** Доля боёв, в которых цель была уничтожена (1 — цель роняют всегда). */
  killProbability: number;
  /** Пережитый урон на 100 очков (меньше = живучее). */
  takenPer100Points: SurvivalStat;
  /** Результат по группам оружия. */
  byGroup: SurvivalResult['byGroup'];
}

/**
 * Сводная таблица живучести по всем типам юнитов: одна строка на архетип.
 * Это ответ на вопрос «насколько трудно убить юнит каждого типа».
 */
export function survivabilityTable(options: SurvivalOptions = {}): SurvivalRow[] {
  return ARCHETYPES.map((archetype) => {
    const result = survivabilityAgainstArchetype(archetype, options);
    return {
      archetype: archetype.id,
      name: archetype.name,
      points: archetype.points,
      models: archetype.models,
      totalWounds: result.target.totalWounds,
      damagePerRound: result.overall.damagePerRound,
      roundsToKill: result.overall.roundsToKill,
      killProbability: result.overall.killProbability,
      takenPer100Points: result.overall.takenPer100Points,
      byGroup: result.byGroup,
    };
  });
}

