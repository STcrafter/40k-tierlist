/**
 * Сборка даташитов BSData.
 *
 * Даташит — это `catalogue.entryLinks[i]`, ссылающийся на `selectionEntry`
 * типа `unit` (отряд) или `model` (одиночная модель: техника, персонаж).
 * Именно этот список формирует «цифровой ростер», поэтому он и берётся за
 * единицу разбора, а не все selectionEntry подряд.
 *
 * Внимание: каталоги фракций ссылаются и на чужие даташиты (импортированные
 * «root entries»), поэтому принадлежность определяется по фракционному
 * categoryLink самой ссылки: если он не совпадает с фракцией каталога, даташит
 * помечается как внешний и по умолчанию не попадает в результат.
 */

import { asArray, type BsDatabase } from './load.ts';
import { costFormula } from './constraints.ts';
import { allAbilities, allRules, transportCapacityOf } from './profiles.ts';
import { modelGroupsOf, wargearAbilitiesOf } from './composition.ts';
import type { BsEntryLinkRaw, BsSelectionNodeRaw } from './raw/types.ts';
import type { BsAbility, BsDatasheet, BsModelGroup } from './types.ts';

/** Все id, которые «принадлежат» даташиту: группы, варианты, снаряжение. */
export function knownIdsOf(groups: BsModelGroup[], datasheetId: string): Set<string> {
  const ids = new Set<string>([datasheetId]);

  const visitWargear = (items: BsModelGroup['variants'][number]['defaultWargear']): void => {
    for (const item of items) {
      ids.add(item.id);
      visitWargear(item.nested);
    }
  };

  for (const group of groups) {
    ids.add(group.id);
    for (const variant of group.variants) {
      ids.add(variant.id);
      visitWargear(variant.defaultWargear);
      visitWargear(variant.optionalWargear);
      for (const choice of variant.choiceGroups) {
        ids.add(choice.id);
        for (const item of choice.choices) {
          ids.add(item.id);
          visitWargear(item.nested);
        }
      }
    }
  }

  return ids;
}

/** Чаптеры, для которых BSData использует общие Astartes-даташиты. */
export const ASTARTES_CHAPTERS = [
  'Black Templars', 'Blood Angels', 'Dark Angels', 'Deathwatch', "Emperor's Children",
  'Imperial Fists', 'Iron Hands', 'Raven Guard', 'Salamanders', 'Space Wolves',
  'Ultramarines', 'White Scars',
] as const;

export const ASTARTES_CHAPTER_SET = new Set<string>(ASTARTES_CHAPTERS);

/** Ключевые слова и фракция из categoryLinks ('Faction: Orks'). */
export function categoriesOf(
  link: BsEntryLinkRaw,
  target: BsSelectionNodeRaw,
  catalogueFaction: string | null = null
): { keywords: string[]; faction: string | null; factions: string[] } {
  const names = new Set<string>();

  for (const category of asArray(target.categoryLinks)) {
    if (category.name) names.add(String(category.name));
  }
  for (const category of asArray(link.categoryLinks)) {
    if (category.name) names.add(String(category.name));
  }

  const keywords = [...names];
  // В BSData общий Astartes-даташит и конкретный чаптер — это две categoryLinks,
  // а не альтернативные значения одного поля. Основная faction всегда
  // Adeptus Astartes, а factions сохраняет оба значения для фильтра чаптера.
  const rawFactions = [...new Set(
    keywords
      .filter((keyword) => keyword.startsWith('Faction: '))
      .map((keyword) => keyword.slice('Faction: '.length))
  )];
  const factions = [...new Set(
    catalogueFaction && ASTARTES_CHAPTER_SET.has(catalogueFaction) && rawFactions.includes('Adeptus Astartes')
      ? [...rawFactions, catalogueFaction]
      : rawFactions
  )];
  const explicitChapter = factions.find((value) => ASTARTES_CHAPTER_SET.has(value));
  // Общий Astartes-даташит (только Adeptus Astartes) входит в ростер каждого
  // чаптера. Даташит с собственным Faction: Chapter остаётся только в своём
  // чаптере и в гиперфракции Adeptus Astartes.
  const expandedFactions = factions.includes('Adeptus Astartes') && explicitChapter === undefined
    ? [...factions, ...ASTARTES_CHAPTERS]
    : factions;
  const faction = factions.includes('Adeptus Astartes')
    ? 'Adeptus Astartes'
    : factions[0] ?? null;
  return { keywords, faction, factions: expandedFactions };
}

export interface DatasheetBuildResult {
  datasheet: BsDatasheet | null;
  /** Почему даташит не собран (для отчёта). */
  reason: 'ok' | 'no-cost' | 'no-model' | 'not-an-entry';
}

/** Убирает дубли способностей: одно и то же снаряжение есть у разных вариантов. */
function uniqueAbilities(abilities: BsAbility[]): BsAbility[] {
  const seen = new Set<string>();
  return abilities.filter((ability) => {
    const key = `${ability.name}\u0000${ability.description}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Строит даташит из корневой ссылки каталога.
 * Фракция каталога передаётся отдельно: у импортированных ссылок factionLink
 * может отсутствовать, тогда используется фракция каталога.
 */
export function buildDatasheet(
  link: BsEntryLinkRaw,
  db: BsDatabase,
  context: { catalogueName: string; sourceFile: string; catalogueFaction: string | null }
): DatasheetBuildResult {
  const target = db.definition(link.targetId);
  if (!target || !('type' in target) || target.type === undefined) {
    return { datasheet: null, reason: 'not-an-entry' };
  }

  const entry = target as BsSelectionNodeRaw;
  if (entry.type !== 'unit' && entry.type !== 'model') {
    return { datasheet: null, reason: 'not-an-entry' };
  }

  const groups = modelGroupsOf(entry, db);
  const id = String(entry.id ?? link.targetId ?? '');
  const categories = categoriesOf(link, entry, context.catalogueFaction);
  const cost = costFormula(entry, knownIdsOf(groups, id), db);

  if (cost.base === 0) return { datasheet: null, reason: 'no-cost' };
  if (groups.length === 0) return { datasheet: null, reason: 'no-model' };

  const abilities: BsAbility[] = [
    ...allAbilities(entry, db),
    ...uniqueAbilities(
      groups.flatMap((group) =>
        group.variants.flatMap((variant) =>
          wargearAbilitiesOf([...variant.defaultWargear, ...variant.optionalWargear])
        )
      )
    ),
  ];
  const rules: BsAbility[] = [...allRules(entry, db), ...allAbilities(link, db)];

  return {
    reason: 'ok',
    datasheet: {
      id,
      name: String(entry.name ?? link.name ?? ''),
      kind: entry.type,
      faction: categories.faction ?? context.catalogueFaction ?? 'Unknown',
      factions: categories.factions.length > 0
        ? categories.factions
        : [categories.faction ?? context.catalogueFaction ?? 'Unknown'],
      catalogue: context.catalogueName,
      sourceFile: context.sourceFile,
      keywords: categories.keywords,
      cost,
      modelGroups: groups,
      variants: groups.flatMap((group) => group.variants),
      abilities,
      rules,
      transportCapacity: transportCapacityOf(entry, db),
    },
  };
}