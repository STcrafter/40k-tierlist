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
import { keywordOf } from './keywords.ts';
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
  /**
   * Атакующий совершил charge move ([LANCE]: +1 к ранению).
   *
   * По умолчанию `true`: симуляция не моделирует перемещения по карте, а
   * оценивает бой в состоянии, когда атакующий уже добрался до цели. Раньше
   * здесь стоял `false`, из-за чего [LANCE] не срабатывал НИКОГДА — кейворд
   * был мёртвым у всех 40+ единиц оружия (Bright/Laser/Inferno/Sonic Lance).
   * Вызывающий код может выставить `false`, чтобы снять бонус зарядки.
   */
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
  rerollHitOn?: number[];
  rerollWoundOn?: number[];
  rerollSaveOn?: number[];
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
  rerollHitOn: number[];
  rerollWoundOn: number[];
  rerollSaveOn: number[];
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
    // Зарядка по умолчанию: см. CombatOptions.charged.
    charged: options.charged ?? true,
    stationary: options.stationary ?? true,
    indirect: options.indirect ?? false,
    cover: options.cover ?? false,
    engaged: options.engaged ?? false,
    rerollHitOn: options.rerollHitOn ?? [],
    rerollWoundOn: options.rerollWoundOn ?? [],
    rerollSaveOn: options.rerollSaveOn ?? [],
    rules: options.rules ?? standardRules(),
    rng: options.rng ?? mulberry32(0x40_4b),
    // Смешанный режим считает рукопашную фалу по правилам: одно основное
    // оружие плюс [EXTRA ATTACKS], а не все профили одновременно.
    melee: options.melee ?? 'primary',
    closeQuarters: options.closeQuarters ?? 'auto',
    allocation: options.allocation ?? 'first',
  };
}

/** Кейворды цели (отряд + модель) — для условий вида 'non-MONSTER/VEHICLE'. */
function targetKeywordsOf(ctx: CombatContext): string[] {
  return [...ctx.defender.keywords, ...ctx.target.keywords];
}

/**
 * Есть ли у оружия кейворд с данным каноническим именем.
 *
 * Без учёта условий — для кейвордов, которые от цели не зависят
 * ([EXTRA ATTACKS], [PISTOL], [CLOSE-QUARTERS]). Условные вроде
 * 'Lethal Hits: non-MONSTER/VEHICLE' проверяются через `keywordOf`.
 */
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

/** Оружие с [PISTOL]/[CLOSE-QUARTERS], доступное и в ближней фазе. */
export function closeQuartersWeaponsOf(model: CombatModel): CombatWeapon[] {
  return model.weapons.filter(
    (weapon) => weapon.kind === 'ranged' && (hasKeyword(weapon, 'pistol') || hasKeyword(weapon, 'close-quarters'))
  );
}

/** Оружие модели в рукопашной, включая пистолеты и [CLOSE-QUARTERS]. */
export function meleePhaseWeaponsOf(
  model: CombatModel,
  strategy: MeleeStrategy,
  includeCloseQuarters = true
): CombatWeapon[] {
  const weapons = [...meleeWeaponsOf(model, strategy)];
  if (includeCloseQuarters) weapons.push(...closeQuartersWeaponsOf(model));
  return distinctMeleeWeapons(weapons);
}

/**
 * Правило 11-й редакции: в рукопашном бою модель может бить НЕСКОЛЬКИМИ
 * одинаковыми оружиями, только если хотя бы одно из них имеет [EXTRA ATTACKS].
 * Без этого бонуса бьёт лишь одним.
 *
 * Зачем: у части моделей в BSData профиль повторяется дважды — это два
 * одинаковых ствола, а не два разных оружия. Замер по базе: 6 моделей с
 * дублями, из них 4 рукопашных и без [EXTRA ATTACKS] (Devastator Sergeant,
 * Aspiring Champion, Tactical Sergeant, Talos) — они били вдвое чаще, чем
 * позволяют правила.
 *
 * Дальнобойные дубли правилом НЕ ограничены: двумя одинаковыми стволами
 * стрелять можно всегда, поэтому `rangedWeaponsOf` их не трогает.
 */
