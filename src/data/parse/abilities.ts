/**
 * Разбор Datasheets_abilities + Abilities.csv.
 *
 * Колонка type в датасете содержит как «чистые» типы (Core, Faction, Datasheet,
 * Wargear, Wargear profile, Psychic, Primarch), так и русские пометки:
 *   'Special (правая колонка)', 'Fortification (левая колонка)', 'Без заголовка'.
 * Строки Core/Faction ссылаются на Abilities.csv через ability_id, причём один
 * id может встречаться несколько раз с разными faction_id — поэтому резолв идёт
 * по (id, faction_id) с откатом на первый найденный.
 */

import type { AbilityLibraryRow, DatasheetAbilityRow } from '../raw/types.ts';
import { cleanText } from '../normalize/text.ts';
import type { Ability, AbilityKind } from '../types/unit.ts';

const KIND_BY_TYPE: Record<string, AbilityKind> = {
  core: 'core',
  faction: 'faction',
  datasheet: 'datasheet',
  wargear: 'wargear',
  'wargear profile': 'wargear-profile',
  psychic: 'psychic',
  primarch: 'primarch',
};

export function abilityKind(rawType: string): AbilityKind {
  const normalized = cleanText(rawType).toLowerCase();
  const direct = KIND_BY_TYPE[normalized];
  if (direct) return direct;
  if (normalized.startsWith('special')) return 'special';
  if (normalized.startsWith('fortification')) return 'fortification';
  return 'unknown';
}

export interface AbilityLibraryIndex {
  resolve(id: string, factionId: string): AbilityLibraryRow | null;
  size: number;
}

export function buildAbilityLibrary(rows: AbilityLibraryRow[]): AbilityLibraryIndex {
  const byId = new Map<string, AbilityLibraryRow[]>();
  for (const row of rows) {
    const bucket = byId.get(row.id) ?? [];
    bucket.push(row);
    byId.set(row.id, bucket);
  }

  return {
    size: byId.size,
    resolve: (id, factionId) => {
      const bucket = byId.get(id);
      if (!bucket || bucket.length === 0) return null;
      return bucket.find((row) => row.faction_id === factionId) ?? bucket[0];
    },
  };
}

export interface ParsedAbilities {
  abilities: Ability[];
  /** ability_id, которые не нашлись в Abilities.csv. */
  unresolvedIds: string[];
}

export function parseDatasheetAbilities(
  rows: DatasheetAbilityRow[],
  library: AbilityLibraryIndex,
  factionId: string
): ParsedAbilities {
  const abilities: Ability[] = [];
  const unresolvedIds: string[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const kind = abilityKind(row.type);
    const isReferenced = row.ability_id !== '';

    let name = cleanText(row.name);
    let description = cleanText(row.description);
    let id: string | null = isReferenced ? row.ability_id : null;

    if (isReferenced && (kind === 'core' || kind === 'faction')) {
      const libraryRow = library.resolve(row.ability_id, factionId);
      if (libraryRow) {
        name = name !== '' ? name : libraryRow.name;
        description = description !== '' ? description : cleanText(libraryRow.description);
      } else {
        unresolvedIds.push(row.ability_id);
      }
    }

    if (name === '' && description === '') continue;

    const dedupeKey = `${id ?? name}|${kind}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    abilities.push({
      id,
      name,
      description,
      kind,
      rawType: row.type,
      parameter: row.parameter !== '' ? row.parameter : null,
      modelName: row.model !== '' ? row.model : null,
    });
  }

  return { abilities, unresolvedIds: [...new Set(unresolvedIds)] };
}

/** Текстовые способности (Datasheet/Wargear/…) конкретной модели по данным Wahapedia. */
export function abilityMatchesModel(ability: Ability, modelName: string): boolean {
  if (!ability.modelName) return false;
  return cleanText(ability.modelName).toLowerCase() === cleanText(modelName).toLowerCase();
}