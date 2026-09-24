/**
 * Сборка доменного Unit из сырых строк Wahapedia.
 *
 * Порядок работы:
 *   1) buildDatasetIndex — группировка строк по datasheet_id (иначе join'ы
 *      по 16k+ строк будут квадратичными);
 *   2) parseCompositionLines + parseModelProfiles + buildModelGroups — состав отряда
 *      (сопоставление по имени, а не по порядку строк);
 *   3) parseCostTable — тиры стоимости, размеры отряда, доплаты за варгир;
 *   4) buildWeaponCatalog — ВСЕ профили оружия даташита;
 *   5) parseBaseLoadout — стартовая комплектация по полю loadout;
 *   6) parseLoadoutOptions — «формула» набора снаряжения;
 *   7) parseDatasheetAbilities + groupKeywords — правила, способности, ключевые слова.
 *
 * Юнит без строк моделей или без стоимости не собирается: он непригоден для
 * анализа, и в отчёте указывается причина пропуска.
 */

import type {
  DatasheetRow,
  LeaderRow,
  ModelCostRow,
  ModelRow,
  OptionRow,
  CompositionRow,
  RawDataset,
  WargearRow,
  KeywordRow,
  DatasheetAbilityRow,
  FactionRow,
} from '../raw/types.ts';
import { buildAbilityLibrary, parseDatasheetAbilities } from './abilities.ts';
import type { AbilityLibraryIndex } from './abilities.ts';
import { buildModelGroups, parseCompositionLines, splitModelCounts } from './composition.ts';
import { parseCostTable, pointsForSize, selectBaseSize } from './costs.ts';
import type { ParsedCostTable } from './costs.ts';
import { parseLoadoutOptions, parseWeaponRefs } from './options.ts';
import { groupKeywords, keywordsForModel, parseModelProfiles } from './stats.ts';
import type { GroupedKeywords } from './stats.ts';
import { buildWeaponCatalog, findWeaponGroup } from './weapons.ts';
import { cleanText, collapseWhitespace } from '../normalize/text.ts';
import { matchByName, coreSlug } from '../normalize/match.ts';
import { parseFlag, parseRangeBounds } from '../normalize/numbers.ts';
import { emptyIssues } from '../types/unit.ts';
import type {
  Ability,
  DamagedBracket,
  ModelGroup,
  TransportInfo,
  Unit,
  UnitParseIssues,
  UnitSize,
  WeaponGroup,
} from '../types/unit.ts';
import type { LoadoutEntry } from '../types/loadout.ts';

export interface DatasetIndex {
  factionsById: Map<string, FactionRow>;
  datasheetsById: Map<string, DatasheetRow>;
  modelsByDatasheet: Map<string, ModelRow[]>;
  costsByDatasheet: Map<string, ModelCostRow[]>;
  compositionByDatasheet: Map<string, CompositionRow[]>;
  wargearByDatasheet: Map<string, WargearRow[]>;
  optionsByDatasheet: Map<string, OptionRow[]>;
  abilitiesByDatasheet: Map<string, DatasheetAbilityRow[]>;
  keywordsByDatasheet: Map<string, KeywordRow[]>;
  /** leader_id → id юнитов, к которым он может присоединиться. */
  leadsByLeader: Map<string, string[]>;
  /** attached_id → id лидеров, которые могут присоединиться. */
  leadersByAttached: Map<string, string[]>;
  abilityLibrary: AbilityLibraryIndex;
  /**
   * Глобальный реестр имён снаряжения (все Datasheets_wargear + все доплаты
   * 'per …' из стоимостей): имена из этого списка не считаются
   * «нераспознанным оружием», если у конкретного юнита у него нет профиля.
   */
  globalWargearNames: Set<string>;
}

function groupBy<T>(rows: T[], keyOf: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row).trim();
    if (key === '') continue;
    const bucket = map.get(key);
    if (bucket) bucket.push(row);
    else map.set(key, [row]);
  }
  return map;
}

function buildLeaderIndex(rows: LeaderRow[]): {
  leads: Map<string, string[]>;
  led: Map<string, string[]>;
} {
  const leads = new Map<string, string[]>();
  const led = new Map<string, string[]>();

  for (const row of rows) {
    const leader = row.leader_id.trim();
    const attached = row.attached_id.trim();
    if (leader === '' || attached === '') continue;

    const leaderBucket = leads.get(leader) ?? [];
    leaderBucket.push(attached);
    leads.set(leader, leaderBucket);

    const attachedBucket = led.get(attached) ?? [];
    attachedBucket.push(leader);
    led.set(attached, attachedBucket);
  }

  return { leads, led };
}

