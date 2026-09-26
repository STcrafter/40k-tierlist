/**
 * Стандартные правила кейвордов 11-й редакции.
 *
 * Тексты правил взяты из gameSystem базы BSData ('Warhammer 40,000.json').
 * Расширение: extendRules(standardRules(), fragment) — цепочки объединяются,
 * пользовательские хуки добавляются в конец и применяются последними.
 */

import { rollDice } from './dice.ts';
import { keywordApplies, keywordOf } from './keywords.ts';
import type { CombatRules, RuleFragment } from './types.ts';

/** Кейворды цели (весь отряд + модель) — для условий вида 'non-MONSTER/VEHICLE'. */
function targetKeywordsOf(ctx: {
  defender: { keywords: string[] };
  target: { keywords: string[] };
}): string[] {
  return [...ctx.defender.keywords, ...ctx.target.keywords];
}

/** Псионическая атака: [PSYCHIC] игнорирует модификаторы BS/WS и попадания. */
function isPsychicAttack(weapon: { keywords: Array<{ name: string }> }): boolean {
  return weapon.keywords.some((keyword) => keyword.name === 'psychic');
}

/** Целевые пороги нельзя модифицировать лучше 2+ и хуже 6+. */
export function clampTarget(target: number): number {
  return Math.min(6, Math.max(2, target));
}

/** Порог ранения по S/T: S=2T → 2+, S>T → 3+, S=T → 4+, S<T → 5+, S=2T → 6+. */
export function woundThresholdByStrength(strength: number, toughness: number): number {
  if (strength >= toughness * 2) return 2;
  if (strength > toughness) return 3;
  if (strength === toughness) return 4;
  if (strength * 2 <= toughness) return 6;
  return 5;
}

