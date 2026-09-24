/**
 * Сырой слой: типы строк CSV Wahapedia 1:1 с колонками файлов.
 *
 * Все значения — строки (в том числе булевы: 'true' | 'false' | '').
 * Нормализация (числа, булевы, HTML) выполняется в слое parse/*.
 *
 * Колонка `id` кратко: каждый файл Wahapedia заканчивается символом '|',
 * поэтому у таблицы есть «хвостовая» пустая колонка — она отбрасывается
 * ридером (см. raw/csv.ts).
 */

export type RawBool = 'true' | 'false' | '';

export interface FactionRow {
  id: string;
  name: string;
  link: string;
}

export interface SourceRow {
  id: string;
  name: string;
  type: string;
  edition: string;
  version: string;
  errata_date: string;
  errata_link: string;
}

export interface DatasheetRow {
  id: string;
  name: string;
  faction_id: string;
  source_id: string;
  legend: string;
  role: string;
  loadout: string;
  transport: string;
  virtual: RawBool;
  is_support: RawBool;
  leader_head: string;
  leader_footer: string;
  damaged_w: string;
  damaged_description: string;
  link: string;
}

export interface ModelRow {
  datasheet_id: string;
  line: string;
  name: string;
  M: string;
  T: string;
  Sv: string;
  inv_sv: string;
  inv_sv_descr: string;
  W: string;
  Ld: string;
  OC: string;
  base_size: string;
  base_size_descr: string;
}

export interface ModelCostRow {
  datasheet_id: string;
  line: string;
  description: string;
  cost: string;
}

export interface CompositionRow {
  datasheet_id: string;
  line: string;
  description: string;
}

export interface WargearRow {
  datasheet_id: string;
  line: string;
  line_in_wargear: string;
  dice: string;
  name: string;
  description: string;
  range: string;
  type: string;
  A: string;
  BS_WS: string;
  S: string;
  AP: string;
  D: string;
}

export interface DatasheetAbilityRow {
  datasheet_id: string;
  line: string;
  ability_id: string;
  model: string;
  name: string;
  description: string;
  type: string;
  parameter: string;
}

export interface AbilityLibraryRow {
  id: string;
  name: string;
  legend: string;
  faction_id: string;
  description: string;
}

export interface OptionRow {
  datasheet_id: string;
  line: string;
  button: string;
  description: string;
}

export interface KeywordRow {
  datasheet_id: string;
  keyword: string;
  model: string;
  is_faction_keyword: RawBool;
}

export interface LeaderRow {
  leader_id: string;
  attached_id: string;
}

export interface DetachmentRow {
  id: string;
  faction_id: string;
  name: string;
  legend: string;
  type: string;
  dp: string;
  force_disposition: string;
}

/** Все файлы, которые загружает парсер (в порядке объявления). */
export interface RawDataset {
  factions: FactionRow[];
  sources: SourceRow[];
  datasheets: DatasheetRow[];
  models: ModelRow[];
  costs: ModelCostRow[];
  composition: CompositionRow[];
  wargear: WargearRow[];
  options: OptionRow[];
  abilities: DatasheetAbilityRow[];
  abilityLibrary: AbilityLibraryRow[];
  keywords: KeywordRow[];
  leaders: LeaderRow[];
  detachments: DetachmentRow[];
}

export type RawFileKey = keyof RawDataset;

/** Соответствие «ключ датасета → имя файла Wahapedia». */
export const RAW_FILES: ReadonlyArray<{ key: RawFileKey; filename: string }> = [
  { key: 'factions', filename: 'Factions.csv' },
  { key: 'sources', filename: 'Source.csv' },
  { key: 'datasheets', filename: 'Datasheets.csv' },
  { key: 'models', filename: 'Datasheets_models.csv' },
  { key: 'costs', filename: 'Datasheets_models_cost.csv' },
  { key: 'composition', filename: 'Datasheets_unit_composition.csv' },
  { key: 'wargear', filename: 'Datasheets_wargear.csv' },
  { key: 'options', filename: 'Datasheets_options.csv' },
  { key: 'abilities', filename: 'Datasheets_abilities.csv' },
  { key: 'abilityLibrary', filename: 'Abilities.csv' },
  { key: 'keywords', filename: 'Datasheets_keywords.csv' },
  { key: 'leaders', filename: 'Datasheets_leader.csv' },
  { key: 'detachments', filename: 'Detachments.csv' },
];

/** Файл сырых данных: имя → текст. */
export interface RawFiles {
  [filename: string]: string;
}
