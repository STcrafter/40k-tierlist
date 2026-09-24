/**
 * Доменная модель юнита: то, что должно получиться из сырых CSV.
 *
 * Иерархия:
 *   Unit
 *    ├─ modelGroups[]   — какие модели входят в отряд и сколько их (диапазон из состава)
 *    │   ├─ profile      — характеристики модели (M/T/Sv/inv/W/Ld/OC/base)
 *    │   ├─ abilities    — способности конкретной модели
 *    │   └─ wargear      — базовые группы оружия этой модели
 *    ├─ costTable       — тиры стоимости ('YOUR 4TH + UNIT COSTS') и доплаты за варгир
 *    ├─ sizes[]         — допустимые размеры отряда в моделях и очках
 *    ├─ abilities[]     — все способности (Core/Faction/Datasheet/Wargear/…)
 *    ├─ weaponCatalog[] — ВСЕ профили оружия (включая альтернативные режимы)
 *    ├─ loadoutOptions[]— «формула» набора снаряжения (см. types/loadout.ts)
 *    └─ baseLoadout[]   — стартовая комплектация
 */

import type { DiceExpr, WeaponRange } from '../normalize/numbers.ts';
import type { LoadoutEntry, LoadoutOption } from './loadout.ts';

export type AbilityKind =
  | 'core'
  | 'faction'
  | 'datasheet'
  | 'wargear'
  | 'wargear-profile'
  | 'psychic'
  | 'primarch'
  | 'special'
  | 'fortification'
  | 'unknown';

export interface Ability {
  /** ability_id для core/faction (ссылка в Abilities.csv), иначе null. */
  id: string | null;
  name: string;
  description: string;
  kind: AbilityKind;
  /** Сырое значение колонки type (в датасете есть русские пометки). */
  rawType: string;
  /** parameter, например 'D6' у Deadly Demise. */
  parameter: string | null;
  modelName: string | null;
}

export interface WeaponKeyword {
  /** Канонический ключ правила ('RAPID FIRE', 'ANTI-VEHICLE', 'TORRENT', …). */
  key: string;
  /** Числовой/дайсовый параметр ('2' у Rapid Fire 2, 'D6' у Melta). */
  value: string | null;
  /** Уточнение после ':' ('non-MONSTER/VEHICLE'). */
  note: string | null;
  raw: string;
  /** false — правило не найдено в таблице известных ключевых слов. */
  known: boolean;
}

export interface WeaponProfile {
  /** `${datasheetId}:wargear:${line}`. */
  id: string;
  /** Полное имя строки: 'Kombi-rokkit - Busta Rokkit'. */
  name: string;
  /** Имя группы оружия: 'Kombi-rokkit', 'Kannon'. */
  weaponName: string;
  /** Вариант профиля: 'Busta Rokkit', 'frag', null если профиль единственный. */
  variant: string | null;
  /** Каким разделителем задан вариант: ' - ' или ' – '. */
  separator: 'space-dash' | 'en-dash' | null;
  type: 'ranged' | 'melee' | null;
  range: WeaponRange | null;
  attacks: DiceExpr | null;
  /** BS/WS; null для N/A (auto-hit). */
  skill: number | null;
  strength: number | null;
  armourPenetration: number;
  damage: DiceExpr | null;
  keywords: WeaponKeyword[];
  autoHit: boolean;
  rawDescription: string | null;
  /** Колонка dice (в текущей выгрузке всегда пустая, оставлена для совместимости). */
  dice: string | null;
}

export interface WeaponGroup {
  /** Канонический id: slug(weaponName). */
  id: string;
  name: string;
  profiles: WeaponProfile[];
}

export interface ModelProfile {
  /** `${datasheetId}:model:${line}`. */
  id: string;
  line: number;
  name: string;
  movement: number | null;
  movementRaw: string;
  toughness: number | null;
  save: number | null;
  invulnerableSave: number | null;
  invulnerableSaveDescription: string | null;
  wounds: number | null;
  leadership: number | null;
  objectiveControl: number | null;
  baseSize: string | null;
  baseSizeDescription: string | null;
  /** Ключевые слова, привязанные к этой модели в Datasheets_keywords.model. */
  keywords: string[];
}