/** Стандартные правила 11-й редакции. */
export function standardRules(): CombatRules {
  return {
    extraAttackDice: [
      // [RAPID FIRE X]: +X дайсов, если цель на половинной дальности и меньше.
      (ctx) => {
        const rapid = ctx.weapon.keywords.find((k) => k.name === 'rapid-fire');
        if (!rapid?.value || ctx.distance === null || ctx.weapon.range === null) return 0;
        return ctx.distance * 2 <= ctx.weapon.range ? rollDice(rapid.value!, ctx.rng) : 0;
      },
      // [BLAST X] / [BLAST]: +X дайсов за каждые 5 моделей цели (округление вниз).
      (ctx) => {
        const blast = ctx.weapon.keywords.find((k) => k.name === 'blast');
        if (!blast?.value) return 0;
        const perFive = Math.floor(ctx.defenderModelCount / 5) * (blast.value!.count + blast.value!.plus);
        return perFive;
      },
      // [CLEAVE X]: как Blast, в рукопашной, при одной цели.
      (ctx) => {
        if (ctx.phase !== 'melee') return 0;
        const cleave = ctx.weapon.keywords.find((k) => k.name === 'cleave');
        if (!cleave?.value) return 0;
        return Math.floor(ctx.defenderModelCount / 5) * cleave.value.count;
      },
    ],

    hitTarget: [
      // [TORRENT]: автопопадание.
      (ctx, base) => {
        const torrent = ctx.weapon.keywords.some((k) => k.name === 'torrent');
        return torrent ? null : base;
      },
      // [PSYCHIC] по правилу 11-й редакции позволяет игнорировать «any or all
      // modifiers» к BS/WS и к попаданию. Поэтому ни бонус [HEAVY], ни штрафы
      // (Stealth, indirect) на псионическую атаку не действуют.
      //
      // [HEAVY]: +1 к попаданию (модификатор порога: −1), если условия выполнены.
      (ctx, base) => {
        if (isPsychicAttack(ctx.weapon) || base === null) return base;
        return ctx.stationary && ctx.weapon.keywords.some((k) => k.name === 'heavy')
          ? base - 1
          : base;
      },
      // Stealth: −1 к попаданию дальнобойными атаками по цели с этим кейвордом.
      // В рукопашной не действует, автопопадание ([TORRENT]) не ломает,
      // псионическая атака ([PSYCHIC]) штраф игнорирует.
      (ctx, base) => {
        if (base === null || ctx.phase !== 'ranged' || isPsychicAttack(ctx.weapon)) return base;
        const stealth =
          ctx.target.keywords.includes('STEALTH') || ctx.defender.keywords.includes('STEALTH');
        return stealth ? base + 1 : base;
      },
      // Стрельба вслепую: −1 к попаданию (включается опцией indirect).
      (ctx, base) =>
        ctx.indirect && base !== null && !isPsychicAttack(ctx.weapon) ? base + 1 : base,
    ],

    extraHits: [
      // [SUSTAINED HITS X]: каждый крит. попадание добавляет X попаданий.
      // Условие ('non-MONSTER/VEHICLE') проверяется по кейвордам цели.
      (ctx, critHits) => {
        if (critHits === 0) return 0;
        const sustained = keywordOf(ctx.weapon.keywords, 'sustained', targetKeywordsOf(ctx));
        if (!sustained?.value) return 0;
        return critHits * rollDice(sustained.value, ctx.rng);
      },
    ],

    lethalCritHits: [
      // [LETHAL HITS]: крит. попадание автоматически ранит (в 11-й редакции).
      // Важно учитывать условие: в BSData 81 оружие имеют
      // 'Lethal Hits: non-MONSTER/VEHICLE' — без проверки такие стволы
      // автоматически ранили бы и технику, что ломает всю ось урона.
      (ctx) => keywordOf(ctx.weapon.keywords, 'lethal', targetKeywordsOf(ctx)) !== null,
    ],

    criticalWoundTarget: [
      // [ANTI-X Y+]: ранение Y+ (НЕ модифицированное) — критическое против
      // цели с кейвордом X.
      //
      // Перебираем ВСЕ Anti-кейворды оружия, а не только первый: у стволов бывает
      // несколько («Anti-MONSTER 4+» и «Anti-VEHICLE 3+»), и каждое действует
      // против своей цели. Берём наименьший порог из применимых — он и делает
      // ранение критическим.
      (ctx, base) => {
        const targetKeywords = targetKeywordsOf(ctx);
        let target = base;
        for (const anti of ctx.weapon.keywords) {
          if (anti.name !== 'anti' || anti.target === null || anti.value === null) continue;
          // Условие на цель ('Anti-VEHICLE 4+: non-FLYER') — точечно для этого
          // кейворда, иначе keywordOf вернул бы только первое совпадение.
          if (!keywordApplies(anti, targetKeywords)) continue;
          const matches = anti.target.some((required) => targetKeywords.includes(required));
          if (!matches) continue;
          target = Math.min(target, anti.value.count);
        }
        return target;
      },
    ],

    rerollWounds: [
      // [TWIN-LINKED] (11-я редакция): переброс ранений, не попаданий.
      (ctx) => ctx.weapon.keywords.some((k) => k.name === 'twin-linked'),
    ],

    devastatingCritWounds: [
      // [DEVASTATING WOUNDS]: крит. ранение → мортиды = D характеристики.
      (ctx) => keywordOf(ctx.weapon.keywords, 'devastating', targetKeywordsOf(ctx)) !== null,
    ],

    saveTarget: [
      // Точное оружие (S = T, например Psycannon / снайперские ружья): сейв не
      // бросается вовсе. В 11-й редакции это способность игнорировать спасброск
      // или профиль с S = T. Добавлено как шаблон: без такого оружия все шесть
      // групп оружия ранжировали отряды почти одинаково (r = 0.75…0.96), и
      // защитный вектор вырождался в одно число.
      (ctx, base) => {
        if (ctx.weapon.keywords.some((k) => k.name === 'precision')) return null;
        return base;
      },
    ],

    damage: [
      // [MELTA X]: +X к D, если цель на половинной дальности.
      (ctx, base) => {
        const melta = ctx.weapon.keywords.find((k) => k.name === 'melta');
        if (!melta?.value || ctx.distance === null || ctx.weapon.range === null) return base;
        if (ctx.distance * 2 > ctx.weapon.range) return base;
        return { ...base, plus: base.plus + melta.value.count };
      },
    ],

    woundTarget: [
      // [LANCE]: +1 к ранению, если атакующий отряд в этом ходу совершил
      // charge move. Порог уменьшается на 1 (−1 к броску ранения = +1 к нему).
      //
      // Правило применяется к «не модифицированному» броску: сначала считаем
      // порог по S/T, затем Lance его улучшает. clampTarget в ядре не даёт
      // порогу уйти лучше 2+.
      (ctx, base) => {
        if (base === null || !ctx.charged) return base;
        if (!ctx.weapon.keywords.some((k) => k.name === 'lance')) return base;
        return base - 1;
      },
    ],
  };
}

/** Слияние фрагментов: хуки из более поздних фрагментов применяются позже. */
export function extendRules(
  base: CombatRules,
  ...fragments: RuleFragment[]
): CombatRules {
  const merged: CombatRules = {
    extraAttackDice: [...base.extraAttackDice],
    hitTarget: [...base.hitTarget],
    extraHits: [...base.extraHits],
    lethalCritHits: [...base.lethalCritHits],
    woundTarget: [...base.woundTarget],
    criticalWoundTarget: [...base.criticalWoundTarget],
    rerollWounds: [...base.rerollWounds],
    devastatingCritWounds: [...base.devastatingCritWounds],
    saveTarget: [...base.saveTarget],
    damage: [...base.damage],
  };
  for (const fragment of fragments) {
    for (const key of Object.keys(fragment) as Array<keyof CombatRules>) {
      const hooks = fragment[key] as unknown[] | undefined;
      if (hooks === undefined) continue;
      (merged[key] as unknown[]).push(...hooks);
    }
  }
  return merged;
}