export function buildDatasetIndex(dataset: RawDataset): DatasetIndex {
  const leaders = buildLeaderIndex(dataset.leaders);

  const globalWargearNames = new Set<string>();
  for (const row of dataset.wargear) {
    const name = coreSlug(row.name);
    if (name !== '') globalWargearNames.add(name);
  }
  for (const row of dataset.costs) {
    const description = cleanText(row.description);
    if (!/^per\b/i.test(description)) continue;
    const name = coreSlug(description.replace(/^per\s+/i, ''));
    if (name !== '') globalWargearNames.add(name);
  }

  // Wahapedia описывает часть снаряжения (щиты, вексиллы, medi-pack, маркеры)
  // без боевого профиля — его нет ни в одном Datasheets_wargear. Но такие имена
  // легитимно упоминаются в текстах опций, поэтому собираем их отовсюду.
  for (const row of dataset.options) {
    const text = cleanText(row.description);
    if (text === '') continue;
    for (const ref of parseWeaponRefs(text, [], null).refs) {
      const name = coreSlug(ref.name);
      if (name !== '') globalWargearNames.add(name);
    }
  }

  return {
    factionsById: new Map(dataset.factions.map((faction) => [faction.id.trim(), faction])),
    datasheetsById: new Map(
      dataset.datasheets.map((datasheet) => [datasheet.id.trim(), datasheet])
    ),
    modelsByDatasheet: groupBy(dataset.models, (row) => row.datasheet_id),
    costsByDatasheet: groupBy(dataset.costs, (row) => row.datasheet_id),
    compositionByDatasheet: groupBy(dataset.composition, (row) => row.datasheet_id),
    wargearByDatasheet: groupBy(dataset.wargear, (row) => row.datasheet_id),
    optionsByDatasheet: groupBy(dataset.options, (row) => row.datasheet_id),
    abilitiesByDatasheet: groupBy(dataset.abilities, (row) => row.datasheet_id),
    keywordsByDatasheet: groupBy(dataset.keywords, (row) => row.datasheet_id),
    leadsByLeader: leaders.leads,
    leadersByAttached: leaders.led,
    abilityLibrary: buildAbilityLibrary(dataset.abilityLibrary),
    globalWargearNames,
  };
}

/** 'This model has a transport capacity of 6 Adeptus Custodes Infantry models.' */
export function parseTransport(raw: string): TransportInfo | null {
  const text = cleanText(raw);
  if (text === '') return null;

  const capacity = text.match(/transport capacity of\s+(\d+)/i);
  const restrictions = text
    .split(/(?<=\.)\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => /cannot transport|is reduced to/i.test(sentence));

  return {
    capacity: capacity ? Number.parseInt(capacity[1], 10) : null,
    description: text,
    restrictions,
  };
}

/** damaged_w '1-5' + текст правила. */
export function parseDamagedBracket(wounds: string, description: string): DamagedBracket | null {
  const text = cleanText(description);
  if (text === '' && cleanText(wounds) === '') return null;

  const bounds = parseRangeBounds(wounds);
  return { from: bounds.from, to: bounds.to, description: text };
}

export function isDatasheetVirtual(datasheet: DatasheetRow): boolean {
  return parseFlag(datasheet.virtual);
}

/** Определяет, к каким группам моделей относится фрагмент loadout. */
export function resolveLoadoutTargets(subject: string, groups: ModelGroup[]): number[] {
  const cleaned = collapseWhitespace(cleanText(subject).replace(/\([^)]*\)/g, ' '));
  if (/^(?:this model|every model|all models|this unit|the model)$/i.test(cleaned)) {
    return groups.map((_, index) => index);
  }

  const name = cleaned
    .replace(/^(?:every|each|the|all|any)\s+/i, '')
    .replace(/^\d+\s+/, '')
    .trim();

  const match = matchByName(name, groups, (group) => group.labelName, 0.8);
  return match ? [match.index] : [];
}

export interface BaseLoadoutResult {
  entries: LoadoutEntry[];
  /** Имена оружия из loadout, не найденные в каталоге. */
  unmatched: string[];
  warnings: string[];
}

