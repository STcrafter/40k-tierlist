/**
 * Источники сырых CSV. Ядро парсера не знает про fetch/fs: ему передают
 * `RawFileSource`. Это позволяет гонять один и тот же код в браузере,
 * в Node-CLI и в тестах.
 */

import { parseCsv, toRecords } from './csv.ts';
import { RAW_FILES } from './types.ts';
import type { RawDataset, RawFileKey } from './types.ts';

export interface RawFileSource {
  read(filename: string): Promise<string>;
}

/** Источник из уже загруженных строк (тесты, моки). */
export function stringSource(files: Record<string, string>): RawFileSource {
  return {
    read: async (filename) => {
      const text = files[filename];
      if (text === undefined) throw new Error(`stringSource: файл ${filename} не задан`);
      return text;
    },
  };
}

/** Источник поверх HTTP (браузер / dev-server Vite). */
export function fetchSource(baseUrl: string): RawFileSource {
  const base = baseUrl.replace(/\/+$/, '');
  return {
    read: async (filename) => {
      const response = await fetch(`${base}/${filename}`);
      if (!response.ok) throw new Error(`HTTP ${response.status} для ${filename}`);
      return response.text();
    },
  };
}

/** Колонки каждого файла (порядок как в Wahapedia). */
const FIELDS: Record<RawFileKey, string[]> = {
  factions: ['id', 'name', 'link'],
  sources: ['id', 'name', 'type', 'edition', 'version', 'errata_date', 'errata_link'],
  datasheets: [
    'id',
    'name',
    'faction_id',
    'source_id',
    'legend',
    'role',
    'loadout',
    'transport',
    'virtual',
    'is_support',
    'leader_head',
    'leader_footer',
    'damaged_w',
    'damaged_description',
    'link',
  ],
  models: [
    'datasheet_id',
    'line',
    'name',
    'M',
    'T',
    'Sv',
    'inv_sv',
    'inv_sv_descr',
    'W',
    'Ld',
    'OC',
    'base_size',
    'base_size_descr',
  ],
  costs: ['datasheet_id', 'line', 'description', 'cost'],
  composition: ['datasheet_id', 'line', 'description'],
  wargear: [
    'datasheet_id',
    'line',
    'line_in_wargear',
    'dice',
    'name',
    'description',
    'range',
    'type',
    'A',
    'BS_WS',
    'S',
    'AP',
    'D',
  ],
  abilities: [
    'datasheet_id',
    'line',
    'ability_id',
    'model',
    'name',
    'description',
    'type',
    'parameter',
  ],
  options: ['datasheet_id', 'line', 'button', 'description'],
  abilityLibrary: ['id', 'name', 'legend', 'faction_id', 'description'],
  keywords: ['datasheet_id', 'keyword', 'model', 'is_faction_keyword'],
  leaders: ['leader_id', 'attached_id'],
  detachments: [
    'id',
    'faction_id',
    'name',
    'legend',
    'type',
    'dp',
    'force_disposition',
  ],
};

export interface FileDiagnostics {
  filename: string;
  found: boolean;
  rows: number;
  /** Колонки, ожидаемые парсером, но отсутствующие в файле. */
  missingColumns: string[];
  /** Колонки файла, которые парсер не использует (drift формата). */
  extraColumns: string[];
  error: string | null;
}

export interface RawDatasetResult {
  dataset: RawDataset;
  files: Record<string, FileDiagnostics>;
}

function projectFields<T>(records: Array<Record<string, string>>, fields: string[]): T[] {
  return records.map((record) => {
    const out: Record<string, string> = {};
    for (const field of fields) out[field] = record[field] ?? '';
    return out as unknown as T;
  });
}

/** Загружает и разбирает весь набор CSV Wahapedia. Ошибки файлов не роняют парсер. */
export async function loadRawDataset(source: RawFileSource): Promise<RawDatasetResult> {
  const dataset = {} as RawDataset;
  const files: Record<string, FileDiagnostics> = {};

  for (const { key, filename } of RAW_FILES) {
    const expected = FIELDS[key];
    try {
      const text = await source.read(filename);
      const table = parseCsv(text);
      const headerColumns = table.header.filter((name) => name !== '');
      const records = toRecords(table);

      const byKey = dataset as unknown as Record<string, unknown>;
      byKey[key] = projectFields(records, expected);
      files[filename] = {
        filename,
        found: true,
        rows: records.length,
        missingColumns: expected.filter((name) => !headerColumns.includes(name)),
        extraColumns: headerColumns.filter((name) => !expected.includes(name)),
        error: null,
      };
    } catch (error) {
      (dataset as unknown as Record<string, unknown>)[key] = [];
      files[filename] = {
        filename,
        found: false,
        rows: 0,
        missingColumns: expected,
        extraColumns: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return { dataset, files };
}

export const RAW_FIELD_NAMES = FIELDS;
