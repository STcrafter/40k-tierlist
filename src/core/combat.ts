// src/core/combat.ts

import { Unit, WeaponProfile, WeaponAbility } from '../data/types/unit';
import { TargetProfile, AttackModifiers, CombatRoll } from './types';
import {
  rollD6,
  resolveDice,
  woundTarget,
  isSuccess,
  saveSucceeds,
  chooseSave,
} from './dice';

/** Фаза боя: стрельба, ближний бой или всё вместе */
export type CombatPhase = 'Shooting' | 'Melee' | 'All';

/**
 * Симулирует одну серию атак одного оружия по цели.
 * Возвращает детализацию бросков.
 */
export function simulateCombat(
  unit: Unit,
  weapon: WeaponProfile,
  target: TargetProfile,
  modifiers: AttackModifiers = {}
): CombatRoll {
  const plusToHit = modifiers.plusToHit ?? 0;
  const plusToWound = modifiers.plusToWound ?? 0;
  const plusDamage = modifiers.plusDamage ?? 0;

  // === 1. Количество атак ===
  let baseAttacks = resolveDice(weapon.attacks);

  // Blast: бонусные атаки против целей с 10+ моделями
  if (weapon.abilities.includes(WeaponAbility.BLAST) && target.models >= 10) {
    baseAttacks += Math.floor(target.models / 5);
  }

  const carriers = weapon.count ?? unit.models;
  const totalAttacks = baseAttacks * carriers;

  // === 2. Броски на попадание ===
  let hits = 0;
  let criticalHits = 0;

  for (let i = 0; i < totalAttacks; i++) {
    const roll = rollD6();
    const isCrit = roll === 6;

    // autoHit (TORRENT): попадание без броска, но 6 всё равно считается критом
    if (weapon.autoHit || isSuccess(roll, weapon.skill, plusToHit)) {
      hits++;
      if (isCrit) criticalHits++;
    } else if (modifiers.rerollHit) {
      const reroll = rollD6();
      if (isSuccess(reroll, weapon.skill, plusToHit)) {
        hits++;
        if (reroll === 6) criticalHits++;
      }
    }
  }

  // Sustained Hits: криты дают дополнительные попадания
  let sustainedBonus = 0;
  if (weapon.abilities.includes(WeaponAbility.SUSTAINED_1)) sustainedBonus = 1;
  else if (weapon.abilities.includes(WeaponAbility.SUSTAINED_2)) sustainedBonus = 2;
  else if (weapon.abilities.includes(WeaponAbility.SUSTAINED_3)) sustainedBonus = 3;
  hits += criticalHits * sustainedBonus;

  // === 3. Броски на ранение ===
  let wounds = 0;
  let criticalWounds = 0; // только натуральные 6 на wound roll
  const woundTgt = woundTarget(weapon.strength, target.toughness);

  // Anti-X: авто-wound (2+) против определённых keywords
  const hasAntiBonus =
    (weapon.abilities.includes(WeaponAbility.ANTI_INFANTRY) &&
      target.keywords.includes('INFANTRY')) ||
    (weapon.abilities.includes(WeaponAbility.ANTI_VEHICLE) &&
      target.keywords.includes('VEHICLE')) ||
    (weapon.abilities.includes(WeaponAbility.ANTI_MONSTER) &&
      target.keywords.includes('MONSTER'));

  for (let i = 0; i < hits; i++) {
    const roll = rollD6();
    const isCrit = roll === 6;

    // Lethal Hits: крит на попадании = авто-ранение БЕЗ броска
    if (isCrit && weapon.abilities.includes(WeaponAbility.LETHAL_HITS)) {
      wounds++;
      continue; // не считается критом для Devastating Wounds
    }

    const effectiveTarget = hasAntiBonus ? 2 : woundTgt;

    if (isSuccess(roll, effectiveTarget, plusToWound)) {
      wounds++;
      if (isCrit) criticalWounds++;
    } else if (modifiers.rerollWound) {
      const reroll = rollD6();
      if (isSuccess(reroll, effectiveTarget, plusToWound)) {
        wounds++;
        if (reroll === 6) criticalWounds++;
      }
    }
  }

  // === 4. Броски на спасение ===
  const chosenSave = chooseSave(target.save, target.invulnerableSave, weapon.ap);
  let failedSaves = 0;

  for (let i = 0; i < wounds; i++) {
    // Devastating Wounds: только натуральная 6 на wound roll игнорирует сейвы
    const isDevastating =
      i < criticalWounds &&
      weapon.abilities.includes(WeaponAbility.DEVASTATING_WOUNDS);

    if (isDevastating) {
      failedSaves++;
      continue;
    }

    if (chosenSave === null) {
      failedSaves++;
      continue;
    }

    if (!saveSucceeds(rollD6(), chosenSave)) {
      failedSaves++;
    }
  }

  // === 5. Расчёт урона ===
  let totalDamage = 0;
  let modelsKilled = 0;
  let currentModelWounds = target.wounds;

  for (let i = 0; i < failedSaves; i++) {
    let damage = resolveDice(weapon.damage) + plusDamage;

    // Damage Reduction
    damage = Math.max(1, damage - target.damageReduction);

    // Feel No Pain: бросок на каждую единицу урона
    let actualDamage = damage;
    if (target.feelNoPain !== null) {
      for (let d = 0; d < damage; d++) {
        if (rollD6() >= target.feelNoPain) actualDamage--;
      }
    }
    actualDamage = Math.max(0, actualDamage);
    totalDamage += actualDamage;

    // Распределение урона по моделям цели
    for (let d = 0; d < actualDamage; d++) {
      currentModelWounds--;
      if (currentModelWounds <= 0) {
        modelsKilled++;
        currentModelWounds = target.wounds;
      }
    }
  }

  modelsKilled = Math.min(modelsKilled, target.models);

  return {
    totalAttacks,
    hits,
    wounds,
    failedSaves,
    totalDamage,
    modelsKilled,
  };
}

/**
 * Симулирует атаку юнита с учётом фазы боя.
 * Shooting → только оружие типа 'Range'
 * Melee → только оружие типа 'Melee'
 * All → всё оружие
 */
export function simulateFullAttack(
  unit: Unit,
  target: TargetProfile,
  modifiers: AttackModifiers = {},
  phase: CombatPhase = 'All'
): CombatRoll {
  const weapons = unit.weapons.filter((w) => {
    if (phase === 'All') return true;
    if (phase === 'Shooting') return w.type === 'Range';
    if (phase === 'Melee') return w.type === 'Melee';
    return true;
  });

  const total: CombatRoll = {
    totalAttacks: 0,
    hits: 0,
    wounds: 0,
    failedSaves: 0,
    totalDamage: 0,
    modelsKilled: 0,
  };

  for (const weapon of weapons) {
    const roll = simulateCombat(unit, weapon, target, modifiers);
    total.totalAttacks += roll.totalAttacks;
    total.hits += roll.hits;
    total.wounds += roll.wounds;
    total.failedSaves += roll.failedSaves;
    total.totalDamage += roll.totalDamage;
    total.modelsKilled += roll.modelsKilled;
  }

  total.modelsKilled = Math.min(total.modelsKilled, target.models);
  return total;
}