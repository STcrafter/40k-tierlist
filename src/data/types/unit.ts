// src/data/types/unit.ts

/**
 * Оружие с нормализованными характеристиками.
 * Все значения — числа или специальные маркеры для кубиков.
 */
export interface WeaponProfile {
  count?: number
  name: string;
  range: number;           // 0 = Melee
  attacks: DiceValue;      // Количество атак
  skill: number;           // BS/WS: 2, 3, 4...
  strength: number;
  ap: number;              // 0, -1, -2, -3, -4
  damage: DiceValue;
  autoHit: boolean;
  type: 'Melee' | 'Range';
  abilities: WeaponAbility[];
}
export interface LoadoutEntry {
  weapon: WeaponProfile;
  count: number;
}
export type DiceValue = number | 'D6' | 'D3';

export enum WeaponAbility {
  SUSTAINED_1 = 'SUSTAINED_1',
  SUSTAINED_2 = 'SUSTAINED_2',
  SUSTAINED_3 = 'SUSTAINED_3',
  LETHAL_HITS = 'LETHAL_HITS',
  DEVASTATING_WOUNDS = 'DEVASTATING_WOUNDS',
  TORRENT = 'TORRENT',
  BLAST = 'BLAST',
  HEAVY = 'HEAVY',
  ASSAULT = 'ASSAULT',
  PISTOL = 'PISTOL',
  RAPID_FIRE = 'RAPID_FIRE',
  ANTI_INFANTRY = 'ANTI_INFANTRY',
  ANTI_VEHICLE = 'ANTI_VEHICLE',
  ANTI_MONSTER = 'ANTI_MONSTER',
  IGNORES_COVER = 'IGNORES_COVER',
  TWINNED = 'TWINNED',
  PSYCHIC = 'PSYCHIC',
  MELTA = 'MELTA',
  HAZARDOUS = 'HAZARDOUS',
}

export enum UnitCategory {
  HORDE = 'HORDE',
  INFANTRY = 'INFANTRY',
  ELITE = 'ELITE',
  CAVALRY = 'CAVALRY',
  BEAST = 'BEAST',
  VEHICLE_LIGHT = 'VEHICLE_LIGHT',
  VEHICLE_HEAVY = 'VEHICLE_HEAVY',
  MONSTER = 'MONSTER',
  FLYER = 'FLYER',
  TRANSPORT = 'TRANSPORT',
  UNKNOWN = 'UNKNOWN',
}

export enum UnitRole {
  STRIKER = 'STRIKER',       // Основной урон
  TANK = 'TANK',             // Поглощение урона
  OBJECTIVE = 'OBJECTIVE',   // Контроль точек
  SUPPORT = 'SUPPORT',       // Ауры, лидеры
  TRANSPORT = 'TRANSPORT',   // Перевозка
  SCOUT = 'SCOUT',           // Разведка, infiltrate
}

/**
 * Чистая модель юнита для математического анализа.
 * Все поля нормализованы: строки превращены в числа.
 */
export interface Unit {

  baseEntries: LoadoutEntry[];
  /** Все профили каталога: база + опции + альт-режимы (frag/krak, standard/supercharge) */
  weaponCatalog: WeaponProfile[];
  /** Сырые description опций для парсера слотов */
  optionDescriptions: string[];
  // Идентификация
  id: string;
  name: string;
  faction: string;
  role: string;                      // BATTLELINE, ELITE и т.д. из datasheet
  category: UnitCategory;
  predictedRole: UnitRole;

  // Стоимость
  points: number;                    // Очки за базовую комплектацию
  pointsPerModel: number;
  models: number;                    // Количество моделей в базовой комплектации

  // Защитные характеристики
  toughness: number;
  save: number | null;               // null если "-"
  invulnerableSave: number | null;
  wounds: number;
  woundsTotal: number;               // wounds * models
  feelNoPain: number | null;         // 5 = 5+, null если нет
  damageReduction: number;           // 0, 1, 2...
  minusToWound: number;              // 0 или 1 (-1 to wound)
  stealth: boolean;                  // -1 to hit

  // Мобильность и OC
  movement: number;
  objectiveControl: number;
  objectiveControlTotal: number;     // OC * models

  // Атака
  optionWeapons: WeaponProfile[];
  weapons: WeaponProfile[];

  // Мета-данные
  keywords: string[];
  factionKeywords: string[];
  hasInfiltrate: boolean;
  hasScout: boolean;
  hasFly: boolean;
  hasDeepStrike: boolean;

  // Сырые ссылки
  link: string;
  factionId: string;
}