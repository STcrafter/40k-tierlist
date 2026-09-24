/**
 * Отчёт о качестве разбора.
 *
 * Смысл: парсер не «молча угадывает», а собирает метрики покрытия и примеры
 * проблем, чтобы по отчёту можно было дорабатывать форматы, а тесты — падать
 * при регрессии. Отчёт используется CLI-скриптом (scripts/parse-report.ts).
 */

import type { FileDiagnostics } from '../raw/source.ts';
import type { Unit } from '../types/unit.ts';

export interface ParseReport {
  files: Record<string, FileDiagnostics>;
  datasheets: {
    total: number;
    parsed: number;
    skipped: Array<{ reason: string; count: number; examples: string[] }>;
  };
  composition: {
    anomalousLines: number;
    unmatchedLabels: Array<{ datasheetId: string; label: string }>;
    anomalies: Array<{ datasheetId: string; line: number; description: string }>;
  };
  options: {
    total: number;
    parsed: number;
    unparsed: number;
    skippedNone: number;
    byFamily: Record<string, number>;
    unparsedSamples: Array<{ datasheetId: string; line: number; raw: string; reason: string }>;
  };
  weapons: {
    groups: number;
    profiles: number;
    unknownKeywords: string[];
    unmatchedNames: Array<{ datasheetId: string; name: string }>;
  };
  abilities: { total: number; unresolvedIds: string[] };
  costs: {
    unitsWithAnomalies: number;
    anomalies: Array<{ datasheetId: string; line: number; description: string; cost: string }>;
  };
  loadout: {
    unitsWithoutBaseLoadout: number;
    unitsWithoutBaseLoadoutSamples: string[];
    unitsWithWarnings: number;
    warningSamples: Array<{ datasheetId: string; warning: string }>;
  };
  coverage: {
    unitsWithOptions: number;
    unitsWithMultipleModelGroups: number;
    unitsWithDamagedBracket: number;
    unitsWithTransport: number;
    unitsWithLeaderLinks: number;
    averageOptionsPerUnit: number;
    averageBaseLoadoutEntries: number;
  };
  sampleLimit: number;
}

export interface ReportAccumulator {
  files: Record<string, FileDiagnostics>;
  sampleLimit: number;
  skipped: Array<{ id: string; name: string; reason: string }>;
  unparsedOptions: Array<{ datasheetId: string; line: number; raw: string; reason: string }>;
  optionsTotal: number;
  optionsParsed: number;
  optionsSkippedNone: number;
  optionsByFamily: Record<string, number>;
  compositionAnomalies: Array<{ datasheetId: string; line: number; description: string }>;
  unmatchedLabels: Array<{ datasheetId: string; label: string }>;
  weaponGroups: number;
  weaponProfiles: number;
  unknownKeywords: Map<string, number>;
  unmatchedWeapons: Array<{ datasheetId: string; name: string }>;
  abilitiesTotal: number;
  unresolvedAbilities: Map<string, number>;
  costAnomalies: Array<{ datasheetId: string; line: number; description: string; cost: string }>;
  costUnitsWithAnomalies: Set<string>;
  unitsWithoutBaseLoadout: string[];
  unitsWithWarnings: number;
  warningSamples: Array<{ datasheetId: string; warning: string }>;
  parsed: number;
  unitsWithOptions: number;
  unitsWithMultipleModelGroups: number;
  unitsWithDamagedBracket: number;
  unitsWithTransport: number;
  unitsWithLeaderLinks: number;
  totalOptionsOnUnits: number;
  totalBaseLoadoutEntries: number;
}

export function createReportAccumulator(
  files: Record<string, FileDiagnostics> = {},
  sampleLimit = 5
): ReportAccumulator {
  return {
    files,
    sampleLimit,
    skipped: [],
    unparsedOptions: [],
    optionsTotal: 0,
    optionsParsed: 0,
    optionsSkippedNone: 0,
    optionsByFamily: {},
    compositionAnomalies: [],
    unmatchedLabels: [],
    weaponGroups: 0,
    weaponProfiles: 0,
    unknownKeywords: new Map(),
    unmatchedWeapons: [],
    abilitiesTotal: 0,
    unresolvedAbilities: new Map(),
    costAnomalies: [],
    costUnitsWithAnomalies: new Set(),
    unitsWithoutBaseLoadout: [],
    unitsWithWarnings: 0,
    warningSamples: [],
    parsed: 0,
    unitsWithOptions: 0,
    unitsWithMultipleModelGroups: 0,
    unitsWithDamagedBracket: 0,
    unitsWithTransport: 0,
    unitsWithLeaderLinks: 0,
    totalOptionsOnUnits: 0,
    totalBaseLoadoutEntries: 0,
  };
}