/**
 * Разбирает поле loadout. Реальные форматы (проверено на выгрузке):
 *   '<b>Every model is equipped with:</b> bolt pistol; bolt rifle; close combat weapon.'   (362 даташита)
 *   '<b>This model is equipped with:</b> 2 godhammer lascannons; twin heavy bolter; …'     (1122)
 *   '<b>Every Nob is equipped with:</b> …<br><br><b>Every Boy is equipped with:</b> …'
 *   '<b>The Nob is equipped with:</b> 1 Choppa; 2 Rokkit Pistol.'
 *   '<b>Aun’Va is equipped with:</b> close combat weapon.<br><br><b>Each Ethereal Guard …'
 * Фрагменты с 'can be' — это опции (они лежат в Datasheets_options), в базовой
 * комплектации они игнорируются с предупреждением.
 */
export function parseBaseLoadout(
  datasheet: DatasheetRow,
  groups: ModelGroup[],
  catalog: WeaponGroup[],
  groupCounts: number[],
  wargearNames: Set<string> | null = null
): BaseLoadoutResult {
  const warnings: string[] = [];
  const unmatched: string[] = [];
  const entries: LoadoutEntry[] = [];

  const text = cleanText(datasheet.loadout);
  if (text === '') return { entries, unmatched, warnings };

  const statements = text
    .split(/(?<=\.)\s+/)
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '');

  for (const statement of statements) {
    if (/\bcan be\b|\bmay be\b|\bcan have\b/i.test(statement)) {
      warnings.push(`loadout содержит опцию, а не базовое снаряжение: "${statement.slice(0, 90)}"`);
      continue;
    }

    const match = statement.match(/^(.*?)\s+(?:is|are)\s+equipped with:?\s*(.+?)\.?$/i);
    if (!match) {
      warnings.push(`не разобран фрагмент loadout: "${statement.slice(0, 90)}"`);
      continue;
    }

    const targets = resolveLoadoutTargets(match[1], groups);
    if (targets.length === 0) {
      warnings.push(`не найдена модель для фрагмента loadout: "${match[1].trim()}"`);
      continue;
    }

    const parsed = parseWeaponRefs(match[2], catalog, wargearNames);
    unmatched.push(...parsed.unmatched);

    for (const groupIndex of targets) {
      const group = groups[groupIndex];
      const models = groupCounts[groupIndex] ?? group.minCount;

      for (const ref of parsed.refs) {
        entries.push({
          groupId: ref.groupId,
          name: ref.name,
          perModel: ref.count,
          count: ref.count * models,
          modelGroupId: group.id,
          source: 'base',
        });
      }
    }
  }

  return { entries: dedupeLoadoutEntries(entries, warnings), unmatched, warnings };
}

/**
 * Одно и то же оружие может упоминаться в нескольких фрагментах (например,
 * 'Every model …' и 'Every Nob …'). Складывать нельзя — получится двойной учёт,
 * поэтому берётся максимум perModel для пары (группа модели, оружие).
 */
