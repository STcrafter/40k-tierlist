/**
 * Ядро симуляции боя: последовательность «сбор дайсов атак → попадание →
 * ранение → сейв → урон → распределение по моделям защитника».
 *
 * Расширяемость:
 *  - все шаги идут через цепочки хуков `CombatRules` (см. rules.ts), поэтому
 *    дополнительные правила добавляются вызовом extendRules без правок ядра;
 *  - выбор оружия, распределение урона и поведение [PISTOL]/[CLOSE-QUARTERS]
 *    вынесены в стратегии-функции (CombatOptions), их можно подменять;
 *  - `simulateTrial` — один прогон, `monteCarlo` — агрегат по многим прогонам,
 *    своя реализация Монте-Карло может использовать `simulateTrial` напрямую.
 *
 * Правила 11-й редакции, реализованные здесь (тексты — из gameSystem BSData):
 *  - попадание по BS/WS, натуральная 6 — критическое попадание;
 *  - ранение по S/T (см. woundThresholdByStrength), натуральная 6 или Anti-X Y+ — крит. ранение;
 *  - сейв: лучший из (броня + AP) и инвуля; [IGNORES COVER] отменяет укрытие;
 *  - в рукопашной модель бьёт все [EXTRA ATTACKS] и одним прочим оружием;
 *  - модель с [PISTOL]/[CLOSE-QUARTERS] выбирает: такие стволы или все прочие
 *    (модели MONSTER/VEHICLE из-под ограничения выведены).
 */

import { diceMean, mulberry32, rollDie, rollDice } from './dice.ts';
import { clampTarget, standardRules, woundThresholdByStrength } from './rules.ts';
import type {
  CombatContext,
  CombatModel,
  CombatRules,
  CombatUnit,
  CombatWeapon,
  DiceSpec,
  MonteCarloResult,
  Phase,
  Rng,
  TrialResult,
  WeaponUsageResult,
} from './types.ts';

/** Как выбирать рукопашное оружие модели. */
export type MeleeStrategy =
  /** По правилам: все [EXTRA ATTACKS] + одно прочее оружие. */
  | 'primary'
  /** Считать всё оружие (верхняя оценка, не по правилам). */
  | 'all';

/** Как модель с [PISTOL]/[CLOSE-QUARTERS] распределяет стрельбу. */
export type CloseQuartersStrategy = 'auto' | 'close-quarters' | 'other';

/** Кому достаётся урон в отряде защитника. */
export type AllocationStrategy = 'first' | 'last' | 'weakest';

export interface CombatOptions {
  /** Фаза: 'ranged' (по умолчанию), 'melee' или 'all' (обе по очереди). */
  phase?: Phase;
  /** Дистанция в дюймах (для Rapid Fire/Melta/Heavy); null — неизвестна. */
  distance?: number | null;
  /** Атакующий совершил charge move (Lance). */
  charged?: boolean;
  /** Атакующий не двигался (Heavy). */
  stationary?: boolean;
  /** Стрельба непрямая (штраф к попаданию). */
  indirect?: boolean;
  /** Цель в укрытии: +1 к броне от дальнобойных атак (кроме [IGNORES COVER]). */
  cover?: boolean;
  /** Атакующий в зоне боя: дальнобойные атаки возможны только [PISTOL]/[CLOSE-QUARTERS]. */
  engaged?: boolean;
  /** Свои правила: extendRules(standardRules(), ...). */
  rules?: CombatRules;
  rng?: Rng;
  melee?: MeleeStrategy;
  closeQuarters?: CloseQuartersStrategy;
  allocation?: AllocationStrategy;
}

/** Настройки с заполненными значениями по умолчанию. */
export interface ResolvedCombatOptions {
  phase: Phase;
  distance: number | null;
  charged: boolean;
  stationary: boolean;
  indirect: boolean;
  cover: boolean;
  engaged: boolean;
  rules: CombatRules;
  rng: Rng;
  melee: MeleeStrategy;
  closeQuarters: CloseQuartersStrategy;
  allocation: AllocationStrategy;
}