export interface ModelGroup {
  /** `${datasheetId}:group:${index}`. */
  id: string;
  /** Подпись из состава отряда: '1-2 Nob models'. */
  label: string;
  /** Имя модели без количественной части: 'Nob models'. */
  labelName: string;
  minCount: number;
  maxCount: number;
  profile: ModelProfile | null;
  /** Имя модели, с которой удалось сопоставить группу. */
  profileName: string | null;
  /** Уверенность сопоставления 0..1 (0 — не сопоставлено). */
  matchScore: number;
  abilities: Ability[];
  /** Базовые группы оружия, которые несёт эта модель по loadout. */
  wargear: WeaponGroup[];
}

export interface UnitSize {
  /** Подпись из файла стоимости: '10 models', '10 Gretchin'. */
  label: string;
  models: number;
  points: number;
}

export interface UnitCostTier {
  /** 'YOUR 1ST TO 3RD UNITS COST', 'YOUR 4TH + UNIT COSTS', … */
  label: string;
  sizes: UnitSize[];
}

export interface WargearCost {
  /** 'per Paired Krumpas'. */
  label: string;
  /** Имя оружия без префикса 'per'. */
  weaponName: string;
  points: number;
}

export interface UnitCostTable {
  tiers: UnitCostTier[];
  wargearCosts: WargearCost[];
}

export interface TransportInfo {
  capacity: number | null;
  description: string;
  restrictions: string[];
}

export interface DamagedBracket {
  from: number | null;
  to: number | null;
  description: string;
}

export interface UnitCompositionRange {
  minModels: number;
  maxModels: number | null;
}

/** Проблемы разбора конкретного юнита (для отчёта и тестов). */
export interface UnitParseIssues {
  unparsedOptions: Array<{ line: number; raw: string; reason: string }>;
  /** Строки опций со значением 'None' (не являются опциями). */
  skippedNoneOptions: number;
  unmatchedCompositionLabels: string[];
  /** Строки состава, которые не удалось разобрать как '1-2 Model models'. */
  compositionAnomalies: Array<{ line: number; description: string }>;
  unmatchedWeaponNames: string[];
  unknownWeaponKeywords: string[];
  missingModelProfile: string[];
  unresolvedAbilityIds: string[];
  /** Строки стоимости без размера отряда/очков. */
  costAnomalies: Array<{ line: number; description: string; cost: string }>;
  missingBaseLoadout: boolean;
  warnings: string[];
}

export interface Unit {
  // Идентификация
  id: string;
  name: string;
  factionId: string;
  faction: string;
  sourceId: string;
  legend: string;
  link: string;
  role: string | null;
  isVirtual: boolean;
  isSupport: boolean;

  // Модели и состав
  modelGroups: ModelGroup[];
  compositionRange: UnitCompositionRange;

  // Стоимость
  costTable: UnitCostTable;
  sizes: UnitSize[];
  baseSize: UnitSize | null;
  pointsPerModel: number | null;
  /** Очки за указанный размер отряда (базовый тир, ближайший доступный размер). */
  pointsForSize(models: number): number | null;

  // Агрегаты базового размера
  totalWounds: number | null;
  totalObjectiveControl: number | null;

  // Правила и способности
  abilities: Ability[];
  keywords: string[];
  factionKeywords: string[];
  keywordsByModel: Record<string, string[]>;

  // Особые блоки
  damagedBracket: DamagedBracket | null;
  transport: TransportInfo | null;
  /** id юнитов, которые могут присоединиться к этому (из Datasheets_leader). */
  ledByUnitIds: string[];
  /** id юнитов, к которым может присоединиться этот (из Datasheets_leader). */
  leadsUnitIds: string[];

  // Оружие и снаряжение
  weaponCatalog: WeaponGroup[];
  baseLoadout: LoadoutEntry[];
  loadoutOptions: LoadoutOption[];
  optionRestrictions: string[];

  issues: UnitParseIssues;
}

export function emptyIssues(): UnitParseIssues {
  return {
    unparsedOptions: [],
    skippedNoneOptions: 0,
    unmatchedCompositionLabels: [],
    compositionAnomalies: [],
    unmatchedWeaponNames: [],
    unknownWeaponKeywords: [],
    missingModelProfile: [],
    unresolvedAbilityIds: [],
    costAnomalies: [],
    missingBaseLoadout: false,
    warnings: [],
  };
}