function dedupeLoadoutEntries(entries: LoadoutEntry[], warnings: string[]): LoadoutEntry[] {
  const byKey = new Map<string, LoadoutEntry>();

  for (const entry of entries) {
    const key = `${entry.modelGroupId ?? ''}|${entry.groupId ?? entry.name}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, entry);
      continue;
    }
    if (existing.perModel !== entry.perModel) {
      warnings.push(
        `дубль оружия "${entry.name}" с разным количеством (${existing.perModel} и ${entry.perModel}) — взят максимум`
      );
    }
    if (entry.perModel > existing.perModel) {
      existing.perModel = entry.perModel;
      existing.count = entry.count;
    }
  }

  return [...byKey.values()];
}

/** Группы оружия, которые несёт конкретная модель/группа (для ModelGroup.wargear). */
export function attachGroupWargear(
  groups: ModelGroup[],
  entries: LoadoutEntry[],
  catalog: WeaponGroup[]
): void {
  for (const group of groups) {
    const names = entries
      .filter((entry) => entry.modelGroupId === group.id)
      .map((entry) => entry.name);
    group.wargear = names
      .map((name) => findWeaponGroup(catalog, name))
      .filter((weapon): weapon is WeaponGroup => weapon !== null);
  }
}

export type UnitSkipReason = 'no datasheet' | 'virtual' | 'no models' | 'no cost' | 'no model groups';

export interface ParseUnitOptions {
  /** Разбирать виртуальные даташиты (по умолчанию пропускаются). */
  includeVirtual?: boolean;
}

export type UnitParseResult = { unit: Unit } | { skip: UnitSkipReason };

function aggregatePerModel(
  groups: ModelGroup[],
  counts: number[],
  pick: (group: ModelGroup) => number | null
): number | null {
  let total = 0;
  for (let index = 0; index < groups.length; index += 1) {
    const value = pick(groups[index]);
    if (value === null) return null;
    total += value * (counts[index] ?? 0);
  }
  return total;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** Превращает строки одного даташита в доменный Unit (или сообщает причину пропуска). */
export function parseUnit(
  index: DatasetIndex,
  datasheetId: string,
  options: ParseUnitOptions = {}
): UnitParseResult {
  const datasheet = index.datasheetsById.get(datasheetId);
  if (!datasheet) return { skip: 'no datasheet' };
  if (!options.includeVirtual && isDatasheetVirtual(datasheet)) return { skip: 'virtual' };

  const modelRows = index.modelsByDatasheet.get(datasheetId) ?? [];
  if (modelRows.length === 0) return { skip: 'no models' };

  const costRows = index.costsByDatasheet.get(datasheetId) ?? [];
  if (costRows.length === 0) return { skip: 'no cost' };

  const id = datasheet.id;
  const issues = emptyIssues();

  // === Состав отряда ===
  const composition = parseCompositionLines(index.compositionByDatasheet.get(id) ?? []);
  const { groups, unmatched } = buildModelGroups(
    id,
    composition.lines,
    parseModelProfiles(modelRows)
  );
  if (groups.length === 0) return { skip: 'no model groups' };
  issues.unmatchedCompositionLabels = unmatched;
  issues.compositionAnomalies = composition.anomalies;
  issues.missingModelProfile = groups.filter((group) => group.profile === null).map((g) => g.label);

  // === Ключевые слова (в том числе по конкретным моделям) ===
  const groupedKeywords = groupKeywords(index.keywordsByDatasheet.get(id) ?? []);
  for (const group of groups) {
    if (!group.profile) continue;
    group.profile.keywords = unique([
      ...keywordsForModel(groupedKeywords, group.profile.name),
      ...keywordsForModel(groupedKeywords, group.labelName),
    ]);
  }

  // === Стоимость и размеры ===
  const cost = parseCostTable(costRows);
  const compositionMin = composition.lines.reduce((sum, line) => sum + line.minCount, 0);
  const compositionMax = composition.lines.reduce((sum, line) => sum + line.maxCount, 0);
  const baseSize = selectBaseSize(cost.sizes, compositionMin);
  const groupCounts = splitModelCounts(groups, baseSize ? baseSize.models : compositionMin);

  // === Способности ===
  const parsedAbilities = parseDatasheetAbilities(
    index.abilitiesByDatasheet.get(id) ?? [],
    index.abilityLibrary,
    datasheet.faction_id
  );
  issues.unresolvedAbilityIds = parsedAbilities.unresolvedIds;
  for (const group of groups) {
    if (!group.profile) continue;
    const profileName = group.profile.name.trim().toUpperCase();
    group.abilities = parsedAbilities.abilities.filter(
      (ability) => ability.modelName !== null && ability.modelName.trim().toUpperCase() === profileName
    );
  }

  return finishUnit({
    index,
    datasheet,
    id,
    issues,
    groups,
    compositionMin,
    compositionMax,
    cost,
    baseSize,
    groupCounts,
    groupedKeywords,
    abilities: parsedAbilities.abilities,
  });
}

interface FinishUnitInput {
  index: DatasetIndex;
  datasheet: DatasheetRow;
  id: string;
  issues: UnitParseIssues;
  groups: ModelGroup[];
  compositionMin: number;
  compositionMax: number;
  cost: ParsedCostTable;
  baseSize: UnitSize | null;
  groupCounts: number[];
  groupedKeywords: GroupedKeywords;
  abilities: Ability[];
}

/** Собирает Unit после разбора состава/стоимости/способностей. */
function finishUnit(input: FinishUnitInput): UnitParseResult {
  const {
    index,
    datasheet,
    id,
    issues,
    groups,
    compositionMin,
    compositionMax,
    cost,
    baseSize,
    groupCounts,
    groupedKeywords,
    abilities,
  } = input;

  // === Оружие и снаряжение ===
  const catalog = buildWeaponCatalog(index.wargearByDatasheet.get(id) ?? []);
  issues.unknownWeaponKeywords = catalog.unknownKeywords;

  // Снаряжение без боевого профиля живёт в блоке WARGEAR OPTIONS стоимости
  // и в глобальном реестре (все Datasheets_wargear + все 'per …'): его
  // отсутствие в каталоге профилей юнита — норма данных, а не ошибка разбора.
  const wargearNames = new Set([
    ...index.globalWargearNames,
    ...cost.table.wargearCosts.map((entry) => coreSlug(entry.weaponName)),
  ]);

  const baseLoadout = parseBaseLoadout(datasheet, groups, catalog.groups, groupCounts, wargearNames);
  attachGroupWargear(groups, baseLoadout.entries, catalog.groups);
  issues.missingBaseLoadout = baseLoadout.entries.length === 0;
  issues.warnings = [...issues.warnings, ...baseLoadout.warnings];

  const parsedOptions = parseLoadoutOptions(
    { datasheetId: id, catalog: catalog.groups, wargearNames },
    index.optionsByDatasheet.get(id) ?? []
  );
  issues.unparsedOptions = parsedOptions.unparsed;
  issues.skippedNoneOptions = parsedOptions.skippedNone;
  issues.costAnomalies = cost.anomalies;
  // В отчёт попадают только имена, которых нет ни в каталоге профилей,
  // ни в реестре снаряжения без профиля.
  issues.unmatchedWeaponNames = unique([
    ...baseLoadout.unmatched,
    ...parsedOptions.options.flatMap((option) =>
      [...option.base, ...option.choices.flatMap((choice) => choice.weapons)]
        .filter((weapon) => weapon.groupId === null)
        .map((weapon) => weapon.name)
    ),
  ]).filter((name) => !wargearNames.has(coreSlug(name)));

  const faction = index.factionsById.get(datasheet.faction_id.trim());
  if (cost.sizes.length > 0 && !cost.sizes.some((size) => size.models === compositionMax)) {
    issues.warnings.push(
      `состав допускает до ${compositionMax} моделей, но такого размера нет в стоимости`
    );
  }

  const unit: Unit = {
    id,
    name: datasheet.name,
    factionId: datasheet.faction_id,
    faction: faction ? faction.name : 'Unknown',
    sourceId: datasheet.source_id,
    legend: cleanText(datasheet.legend),
    link: datasheet.link,
    role: datasheet.role === '' ? null : cleanText(datasheet.role),
    isVirtual: isDatasheetVirtual(datasheet),
    isSupport: parseFlag(datasheet.is_support),

    modelGroups: groups,
    compositionRange: {
      minModels: compositionMin,
      maxModels: compositionMax === compositionMin ? null : compositionMax,
    },

    costTable: cost.table,
    sizes: cost.sizes,
    baseSize,
    pointsPerModel: baseSize && baseSize.models > 0 ? baseSize.points / baseSize.models : null,
    pointsForSize: (requested: number) => pointsForSize(cost.table, requested),

    totalWounds: aggregatePerModel(groups, groupCounts, (group) => group.profile?.wounds ?? null),
    totalObjectiveControl: aggregatePerModel(
      groups,
      groupCounts,
      (group) => group.profile?.objectiveControl ?? null
    ),

    abilities,
    keywords: unique([
      ...groupedKeywords.unit,
      ...groupedKeywords.allModels,
      ...Object.values(groupedKeywords.byModel).flat(),
    ]),
    factionKeywords: groupedKeywords.faction,
    keywordsByModel: groupedKeywords.byModel,

    damagedBracket: parseDamagedBracket(datasheet.damaged_w, datasheet.damaged_description),
    transport: parseTransport(datasheet.transport),
    ledByUnitIds: index.leadersByAttached.get(id) ?? [],
    leadsUnitIds: index.leadsByLeader.get(id) ?? [],

    weaponCatalog: catalog.groups,
    baseLoadout: baseLoadout.entries,
    loadoutOptions: parsedOptions.options,
    optionRestrictions: parsedOptions.restrictions,

    issues,
  };

  return { unit };
}