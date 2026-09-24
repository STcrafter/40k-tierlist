/**
 * Минимальные объявления Node builtin-модулей.
 *
 * Ядро парсера не зависит от Node (чистые функции + адаптеры), но CLI-отчёт и
 * интеграционные тесты читают CSV из public/data. В репозитории нет @types/node,
 * поэтому объявляем только то, что реально используется. Если @types/node будет
 * добавлен позже — этот файл нужно удалить.
 */

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function readdirSync(path: string): string[];
  export function existsSync(path: string): boolean;
  export function writeFileSync(path: string, data: string, encoding?: 'utf8'): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function dirname(path: string): string;
  export function basename(path: string, ext?: string): string;
}

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd(): string;
  exit(code?: number): never;
  exitCode: number | undefined;
};