export function recordSkipped(
  accumulator: ReportAccumulator,
  datasheet: { id: string; name: string },
  reason: string
): void {
  accumulator.skipped.push({ id: datasheet.id, name: datasheet.name, reason });
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

export function accumulateUnit(accumulator: ReportAccumulator, unit: Unit): void {
  accumulator.parsed += 1;

  for (const anomaly of unit.issues.compositionAnomalies) {
    accumulator.compositionAnomalies.push({ datasheetId: unit.id, ...anomaly });
  }
  for (const label of unit.issues.unmatchedCompositionLabels) {
    accumulator.unmatchedLabels.push({ datasheetId: unit.id, label });
  }
  for (const anomaly of unit.issues.costAnomalies) {
    accumulator.costAnomalies.push({ datasheetId: unit.id, ...anomaly });
    accumulator.costUnitsWithAnomalies.add(unit.id);
  }

  accumulator.optionsTotal +=
    unit.loadoutOptions.length +
    unit.issues.unparsedOptions.length +
    unit.issues.skippedNoneOptions;
  accumulator.optionsParsed += unit.loadoutOptions.length;
  accumulator.optionsSkippedNone += unit.issues.skippedNoneOptions;
  for (const option of unit.loadoutOptions) {
    accumulator.optionsByFamily[option.family] =
      (accumulator.optionsByFamily[option.family] ?? 0) + 1;
  }
  for (const unparsed of unit.issues.unparsedOptions) {
    if (accumulator.unparsedOptions.length < accumulator.sampleLimit * 40) {
      accumulator.unparsedOptions.push({ datasheetId: unit.id, ...unparsed });
    }
  }

  accumulator.weaponGroups += unit.weaponCatalog.length;
  accumulator.weaponProfiles += unit.weaponCatalog.reduce(
    (sum, group) => sum + group.profiles.length,
    0
  );
  for (const keyword of unit.issues.unknownWeaponKeywords) bump(accumulator.unknownKeywords, keyword);
  for (const name of unit.issues.unmatchedWeaponNames) {
    accumulator.unmatchedWeapons.push({ datasheetId: unit.id, name });
  }

  accumulator.abilitiesTotal += unit.abilities.length;
  for (const abilityId of unit.issues.unresolvedAbilityIds) {
    bump(accumulator.unresolvedAbilities, abilityId);
  }

  if (unit.issues.missingBaseLoadout) accumulator.unitsWithoutBaseLoadout.push(unit.id);
  if (unit.issues.warnings.length > 0) {
    accumulator.unitsWithWarnings += 1;
    for (const warning of unit.issues.warnings.slice(0, 2)) {
      accumulator.warningSamples.push({ datasheetId: unit.id, warning });
    }
  }

  if (unit.loadoutOptions.length > 0) accumulator.unitsWithOptions += 1;
  if (unit.modelGroups.length > 1) accumulator.unitsWithMultipleModelGroups += 1;
  if (unit.damagedBracket) accumulator.unitsWithDamagedBracket += 1;
  if (unit.transport) accumulator.unitsWithTransport += 1;
  if (unit.leadsUnitIds.length > 0 || unit.ledByUnitIds.length > 0) {
    accumulator.unitsWithLeaderLinks += 1;
  }

  accumulator.totalOptionsOnUnits += unit.loadoutOptions.length;
  accumulator.totalBaseLoadoutEntries += unit.baseLoadout.length;
}

export function finalizeReport(
  accumulator: ReportAccumulator,
  datasheetTotal: number
): ParseReport {
  const skippedByReason = new Map<string, { count: number; examples: string[] }>();
  for (const skip of accumulator.skipped) {
    const bucket = skippedByReason.get(skip.reason) ?? { count: 0, examples: [] };
    bucket.count += 1;
    if (bucket.examples.length < accumulator.sampleLimit) {
      bucket.examples.push(`${skip.id} ${skip.name}`);
    }
    skippedByReason.set(skip.reason, bucket);
  }

  const parsed = accumulator.parsed;

  return {
    files: accumulator.files,
    datasheets: {
      total: datasheetTotal,
      parsed,
      skipped: [...skippedByReason.entries()]
        .map(([reason, bucket]) => ({ reason, count: bucket.count, examples: bucket.examples }))
        .sort((a, b) => b.count - a.count),
    },
    composition: {
      anomalousLines: accumulator.compositionAnomalies.length,
      unmatchedLabels: accumulator.unmatchedLabels,
      anomalies: accumulator.compositionAnomalies,
    },
    options: {
      total: accumulator.optionsTotal,
      parsed: accumulator.optionsParsed,
      unparsed: accumulator.optionsTotal - accumulator.optionsParsed - accumulator.optionsSkippedNone,
      skippedNone: accumulator.optionsSkippedNone,
      byFamily: accumulator.optionsByFamily,
      unparsedSamples: accumulator.unparsedOptions,
    },
    weapons: {
      groups: accumulator.weaponGroups,
      profiles: accumulator.weaponProfiles,
      unknownKeywords: [...accumulator.unknownKeywords.keys()].sort(),
      unmatchedNames: accumulator.unmatchedWeapons,
    },
    abilities: {
      total: accumulator.abilitiesTotal,
      unresolvedIds: [...accumulator.unresolvedAbilities.keys()].sort(),
    },
    costs: {
      unitsWithAnomalies: accumulator.costUnitsWithAnomalies.size,
      anomalies: accumulator.costAnomalies,
    },
    loadout: {
      unitsWithoutBaseLoadout: accumulator.unitsWithoutBaseLoadout.length,
      unitsWithoutBaseLoadoutSamples: accumulator.unitsWithoutBaseLoadout.slice(
        0,
        accumulator.sampleLimit
      ),
      unitsWithWarnings: accumulator.unitsWithWarnings,
      warningSamples: accumulator.warningSamples.slice(0, accumulator.sampleLimit * 4),
    },
    coverage: {
      unitsWithOptions: accumulator.unitsWithOptions,
      unitsWithMultipleModelGroups: accumulator.unitsWithMultipleModelGroups,
      unitsWithDamagedBracket: accumulator.unitsWithDamagedBracket,
      unitsWithTransport: accumulator.unitsWithTransport,
      unitsWithLeaderLinks: accumulator.unitsWithLeaderLinks,
      averageOptionsPerUnit: parsed === 0 ? 0 : accumulator.totalOptionsOnUnits / parsed,
      averageBaseLoadoutEntries: parsed === 0 ? 0 : accumulator.totalBaseLoadoutEntries / parsed,
    },
    sampleLimit: accumulator.sampleLimit,
  };
}