/**
 * Типы сырых данных BattleScribe JSON (репозиторий BSData/wh40k-11e).
 *
 * Описываем только то, что реально встречается в выгрузке и нужно парсеру:
 * каталоги, selectionEntry/entryLink/selectionEntryGroup, профили, стоимости,
 * ограничения и модификаторы. Значения характеристик лежат в `$text`.
 */

/** Значение с типом ('4+', 'Melee', '24"'…). */
export interface BsCharacteristic {
  name?: string;
  typeId?: string;
  $text?: string;
  value?: string | number;
}

export interface BsProfileRaw {
  name?: string;
  id?: string;
  hidden?: boolean;
  typeId?: string;
  typeName?: string;
  characteristics?: BsCharacteristic[];
}

export interface BsCostRaw {
  name?: string;
  typeId?: string;
  value?: number | string;
}

export interface BsConstraintRaw {
  id?: string;
  field?: string;
  type?: string;
  value?: number | string;
  scope?: string;
  shared?: boolean;
  automatic?: boolean;
  childId?: string;
  childName?: string;
  message?: string;
}

export interface BsConditionRaw {
  childId?: string;
  childName?: string;
  field?: string;
  type?: string;
  value?: number | string;
  scope?: string;
  shared?: boolean;
}

export interface BsConditionGroupRaw {
  type?: string;
  conditions?: BsConditionRaw[];
  /** Вложенные группы (в данных встречается у Boyz, 'Boarding Actions', Windriders). */
  conditionGroups?: BsConditionGroupRaw[];
  localConditionGroups?: BsConditionGroupRaw[];
}

export interface BsModifierRaw {
  field?: string;
  type?: string;
  value?: number | string;
  /** Повторы: 'за каждые N selections …'. */
  repeats?: BsConditionRaw[];
  conditions?: BsConditionRaw[];
  conditionGroups?: BsConditionGroupRaw[];
  comment?: string;
}

export interface BsModifierGroupRaw {
  type?: string;
  comment?: string;
  modifiers?: BsModifierRaw[];
}

export interface BsCategoryLinkRaw {
  name?: string;
  id?: string;
  primary?: boolean;
  targetId?: string;
}

export interface BsInfoLinkRaw {
  name?: string;
  id?: string;
  type?: string;
  targetId?: string;
  hidden?: boolean;
}

export interface BsEntryLinkRaw {
  name?: string;
  id?: string;
  type?: string;
  targetId?: string;
  hidden?: boolean;
  import?: boolean;
  collective?: boolean;
  constraints?: BsConstraintRaw[];
  modifiers?: BsModifierRaw[];
  modifierGroups?: BsModifierGroupRaw[];
  categoryLinks?: BsCategoryLinkRaw[];
  infoLinks?: BsInfoLinkRaw[];
  entryLinks?: BsEntryLinkRaw[];
}

export interface BsRuleRaw {
  name?: string;
  id?: string;
  description?: string;
  hidden?: boolean;
}

/** Общая часть selectionEntry и selectionEntryGroup — то, что вкладывается друг в друга. */
export interface BsSelectionNodeRaw {
  name?: string;
  id?: string;
  type?: string;
  hidden?: boolean;
  import?: boolean;
  collective?: boolean;
  constraints?: BsConstraintRaw[];
  modifiers?: BsModifierRaw[];
  modifierGroups?: BsModifierGroupRaw[];
  categoryLinks?: BsCategoryLinkRaw[];
  infoLinks?: BsInfoLinkRaw[];
  costs?: BsCostRaw[];
  profiles?: BsProfileRaw[];
  rules?: BsRuleRaw[];
  entryLinks?: BsEntryLinkRaw[];
  selectionEntries?: BsSelectionNodeRaw[];
  selectionEntryGroups?: BsSelectionNodeRaw[];
}

/** Контейнер, внутри которого лежат shared-определения (каталог/gameSystem). */
export interface BsContainerRaw extends BsSelectionNodeRaw {
  sharedSelectionEntries?: BsSelectionNodeRaw[];
  sharedSelectionEntryGroups?: BsSelectionNodeRaw[];
  sharedProfiles?: BsProfileRaw[];
  sharedRules?: BsRuleRaw[];
}

export interface BsProfileTypeRaw {
  name?: string;
  id?: string;
  characteristicTypes?: Array<{ name?: string; id?: string }>;
}

export interface BsCostTypeRaw {
  name?: string;
  id?: string;
  defaultCostLimit?: number | string;
  hidden?: boolean;
}

export interface BsCatalogueLinkRaw {
  name?: string;
  id?: string;
  targetId?: string;
  type?: string;
  importRootEntries?: boolean;
}

export interface BsCatalogueRaw extends BsContainerRaw {
  name?: string;
  id?: string;
  revision?: number;
  library?: boolean;
  authorName?: string;
  battleScribeVersion?: string;
  gameSystemId?: string;
  xmlns?: string;
  catalogueLinks?: BsCatalogueLinkRaw[];
  costTypes?: BsCostTypeRaw[];
  profileTypes?: BsProfileTypeRaw[];
  categoryEntries?: BsSelectionNodeRaw[];
  forceEntries?: BsSelectionNodeRaw[];
}

/** Файл каталога: 'catalogue' или 'gameSystem' в корне JSON. */
export interface BsDocumentRaw {
  catalogue?: BsCatalogueRaw;
  gameSystem?: BsCatalogueRaw;
}

/** Разобранный файл: имя файла + корневой узел + признак gameSystem. */
export interface BsDocument {
  fileName: string;
  isGameSystem: boolean;
  node: BsCatalogueRaw;
}