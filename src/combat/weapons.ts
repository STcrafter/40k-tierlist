/**
 * Шаблоны оружия — обратная сторона шаблонов юнитов.
 *
 * Для оценки выживаемости нужна обратная величина: не «сколько юнит наносит»,
 * а «сколько он получает от типового противника». Поэтому здесь собраны
 * эталонные оружейные профили, сгруппированные по роли, и для каждого —
 * типовая численность стрельющего отряда и его стоимость в очках
 * (нужна для нормировки «урон на 100 очков»).
 *
 * Характеристики взяты из правил 11-й редакции и сверены с даташитами
 * BSData: болтер A1 3+ S4 AP-1 D2, силовой меч A2 3+ S5 AP-2 D2,
 * силовой кулак A3 3+ S8 AP-3 D3, штурмовая пушка A6 3+ S6 AP-1 D6.
 *
 * Как и архетипы юнитов, это допущения модели: у конкретных отрядов
 * характеристики отличаются, а часть шаблонов (ласканы, лансы) у разных
 * фракций разная. Задача шаблонов — дать сопоставимую шкалу угрозы.
 */

import { parseDice } from './dice.ts';
import { parseKeywords } from './keywords.ts';
import type { CombatModel, CombatUnit, CombatWeapon } from './types.ts';

/** Роль группы оружия в тирлисте. */
export type WeaponGroupId =
  /** Стрелковое оружие пехоты: болтер, болт-пистолет, лазган. */
  | 'small-arms'
  /** Тяжёлое оружие пехоты: плазма, штурмовая пушка, мельта. */
  | 'heavy-infantry'
  /** Рукопашное оружие пехоты: цепной меч, силовой меч, кулак. */
  | 'melee-infantry'
  /** Рукопашное оружие монстров: дробящие кулаки, пасть. */
  | 'monster-melee'
  /** Орудия техники: батарейная пушка, лазкан, мультимельта. */
  | 'vehicle-guns'
  /** Специализированное оружие против техники: ланс, мультимельта. */
  | 'anti-armour';

/** Эталонный оружейный профиль. */
export interface WeaponArchetype {
  id: string;
  name: string;
  group: WeaponGroupId;
  kind: 'ranged' | 'melee';
  range: number | null;
  /** A: 'D6' → { count: 1, sides: 6, plus: 0 }. */
  attacks: string;
  /** BS/WS '3+' → 3; '-' → null (автопопадание [TORRENT]). */
  skill: string;
  strength: number;
  ap: number;
  /** D: '1' → фиксированный урон. */
  damage: string;
  keywords: string[];
  /** Сколько моделей в типовом отряде с таким оружием. */
  models: number;
  /** Очки за одну модель с этим оружием (для нормировки). */
  pointsPerModel: number;
}

/** Человекочитаемые названия групп. */
export const WEAPON_GROUP_NAMES: Record<WeaponGroupId, string> = {
  'small-arms': 'Стрелковое пехоты',
  'heavy-infantry': 'Тяжёлое пехоты',
  'melee-infantry': 'Рукопашное пехоты',
  'monster-melee': 'Рукопашное монстров',
  'vehicle-guns': 'Орудия техники',
  'anti-armour': 'Против техники',
};

/** Все группы оружия в фиксированном порядке — для стабильных отчётов. */
export const WEAPON_GROUPS: readonly WeaponGroupId[] = [
  'small-arms',
  'heavy-infantry',
  'melee-infantry',
  'monster-melee',
  'vehicle-guns',
  'anti-armour',
];

/**
 * Эталонные оружейные профили. `models` и `pointsPerModel` задают типового
 * стрельющего: болтер у 10 астартес-интерсекторов (10 × 12 = 120 очков),
 * батарейная пушка у одного танка (160 очков).
 */
