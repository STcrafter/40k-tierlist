/**
 * Конвейер верхнего уровня: сырые CSV → Unit[] + отчёт о качестве разбора.
 *
 * Пример:
 *   const { units, report } = await loadUnitsFromSource(fsSource('public/data/wahapedia'));
 *   const unit = units.find((u) => u.name === 'Nobz');
 *   const loadout = applyLoadout(unit, 10, []);
 */

import { loadRawDataset } from '../raw/source.ts';
import type { FileDiagnostics, RawDatasetResult, RawFileSource } from '../raw/source.ts';
import type { RawDataset } from '../raw/types.ts';
import { accumulateUnit, createReportAccumulator, finalizeReport, recordSkipped } from './report.ts';
import type { ParseReport } from './report.ts';
import { buildDatasetIndex, parseUnit } from './unit.ts';
import type { DatasetIndex, ParseUnitOptions } from './unit.ts';
import type { Unit } from '../types/unit.ts';

export interface ParseUnitsOptions extends ParseUnitOptions {
  /** Сколько примеров проблем складывать в отчёт (по умолчанию 5). */
  sampleLimit?: number;
}

export interface ParseUnitsResult {
  units: Unit[];
  byId: Map<string, Unit>;
  index: DatasetIndex;
  report: ParseReport;
}

export function parseUnitsFromDataset(
  dataset: RawDataset,
  files: Record<string, FileDiagnostics> = {},
  options: ParseUnitsOptions = {}
): ParseUnitsResult {
  const index = buildDatasetIndex(dataset);
  const accumulator = createReportAccumulator(files, options.sampleLimit ?? 5);
  const units: Unit[] = [];

  for (const datasheet of dataset.datasheets) {
    const result = parseUnit(index, datasheet.id.trim(), options);

    if ('unit' in result) {
      units.push(result.unit);
      accumulateUnit(accumulator, result.unit);
    } else {
      recordSkipped(accumulator, datasheet, result.skip);
    }
  }

  return {
    units,
    byId: new Map(units.map((unit) => [unit.id, unit])),
    index,
    report: finalizeReport(accumulator, dataset.datasheets.length),
  };
}

export function parseUnitsFromRaw(
  raw: RawDatasetResult,
  options: ParseUnitsOptions = {}
): ParseUnitsResult {
  return parseUnitsFromDataset(raw.dataset, raw.files, options);
}

export async function loadUnitsFromSource(
  source: RawFileSource,
  options: ParseUnitsOptions = {}
): Promise<ParseUnitsResult> {
  const raw = await loadRawDataset(source);
  return parseUnitsFromRaw(raw, options);
}