/** Заполняет умолчания (rng — детерминированный mulberry32, если не задан). */
export function resolveCombatOptions(options: CombatOptions = {}): ResolvedCombatOptions {
  return {
    phase: options.phase ?? 'ranged',
    distance: options.distance ?? null,
    charged: options.charged ?? false,
    stationary: options.stationary ?? true,
    indirect: options.indirect ?? false,
    cover: options.cover ?? false,
    engaged: options.engaged ?? false,
    rules: options.rules ?? standardRules(),
    rng: options.rng ?? mulberry32(0x40_4b),
    // По требованию задачи в рукопашной считаем все профили (верхняя оценка);
    // 'primary' включает строгое правило «одно оружие + [EXTRA ATTACKS]».
    melee: options.melee ?? 'all',
    closeQuarters: options.closeQuarters ?? 'auto',
    allocation: options.allocation ?? 'first',
  };
}

/** Есть ли у оружия кейворд с данным каноническим именем. */
function hasKeyword(weapon: CombatWeapon, name: string): boolean {
  return weapon.keywords.some((keyword) => keyword.name === name);
}

/**
 * Вес оружия для эвристик: ожидаемые атаки × шанс попадания × ожидаемый урон.
 * Нужен только для выбора «какое оружие считать» — на сам бросок не влияет.
 */
export function weaponWeight(weapon: CombatWeapon): number {
  if (weapon.skill === null || weapon.attacks === null) return 0;
  const hitChance = (7 - weapon.skill) / 6;
  const damage = weapon.damage === null ? 1 : diceMean(weapon.damage);
  return diceMean(weapon.attacks) * hitChance * Math.max(damage, 0);
}

const weightOf = (weapons: CombatWeapon[]): number =>
  weapons.reduce((sum, weapon) => sum + weaponWeight(weapon), 0);

/**
 * Оружие модели в рукопашной.
 *  - 'all'     — все рукопашные профили (по умолчанию: верхняя оценка);
 *  - 'primary' — по правилам одно «лучшее» оружие плюс все [EXTRA ATTACKS].
 */
export function meleeWeaponsOf(model: CombatModel, strategy: MeleeStrategy): CombatWeapon[] {
  const melee = model.weapons.filter((weapon) => weapon.kind === 'melee');
  if (strategy === 'all') return melee;

  const extras = melee.filter((weapon) => hasKeyword(weapon, 'extra-attacks'));
  const primary = melee.filter((weapon) => !hasKeyword(weapon, 'extra-attacks'));
  const best = primary.reduce<CombatWeapon | null>(
    (acc, weapon) => (acc === null || weaponWeight(weapon) > weaponWeight(acc) ? weapon : acc),
    null
  );
  return best === null ? extras : [best, ...extras];
}

/**
 * Оружие модели для дальнобойной фазы.
 *  - в зоне боя ('engaged') доступны только [PISTOL]/[CLOSE-QUARTERS];
 *  - если у модели есть такие стволы, стреляет либо группа [PISTOL]/[CLOSE-QUARTERS],
 *    либо все остальные ('auto' — та группа, у которой больше ожидаемый урон).
 */
export function rangedWeaponsOf(
  model: CombatModel,
  strategy: CloseQuartersStrategy,
  engaged: boolean
): CombatWeapon[] {
  const ranged = model.weapons.filter((weapon) => weapon.kind === 'ranged');
  const close = ranged.filter(
    (weapon) => hasKeyword(weapon, 'pistol') || hasKeyword(weapon, 'close-quarters')
  );
  const other = ranged.filter((weapon) => !close.includes(weapon));

  if (engaged) return close;
  if (strategy === 'close-quarters') return close.length > 0 ? close : other;
  if (strategy === 'other') return other.length > 0 ? other : ranged;
  if (close.length === 0 || other.length === 0) return ranged;
  return weightOf(close) >= weightOf(other) ? close : other;
}