export const WEAPON_ARCHETYPES: readonly WeaponArchetype[] = [
  {
    id: 'bolter',
    name: 'Болтер',
    group: 'small-arms',
    kind: 'ranged',
    range: 24,
    attacks: '1',
    skill: '3+',
    strength: 4,
    ap: -1,
    damage: '2',
    keywords: [],
    models: 10,
    pointsPerModel: 12,
  },
  {
    id: 'bolt-pistol',
    name: 'Болт-пистолет',
    group: 'small-arms',
    kind: 'ranged',
    range: 12,
    attacks: '1',
    skill: '3+',
    strength: 4,
    ap: -1,
    damage: '2',
    keywords: ['Pistol'],
    models: 10,
    pointsPerModel: 12,
  },
  {
    id: 'lasgun',
    name: 'Лазган',
    group: 'small-arms',
    kind: 'ranged',
    range: 24,
    attacks: '1',
    skill: '3+',
    strength: 3,
    ap: 0,
    damage: '1',
    keywords: ['Las'],
    models: 10,
    pointsPerModel: 6,
  },
  {
    id: 'chainsword',
    name: 'Цепной меч',
    group: 'melee-infantry',
    kind: 'melee',
    range: null,
    attacks: '4',
    skill: '3+',
    strength: 4,
    ap: -1,
    damage: '1',
    keywords: [],
    models: 10,
    pointsPerModel: 10,
  },
  {
    id: 'power-sword',
    name: 'Силовой меч',
    group: 'melee-infantry',
    kind: 'melee',
    range: null,
    attacks: '2',
    skill: '3+',
    strength: 5,
    ap: -2,
    damage: '2',
    keywords: [],
    models: 5,
    pointsPerModel: 20,
  },
  {
    id: 'power-fist',
    name: 'Силовой кулак',
    group: 'melee-infantry',
    kind: 'melee',
    range: null,
    attacks: '3',
    skill: '3+',
    strength: 8,
    ap: -3,
    damage: '3',
    keywords: [],
    models: 5,
    pointsPerModel: 20,
  },
  {
    id: 'power-hammer',
    name: 'Силовой молот',
    group: 'melee-infantry',
    kind: 'melee',
    range: null,
    attacks: '2',
    skill: '3+',
    strength: 6,
    ap: -2,
    damage: '3',
    keywords: [],
    models: 5,
    pointsPerModel: 20,
  },
  {
    id: 'plasma-gunner',
    name: 'Плазменный пулемёт',
    group: 'heavy-infantry',
    kind: 'ranged',
    range: 24,
    attacks: '2',
    skill: '3+',
    strength: 8,
    ap: -3,
    damage: '3',
    keywords: ['Plasma'],
    models: 5,
    pointsPerModel: 25,
  },
  {
    id: 'assault-cannon',
    name: 'Штурмовая пушка',
    group: 'heavy-infantry',
    kind: 'ranged',
    range: 24,
    attacks: '6',
    skill: '3+',
    strength: 6,
    ap: -1,
    damage: '6',
    keywords: [],
    models: 5,
    pointsPerModel: 25,
  },
  {
    id: 'melta-gun',
    name: 'Мельта-пушка',
    group: 'heavy-infantry',
    kind: 'ranged',
    range: 12,
    attacks: '2',
    skill: '3+',
    strength: 8,
    ap: -4,
    damage: '6',
    keywords: ['Melta 2'],
    models: 5,
    pointsPerModel: 25,
  },
  {
    id: 'heavy-bolter',
    name: 'Тяжёлый болтер',
    group: 'heavy-infantry',
    kind: 'ranged',
    range: 36,
    attacks: '2',
    skill: '3+',
    strength: 6,
    ap: -3,
    damage: '3',
    keywords: [],
    models: 5,
    pointsPerModel: 30,
  },
  {
    id: 'crushing-fists',
    name: 'Дробящие кулаки',
    group: 'monster-melee',
    kind: 'melee',
    range: null,
    attacks: '3',
    skill: '2+',
    strength: 9,
    ap: -3,
    damage: '4',
    keywords: ['Extra Attacks'],
    models: 1,
    pointsPerModel: 80,
  },
  {
    id: 'monster-maw',
    name: 'Пасть монстра',
    group: 'monster-melee',
    kind: 'melee',
    range: null,
    attacks: '4',
    skill: '2+',
    strength: 9,
    ap: -3,
    damage: '6',
    keywords: ['Extra Attacks'],
    models: 1,
    pointsPerModel: 80,
  },
  {
    id: 'battle-cannon',
    name: 'Батарейная пушка',
    group: 'vehicle-guns',
    kind: 'ranged',
    range: 36,
    attacks: '1',
    skill: '3+',
    strength: 8,
    ap: -2,
    damage: '4',
    keywords: [],
    models: 1,
    pointsPerModel: 160,
  },
  {
    id: 'lascannon',
    name: 'Лазкан',
    group: 'vehicle-guns',
    kind: 'ranged',
    range: 48,
    attacks: '1',
    skill: '3+',
    strength: 12,
    ap: -4,
    damage: '6',
    keywords: ['Las'],
    models: 1,
    pointsPerModel: 160,
  },
  {
    id: 'autocannon',
    name: 'Автопушка',
    group: 'vehicle-guns',
    kind: 'ranged',
    range: 24,
    attacks: '2',
    skill: '3+',
    strength: 8,
    ap: -2,
    damage: '4',
    keywords: ['Rapid Fire 1'],
    models: 1,
    pointsPerModel: 160,
  },
  {
    id: 'lance',
    name: 'Ланс',
    group: 'anti-armour',
    kind: 'melee',
    range: null,
    attacks: '2',
    skill: '3+',
    strength: 12,
    ap: -5,
    damage: '6',
    keywords: ['Lance', 'Extra Attacks'],
    models: 5,
    pointsPerModel: 35,
  },
  {
    id: 'multi-melta',
    name: 'Мультимельта',
    group: 'anti-armour',
    kind: 'ranged',
    range: 12,
    attacks: '3',
    skill: '3+',
    strength: 7,
    ap: -5,
    damage: '2',
    keywords: ['Melta 8', 'Ignores Cover'],
    models: 5,
    pointsPerModel: 35,
  },
];

