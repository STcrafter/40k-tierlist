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

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}

declare module 'node:os' {
  export function cpus(): Array<{ model: string; speed: number }>;
}

declare module 'node:child_process' {
  /**
   * Дочерний процесс с IPC-каналом. Объявлен минимально: сборщику нужен только
   * запуск воркера и подписка на сообщения/выход.
   */
  export interface ChildProcess {
    send?(message: unknown): boolean;
    /** Тип сообщения выводится из подписи слушателя на месте вызова. */
    on<T>(event: 'message', listener: (message: T) => void): ChildProcess;
    on(event: 'error', listener: (error: Error) => void): ChildProcess;
    on(event: 'exit', listener: (code: number | null) => void): ChildProcess;
    kill(signal?: string): boolean;
  }
  export function fork(
    modulePath: string,
    args?: string[],
    options?: { stdio?: unknown[] }
  ): ChildProcess;
}

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd(): string;
  exit(code?: number): never;
  exitCode: number | undefined;
  /** Присутствует только у процессов, запущенных с IPC-каналом. */
  send?(message: unknown): boolean;
};