/** Состояние защитника: раны по моделям; входные данные не мутируются. */
export interface DefenderState {
  unit: CombatUnit;
  /** Остаток ран каждой модели (0 — уничтожена). */
  woundsLeft: number[];
  /** Порядок распределения урона. */
  order: number[];
  aliveCount: number;
  kills: number;
  /** Урон, доведённый до моделей (без избытка по «убитым» ранам). */
  damage: number;
}

/** Копия состояния защитника под конкретный прогон. */
export function createDefenderState(
  unit: CombatUnit,
  allocation: AllocationStrategy = 'first'
): DefenderState {
  const order = unit.models.map((_, index) => index);
  if (allocation === 'last') order.reverse();
  if (allocation === 'weakest') {
    order.sort((a, b) => unit.models[a].wounds - unit.models[b].wounds || a - b);
  }
  return {
    unit,
    woundsLeft: unit.models.map((model) => model.wounds),
    order,
    aliveCount: unit.models.length,
    kills: 0,
    damage: 0,
  };
}

/** Индекс следующей живой модели (по стратегии распределения), иначе null. */
export function nextTargetIndex(state: DefenderState): number | null {
  for (const index of state.order) {
    if (state.woundsLeft[index] > 0) return index;
  }
  return null;
}

/** Снимает одну модель (раны обнуляются, счётчик убитых растёт). */
function killModel(state: DefenderState, index: number): void {
  state.woundsLeft[index] = 0;
  state.aliveCount -= 1;
  state.kills += 1;
}

/**
 * Урон следующей модели: избыток сгорает (урон не «переливается» между моделями).
 * Возвращает фактически снятые раны.
 */
export function damageNextModel(state: DefenderState, amount: number): number {
  const index = nextTargetIndex(state);
  if (index === null || amount <= 0) return 0;
  const dealt = Math.min(amount, state.woundsLeft[index]);
  state.woundsLeft[index] -= dealt;
  state.damage += dealt;
  if (state.woundsLeft[index] <= 0) killModel(state, index);
  return dealt;
}

/** Мортиды: распределяются по моделям с переносом избытка. */
export function damageSpill(state: DefenderState, amount: number): number {
  let left = amount;
  let dealt = 0;
  while (left > 0) {
    const index = nextTargetIndex(state);
    if (index === null) break;
    const step = Math.min(left, state.woundsLeft[index]);
    state.woundsLeft[index] -= step;
    left -= step;
    dealt += step;
    if (state.woundsLeft[index] <= 0) killModel(state, index);
  }
  state.damage += dealt;
  return dealt;
}

/** Порог ранения по S/T с учётом цепочки woundTarget. */
function woundTargetOf(
  ctx: CombatContext,
  rules: CombatRules,
  strength: number,
  toughness: number,
): number | null {
  let target: number | null = woundThresholdByStrength(strength, toughness);
  for (const hook of rules.woundTarget) target = hook(ctx, target);
  return target;
}

/**
 * Порог сейва: броня с AP (и укрытием), затем инвуля — берётся лучший.
 * Укрытие улучшает сейв на 1, но не работает в рукопашной и для [IGNORES COVER].
 */
function saveTargetOf(
  ctx: CombatContext,
  rules: CombatRules,
  target: CombatModel,
): number | null {
  const weapon = ctx.weapon;
  let armor: number | null = null;
  if (target.save !== null) {
    // AP отрицательный, но чем он больше по модулю, тем ХУЖЕ сейв:
    // 3+ с AP-2 → 5+, поэтому к порогу прибавляется модуль AP.
    armor = target.save - weapon.ap;
    if (ctx.cover && ctx.phase === 'ranged' && !hasKeyword(weapon, 'ignores-cover')) {
      armor -= 1;
    }
    armor = Math.max(2, armor);
  }
  let best = armor;
  if (target.invuln !== null) {
    best = best === null ? target.invuln : Math.min(best, target.invuln);
  }
  for (const hook of rules.saveTarget) best = hook(ctx, best);
  return best;
}

/** Урон за ранение: характеристика D оружия + цепочка damage (Melta и др.). */
function damageSpecOf(ctx: CombatContext, rules: CombatRules): DiceSpec {
  let spec: DiceSpec = ctx.weapon.damage ?? { count: 1, sides: 1, plus: 0 };
  for (const hook of rules.damage) spec = hook(ctx, spec);
  return spec;
}

