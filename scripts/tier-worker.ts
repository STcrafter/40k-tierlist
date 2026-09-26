/**
 * Дочерний процесс сборки тирлиста.
 *
 * Считает порученные ему комбинации «парадигма × режим» и/или sensitivity.
 * Запускается из build-tierlist.ts через child_process.fork, разбор аргументов
 * — тем же `--ключ=значение`, что и у главного скрипта.
 *
 * Почему отдельный процесс, а не worker_threads: воркеру всё равно нужен свой
 * разбор BSData, а отдельный процесс изолирован по памяти — при 6 параллельных
 * копиях базы это существенно, и заодно страхует от падения одного воркера.
 *
 * Результаты уходят по IPC уже обрезанными (см. prepare-units.ts): полные
 * TierRow по всем 12 комбинациям не поместились бы в канал разумного размера.
 */

import { ARCHETYPES } from '../src/combat/archetypes.ts';
import { sensitivityAnalysis, tierList, type CombatMode, type TargetParadigm } from '../src/tier/scoring.ts';
import {
  attachedEntriesOf,
  prepareUnits,
  trimAttached,
  trimRow,
  type AttachedPayload,
  type TrimmedRow,
} from './prepare-units.ts';

export interface ComboJob {
  kind: 'combo';
  paradigm: TargetParadigm;
  mode: CombatMode;
}

export interface SensitivityJob {
  kind: 'sensitivity';
}

export type TierJob = ComboJob | SensitivityJob;

/** Ответ воркера по одной комбинации. */
export interface ComboResult {
  kind: 'combo';
  paradigm: TargetParadigm;
  mode: CombatMode;
  rows: TrimmedRow[];
  attached: AttachedPayload[];
  elapsedMs: number;
}

/** Ответ воркера по sensitivity — та же сводка, что уходит в payload. */
export type SensitivitySummary = {
  spread: number;
  high: boolean;
  medium: boolean;
  tierChangeProbability: number;
};

export interface SensitivityResult {
  kind: 'sensitivity';
  /** Готовится в главном процессе: Map не пересылается по IPC без потерь. */
  entries: Array<[string, SensitivitySummary]>;
  high: number;
  size: number;
  elapsedMs: number;
}

export type TierWorkerResult = ComboResult | SensitivityResult;

const argv = process.argv.slice(2);
const flagValue = (name: string): string | null => {
  const found = argv.find((arg) => arg.startsWith(`--${name}=`));
  return found === undefined ? null : found.slice(name.length + 3);
};

const bsDataDir = flagValue('bs-data') ?? 'public/BSData/wh40k-11e';
const trials = Number(flagValue('trials') ?? 40);
const distance = Number(flagValue('distance') ?? 12);
const jobs = JSON.parse(flagValue('jobs') ?? '[]') as TierJob[];

const preparedStarted = Date.now();
const { prepared, leaders } = prepareUnits(bsDataDir);
const preparedMs = Date.now() - preparedStarted;

// Пары «юнит + лидер» строятся один раз на процесс и переиспользуются всеми
// комбинациями этого воркера: это самая дорогая часть подготовки.
const attachedEntries = attachedEntriesOf(prepared, leaders);

/**
 * Пониженные прогоны для вкладки с лидерами.
 *
 * Так было и до распараллеливания: пар «юнит + лидер» в разы больше, чем
 * обычных юнитов, а вкладка эта справочная, поэтому точность ей не нужна.
 */
const attachedOptions = {
  combat: { trials: Math.min(trials, 4), distance },
  survival: { trials: Math.min(trials, 3), maxRounds: 8, distance },
  archetypes: ARCHETYPES,
};

for (const job of jobs) {
  if (job.kind === 'sensitivity') {
    const started = Date.now();
    const report = sensitivityAnalysis(prepared, {
      mode: 'combined',
      targetParadigm: 'all',
      combat: { trials, distance },
      survival: { trials, maxRounds: 15, distance },
      archetypes: ARCHETYPES,
    });
    const entries: Array<[string, SensitivitySummary]> = [...report.entries()].map(
      ([id, item]) => [
        id,
        {
          spread: item.spread,
          high: item.high,
          medium: item.medium,
          tierChangeProbability: item.tierChangeProbability,
        },
      ]
    );
    const high = entries.filter(([, item]) => item.high).length;
    const result: SensitivityResult = {
      kind: 'sensitivity',
      entries,
      high,
      size: report.size,
      elapsedMs: Date.now() - started,
    };
    process.send?.({ preparedMs, result });
    continue;
  }

  const started = Date.now();
  const rows = tierList(prepared, {
    mode: job.mode,
    targetParadigm: job.paradigm,
    combat: { trials, distance },
    survival: { trials, maxRounds: 15, distance },
    archetypes: ARCHETYPES,
  });
  const attachedRows = tierList(attachedEntries, { mode: job.mode, targetParadigm: job.paradigm, ...attachedOptions });
  const result: ComboResult = {
    kind: 'combo',
    paradigm: job.paradigm,
    mode: job.mode,
    rows: rows.map(trimRow),
    attached: trimAttached(attachedRows, prepared, leaders),
    elapsedMs: Date.now() - started,
  };
  process.send?.({ preparedMs, result });
}
