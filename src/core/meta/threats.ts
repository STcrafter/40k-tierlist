// src/core/meta/threats.ts

import { Unit, WeaponProfile, UnitCategory, UnitRole } from '../../data/types/unit';
import { TargetProfile } from '../types';

export interface MetaThreat {
  id: string;
  name: string;
  weight: number;      // частота угрозы в мете
  attacker: Unit;      // виртуальный "залп" как юнит с 1 моделью
}

function volley(
  name: string, attacks: number, skill: number,
  s: number, ap: number, d: number
): WeaponProfile {
  return {
    name, range: 24, attacks, skill,
    strength: s, ap, damage: d,
    type: 'Range', abilities: [],
  };
}

function virtualUnit(id: string, name: string, weapons: WeaponProfile[]): Unit {
  return {
    id, name,
    faction: 'META', factionId: 'META',
    role: 'THREAT', link: '',
    category: UnitCategory.UNKNOWN,
    predictedRole: UnitRole.STRIKER,
    points: 1, pointsPerModel: 1, models: 1,
    toughness: 4, save: 3, invulnerableSave: null,
    wounds: 1, woundsTotal: 1,
    feelNoPain: null, damageReduction: 0, minusToWound: 0, stealth: false,
    movement: 6, objectiveControl: 0, objectiveControlTotal: 0,
    weapons,
    keywords: [], factionKeywords: [],
    hasInfiltrate: false, hasScout: false, hasFly: false, hasDeepStrike: false,
  };
}

/**
 * Типичные залпы мета-армии за один ход.
 * Веса = доля угрозы в типичном матче.
 */
export const META_THREATS: MetaThreat[] = [
  {
    id: 'horde', name: 'Орда: 20× S4 AP0 D1', weight: 0.20,
    attacker: virtualUnit('t-horde', 'Horde volley', [volley('Horde guns', 20, 4, 4, 0, 1)]),
  },
  {
    id: 'meq', name: 'Пехота: 10× S4 AP-1 D1', weight: 0.25,
    attacker: virtualUnit('t-meq', 'MEQ volley', [volley('MEQ guns', 10, 3, 4, -1, 1)]),
  },
  {
    id: 'elite', name: 'Элита: 8× S8 AP-2 D2', weight: 0.20,
    attacker: virtualUnit('t-elite', 'Elite melee', [volley('Elite weapons', 8, 3, 8, -2, 2)]),
  },
  {
    id: 'at', name: 'Антитанк: 4× S12 AP-3 D6', weight: 0.20,
    attacker: virtualUnit('t-at', 'Anti-tank', [volley('AT weapons', 4, 3, 12, -3, 6)]),
  },
  {
    id: 'destroyer', name: 'Дестроер: 2× S16 AP-4 D6', weight: 0.15,
    attacker: virtualUnit('t-dest', 'Destroyer', [volley('Destroyer weapons', 2, 3, 16, -4, 6)]),
  },
];

/** Превращает наш юнит в цель для обратных симуляций */
export function unitAsTarget(unit: Unit): TargetProfile {
  return {
    id: unit.id,
    name: unit.name,
    toughness: unit.toughness,
    save: unit.save,
    invulnerableSave: unit.invulnerableSave,
    wounds: unit.wounds,
    models: unit.models,
    feelNoPain: unit.feelNoPain,
    damageReduction: unit.damageReduction,
    minusToHit: 0,
    hasCover: false,
    keywords: unit.keywords,
    metaWeight: 0,
  };
}