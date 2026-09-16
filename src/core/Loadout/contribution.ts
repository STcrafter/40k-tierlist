// src/core/loadout/contributions.ts

import { WeaponProfile, WeaponAbility } from '../../data/types/unit';
import { TargetProfile } from '../types';
import { woundTarget } from '../dice';

/**
 * Ожидаемый урон ОДНОЙ атаки этого профиля по цели (замкнутая формула).
 * Используется оптимизатором вместо Монте-Карло — быстро и детерминированно.
 */
export function expectedDamagePerAttack(
  weapon: WeaponProfile,
  target: TargetProfile
): number {
  // Попадание
  const hit = weapon.autoHit ? 1 : clampProb((7 - weapon.skill) / 6);
  const crit = 1 / 6;

  // Sustained Hits: криты дают дополнительные попадания
  const sustained = weapon.abilities.includes(WeaponAbility.SUSTAINED_1) ? 1
    : weapon.abilities.includes(WeaponAbility.SUSTAINED_2) ? 2
    : weapon.abilities.includes(WeaponAbility.SUSTAINED_3) ? 3
    : 0;
  const hits = hit + crit * sustained;

  // Ранение
  const wt = woundTarget(weapon.strength, target.toughness);
  const wound = clampProb((7 - wt) / 6);

  const lethal = weapon.abilities.includes(WeaponAbility.LETHAL_HITS);
  // Крит-попадания с Lethal ранят автоматически; остальные как обычно
  const nonCritHits = lethal ? hits - crit : hits;
  const critAutoWounds = lethal ? crit : 0;
  const wounds = critAutoWounds + nonCritHits * wound;

  // Крит-ранения для Devastating Wounds проходят сквозь сейвы
  const devastating = weapon.abilities.includes(WeaponAbility.DEVASTATING_WOUNDS);
  const critWounds = devastating ? nonCritHits * wound * (1 / 6) : 0;
  const normalWounds = wounds - critWounds;

  // Спасбросок
  const save = chooseSaveProb(target.save, target.invulnerableSave, weapon.ap);
  const unsaved = critWounds + normalWounds * (1 - save);

  // Средний урон за рану
  let avgDamage = expectedDice(weapon.damage);
  avgDamage = Math.max(1, avgDamage - target.damageReduction);
  if (target.feelNoPain !== null) {
    avgDamage *= 1 - clampProb((7 - target.feelNoPain) / 6);
  }

  // Blast: бонус-атаки по большим отрядам учтём множителем снаружи
  let attacksMult = 1;
  if (weapon.abilities.includes(WeaponAbility.BLAST) && target.models >= 10) {
    attacksMult += Math.floor(target.models / 5);
  }

  return unsaved * avgDamage * attacksMult;
}

/** Ценность оружия по пресету (взвешенная сумма по целям, стрельба+мили) */
export function weaponValue(
  weapon: WeaponProfile,
  targets: TargetProfile[],
  weights: number[]
): number {
  let v = 0;
  for (let i = 0; i < targets.length; i++) {
    v += weights[i] * expectedDamagePerAttack(weapon, targets[i]);
  }
  return v;
}

function clampProb(p: number): number {
  return Math.max(1 / 6, Math.min(1, p));
}

function expectedDice(d: number | 'D6' | 'D3'): number {
  if (d === 'D6') return 3.5;
  if (d === 'D3') return 2;
  return d;
}

function chooseSaveProb(
  save: number | null,
  invuln: number | null,
  ap: number
): number {
  const eff = save !== null ? Math.min(7, save + Math.abs(ap)) : null;
  let best: number | null = null;
  if (eff !== null && eff <= 6) best = eff;
  if (invuln !== null && (best === null || invuln < best)) best = invuln;
  if (best === null) {
    // сейв 7+ спасает только на натуральной 6
    return eff !== null && eff >= 7 ? 1 / 6 : 0;
  }
  return clampProb((7 - best) / 6);
}