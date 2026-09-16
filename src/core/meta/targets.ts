// src/core/meta/targets.ts

import { TargetProfile } from '../types';

/**
 * Стандартный набор мета-целей для анализа DPE.
 * Покрывает 95% типичных целей в текущей мете 10th edition.
 */
export const META_TARGETS: TargetProfile[] = [
  {
    id: 'geq', // Guard-Equivalent Quality
    name: 'Орда (T3/Sv5+)',
    toughness: 3,
    save: 5,
    invulnerableSave: null,
    wounds: 1,
    models: 20,
    feelNoPain: null,
    damageReduction: 0,
    minusToHit: 0,
    hasCover: false,
    keywords: ['INFANTRY'],
    metaWeight: 0.25,
  },
  {
    id: 'meq', // Marine-Equivalent Quality
    name: 'Пехота (T4/Sv3+)',
    toughness: 4,
    save: 3,
    invulnerableSave: null,
    wounds: 2,
    models: 10,
    feelNoPain: null,
    damageReduction: 0,
    minusToHit: 0,
    hasCover: false,
    keywords: ['INFANTRY'],
    metaWeight: 0.25,
  },
  {
    id: 'teq', // Terminator-Equivalent Quality
    name: 'Элита (T5/Sv2+/Inv4+)',
    toughness: 5,
    save: 2,
    invulnerableSave: 4,
    wounds: 3,
    models: 5,
    feelNoPain: null,
    damageReduction: 0,
    minusToHit: 0,
    hasCover: false,
    keywords: ['INFANTRY'],
    metaWeight: 0.15,
  },
  {
    id: 'light_vehicle',
    name: 'Лёгкая техника (T9/Sv3+)',
    toughness: 9,
    save: 3,
    invulnerableSave: null,
    wounds: 10,
    models: 1,
    feelNoPain: null,
    damageReduction: 0,
    minusToHit: 0,
    hasCover: false,
    keywords: ['VEHICLE'],
    metaWeight: 0.15,
  },
  {
    id: 'heavy_vehicle',
    name: 'Тяжёлая техника (T12/Sv2+)',
    toughness: 12,
    save: 2,
    invulnerableSave: null,
    wounds: 16,
    models: 1,
    feelNoPain: 5, // FNP 5+ против смертельных ран
    damageReduction: 0,
    minusToHit: 0,
    hasCover: false,
    keywords: ['VEHICLE'],
    metaWeight: 0.10,
  },
  {
    id: 'monster',
    name: 'Монстр (T10/Sv3+/Inv4+)',
    toughness: 10,
    save: 3,
    invulnerableSave: 4,
    wounds: 12,
    models: 1,
    feelNoPain: 5,
    damageReduction: 0,
    minusToHit: 0,
    hasCover: false,
    keywords: ['MONSTER'],
    metaWeight: 0.10,
  },
];