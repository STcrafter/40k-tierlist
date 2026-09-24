/**
 * Стандартные правила кейвордов 11-й редакции.
 *
 * Тексты правил взяты из gameSystem базы BSData ('Warhammer 40,000.json').
 * Расширение: extendRules(standardRules(), fragment) — цепочки объединяются,
 * пользовательские хуки добавляются в конец и применяются последними.
 */

import { rollDice } from './dice.ts';
import type { CombatRules, RuleFragment } from './types.ts';

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
      // [HEAVY]: +1 к попаданию (модификатор порога: −1), если условия выполнены.
      (ctx, base) => (ctx.stationary && ctx.weapon.keywords.some((k) => k.name === 'heavy')) ? base === null ? null : base - 1 : base,
      // Стрельба вслепую: −1 к попаданию (включается опцией indirect).
      (ctx, base) => (ctx.indirect && base !== null) ? base + 1 : base,
    ],

    extraHits: [
      // [SUSTAINED HITS X]: каждый крит. попадание добавляет X попаданий.
      (ctx, critHits) => {
        const sustained = ctx.weapon.keywords.find((k) => k.name === 'sustained');
        if (!sustained?.value || critHits === 0) return 0;
        return critHits * rollDice(sustained.value, ctx.rng);
      },
    ],

    lethalCritHits: [
      // [LETHAL HITS]: крит. попадание автоматически ранит (в 11-й редакции).
      (ctx) => ctx.weapon.keywords.some((k) => k.name === 'lethal'),
    ],

    criticalWoundTarget: [
      // [ANTI-X Y+]: ранение Y+ (не модифицированное) — критическое против цели с кейвордом X.
      (ctx, base) => {
        const anti = ctx.weapon.keywords.find(
          (k) => k.name === 'anti' && k.target !== null && k.value !== null
        );
        if (!anti || !anti.target || anti.value === null) return base;
        const targetKeywords = [...ctx.defender.keywords, ...ctx.target.keywords];
        if (!anti.target.some((required) => targetKeywords.includes(required))) return base;
        return Math.min(base, anti.value.count);
      },
    ],

    rerollWounds: [
      // [TWIN-LINKED] (11-я редакция): переброс ранений, не попаданий.
      (ctx) => ctx.weapon.keywords.some((k) => k.name === 'twin-linked'),
    ],

    devastatingCritWounds: [
      // [DEVASTATING WOUNDS]: крит. ранение → мортиды = D характеристики.
      (ctx) => ctx.weapon.keywords.some((k) => k.name === 'devastating'),
    ],

    saveTarget: [],

    damage: [
      // [MELTA X]: +X к D, если цель на половинной дальности.
      (ctx, base) => {
        const melta = ctx.weapon.keywords.find((k) => k.name === 'melta');
        if (!melta?.value || ctx.distance === null || ctx.weapon.range === null) return base;
        if (ctx.distance * 2 > ctx.weapon.range) return base;
        return { ...base, plus: base.plus + melta.value.count };
      },
    ],

    woundTarget: [],
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