export function distinctMeleeWeapons(weapons: CombatWeapon[]): CombatWeapon[] {
  if (weapons.length < 2) return weapons;
  const kept: CombatWeapon[] = [];
  const used = new Set<string>();
  for (const weapon of weapons) {
    // [PISTOL] / [CLOSE-QUARTERS] — не «ручное оружие», дубли не схлопываем.
    const isHandToHand = weapon.kind === 'melee';
    if (!isHandToHand) {
      kept.push(weapon);
      continue;
    }
    const key = weaponSignature(weapon);
    if (!used.has(key)) {
      used.add(key);
      kept.push(weapon);
      continue;
    }
    // Повтор: оставляем, только если у этой пары есть [EXTRA ATTACKS].
    const first = kept.find((candidate) => weaponSignature(candidate) === key);
    if (first && first.keywords.some((keyword) => keyword.name === 'extra-attacks')) {
      kept.push(weapon);
    }
  }
  return kept;
}

/** Подпись профиля для поиска «того же самого» оружия. */
function weaponSignature(weapon: CombatWeapon): string {
  const dice = (spec: DiceSpec | null): string =>
    spec === null ? '-' : `${spec.count}x${spec.sides}+${spec.plus}`;
  return [
    weapon.kind,
    weapon.range ?? '-',
    dice(weapon.attacks),
    weapon.skill ?? '-',
    weapon.strength ?? '-',
    weapon.ap,
    dice(weapon.damage),
    weapon.keywords
      .map((keyword) => `${keyword.name}${keyword.value ? ':' + keyword.value.count : ''}`)
      .sort()
      .join(','),
  ].join('|');
}

/** Оружие модели для дальнобойной фазы. */
export function rangedWeaponsOf(
  model: CombatModel,
  strategy: CloseQuartersStrategy,
  engaged: boolean,
  includeCloseQuarters = true
): CombatWeapon[] {
  const ranged = model.weapons.filter((weapon) => weapon.kind === 'ranged');
  const close = closeQuartersWeaponsOf(model);
  const other = ranged.filter((weapon) => !close.includes(weapon));

  if (engaged) return close;
  if (!includeCloseQuarters) return other;
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
  /**
   * Сколько моделей было в отряде в начале боя.
   *
   * Нужен отдельно от `aliveCount`: [BLAST]/[CLEAVE] по правилам считаются
   * от числа моделей, которые БЫЛИ в цели на шаге выбора целей, а не от
   * живых на момент броска. Иначе Blast 10-ти моделей терял бы бонус
   * по мере убийства.
   */
  initialModelCount: number;
  kills: number;
  /** Урон, доведённый до моделей (без избытка по «убитым» ранам). */
  damage: number;
  /** Воскрешение уже израсходовано (одноразовые способности, ручной слой). */
  resurrectUsed: boolean;
}

/**
 * Возврат убитых моделей целителем (Hospitaller), который остаётся в строю.
 *
 * Возвращается столько моделей, сколько живых целителей в отряде: один
 * Hospitaller — одну модель за раунд. Модель встаёт с полным запасом ран, а её
 * убийство вычитается из счётчика, потому что она снова в строю.
 *
 * @returns true, если хотя бы одна модель вернулась в бой.
 */
function reviveFallenByLeader(state: DefenderState): boolean {
  const healers = state.unit.models
    .map((model, index) => ({ model, index }))
    .filter(({ model, index }) => model.reviveLeader === true && state.woundsLeft[index] > 0);
  if (healers.length === 0) return false;
  const fallen = state.woundsLeft
    .map((wounds, index) => ({ wounds, index }))
    .filter(({ wounds, index }) => wounds <= 0 && !state.unit.models[index].reviveLeader)
    .sort((a, b) => a.index - b.index);
  if (fallen.length === 0) return false;
  const limit = fallen.length;
  let revived = 0;
  for (const healer of healers) {
    // Один целитель возвращает reviveCount моделей за раунд (Hospitaller — 1,
    // Ministorum Priest при Sanctifiers — D3, то есть 3).
    const quota = healer.model.reviveCount ?? 1;
    for (let i = 0; i < quota && revived < limit; i += 1) {
      const target = fallen[revived];
      state.woundsLeft[target.index] = state.unit.models[target.index].wounds;
      state.aliveCount += 1;
      state.kills -= 1;
      revived += 1;
    }
  }
  return revived > 0;
}

/**
 * Регенерация и одноразовое воскрешение между раундами (ручной слой).
 *
 * Вызывается в начале каждого раунда, пока жив хоть кто-то:
 *  - раны восстанавливаются, но не выше исходного запаса модели;
 *  - если ВСЕ модели мертвы, но у отряда есть модель с `resurrectOnce`, она
 *    возвращается в бой с полными ранами. Происходит это не чаще одного раза
 *    за бой: иначе «одноразовое» воскрешение стало бы бесконечным.
 *
 * @returns true, если отряд был возвращён в бой воскрешением.
 */
