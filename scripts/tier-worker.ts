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
import {
  resetSimulationCounters,
  simulationCounters,
  type SimulationCounters,
} from '../src/combat/counters.ts';
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

/**
 * Ответ воркера целиком: счётчики идут рядом с результатом, а не внутрь него.
 *
 * Счётчики живут в памяти процесса, поэтому наверх они уезжают отдельным
 * полем конверта: типы результата описывают строки тирлиста и ничего не знают
 * про наблюдение, а главному процессу нужна сумма по всем воркерам.
 */
export interface WorkerMessage {
  preparedMs: number;
  result: TierWorkerResult;
  counters: SimulationCounters;
}

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
 * Опции одного прохода сетки.
 *
 * Основная вкладка и объединённая сетка ОБЯЗАНЫ считаться одинаковыми опциями.
 * От этого зависит кэш замеров: замер голого отряда внутри объединённой сетки
 * должен попасть в ту же таблицу, что и замер основной вкладки, и тогда он
 * бесплатный — платят только пары.
 *
 * Поэтому вызовы связаны в одну функцию. Стоит развести их по разным файлам или
 * поправить один и забыть про второй — попадание в кэш умрёт тихо, и объединённая
 * сетка начнёт заново считать все 1093 голых отряда на каждом проходе.
 */
function comboOptions(mode: CombatMode, paradigm: TargetParadigm) {
  return {
    mode,
    targetParadigm: paradigm,
    combat: { trials, distance },
    // Пары меряются с той же точностью, что и основной тирлист. Раньше здесь
    // стояло min(trials, 4) и maxRounds 8 «потому что вкладка справочная» — но
    // аргумент был верен, пока каждая пара считалась ещё в трёх парадигмах.
    // Теперь повторов нет, и 4 прогона — это в основном шум в порядке строк.
    survival: { trials, maxRounds: 15, distance },
    archetypes: ARCHETYPES,
  };
}

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
    process.send?.({ preparedMs, result, counters: simulationCounters() });
    // Обнуляем ПОСЛЕ отправки: счётчик в процессе накопительный, а сообщений по
    // одному на задачу, и без сброса главный процесс сложил бы 1+2+3 вместо 3.
    // Подготовка (adaptUnit с подбором стоек) попадает в первое сообщение — это
    // честная работа, просто никому больше не принадлежит.
    resetSimulationCounters();
    continue;
  }

  const started = Date.now();
  const options = comboOptions(job.mode, job.paradigm);
  const rows = tierList(prepared, options);

  /**
   * Объединённая сетка: голые отряды и пары в одном наборе.
   *
   * Раньше пары нормализовались ОТДЕЛЬНО, и `totalScore` пары нельзя было
   * сравнить с `totalScore` юнита: разные распределения, разные перцентили.
   * Теперь они стоят в одной шкале, и «насколько лидер поднял отряд» становится
   * разностью перцентилей одной сетки, а не сравнением двух разных миров.
   *
   * Цена — нулевая для голых отрядов: только что посчитанные замеры лежат в
   * кэше (см. comboOptions), платят только пары, которых в кэше ещё не было.
   *
   * Основная вкладка при этом НЕ трогается: она считается своим проходом выше,
   * иначе 1095 пар сдвинули бы перцентили всех 1093 юнитов.
   */
  const pairIds = new Set(attachedEntries.map((entry) => entry.rowId));
  const merged = tierList([...prepared, ...attachedEntries], options);
  const attachedRows = merged.filter((row) => pairIds.has(row.id));
  // Голые отряды той же сетки — база для дельт. Брать их из основного прохода
  // нельзя: там другая нормализация и другие перцентили.
  const bareById = new Map(merged.filter((row) => !pairIds.has(row.id)).map((row) => [row.id, row]));
  const result: ComboResult = {
    kind: 'combo',
    paradigm: job.paradigm,
    mode: job.mode,
    rows: rows.map(trimRow),
    attached: trimAttached(attachedRows, bareById, prepared, leaders),
    elapsedMs: Date.now() - started,
  };
  process.send?.({ preparedMs, result, counters: simulationCounters() });
  resetSimulationCounters();
}
