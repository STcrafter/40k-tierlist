/**
 * MARTIAL KA'TAH: выбор стойки перебором по уничтоженным очкам.
 *
 * Способность даёт выбор раз в бой: DACATARAI даёт рукопашному оружию
 * [SUSTAINED HITS 1], RENDAX — [LETHAL HITS].
 *
 * ── Почему перебор, а не формула ────────────────────────────────────────────
 *
 * Аналитически стойки разбираются точно. Обе действуют на критическое
 * попадание (натуральная 6) и отличаются ровно одним:
 *
 *   Sustained Hits 1 (rules.ts, extraHits) даёт critHits × 1 ДОПОЛНИТЕЛЬНЫХ
 *     хитов; они не криты, поэтому каждый катит обычный порог S/T.
 *   Lethal Hits (simulate.ts, lethalCritHits) убирает бросок ранения: крит
 *     ранит автоматически. Сейв и урон те же — здесь Lethal НЕ снимает броню.
 *
 * Дальше обе идут по дорожке «ранение → сейв → урон», и множители одинаковы,
 * поэтому по ОДНОЙ цели решение выводится без бросков:
 *
 *     Lethal выигрывает  ⇔  p(S/T) < 1/2
 *
 * Но тирлист считает не урон, а УНИЧТОЖЕННЫЕ ОЧКИ, и они насыщаются: убитую
 * цель больше нечего разрушать. На Custodian Guard против T3-пехоты лишний
 * урон почти весь уходит в добой (разница +0.6 очка), а против T9-цели он
 * конвертируется в очки один в один (разница −12 очков). Среднее по статам
 * тут врёт: проверенная формула приравняла +0.6 к −12 и ошиблась на 4 юнитах
 * из 24, а взвешивание по насыщенности очков стало хуже (15/24 против 18/24).
 *
 * Маржинальная ценность лишнего хита зависит от того, как урон ложится по
 * моделям и где каждая по рангу, — это не статы, а результат прогона. Поэтому
 * выбор делается перебором, а не формулой.
 *
 * ── Сколько прогонов ────────────────────────────────────────────────────────
 *
 * Плоский «жёсткий сид + 8 прогонов» был ошибкой: разница между стойками
 * обычно доли процента, и при 8 прогонах её не отличить от шума. Замерено:
 * 8 прогонов давали 12/14 юнитов, неустойчивых к сиду, а сходились к 12 L / 2 S.
 * Текущий порог MARGIN_PCT отсекает именно этот случай: близкий результат
 * означает, что стойки равноценны, и выбор уходит на тай-брейк.
 *
 * Детерминизм. Сид фиксирован, кэш ключуется составом оружия. Поэтому ни
 * порядок обхода юнитов, ни число воркеров не влияют ни на одну цифру.
 *
 * Цикл импортов. Модуль тянет только `combat/*` (perRound, archetypes,
 * keywords), а они в `manual/` и `tier/` не ходят — иначе `adapter.ts`,
 * импортирующий этот файл, замкнул бы цикл.
 */

import { damagePerRound } from '../combat/perRound.ts';
import { ARCHETYPES } from '../combat/archetypes.ts';
import { parseKeywords } from '../combat/keywords.ts';
import type { CombatUnit, CombatWeapon } from '../combat/types.ts';

/** Кейворды двух стоек, как они пишутся в правилах. */
const SUSTAINED = ['Sustained Hits 1'];
const LETHAL = ['Lethal Hits'];

/**
 * Сиды перебора.
 *
 * Их несколько не для красоты: разница между стойками у большинства юнитов
 * меньше процента, и по ОДНОМУ сиду она неотличима от шума — на 8 прогонах
 * 12 юнитов из 14 меняли стойку от сида к сиду. Усреднение по нескольким
 * фиксированным сидам снижает разброс втрое (как 1/√N), и детерминизм при
 * этом не страдает: пул задан константой, а не перебирается.
 */
const KATAH_SEEDS = [0x4b_a7, 0x1f3c, 0x7a11] as const;

/**
 * Прогонов на стойку и сид.
 *
 * 200 вместо прежних 8. Вместе с усреднением по трём сидам это около 600
 * замеров на стойку — достаточно, чтобы решение не зависело от сида.
 */
const KATAH_TRIALS = 200;

/**
 * Минимальный разрыв, ниже которого стойки считаются равноценными.
 *
 * 2.5% стоит на разрыве в замере: у 11 юнитов разница 0.5–2.4%, у 13 — 3.3–8.6%.
 * Порог не подгоняется под удобный ответ, а разделяет две группы, которые
 * иначе не различить. Всё, что ниже, — честное «стойки равноценны».
 *
 * 4% выбран не с запасом, а по замеру шума: на 2.5% Ares Gunship (истинный
 * разрыв ~0.5%) всё ещё перескакивал порог на разных сидах — у юнита с
 * малым счёом относительная мера шумнее абсолютной. 4% перекрывает этот шум,
 * не съедая ни одного из 13 юнитов с реальным разрывом (минимум там 4.1%).
 */
const MARGIN_PCT = 0.04;

/** Дистанция, на которой считается перебор (та же, что в сборке тирлиста). */
const KATAH_DISTANCE = 12;

