/**
 * Модель данных «формула набора снаряжения».
 *
 * Каждая строка Datasheets_options превращается в декларативное правило
 * (LoadoutOption), из которого можно:
 *  1) применить конкретный выбор игрока (loadout/apply.ts → applyLoadout);
 *  2) перечислить все допустимые конфигурации (loadout/enumerate.ts).
 *
 * Поля rule соответствуют формулировкам Wahapedia:
 *  - scope.kind='models' + scope.count   ← 'Up to 2 Kommando models …', 'Any number of models …'
 *  - scope.kind='model'                  ← 'This model …', 'Each of this model's …', '2 of this model's …'
 *  - scope.kind='unit'                   ← 'This unit can be equipped with 1 Watcher in the Dark.'
 *  - perModels                           ← 'For every 5 models in this unit, 1 model can …'
 *  - minUnitModels                       ← 'If this unit contains 10 models: …'
 *  - exclusive                           ← 'one of the following' (нельзя взять два варианта списка)
 *  - allowDuplicates                     ← 'up to two of the following, and can take duplicates'
 *  - base                                ← что заменяем ('can have their X replaced with …')
 *  - choices                             ← что можно взять (варианты из <ul><li> или единственный вариант)
 */

export interface WeaponRef {
  /** Имя так, как оно найдено в тексте (нормализованное). */
  name: string;
  /** id группы оружия в каталоге юнита, null если оружие не найдено. */
  groupId: string | null;
  /** Количество экземпляров в варианте ('1 Big Skorcha and 1 Kustom Choppa' → 1 и 1). */
  count: number;
}

export type OptionFamily =
  | 'this-model'
  | 'each-of-weapon'
  | 'n-of-weapon'
  | 'model-add'
  | 'unit-add'
  | 'any-number'
  | 'all-models'
  | 'per-n'
  | 'up-to-n'
  | 'size-conditional'
  | 'none'
  | 'restriction'
  | 'unknown';

export type OptionScope =
  | { kind: 'model' }
  | { kind: 'models'; count: number | null }
  | { kind: 'unit' };

export interface LoadoutChoice {
  /** Текст варианта как в данных. */
  label: string;
  /** Что игрок получает, выбрав этот вариант. */
  weapons: WeaponRef[];
}

export interface LoadoutOption {
  /** id вида `${datasheetId}:option:${line}`. */
  id: string;
  line: number;
  raw: string;
  family: OptionFamily;
  action: 'replace' | 'add';
  scope: OptionScope;
  /** Имя модели-ограничения ('Kommando', 'Nob'), если указано в тексте. */
  modelName: string | null;
  /** Сколько моделей могут воспользоваться опцией; null = все модели группы. */
  capacity: number | null;
  /** 'For every N models' — вместимость = floor(size / perModels). */
  perModels: number | null;
  /** 'If this unit contains N models' — опция доступна только при таком размере. */
  minUnitModels: number | null;
  /**
   * Условие доступности из текста опции ('If this model is equipped with X').
   * В первой версии не влияет на перебор — сохраняется для UI и отчёта.
   */
  condition: string | null;
  /** Варианты из 'one of the following' взаимоисключающие. */
  exclusive: boolean;
  /** 'can take duplicates' — можно брать один вариант несколько раз. */
  allowDuplicates: boolean;
  /** Что заменяется (для action='replace'). */
  base: WeaponRef[];
  choices: LoadoutChoice[];
  /** Тексты ограничений из строк с button='*', привязанные к этой опции. */
  restrictions: string[];
  /**
   * Сколько раз можно выбрать один и тот же вариант ('…more than once per unit').
   * null — ограничений на повторы нет.
   */
  duplicateLimit: number | null;
  /** Условное ослабление ограничения ('unless it contains 20 models, … more than twice'). */
  duplicateLimitAtSize: { models: number; limit: number | null } | null;
}

/** Выбор игрока: какую опцию, какой вариант и сколько раз. */
export interface LoadoutSelection {
  optionId: string;
  choiceIndex: number;
  count: number;
}

export interface LoadoutEntry {
  /** Группа оружия в каталоге юнита (null — оружие не найдено в каталоге). */
  groupId: string | null;
  name: string;
  /** Сколько стволов на ОДНУ модель группы-носителя ('2 godhammer lascannons' → 2). */
  perModel: number;
  /** Сколько стволов во всём отряде при базовом размере (масштабируется в applyLoadout). */
  count: number;
  /** Группа моделей, которая несёт это оружие. */
  modelGroupId: string | null;
  source: 'base' | 'option';
  optionId?: string;
}

export interface LoadoutConfiguration {
  size: number;
  selections: LoadoutSelection[];
  entries: LoadoutEntry[];
  /** Опции, недоступные при данном размере отряда (minUnitModels/perModels). */
  unavailableOptionIds: string[];
}