/** Разрешает одно применение оружия: атаки → попадания → ранения → сейвы → урон. */
export function resolveWeapon(
  ctx: CombatContext,
  state: DefenderState,
  usage: WeaponUsageResult,
  rules: CombatRules,
): void {
  const { weapon, defender, rng } = ctx;
  usage.models += 1;

  // 1. Дайсы атак (Rapid Fire, Blast и т.п. добавляются сверху).
  let attacks = weapon.attacks === null ? 0 : rollDice(weapon.attacks, rng);
  for (const hook of rules.extraAttackDice) {
    attacks += hook(ctx, attacks);
  }
  usage.attacks += attacks;
  if (attacks <= 0) return;

  // 2. Попадания: порог BS/WS, натуральная 6 — критическое попадание.
  let hitTarget = weapon.skill;
  for (const hook of rules.hitTarget) hitTarget = hook(ctx, hitTarget);
  // null после хуков = автопопадание ([TORRENT] или BS/WS '-'); иначе — обычный бросок.
  const autoHit = hitTarget === null;
  let hits = 0;
  let critHits = 0;
  if (autoHit) {
    hits = attacks;
  } else if (hitTarget !== null) {
    const target = clampTarget(hitTarget);
    for (let i = 0; i < attacks; i += 1) {
      const roll = rollDie(6, rng);
      if (roll >= target) hits += 1;
      if (roll === 6) critHits += 1;
    }
  }
  for (const hook of rules.extraHits) hits += hook(ctx, critHits);
  usage.hits += hits;
  if (hits <= 0) return;
  // 3. Ранения. [LETHAL HITS] превращает критические попадания в ранения
  //    без броска; остальные попадания бросаются по порогу S/T.
  const lethal = rules.lethalCritHits.some((hook) => hook(ctx));
  const rerollWounds = rules.rerollWounds.some((hook) => hook(ctx));
  const devastating = rules.devastatingCritWounds.some((hook) => hook(ctx));

  let remainingHits = hits;
  let remainingCrits = critHits;
  while (remainingHits > 0) {
    const targetIndex = nextTargetIndex(state);
    if (targetIndex === null) break; // защитник уничтожен — оставшиеся попадания не тратятся
    const target = defender.models[targetIndex];
    const hitCtx = contextFor(ctx, state, target);

    remainingHits -= 1;
    const isCritHit = remainingCrits > 0;
    if (isCritHit) remainingCrits -= 1;

    let woundRoll: number | null = null;
    if (lethal && isCritHit) {
      // авторанение: критическое попадание с [LETHAL HITS]
    } else if (weapon.strength === null) {
      continue; // оружие не может ранить (S '-')
    } else {
      const woundTarget = woundTargetOf(hitCtx, rules, weapon.strength, target.toughness);
      if (woundTarget === null) continue;
      const targetClamped = clampTarget(woundTarget);
      woundRoll = rollDie(6, rng);
      if (woundRoll < targetClamped && rerollWounds) woundRoll = rollDie(6, rng);
      if (woundRoll < targetClamped) continue;
    }
    usage.wounds += 1;

    // 4. Сейв / урон. Критическое ранение (натуральная 6 или [ANTI-X Y+])
    //    с [DEVASTATING WOUNDS] наносит мортиды в обход сейва.
    let critTarget = 6;
    if (woundRoll !== null) {
      for (const hook of rules.criticalWoundTarget) critTarget = hook(hitCtx, critTarget);
    }
    const critical = woundRoll !== null && woundRoll >= clampTarget(critTarget);
    const killsBefore = state.kills;

    if (critical && devastating) {
      const mortals = rollDice(damageSpecOf(hitCtx, rules), rng);
      const dealt = damageSpill(state, mortals);
      usage.unsaved += 1;
      usage.mortals += dealt;
      usage.damage += dealt;
      usage.kills += state.kills - killsBefore;
      continue;
    }

    const saveTarget = saveTargetOf(hitCtx, rules, target);
    if (saveTarget !== null) {
      const saveRoll = rollDie(6, rng);
      const passed = saveRoll === 6 || (saveRoll !== 1 && saveRoll >= clampTarget(saveTarget));
      if (passed) continue;
    }
    usage.unsaved += 1;
    const damage = rollDice(damageSpecOf(hitCtx, rules), rng);
    const dealt = damageNextModel(state, damage);
    usage.damage += dealt;
    usage.kills += state.kills - killsBefore;
  }
}