export function upkeepBetweenRounds(state: DefenderState): boolean {
  // Целитель (Hospitaller): пока он жив, возвращаем убитые модели. Идёт
  // ПЕРВЫМ, чтобы лечение было на «свежей» бою: сначала поднимаем павших,
  // потом лечим — иначе очередь возврата съедала бы лечение.
  if (reviveFallenByLeader(state)) return true;
  for (let index = 0; index < state.woundsLeft.length; index += 1) {
    const model = state.unit.models[index];
    if (state.woundsLeft[index] <= 0) continue;
    const regen = model.regeneration ?? 0;
    if (regen <= 0) continue;
    const max = model.wounds;
    const healed = Math.min(regen, max - state.woundsLeft[index]);
    if (healed > 0) state.woundsLeft[index] += healed;
  }
  if (state.aliveCount > 0 || state.resurrectUsed) return false;
  const revivable = state.unit.models.findIndex((model) => model.resurrectOnce === true);
  if (revivable < 0) return false;
  state.woundsLeft[revivable] = state.unit.models[revivable].wounds;
  state.aliveCount += 1;
  state.kills -= 1;
  state.resurrectUsed = true;
  return true;
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
    initialModelCount: unit.models.length,
    kills: 0,
    damage: 0,
    resurrectUsed: false,
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
 * Feel No Pain: невелирование урона.
 *
 * За каждый урон атаки бросается один кубик, каждый результат ≥ порога
 * невелирует 1 урон. Число кубиков НЕ уменьшается при оверфлоу: модель с 1
 * раной под атакой на 3 урона всё равно бросает 3 кубика (три 5+ — и она
 * выживает, два — умирает).
 *
 * Область действия (три вида в BSData):
 *   - обычный FNP (`fnpScope: 'all'`) защищает и от обычного урона, и от
 *     мортидов;
 *   - FNP «against mortal wounds» (`'mortals'`) — это ОГРАНИЧЕНИЕ области, а
 *     не усиление: он защищает ТОЛЬКО от мортидов и пропускает обычный урон;
 *   - псионические атаки идут мимо FNP в любом случае.
 */
function feelNoPain(
  model: CombatModel,
  amount: number,
  rng: Rng,
  kind: 'damage' | 'mortals',
  psychic: boolean
): number {
  if (model.fnp === null || amount <= 0 || psychic) return amount;
  if (kind === 'damage' && model.fnpScope === 'mortals') return amount;
  let negated = 0;
  for (let i = 0; i < amount; i += 1) {
    if (rollDie(6, rng) >= model.fnp) negated += 1;
  }
  return amount - negated;
}

/**
 * Урон следующей модели: избыток сгорает (урон не «переливается» между моделями).
 * Если передан rng, урон сначала проходит через Feel No Pain цели.
 * `psychic` помечает атаку, мимо которой FNP не защищает.
 * Возвращает фактически снятые раны.
 */
export function damageNextModel(
  state: DefenderState,
  amount: number,
  rng?: Rng,
  psychic = false
): number {
  const index = nextTargetIndex(state);
  if (index === null || amount <= 0) return 0;
  const incoming =
    rng === undefined
      ? amount
      : feelNoPain(state.unit.models[index], amount, rng, 'damage', psychic);
  if (incoming <= 0) return 0;
  const dealt = Math.min(incoming, state.woundsLeft[index]);
  state.woundsLeft[index] -= dealt;
  state.damage += dealt;
  if (state.woundsLeft[index] <= 0) killModel(state, index);
  return dealt;
}

/**
 * Мортиды: распределяются по моделям с переносом избытка.
 * FNP действует и здесь: обычный FNP защищает от мортидов, а FNP
 * «against mortal wounds» защищает ИМЕННО от них.
 */
export function damageSpill(state: DefenderState, amount: number, rng?: Rng, psychic = false): number {
  let left = amount;
  let dealt = 0;
  while (left > 0) {
    const index = nextTargetIndex(state);
    if (index === null) break;
    const model = state.unit.models[index];
    // Невелирование считается от уронА, пришедшего в эту модель.
    const incoming =
      rng === undefined ? left : feelNoPain(model, left, rng, 'mortals', psychic);
    if (incoming <= 0) break;
    const step = Math.min(incoming, state.woundsLeft[index]);
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
    if (
      ctx.cover &&
      ctx.phase === 'ranged' &&
      keywordOf(weapon.keywords, 'ignores-cover', targetKeywordsOf(ctx)) === null
    ) {
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
  const rerollHitOn = ctx.rerollHitOn ?? [];
  const rerollWoundOn = ctx.rerollWoundOn ?? [];
  const rerollSaveOn = ctx.rerollSaveOn ?? [];
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
      const hitRoll = roll < target && rerollHitOn.includes(roll) ? rollDie(6, rng) : roll;
      if (hitRoll >= target) hits += 1;
      if (hitRoll === 6) critHits += 1;
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
  // Псионическая атака идёт мимо Feel No Pain.
  const isPsychic = hasKeyword(weapon, 'psychic');

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
      if (woundRoll < targetClamped && (rerollWounds || rerollWoundOn.includes(woundRoll))) woundRoll = rollDie(6, rng);
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
      const base = rollDice(damageSpecOf(hitCtx, rules), rng);
      // Ручной бонус к мортидам (Daemonifuge): действует только в своей фазе,
      // поэтому прибавляется здесь, а не в damageSpecOf — там нет доступа к фазе.
      const bonus =
        weapon.mortalDamageBonus !== undefined &&
        weapon.mortalDamageBonus.phase === hitCtx.phase
          ? weapon.mortalDamageBonus.amount
          : 0;
      const mortals = base + bonus;
      const dealt = damageSpill(state, mortals, rng, isPsychic);
      usage.unsaved += 1;
      usage.mortals += dealt;
      usage.damage += dealt;
      usage.kills += state.kills - killsBefore;
      continue;
    }

    const saveTarget = saveTargetOf(hitCtx, rules, target);
    if (saveTarget !== null) {
      const saveRoll = rollDie(6, rng);
      const passedRoll = saveRoll < clampTarget(saveTarget) && rerollSaveOn.includes(saveRoll)
        ? rollDie(6, rng)
        : saveRoll;
      const passed = passedRoll === 6 || (passedRoll !== 1 && passedRoll >= clampTarget(saveTarget));
      if (passed) continue;
    }
    usage.unsaved += 1;
    const damage = rollDice(damageSpecOf(hitCtx, rules), rng);
    const dealt = damageNextModel(state, damage, rng, isPsychic);
    usage.damage += dealt;
    usage.kills += state.kills - killsBefore;
    // Palatine: +N мортид за успешное ранение. Мортиды идут СВЕРХ обычного урона
    // и переносятся на другие модели (как damageSpill, а не как оверфлоу).
    const perWound =
      weapon.mortalPerWound !== undefined && weapon.mortalPerWound.phase === hitCtx.phase
        ? weapon.mortalPerWound.amount
        : 0;
    if (perWound > 0) {
      const killsAfterWound = state.kills;
      const extra = damageSpill(state, perWound, rng, isPsychic);
      usage.mortals += extra;
      usage.damage += extra;
      usage.kills += state.kills - killsAfterWound;
    }
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
  return { ...ctx, target, defenderModelCount: state.initialModelCount };
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
      // В фазе 'all' пистолеты и [CLOSE-QUARTERS] уже включены в melee:
      // их повторный вызов в ranged дал бы двойной урон. Для отдельной
      // стрельбы они, наоборот, доступны как обычное дальнобойное оружие.
      const weapons =
        phase === 'melee'
          ? meleePhaseWeaponsOf(model, opts.melee)
          : rangedWeaponsOf(model, opts.closeQuarters, opts.engaged, opts.phase !== 'all');

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
          rerollHitOn: opts.rerollHitOn,
          rerollWoundOn: opts.rerollWoundOn,
          rerollSaveOn: opts.rerollSaveOn,
          weapon,
          attacker,
          attackerModel: model,
          defender: state.unit,
          target: state.unit.models[targetIndex],
          defenderModelCount: state.initialModelCount,
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
  /**
   * Сколько урона цель УСПЕЛА поглотить до своей смерти.
   *
   * Отличается от `damage` учётом избытка (overkill): удар, убивший модель с
   * 1 оставшейся раной, «потратил» на неё 1 рану, а не все 6 нанесённых. Именно
   * поглощённый урон отвечает на вопрос «сколько ресурса противник вложил,
   * чтобы удалить юнит», поэтому именно он идёт в effective durability.
   */
  absorbed: number;
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
    // Регенерация и воскрешение (ручной слой) — между раундами, поэтому
    // вызываются ПОСЛЕ атаки: иначе лечение шло бы в том же раунде, что и урон.
    upkeepBetweenRounds(state);
  }

  return {
    rounds,
    targetDestroyed: state.aliveCount === 0,
    damage: state.damage,
    // state.damage копится как `dealt = min(урон, остаток ран)`, то есть
    // избыток (overkill) в него не попадает: удар, убивший модель с 1 раной,
    // добавляет 1, а не 6. Поэтому absorbed — это ровно «сколько урона цель
    // поглотила», и отдельный пересчёт не нужен.
    absorbed: state.damage,
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


