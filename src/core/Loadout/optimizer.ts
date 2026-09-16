// src/core/loadout/optimizer.ts

import { WeaponProfile } from '../../data/types/unit';
import { TargetProfile } from '../types';
import { META_TARGETS } from '../meta/targets';
import { weaponValue } from './contributions';
import { LoadoutSlot } from './slots';

export type Doctrine = 'BALANCED' | 'ANTI_INFANTRY' | 'ANTI_ARMOR';

export const DOCTRINE_WEIGHTS: Record<Doctrine, number[]> = {
  //           horde  meq   teq   lveh  hveh  mon
  BALANCED:     [0.25, 0.25, 0.15, 0.15, 0.10, 0.10],
  ANTI_INFANTRY:[0.45, 0.35, 0.15, 0.05, 0.00, 0.00],
  ANTI_ARMOR:   [0.00, 0.05, 0.15, 0.30, 0.25, 0.25],
};

export interface LoadoutEntry {
  weapon: WeaponProfile;
  count: number;   // сколько моделей несут это оружие
}

/**
 * Жадная оптимизация loadout'а под доктрину.
 * Экспоненты нет: каждый слот оценивается независимо по таблице вкладов,
 * связь между слотами — только через остаток базовых пушек.
 */
export function optimizeLoadout(
  base: LoadoutEntry[],
  slots: LoadoutSlot[],
  catalog: Map<string, WeaponProfile>,
  doctrine: Doctrine
): LoadoutEntry[] {
  const weights = DOCTRINE_WEIGHTS[doctrine];
  const value = (w: WeaponProfile) => weaponValue(w, META_TARGETS, weights);

  // Остаток базовых оружий по группам
  const counts = new Map<string, number>();
  const entries: LoadoutEntry[] = base.map((e) => {
    const key = groupOf(e.weapon.name);
    counts.set(key, (counts.get(key) ?? 0) + e.count);
    return { weapon: e.weapon, count: e.count };
  });

  const addEntry = (w: WeaponProfile, count: number) => {
    const existing = entries.find((e) => e.weapon.name === w.name);
    if (existing) existing.count += count;
    else entries.push({ weapon: w, count });
  };

  const removeEntry = (groupName: string, count: number) => {
    const left = counts.get(groupName) ?? 0;
    const take = Math.min(left, count);
    if (take <= 0) return 0;
    counts.set(groupName, left - take);
    const entry = entries.find((e) => groupOf(e.weapon.name) === groupName);
    if (entry) {
      entry.count -= take;
      if (entry.count <= 0) entries.splice(entries.indexOf(entry), 1);
    }
    return take;
  };

  // Оцениваем слоты: лучшая дельта первой (конкуренция за базовые пушки)
  const scored = slots
    .map((slot) => {
      const baseWeapon = slot.baseWeapon ? catalog.get(slot.baseWeapon) : undefined;
      const baseVal = baseWeapon ? value(baseWeapon) : 0;
      let bestChoice: WeaponProfile | null = null;
      let bestDelta = 0;
      for (const name of slot.choices) {
        const w = catalog.get(name);
        if (!w) continue;
        const delta = value(w) - (slot.kind.startsWith('replace') ? baseVal : 0);
        if (delta > bestDelta) {
          bestDelta = delta;
          bestChoice = w;
        }
      }
      return { slot, bestChoice, bestDelta };
    })
    .filter((s) => s.bestChoice !== null && s.bestDelta > 0)
    .sort((a, b) => b.bestDelta - a.bestDelta);

  for (const { slot, bestChoice } of scored) {
    let capacity = slot.capacity;
    if (slot.baseWeapon) {
      capacity = Math.min(capacity, counts.get(slot.baseWeapon) ?? 0);
    }
    if (capacity <= 0) continue;

    if (slot.baseWeapon) removeEntry(slot.baseWeapon, capacity);
    addEntry(bestChoice!, capacity);
  }

  return entries.filter((e) => e.count > 0);
}

function groupOf(name: string): string {
  return name.split('–')[0].split('-')[0].trim().toLowerCase();
}