/** Нулевой счётчик использования оружия. */
export function emptyUsage(weapon: CombatWeapon): WeaponUsageResult {
  return {
    weaponId: weapon.id,
    weaponName: weapon.name,
    kind: weapon.kind,
    models: 0,
    attacks: 0,
    hits: 0,
    wounds: 0,
    unsaved: 0,
    mortals: 0,
    damage: 0,
    kills: 0,
  };
}

/** Копия контекста под текущую цель и актуальное число живых моделей защитника. */
function contextFor(
  ctx: CombatContext,
  state: DefenderState,
  target: CombatModel
): CombatContext {
  return { ...ctx, target, defenderModelCount: state.aliveCount };
}

/** Фазы боя, в которые попадает атакующий ('all' → сначала стрельба, потом рукопашная). */
function phasesOf(phase: Phase): Array<'ranged' | 'melee'> {
  if (phase === 'all') return ['ranged', 'melee'];
  return [phase];
}

/**
 * Один раунд атаки по уже существующему состоянию защитника: каждая модель
 * атакует выбранным оружием, пока у защитника есть живые модели.
 * Состояние мутируется — это позволяет звать функцию в цикле (см. simulateBattle)
 * и считать, сколько раундов нужно на уничтожение цели.
 *
 * @returns урон, нанесённый за этот раунд.
 */
export function simulateRound(
  attacker: CombatUnit,
  state: DefenderState,
  opts: ResolvedCombatOptions,
  usages: Map<string, WeaponUsageResult> = new Map()
): number {
  const damageBefore = state.damage;

  for (const phase of phasesOf(opts.phase)) {
    for (const model of attacker.models) {
      if (state.aliveCount === 0) break;
      const weapons =
        phase === 'melee'
          ? meleeWeaponsOf(model, opts.melee)
          : rangedWeaponsOf(model, opts.closeQuarters, opts.engaged);

      for (const weapon of weapons) {
        if (state.aliveCount === 0) break;
        const targetIndex = nextTargetIndex(state);
        if (targetIndex === null) break;
        let usage = usages.get(weapon.id);
        if (!usage) {
          usage = emptyUsage(weapon);
          usages.set(weapon.id, usage);
        }
        const ctx: CombatContext = {
          phase,
          distance: opts.distance,
          weapon,
          attacker,
          attackerModel: model,
          defender: state.unit,
          target: state.unit.models[targetIndex],
          defenderModelCount: state.aliveCount,
          charged: opts.charged,
          stationary: opts.stationary,
          indirect: opts.indirect,
          cover: opts.cover,
          engaged: opts.engaged,
          rng: opts.rng,
        };
        resolveWeapon(ctx, state, usage, opts.rules);
      }
    }
  }

  return state.damage - damageBefore;
}

/**
 * Один прогон боя: свежее состояние защитника + один раунд атаки.
 * Возвращает суммарный урон, убийства и статистику по оружию.
 */
export function simulateTrial(
  attacker: CombatUnit,
  defender: CombatUnit,
  options: CombatOptions = {}
): TrialResult {
  const opts = resolveCombatOptions(options);
  const state = createDefenderState(defender, opts.allocation);
  const usages = new Map<string, WeaponUsageResult>();
  simulateRound(attacker, state, opts, usages);

  return {
    phase: opts.phase,
    damage: state.damage,
    kills: state.kills,
    survivors: state.aliveCount,
    weapons: [...usages.values()],
  };
}

