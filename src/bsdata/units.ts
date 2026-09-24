/**
 * Парсер базы BSData: BattleScribe JSON → даташиты (юниты) + отчёт о качестве.
 *
 * Точка входа — `parseBsDatabase(db)`: обходит все каталоги, собирает даташиты
 * из корневых entryLinks (именно они формируют ростер) и складывает отчёт.
 *
 * Отчёт намеренно подробный: по нему видно, сколько даташитов пропущено и почему
 * ('no-cost', 'no-model'), где встретились ценовые условия, которые нельзя
 * применить автоматически, и сколько единиц снаряжения без боевого профиля
 * (щиты, жетоны, апгрейды вроде 'Weapon Modifications').
 */

import { asArray, type BsDatabase } from './load.ts';
import { buildDatasheet } from './datasheets.ts';
import { asChoiceGroup, weaponsOf, withoutRoster } from './composition.ts';
import { sizeTiersOf } from './points.ts';
import type { BsDatasheet, BsParseReport, BsWargear } from './types.ts';
import type { BsCatalogueRaw, BsEntryLinkRaw } from './raw/types.ts';

export interface BsParseResult {
  datasheets: BsDatasheet[];
  byId: Map<string, BsDatasheet>;
  report: BsParseReport;
}

export interface BsParseOptions {
  /**
   * 'keep' (по умолчанию) — хранить ростерные записи (Warlord/Enhancements/Crusade)
   * в снаряжении; 'drop' — выбросить их: нужен только боевой набор модели.
   */
  roster?: 'keep' | 'drop';
}

/** 'Xenos - Orks' → 'Orks'; 'Imperium - Astra Militarum - Library' → 'Astra Militarum'. */
export function factionFromCatalogueName(name: string): string {
  const parts = name
    .split(' - ')
    .map((part) => part.trim())
    .filter((part) => part !== '' && part.toLowerCase() !== 'library');
  return parts.length > 1 ? parts[parts.length - 1] : parts[0] ?? name;
}

