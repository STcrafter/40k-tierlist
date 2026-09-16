// src/data/loader.ts

import { parseCSV } from './csv-parser';
import {
  WahapediaFaction,
  WahapediaSource,
  WahapediaDatasheet,
  WahapediaModel,
  WahapediaWargear,
  WahapediaAbility,
  WahapediaKeyword,
  WahapediaCost,
  WahapediaStratagem,
  WahapediaDetachment,
  WahapediaData,
} from './types/wahapedia';

const FILES: { key: keyof WahapediaData; filename: string }[] = [
  { key: 'factions', filename: 'Factions.csv' },
  { key: 'sources', filename: 'Source.csv' },
  { key: 'datasheets', filename: 'Datasheets.csv' },
  { key: 'models', filename: 'Datasheets_models.csv' },
  { key: 'wargear', filename: 'Datasheets_wargear.csv' },
  { key: 'abilities', filename: 'Datasheets_abilities.csv' },
  { key: 'keywords', filename: 'Datasheets_keywords.csv' },
  { key: 'costs', filename: 'Datasheets_models_cost.csv' },
  { key: 'stratagems', filename: 'Stratagems.csv' },
  { key: 'detachments', filename: 'Detachments.csv' },
  { key: 'options', filename: 'Datasheets_options.csv' },
  { key: 'composition', filename: 'Datasheets_unit_composition.csv' },
];

/**
 * Загружает все CSV файлы Wahapedia из указанной папки
 */
export async function loadWahapediaData(basePath: string): Promise<WahapediaData> {
  const data: Partial<WahapediaData> = {};
  const errors: string[] = [];

  await Promise.all(
    FILES.map(async ({ key, filename }) => {
      try {
        const response = await fetch(`${basePath}/${filename}`);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const text = await response.text();
        (data as any)[key] = parseCSV(text);
        console.log(`✓ ${filename}: ${(data as any)[key].length} записей`);
      } catch (error) {
        const message = `✗ ${filename}: ${(error as Error).message}`;
        console.warn(message);
        errors.push(message);
        (data as any)[key] = [];
      }
    })
  );

  if (errors.length > 0) {
    console.warn(
      `Не удалось загрузить ${errors.length} файлов, используем пустые данные`
    );
  }

  return data as WahapediaData;
}

/**
 * Загружает данные из строки (для тестирования/моков)
 */
export function loadWahapediaFromStrings(
  sources: Record<string, string>
): WahapediaData {
  const data: Partial<WahapediaData> = {};

  FILES.forEach(({ key, filename }) => {
    if (sources[filename]) {
      (data as any)[key] = parseCSV(sources[filename]);
    } else {
      (data as any)[key] = [];
    }
  });

  return data as WahapediaData;
}