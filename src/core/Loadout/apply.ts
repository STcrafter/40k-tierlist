// src/core/loadout/apply.ts

import { Unit, WeaponProfile } from '../../data/types/unit';
import { parseSlots } from './slots';
import { optimizeLoadout, Doctrine } from './optimizer';

function groupOf(name: string): string {
  return name.split('–')[0].split('-')[0].trim().toLowerCase();
}

/**
 * Пересобирает weapons юнита под выбранную доктрину.
 * Чистая функция без симуляций — мгновенно.
 */
export function applyDoctrine(unit: Unit, doctrine: Doctrine): Unit {
  if (unit.baseEntries.length === 0 || unit.weaponCatalog.length === 0) {
    return unit;
  }

  // Группа → все варианты профиля (frag/krak, standard/supercharge)
  const variants = new Map<string, WeaponProfile[]>();
  for (const w of unit.weaponCatalog) {
    const g = groupOf(w.name);
    if (!variants.has(g)) variants.set(g, []);
    variants.get(g)!.push(w);
  }

  const slots = parseSlots(
    unit.optionDescriptions,
    unit.models,
    groupOf,
    new Set(variants.keys())
  );

  const optimized = optimizeLoadout(unit.baseEntries, slots, variants, doctrine);

  return {
    ...unit,
    weapons: optimized.map((e) => ({ ...e.weapon, count: e.count })),
  };
}