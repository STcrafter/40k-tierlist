/**
 * Публичный API слоя данных.
 *
 * Ядро не зависит от среды: `fetchSource` (браузер/Vite) или `fsSource`
 * (Node, импортируется напрямую из raw/node-source.ts, чтобы не тянуть node:fs
 * в бандл браузера).
 */

// Сырой слой
export { parseCsv, toRecords, parseCsvRecords, stripBom } from './raw/csv.ts';
export type { CsvTable } from './raw/csv.ts';
export { loadRawDataset, fetchSource, stringSource, RAW_FIELD_NAMES } from './raw/source.ts';
export type { FileDiagnostics, RawDatasetResult, RawFileSource } from './raw/source.ts';
export * from './raw/types.ts';

// Домен
export * from './types/unit.ts';
export * from './types/loadout.ts';

// Разбор
export { loadUnitsFromSource, parseUnitsFromDataset, parseUnitsFromRaw } from './parse/units.ts';
export type { ParseUnitsOptions, ParseUnitsResult } from './parse/units.ts';
export {
  buildDatasetIndex,
  parseUnit,
  parseTransport,
  parseDamagedBracket,
  parseBaseLoadout,
  resolveLoadoutTargets,
} from './parse/unit.ts';
export type {
  BaseLoadoutResult,
  DatasetIndex,
  ParseUnitOptions,
  UnitParseResult,
  UnitSkipReason,
} from './parse/unit.ts';
export {
  parseLoadoutOptions,
  matchScope,
  buildOption,
  parseAction,
  parseWeaponRefs,
  parseDuplicateLimit,
  extractListItems,
} from './parse/options.ts';
export type {
  BuildOptionInput,
  BuildOptionResult,
  OptionParseContext,
  ParsedOptionsResult,
  ScopeMatch,
} from './parse/options.ts';
export {
  buildWeaponCatalog,
  parseWeaponProfile,
  parseWeaponKeywords,
  splitWeaponName,
  findWeaponGroup,
  WEAPON_KEYWORDS,
} from './parse/weapons.ts';
export type { WeaponCatalogResult } from './parse/weapons.ts';
export { parseCostTable, pointsForSize, selectBaseSize } from './parse/costs.ts';
export type { ParsedCostTable } from './parse/costs.ts';
export { parseCompositionLines, buildModelGroups, splitModelCounts } from './parse/composition.ts';
export type { BuildModelGroupsResult, CompositionLine, ParsedComposition } from './parse/composition.ts';
export { parseModelProfile, parseModelProfiles, groupKeywords, keywordsForModel } from './parse/stats.ts';
export type { GroupedKeywords } from './parse/stats.ts';
export { buildAbilityLibrary, parseDatasheetAbilities, abilityKind } from './parse/abilities.ts';
export { createReportAccumulator, finalizeReport } from './parse/report.ts';
export type { ParseReport, ReportAccumulator } from './parse/report.ts';

// Снаряжение
export {
  applyLoadout,
  resolveOptionCapacity,
  resolveOptionScopeGroup,
  isOptionAvailable,
  effectiveDuplicateLimit,
} from './loadout/apply.ts';
export type { AppliedLoadout } from './loadout/apply.ts';
export {
  enumerateLoadouts,
  iterateLoadouts,
  defaultConfiguration,
  optimizeLoadout,
  optionSelectionSpace,
  configurationKey,
} from './loadout/enumerate.ts';
export type { EnumerateOptions, OptionSpace } from './loadout/enumerate.ts';

// Утилиты сопоставления имён (нужны потребителям данных)
export { matchByName, scoreNameMatch, nameVariants, coreSlug, singularize } from './normalize/match.ts';
export { cleanText, stripHtml, slug, parseCountWord, stripDashTail } from './normalize/text.ts';
export { diceMean, parseDice, parseSave, parseSkill, parseRange } from './normalize/numbers.ts';
export type { DiceExpr, WeaponRange } from './normalize/numbers.ts';