/** Шаблон оружия по идентификатору. */
export function weaponById(id: string): WeaponArchetype {
  const found = WEAPON_ARCHETYPES.find((weapon) => weapon.id === id);
  if (!found) throw new Error(`Неизвестный шаблон оружия: ${id}`);
  return found;
}

/** '3+' → 3; '-' → null. */
function parseSkill(text: string): number | null {
  const match = /^\s*(\d+)/.exec(text);
  return match ? Number(match[1]) : null;
}

/**
 * Шаблон оружия → боевой профиль.
 * Имя отличается от одноимённой функции адаптера BSData: там профиль приходит
 * из данных даташита, здесь — из нашего перечня шаблонов.
 */
export function toTemplateWeapon(archetype: WeaponArchetype): CombatWeapon {
  return {
    id: archetype.id,
    name: archetype.name,
    kind: archetype.kind,
    range: archetype.kind === 'ranged' ? archetype.range : null,
    attacks: parseDice(archetype.attacks),
    skill: parseSkill(archetype.skill),
    strength: archetype.strength,
    ap: archetype.ap,
    damage: parseDice(archetype.damage),
    keywords: parseKeywords(archetype.keywords),
  };
}

/** Кейворды стрельющего по группе оружия: танк не должен выглядеть пехотой. */
const GROUP_KEYWORDS: Record<WeaponGroupId, string[]> = {
  'small-arms': ['INFANTRY'],
  'heavy-infantry': ['INFANTRY'],
  'melee-infantry': ['INFANTRY'],
  'monster-melee': ['MONSTER'],
  'vehicle-guns': ['VEHICLE'],
  'anti-armour': ['INFANTRY'],
};

/**
 * Типовой стрельющий отряд: `models` моделей с этим оружием.
 * Характеристики самих стрелков на бой не влияют (защитник не атакует) —
 * они нужны, чтобы отряд-шаблон выглядел правдоподобно в отчётах.
 */
export function weaponUnitOf(
  archetype: WeaponArchetype,
  overrides: Partial<Pick<WeaponArchetype, 'models'>> = {}
): CombatUnit {
  const models: CombatModel[] = [];
  const weapon = toTemplateWeapon(archetype);
  const keywords = GROUP_KEYWORDS[archetype.group];
  const count = overrides.models ?? archetype.models;
  for (let i = 0; i < count; i += 1) {
    models.push({
      id: `${archetype.id}#${i}`,
      name: archetype.name,
      toughness: 4,
      wounds: 2,
      save: 3,
      invuln: null,
      keywords,
      weapons: [weapon],
    });
  }
  return { id: archetype.id, name: archetype.name, keywords, models };
}

/** Стоимость типового стрельющего в очках. */
export function weaponPointsOf(archetype: WeaponArchetype): number {
  return archetype.models * archetype.pointsPerModel;
}

