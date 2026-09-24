/**
 * Адаптеры источника данных BSData: файловая система (CLI/тесты) и HTTP (браузер).
 * Ядро парсера работает с массивом { name, text } и не зависит от источника.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BsFileInput } from './load.ts';

/** Читает все .json каталоги из папки (порядок файлов детерминирован). */
export function bsFilesFromDir(directory: string): BsFileInput[] {
  return readdirSync(directory)
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(directory, name), 'utf8') }));
}

/** Загружает каталоги по списку URL (для браузера/статического хостинга). */
export async function bsFilesFromUrls(baseUrl: string, names: string[]): Promise<BsFileInput[]> {
  const files: BsFileInput[] = [];
  for (const name of names) {
    const response = await fetch(`${baseUrl}/${encodeURIComponent(name)}`);
    if (!response.ok) continue;
    files.push({ name, text: await response.text() });
  }
  return files;
}