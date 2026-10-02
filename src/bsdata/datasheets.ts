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
import { canonicalFaction } from './factions.ts';
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

/**
 * Ключевые слова и фракция из categoryLinks ('Faction: Orks').
 *
 * Возвращается РОВНО ОДНА верхняя фракция плюс её подразделение. Раньше здесь
 * был другой уклад: в `factions` добавлялись все чаптеры Astartes и все легионы
 * демонов, чтобы лидер чаптера находил общие даташиты. Теперь это не нужно —
 * сопоставление лидера и отряда идёт по верхним фракциям, а подразделение
 * живёт отдельным полем `subFaction` и в подборе пар не участвует.
 *
 * Побочный эффект, который стоит знать: раньше `Sternguard Veteran Squad`
 * получал фракцию `Black Templars` и не находился ни для одного астартес-лидера,
 * хотя Black Templars — чаптер, а не отдельная армия. Теперь это 15 пар,
 * которые были разрешены правилами, но молча терялись.
 */
export function categoriesOf(
  link: BsEntryLinkRaw,
  target: BsSelectionNodeRaw
): { keywords: string[]; faction: string; subFaction: string | null } {
  const names = new Set<string>();

  for (const category of asArray(target.categoryLinks)) {
    if (category.name) names.add(String(category.name));
  }
  for (const category of asArray(link.categoryLinks)) {
    if (category.name) names.add(String(category.name));
  }

  const keywords = [...names];
  const rawFactions = [
    ...new Set(
      keywords
        .filter((keyword) => keyword.startsWith('Faction: '))
        .map((keyword) => keyword.slice('Faction: '.length))
    ),
  ];
  // В BSData общий даташит и конкретный чаптер — это две разные categoryLinks:
// «Faction: Adeptus Astartes» и «Faction: Imperial Fists» на одном юните.
// Порядок их хранения ничем не гарантирован, поэтому берётся не первое значение,
// а то, которое даёт ПОДРАЗДЕЛЕНИЕ: иначе у Lysander'а и его отрядов пропадал бы
// чаптер и подфракция молча не появлялась бы в переключателе.
const refs = rawFactions.map((raw) => canonicalFaction(raw));
  const chosen = refs.find((ref) => ref.subFaction !== null) ?? refs[0];
  if (chosen === undefined) {
    return { keywords, faction: 'Unknown', subFaction: null };
  }
  return { keywords, faction: chosen.faction, subFaction: chosen.subFaction };
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
  const categories = categoriesOf(link, entry);
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
      // Фракция подставляется ниже, в parseBsDatabase, где известна фракция
      // каталога целиком. Пустой массив означает «своего Faction: нет».
      faction: categories.faction,
      subFaction: categories.subFaction,
      // Пока в `factions` одна верхняя фракция. Массив сохранён, потому что
      // строкам пар он нужен объединённым: пара «Aleya + Seekers» находится и
      // по фильтру Custodes, и по фильтру демонов.
      factions: categories.faction === 'Unknown' ? [] : [categories.faction],
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