/** Итог боя на несколько раундов. */
export interface BattleResult {
  /** Сколько раундов длился бой (при обрыве по maxRounds — потолок). */
  rounds: number;
  /** Цель уничтожена (не достигнута лимит раундов). */
  targetDestroyed: boolean;
  /** Урон, нанесённый цели за все раунды. */
  damage: number;
  /** Осталось живых моделей цели. */
  survivors: number;
  /** Моделей цели потеряно. */
  kills: number;
  /** Урон по раундам — полезно для медианы и разброса времени до смерти. */
  damageByRound: number[];
}

export interface BattleOptions extends CombatOptions {
  /** Потолок раундов; по умолчанию 20 — достаточно для большинства боёв. */
  maxRounds?: number;
}

/**
 * Бой на несколько раундов: атакующий бьёт цель, пока та жива.
 * Нужен для оценки живучести — «сколько раундов цель держится».
 * Атакующий не теряет модели (оборона не моделируется).
 */
export function simulateBattle(
  attacker: CombatUnit,
  defender: CombatUnit,
  options: BattleOptions = {}
): BattleResult {
  const { maxRounds = 20, ...combat } = options;
  const opts = resolveCombatOptions(combat);
  const state = createDefenderState(defender, opts.allocation);
  const damageByRound: number[] = [];
  let rounds = 0;

  while (state.aliveCount > 0 && rounds < maxRounds) {
    damageByRound.push(simulateRound(attacker, state, opts));
    rounds += 1;
  }

  return {
    rounds,
    targetDestroyed: state.aliveCount === 0,
    damage: state.damage,
    survivors: state.aliveCount,
    kills: state.kills,
    damageByRound,
  };
}

/** Среднее и стандартное отклонение (sqrt дисперсии) по выборке. */
function stats(values: number[]): { mean: number; stdev: number } {
  if (values.length === 0) return { mean: 0, stdev: 0 };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return { mean, stdev: Math.sqrt(variance) };
}

/**
 * Монте-Карло: серия независимых прогонов с агрегацией по урону, убийствам
 * и вкладу каждого оружия. При одинаковом seed результат воспроизводим.
 */
export function monteCarlo(
  attacker: CombatUnit,
  defender: CombatUnit,
  trials: number,
  options: CombatOptions = {}
): MonteCarloResult {
  const damageSamples: number[] = [];
  const killSamples: number[] = [];
  const weaponDamage = new Map<string, number[]>();
  const usageTotals = new Map<string, WeaponUsageResult>();
  let killTrials = 0;

  // Опции разрешаются один раз: иначе каждый прогон получил бы свежий
  // mulberry32 с одинаковым сидом и все результаты совпали бы.
  const opts = resolveCombatOptions(options);

  for (let i = 0; i < trials; i += 1) {
    const trial = simulateTrial(attacker, defender, opts);
    damageSamples.push(trial.damage);
    killSamples.push(trial.kills);
    if (trial.kills > 0) killTrials += 1;
    for (const usage of trial.weapons) {
      const samples = weaponDamage.get(usage.weaponId) ?? [];
      samples.push(usage.damage);
      weaponDamage.set(usage.weaponId, samples);
      const total = usageTotals.get(usage.weaponId);
      if (!total) {
        usageTotals.set(usage.weaponId, { ...usage });
        continue;
      }
      for (const key of ['models', 'attacks', 'hits', 'wounds', 'unsaved', 'mortals', 'damage', 'kills'] as const) {
        total[key] += usage[key];
      }
    }
  }

  const weapons = [...usageTotals.values()].map((total) => {
    const samples = weaponDamage.get(total.weaponId) ?? [];
    const damage = stats(samples);
    const averaged: WeaponUsageResult = { ...total };
    for (const key of ['models', 'attacks', 'hits', 'wounds', 'unsaved', 'mortals', 'damage', 'kills'] as const) {
      averaged[key] = total[key] / trials;
    }
    return { ...averaged, damageMean: damage.mean, damageStdev: damage.stdev };
  });

  return {
    trials,
    damage: stats(damageSamples),
    kills: stats(killSamples),
    killProbability: trials > 0 ? killTrials / trials : 0,
    weapons,
  };
}