/** Кэш «юнит + состав оружия» → выбранный кейворд. */
const cache = new Map<string, string[]>();

/** Есть ли у юнита Martial Ka'tah: правило лежит в datasheet.rules. */
export function hasMartialKatah(rules: Array<{ name: string }> | undefined): boolean {
  return (rules ?? []).some((rule) => /martial\s+ka'?tah/i.test(rule.name ?? ''));
}

/** Подпись оружия: стойка зависит от того, чем юнит бьёт, а не от его id. */
function weaponSignature(weapons: CombatWeapon[]): string {
  return weapons
    .map((w) => `${w.kind}:${w.attacks?.count ?? 0}:${w.strength ?? 0}:${w.attacks?.sides ?? 0}:${w.damage?.count ?? 0}:${w.ap}`)
    .sort()
    .join('|');
}

/** Копия отряда с кейвордом стойки на всём рукопашном оружии. */
function withStance(unit: CombatUnit, raw: string[]): CombatUnit {
  const wanted = parseKeywords(raw);
  return {
    ...unit,
    models: unit.models.map((model) => ({
      ...model,
      weapons: model.weapons.map((weapon) => {
        if (weapon.kind !== 'melee') return weapon;
        const extra = wanted.filter(
          (keyword) => !weapon.keywords.some((existing) => existing.name === keyword.name)
        );
        return extra.length === 0 ? weapon : { ...weapon, keywords: [...weapon.keywords, ...extra] };
      }),
    })),
  };
}

/**
 * Сколько очков цели отряд уничтожает за раунд в рукопашной фазе.
 *
 * Усредняется по KATAH_SEEDS: см. там, почему одного сида мало.
 */
function scoreOf(unit: CombatUnit): number {
  let total = 0;
  for (const seed of KATAH_SEEDS) {
    const result = damagePerRound(unit, {
      trials: KATAH_TRIALS,
      distance: KATAH_DISTANCE,
      phase: 'melee',
      targets: ARCHETYPES.map((archetype) => archetype.id),
      seed,
    });
    total += result.total.destroyedPoints.overall.mean;
  }
  return total / KATAH_SEEDS.length;
}

/**
 * Победитель, с отсечкой неразличимого.
 *
 * MARGIN_PCT — главное здесь. Разница между стойками у большинства юнитов меньше
 * процента, и без порога выбор определялся остатком шума: при 8 прогонах 12
 * юнитов из 14 меняли стойку от сида к сиду. Теперь близкий результат читается
 * как «стойки равноценны» и уходит на тай-брейк, а не как победа одной над
 * другой на копейку.
 *
 * Тай-брейк — DACATARAI (Sustained Hits 1): она не превращает часть попаданий
 * в авторанения, то есть в спорной ситуации это менее рискованный выбор.
 * Он обязателен и для детерминизма: без него исход зависел бы от порядка
 * сравнения, а это сломается при появлении третьей стойки.
 */
function pickStance(unit: CombatUnit): string[] {
  const sustained = scoreOf(withStance(unit, SUSTAINED));
  const lethal = scoreOf(withStance(unit, LETHAL));
  const scale = Math.max(sustained, lethal);
  if (scale <= 0) return SUSTAINED;
  // Разница меньше порога — равенство, тай-брейк.
  if (Math.abs(lethal - sustained) / scale < MARGIN_PCT) return SUSTAINED;
  return lethal > sustained ? LETHAL : SUSTAINED;
}

/** Есть ли у отряда рукопашное оружие: стойка на стрельбу не действует. */
function hasMeleeWeapon(unit: CombatUnit): boolean {
  return unit.models.some((model) => model.weapons.some((weapon) => weapon.kind === 'melee'));
}

/** Ключ кэша: стойка зависит от оружия, поэтому в ключ входит состав, а не id. */
function cacheKeyOf(unit: CombatUnit): string {
  return `${unit.id}|${weaponSignature(unit.models.flatMap((model) => model.weapons))}`;
}

/**
 * Выбирает и применяет стойку Martial Ka'tah.
 *
 * Принимает БАЗОВЫЙ отряд — без уже выбранной стойки. Это не формальность:
 * scoreOf меряет обе стойки на одном и том же оружии, и на уже обработанном
 * юните одна из них окажется навешена заранее, а другая добавится поверх.
 *
 * Юнит без рукопашного оружия не трогается: выбирать не из чего.
 */
export function applyKaTah(unit: CombatUnit): CombatUnit {
  if (!hasMeleeWeapon(unit)) return unit;
  const name = katahStanceNameOf(unit);
  return withStance(unit, name === 'Lethal Hits' ? LETHAL : SUSTAINED);
}

/**
 * Выбранная стойка поимённо — для отчётов и тестов.
 *
 * Как и applyKaTah, ждёт БАЗОВЫЙ отряд.
 */
export function katahStanceNameOf(unit: CombatUnit): string {
  if (!hasMeleeWeapon(unit)) return SUSTAINED[0];
  const key = cacheKeyOf(unit);
  const cached = cache.get(key);
  const chosen = cached ?? pickStance(unit);
  cache.set(key, chosen);
  return chosen[0] ?? SUSTAINED[0];
}
