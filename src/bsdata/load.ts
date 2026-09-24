/**
 * Загрузка базы BSData: разбор JSON, глобальный индекс определений, метаданные.
 *
 * Каталоги ссылаются друг на друга по id (entryLinks/infoLinks), поэтому индекс
 * строится по ВСЕМ файлам сразу: на выгрузке wh40k-11e это резолвит 25107 из
 * 25236 ссылок (остальное — служебные infoGroup-ссылки).
 *
 * Типы профилей и стоимостей объявлены в gameSystem («Warhammer 40,000.json»),
 * а каталоги фракций их не дублируют — без gameSystem нельзя понять, что
 * `field: '51b2-306e-1021-d207'` это «pts».
 */

import type {
  BsCatalogueRaw,
  BsContainerRaw,
  BsCostTypeRaw,
  BsDocument,
  BsDocumentRaw,
  BsProfileRaw,
  BsRuleRaw,
  BsSelectionNodeRaw,
} from './raw/types.ts';

/** Что угодно, на что можно сослаться по id. */
export type BsDefinition = BsSelectionNodeRaw | BsProfileRaw | BsRuleRaw;

export interface BsFileInput {
  name: string;
  text: string;
}

export interface BsMeta {
  /** id типа стоимости 'pts' — им же помечены ценовые модификаторы. */
  ptsCostTypeId: string | null;
  profileTypeIds: {
    unit: string | null;
    ranged: string | null;
    melee: string | null;
    abilities: string | null;
    transport: string | null;
  };
  /** id характеристик: 'M' → id (для разбора профилей по имени). */
  characteristicIds: Map<string, string>;
  /** Имя типа стоимости: id → 'pts' | 'Detachment Points' | … */
  costTypeNames: Map<string, string>;
}

export interface BsDatabase {
  documents: BsDocument[];
  gameSystem: BsCatalogueRaw | null;
  meta: BsMeta;
  /** id → определение (первое найденное; id в BattleScribe уникальны). */
  definition: (id: string | undefined) => BsDefinition | null;
  /** Ссылки, которые не удалось разрешить (служебные infoGroup и т.п.). */
  unresolvedLinks: number;
  /** Сколько определений попало в индекс. */
  definitionCount: number;
}

export const asArray = <T>(value: T[] | undefined): T[] => (Array.isArray(value) ? value : []);

/** Рекурсивно обходит selectionEntry/selectionEntryGroup и собирает id → узел. */
export function indexNode(node: BsContainerRaw, into: Map<string, BsDefinition>): void {
  if (typeof node.id === 'string' && !into.has(node.id)) into.set(node.id, node);
  for (const profile of asArray(node.profiles)) {
    if (typeof profile.id === 'string' && !into.has(profile.id)) into.set(profile.id, profile);
  }
  for (const rule of asArray(node.rules)) {
    if (typeof rule.id === 'string' && !into.has(rule.id)) into.set(rule.id, rule);
  }
  for (const child of asArray(node.selectionEntries)) indexNode(child, into);
  for (const group of asArray(node.selectionEntryGroups)) indexNode(group, into);
  for (const entry of asArray(node.sharedSelectionEntries)) indexNode(entry, into);
  for (const group of asArray(node.sharedSelectionEntryGroups)) indexNode(group, into);
  for (const profile of asArray(node.sharedProfiles)) {
    if (typeof profile.id === 'string' && !into.has(profile.id)) into.set(profile.id, profile);
  }
  for (const rule of asArray(node.sharedRules)) {
    if (typeof rule.id === 'string' && !into.has(rule.id)) into.set(rule.id, rule);
  }
}
function buildMeta(gameSystem: BsCatalogueRaw | null): BsMeta {
  const profileTypes = asArray(gameSystem?.profileTypes);
  const costTypes = asArray(gameSystem?.costTypes);

  const typeIdByName = (name: string): string | null =>
    profileTypes.find((type) => type.name === name)?.id ?? null;

  const characteristicIds = new Map<string, string>();
  for (const type of profileTypes) {
    for (const characteristic of asArray(type.characteristicTypes)) {
      if (characteristic.name && characteristic.id) {
        characteristicIds.set(characteristic.name, characteristic.id);
      }
    }
  }

  const costTypeNames = new Map<string, string>();
  for (const type of costTypes as BsCostTypeRaw[]) {
    if (type.id && type.name) costTypeNames.set(type.id, type.name);
  }

  return {
    ptsCostTypeId: costTypes.find((type) => type.name === 'pts')?.id ?? null,
    profileTypeIds: {
      unit: typeIdByName('Unit'),
      ranged: typeIdByName('Ranged Weapons'),
      melee: typeIdByName('Melee Weapons'),
      abilities: typeIdByName('Abilities'),
      transport: typeIdByName('Transport'),
    },
    characteristicIds,
    costTypeNames,
  };
}

/** Считает ссылки, которые не разрешились (для отчёта о качестве данных). */
function countUnresolved(
  documents: BsDocument[],
  resolve: (id: string | undefined) => unknown
): number {
  let unresolved = 0;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    for (const key of ['entryLinks', 'infoLinks']) {
      for (const link of asArray(
        record[key] as Array<{ targetId?: string; type?: string }> | undefined
      )) {
        // infoGroup — служебная ссылка на группу свойств, её отсутствие нормально.
        if (link.type === 'infoGroup') continue;
        if (!resolve(link.targetId)) unresolved += 1;
      }
    }
    for (const [key, value] of Object.entries(record)) {
      if (key === 'entryLinks' || key === 'infoLinks') continue;
      visit(value);
    }
  };
  for (const document of documents) visit(document.node);
  return unresolved;
}

/**
 * Собирает базу из разобранных файлов. gameSystem ищется по признаку
 * (наличие ключа `gameSystem`), а не по имени файла — имя может измениться.
 */
export function loadBsData(files: BsFileInput[]): BsDatabase {
  const documents: BsDocument[] = [];

  for (const file of files) {
    let parsed: BsDocumentRaw;
    try {
      parsed = JSON.parse(file.text) as BsDocumentRaw;
    } catch {
      continue;
    }
    const node = parsed.catalogue ?? parsed.gameSystem;
    if (!node) continue;
    documents.push({ fileName: file.name, isGameSystem: parsed.gameSystem !== undefined, node });
  }

  const byId = new Map<string, BsDefinition>();
  for (const document of documents) {
    const node = document.node;
    if (typeof node.id === 'string' && !byId.has(node.id)) byId.set(node.id, node);
    for (const entry of asArray(node.sharedSelectionEntries)) indexNode(entry, byId);
    for (const group of asArray(node.sharedSelectionEntryGroups)) indexNode(group, byId);
    for (const profile of asArray(node.sharedProfiles)) {
      if (typeof profile.id === 'string' && !byId.has(profile.id)) byId.set(profile.id, profile);
    }
    for (const rule of asArray(node.sharedRules)) {
      if (typeof rule.id === 'string' && !byId.has(rule.id)) byId.set(rule.id, rule);
    }
    for (const entry of asArray(node.selectionEntries)) indexNode(entry, byId);
    for (const group of asArray(node.selectionEntryGroups)) indexNode(group, byId);
  }

  const gameSystem = documents.find((document) => document.isGameSystem)?.node ?? null;
  const definition = (id: string | undefined): BsDefinition | null =>
    typeof id === 'string' ? byId.get(id) ?? null : null;

  return {
    documents,
    gameSystem,
    meta: buildMeta(gameSystem),
    definition,
    unresolvedLinks: countUnresolved(documents, definition),
    definitionCount: byId.size,
  };
}