/**
 * Разбор строк Datasheets_models (+ ключевые слова моделей).
 *
 * Важно: порядок строк в Datasheets_models НЕ совпадает с порядком строк состава
 * отряда в Datasheets_unit_composition (например, для 000000016 состав идёт
 * «Nob, затем Boy», а модели — «Boy, затем Nob»). Поэтому сопоставление
 * выполняется по имени (см. normalize/match.ts), а не по колонке line.
 */

import type { KeywordRow, ModelRow } from '../raw/types.ts';
import { parseIntOrNull, parseMovement, parseSave } from '../normalize/numbers.ts';
import type { ModelProfile } from '../types/unit.ts';

export function parseModelProfile(row: ModelRow): ModelProfile {
  return {
    id: `${row.datasheet_id}:model:${row.line}`,
    line: parseIntOrNull(row.line) ?? 0,
    name: row.name,
    movement: parseMovement(row.M),
    movementRaw: row.M,
    toughness: parseIntOrNull(row.T),
    save: parseSave(row.Sv),
    invulnerableSave: parseSave(row.inv_sv),
    invulnerableSaveDescription: row.inv_sv_descr || null,
    wounds: parseIntOrNull(row.W),
    leadership: parseSave(row.Ld),
    objectiveControl: parseIntOrNull(row.OC),
    baseSize: row.base_size || null,
    baseSizeDescription: row.base_size_descr || null,
    keywords: [],
  };
}

export function parseModelProfiles(rows: ModelRow[]): ModelProfile[] {
  return rows.map(parseModelProfile);
}

/** Значение колонки model, означающее «ключевое слово относится ко всем моделям». */
export const ALL_MODELS = 'ALL MODELS';

export interface GroupedKeywords {
  /** Ключевые слова отряда (строки с пустой колонкой model). */
  unit: string[];
  /** Ключевые слова, помеченные как относящиеся ко всем моделям. */
  allModels: string[];
  /** Ключевые слова отдельных моделей: 'AUN’VA' → [...]. */
  byModel: Record<string, string[]>;
  /** Все faction-ключевые слова отряда. */
  faction: string[];
}

export function groupKeywords(rows: KeywordRow[]): GroupedKeywords {
  const unit: string[] = [];
  const allModels: string[] = [];
  const faction: string[] = [];
  const byModel: Record<string, string[]> = {};

  for (const row of rows) {
    const keyword = row.keyword;
    if (!keyword) continue;
    const isFaction = row.is_faction_keyword === 'true';

    if (row.model === '') {
      unit.push(keyword);
      if (isFaction) faction.push(keyword);
      continue;
    }
    if (row.model.toUpperCase() === ALL_MODELS) {
      allModels.push(keyword);
      if (isFaction) faction.push(keyword);
      continue;
    }
    const bucket = byModel[row.model] ?? (byModel[row.model] = []);
    bucket.push(keyword);
    if (isFaction) faction.push(keyword);
  }

  return {
    unit: unique(unit),
    allModels: unique(allModels),
    byModel,
    faction: unique(faction),
  };
}

/** Полный набор ключевых слов для конкретной модели (с учётом ALL MODELS и отряда). */
export function keywordsForModel(
  grouped: GroupedKeywords,
  modelName: string,
  includeUnitKeywords = false
): string[] {
  const exact = grouped.byModel[modelName] ?? [];
  const normalized = modelName.trim().toUpperCase();
  const loose = Object.entries(grouped.byModel)
    .filter(([name]) => name.trim().toUpperCase() === normalized)
    .flatMap(([, keywords]) => keywords);

  const result = [...exact, ...loose, ...grouped.allModels];
  return unique(includeUnitKeywords ? [...result, ...grouped.unit] : result);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}