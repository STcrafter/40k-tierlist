/**
 * Доменные типы BSData-парсера: то, что получается из BattleScribe JSON.
 *
 * Комплектация описывается не «семействами формулировок» (как в Wahapedia),
 * а ограничениями: у каждой единицы снаряжения есть min/max по числу выборов,
 * группы выбора взаимоисключающие по своим min/max. Это и есть «формула»
 * набора — её можно и применять к выбору игрока, и перебирать целиком.
 */

export type BsWeaponKind = 'ranged' | 'melee';

export interface BsWeaponProfile {
  name: string;
  kind: BsWeaponKind;
  range: string | null;
  attacks: string | null;
  /** BS для стрелкового, WS для рукопашного. */
  skill: string | null;
  strength: string | null;
  ap: string | null;
  damage: string | null;
  keywords: string[];
}

export interface BsModelProfile {
  name: string;
  movement: string | null;
  toughness: string | null;
  save: string | null;
  wounds: string | null;
  leadership: string | null;
  objectiveControl: string | null;
  invulnerableSave: string | null;
}

export interface BsAbility {
  name: string;
  description: string;
  /**
   * datasheet — профиль/правило на юните, rule — общее правило (infoLink),
   * wargear — способность, описанная у снаряжения ('Smoke Launchers').
   */
  kind: 'datasheet' | 'rule' | 'wargear';
}

/**
 * Классификация записи снаряжения:
 *  - 'weapon' — оружие (само или во вложенных записях) с боевым профилем;
 *  - 'choice' — группа выбора: min/max говорят, сколько записей из `nested` взять;
 *  - 'upgrade' — прочее снаряжение (щиты, жетоны, апгрейды без профиля);
 *  - 'roster' — служебные записи уровня ростера: Warlord, Enhancements, Crusade.
 */
export type BsWargearKind = 'weapon' | 'choice' | 'upgrade' | 'roster';

/** Единица снаряжения: и обязательная («по умолчанию»), и опциональная. */
export interface BsWargear {
  /** id определения (profile/upgrade) — ключ для сопоставления с выбором игрока. */
  id: string;
  name: string;
  /** Минимум выборов у модели/группы (min:selections(parent)). */
  min: number;
  /** Максимум выборов; null — не ограничен явно. */
  max: number | null;
  /** Лимит на весь отряд ('max:selections=N(unit)'), иначе null. */
  unitWideMax: number | null;
  kind: BsWargearKind;
  /** Описание способности снаряжения ('Smoke Launchers'), если она есть в данных. */
  ability: string | null;
  profiles: BsWeaponProfile[];
  /** Положительная доплата за единицу снаряжения (обычно 0). */
  cost: number;
  /** Вложенное снаряжение составного апгрейда ('Kustom Choppa and Kombi-skorcha'). */
  nested: BsWargear[];
}

/** Взаимоисключающая группа выбора ('Weapon 1', 'Kustom Choppa и Kombi-skorcha'). */
export interface BsChoiceGroup {
  id: string;
  name: string;
  min: number;
  max: number | null;
  choices: BsWargear[];
}

export interface BsModelVariant {
  id: string;
  name: string;
  min: number;
  max: number | null;
  profile: BsModelProfile | null;
  /** Снаряжение с min ≥ 1 — входит в комплект по умолчанию. */
  defaultWargear: BsWargear[];
  /** Снаряжение с min = 0 — можно добавить. */
  optionalWargear: BsWargear[];
  choiceGroups: BsChoiceGroup[];
}

export interface BsModelGroup {
  id: string;
  name: string;
  min: number;
  max: number | null;
  variants: BsModelVariant[];
}

/** Условие ценового модификатора, приведённое к нашим понятиям. */
export interface BsCostCondition {
  /** К чему относится условие: число моделей юнита, конкретная группа/вариант или внешнее. */
  target: 'total-models' | 'variant' | 'group' | 'external';
  targetId: string | null;
  compare: string;
  value: number;
}

/** Булево дерево условий: группа ('and' | 'or') из вложенных групп и листьев-условий. */
export interface BsCostExpr {
  op: 'and' | 'or';
  items: Array<BsCostExpr | BsCostCondition>;
}

export interface BsCostModifier {
  type: string;
  value: number;
  /** Все условия-листья (без группировки) — для отчётов и поиска порогов размеров. */
  conditions: BsCostCondition[];
  /** Логика применения условий; отсутствует для тривиального AND по `conditions`. */
  expr?: BsCostExpr;
  /** Текст условия для отчёта ('если моделей больше 10'). */
  description: string;
  /** Есть нераспознанные условия — цену применять нельзя без ручной проверки. */
  uncertain: boolean;
}

export interface BsCostFormula {
  base: number;
  modifiers: BsCostModifier[];
}

export interface BsDatasheet {
  id: string;
  name: string;
  /** 'unit' — отряд, 'model' — одиночный даташит (техника, персонаж). */
  kind: 'unit' | 'model';
  /** Основная фракция для обратной совместимости; для Astartes — Adeptus Astartes. */
  faction: string;
  /** Все фракционные categoryLinks, включая Adeptus Astartes и конкретный чаптер. */
  factions: string[];
  catalogue: string;
  sourceFile: string;
  keywords: string[];
  cost: BsCostFormula;
  modelGroups: BsModelGroup[];
  /** Плоский список вариантов моделей (удобно для UI и расчётов). */
  variants: BsModelVariant[];
  abilities: BsAbility[];
  rules: BsAbility[];
  transportCapacity: string | null;
}

export interface BsParseReport {
  documents: number;
  catalogues: number;
  datasheets: number;
  skippedNoCost: string[];
  externalFactionEntries: number;
  unresolvedLinks: number;
  profileTypeIds: Record<string, string | null>;
  /** Даташиты, где встретились непонятные ценовые условия. */
  uncertainCosts: Array<{ name: string; description: string }>;
  /** Всего оружейных профилей по базе (включая вложенные в составные апгрейды). */
  weapons: number;
  /** Записи снаряжения без профиля оружия (щиты, токены, апгрейды). */
  wargearWithoutProfile: number;
  /** Записи уровня ростера (Warlord, Enhancements, Crusade) — не снаряжение модели. */
  rosterEntries: number;
  /** Даташиты, у которых не нашлось ни одного оружейного профиля. */
  datasheetsWithoutWeapons: string[];
  /** Даташиты без моделей (структуру не удалось прочитать). */
  datasheetsWithoutModels: string[];
  datasheetsByFaction: Record<string, number>;
}