/** Фракция каталога: самое частое «Faction: …» среди его даташитов. */
function factionOfCatalogue(datasheets: BsDatasheet[], catalogueRaw: BsCatalogueRaw): string {
  const counts = new Map<string, number>();
  for (const datasheet of datasheets) {
    counts.set(datasheet.faction, (counts.get(datasheet.faction) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [faction, count] of counts) {
    if (faction === 'Unknown') continue;
    if (count > bestCount) {
      best = faction;
      bestCount = count;
    }
  }
  return best ?? factionFromCatalogueName(String(catalogueRaw.name ?? 'Unknown'));
}

/** Оружейные профили и записи снаряжения даташита, разложенные по видам. */
interface WargearStats {
  /** Все оружейные профили, включая вложенные в составные апгрейды. */
  weapons: number;
  /** Записи-апгрейды без единого боевого профиля (щиты, жетоны). */
  withoutProfile: number;
  /** Записи уровня ростера (Warlord, Enhancements, Crusade). */
  roster: number;
}

function wargearStats(datasheet: BsDatasheet): WargearStats {
  const stats: WargearStats = { weapons: 0, withoutProfile: 0, roster: 0 };

  const visit = (items: BsWargear[]): void => {
    for (const item of items) {
      stats.weapons += item.profiles.length;
      if (item.kind === 'roster') stats.roster += 1;
      if (item.kind === 'upgrade' && weaponsOf(item).length === 0) stats.withoutProfile += 1;
      visit(item.nested);
    }
  };

  for (const variant of datasheet.variants) {
    visit(variant.defaultWargear);
    visit(variant.optionalWargear);
  }

  return stats;
}

/**
 * Ищет встроенные наборы опций размера: в некоторых каталогах добавлены
 * selectionEntry типа unit с модификаторами цены по числу моделей.
 * Возвращает список порогов размера (для отчёта).
 */
function tierSummary(datasheet: BsDatasheet): string[] {
  return sizeTiersOf(datasheet).map((tier) => `${tier.models} → ${tier.points}`);
}
/**
 * Парсит все даташиты базы.
 *
 * Даташиты дедуплицируются по id: библиотечные каталоги и «- Library»-файлы
 * ссылаются на те же определения, что и фракционные.
 */
export function parseBsDatabase(db: BsDatabase, options: BsParseOptions = {}): BsParseResult {
  const byId = new Map<string, BsDatasheet>();
  const skippedNoCost: string[] = [];
  const skippedNoModel: string[] = [];
  const skippedOther: string[] = [];
  const uncertainCosts: Array<{ name: string; description: string }> = [];
  const datasheetsByFaction: Record<string, number> = {};
  let catalogues = 0;

  for (const document of db.documents) {
    if (document.isGameSystem) continue;
    catalogues += 1;

    const links = asArray(document.node.entryLinks) as BsEntryLinkRaw[];
    const collected: BsDatasheet[] = [];

    for (const link of links) {
      if (link.hidden === true) continue;
      const result = buildDatasheet(link, db, {
        catalogueName: String(document.node.name ?? document.fileName),
        sourceFile: document.fileName,
        catalogueFaction: null,
      });

      if (result.reason === 'no-cost') {
        skippedNoCost.push(String(link.name ?? ''));
        continue;
      }
      if (result.reason === 'no-model') {
        skippedNoModel.push(String(link.name ?? ''));
        continue;
      }
      if (result.reason !== 'ok' || !result.datasheet) {
        skippedOther.push(String(link.name ?? ''));
        continue;
      }

      collected.push(result.datasheet);
    }

    // Фракция каталога нужна для ссылок без собственного 'Faction: …'.
    const faction = factionOfCatalogue(collected, document.node);
    for (const built of collected) {
      const datasheet = options.roster === 'drop' ? withoutRosterDatasheet(built) : built;
      const resolved: BsDatasheet =
        datasheet.faction === 'Unknown' ? { ...datasheet, faction } : datasheet;

      // Дедупликация: одно и то же определение может быть связано из нескольких
      // каталогов (например, из «- Library» и из фракционного файла).
      const existing = byId.get(resolved.id);
      if (existing) {
        const better =
          (existing.faction === 'Unknown' && resolved.faction !== 'Unknown') ||
          resolved.variants.length > existing.variants.length;
        if (better) byId.set(resolved.id, resolved);
        continue;
      }

      byId.set(resolved.id, resolved);
      datasheetsByFaction[resolved.faction] = (datasheetsByFaction[resolved.faction] ?? 0) + 1;

      for (const modifier of resolved.cost.modifiers) {
        if (modifier.uncertain) {
          uncertainCosts.push({ name: resolved.name, description: modifier.description });
        }
      }
    }
  }

  const datasheets = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));

  const totals: WargearStats = { weapons: 0, withoutProfile: 0, roster: 0 };
  const datasheetsWithoutWeapons: string[] = [];
  for (const datasheet of datasheets) {
    const stats = wargearStats(datasheet);
    totals.weapons += stats.weapons;
    totals.withoutProfile += stats.withoutProfile;
    totals.roster += stats.roster;
    if (stats.weapons === 0) datasheetsWithoutWeapons.push(datasheet.name);
  }

  const report: BsParseReport = {
    documents: db.documents.length,
    catalogues,
    datasheets: datasheets.length,
    skippedNoCost: [...new Set(skippedNoCost)].sort(),
    externalFactionEntries: skippedOther.length + skippedNoModel.length,
    unresolvedLinks: db.unresolvedLinks,
    profileTypeIds: {
      unit: db.meta.profileTypeIds.unit,
      ranged: db.meta.profileTypeIds.ranged,
      melee: db.meta.profileTypeIds.melee,
      abilities: db.meta.profileTypeIds.abilities,
      transport: db.meta.profileTypeIds.transport,
    },
    uncertainCosts,
    weapons: totals.weapons,
    wargearWithoutProfile: totals.withoutProfile,
    rosterEntries: totals.roster,
    datasheetsWithoutWeapons: datasheetsWithoutWeapons.sort(),
    datasheetsWithoutModels: [...new Set(skippedNoModel)].sort(),
    datasheetsByFaction: Object.fromEntries(
      Object.entries(datasheetsByFaction).sort((a, b) => b[1] - a[1])
    ),
  };

  return { datasheets, byId, report };
}

