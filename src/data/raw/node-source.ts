/**
 * Node-адаптер источника данных (используется CLI-скриптами и тестами).
 * Вынесен отдельно, чтобы ядро парсера оставалось свободным от зависимостей
 * на Node builtins и работало в браузере.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RawFileSource } from './source.ts';

export function fsSource(directory: string): RawFileSource {
  return {
    read: async (filename) => readFileSync(join(directory, filename), 'utf8'),
  };
}