/**
 * Даташит без ростерных записей: снаряжение чистится от кампанийного поддерева,
 * группы выбора пересобираются по оставшимся записям.
 */
function withoutRosterDatasheet(datasheet: BsDatasheet): BsDatasheet {
  const variants = datasheet.variants.map((variant) => {
    const wargear = withoutRoster([...variant.defaultWargear, ...variant.optionalWargear]);
    return {
      ...variant,
      defaultWargear: wargear.filter((item) => item.min >= 1),
      optionalWargear: wargear.filter((item) => item.min === 0),
      choiceGroups: wargear.filter((item) => item.kind === 'choice').map(asChoiceGroup),
    };
  });
  const byVariantId = new Map(variants.map((variant) => [variant.id, variant]));

  return {
    ...datasheet,
    variants,
    modelGroups: datasheet.modelGroups.map((group) => ({
      ...group,
      variants: group.variants.map((variant) => byVariantId.get(variant.id) ?? variant),
    })),
  };
}

/** Сводка по даташиту для CLI и тестов. */
export function describeDatasheet(datasheet: BsDatasheet): string[] {
  const lines: string[] = [];
  lines.push(
    `${datasheet.name} <${datasheet.kind}> [${datasheet.faction}] base ${datasheet.cost.base} pts`
  );

  /** '+' — обязательное, '?' — опциональное, '=' — группа выбора, '~' — ростер. */
  const showWargear = (item: BsWargear, depth: number): void => {
    const range = item.max === null ? `${item.min}+` : `${item.min}-${item.max}`;
    const mark =
      item.kind === 'roster' ? '~' : item.kind === 'choice' ? '=' : item.min >= 1 ? '+' : '?';
    const weapons = weaponsOf(item)
      .map((weapon) => `${weapon.name}(${weapon.kind})`)
      .join(', ');
    const suffix = [item.cost > 0 ? `${item.cost} pts` : '', weapons].filter(
      (part) => part !== ''
    );
    lines.push(
      `      ${'  '.repeat(depth)}${mark} ${item.name} ×${range}` +
        `${suffix.length > 0 ? ` → ${suffix.join(' | ')}` : ''}`
    );
    for (const nested of item.nested) showWargear(nested, depth + 1);
  };

  for (const group of datasheet.modelGroups) {
    const range = group.max === null ? `${group.min}+` : `${group.min}-${group.max}`;
    lines.push(`  group '${group.name}' ${range}`);
    for (const variant of group.variants) {
      const variantRange =
        variant.max === null ? `${variant.min}+` : `${variant.min}-${variant.max}`;
      const profile = variant.profile;
      const stats = profile
        ? `M=${profile.movement ?? '?'} T=${profile.toughness ?? '?'} Sv=${profile.save ?? '?'} W=${profile.wounds ?? '?'}`
        : 'нет профиля';
      lines.push(`    ${variant.name} ×${variantRange} (${stats})`);
      for (const item of variant.defaultWargear) showWargear(item, 0);
      for (const item of variant.optionalWargear) showWargear(item, 0);
    }
  }

  for (const ability of datasheet.abilities) lines.push(`  ability ${ability.name}`);
  for (const rule of datasheet.rules) lines.push(`  rule ${rule.name}`);
  if (datasheet.transportCapacity) lines.push(`  transport: ${datasheet.transportCapacity}`);
  lines.push(`  tiers: ${tierSummary(datasheet).join(', ') || '—'}`);
  return lines;
}