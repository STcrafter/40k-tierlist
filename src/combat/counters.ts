/**
 * Счётчики дорогих вычислений.
 *
 * Сборка тирлиста — единственное место проекта, где неизвестно, во что уходит
 * время: 12 комбинаций «парадигма × режим», в каждой тысячи Монте-Карло, и всё
 * это молчит. Оптимизация по догадкам здесь хуже отсутствия оптимизации —
 * можно месяц переписывать горячий код, который стоит трёх процентов времени.
 *
 * Счётчики отвечают на вопрос «что именно вызывается» и не отвечают на
 * «сколько это стоит»: время даёт build-tierlist вокруг своих этапов, а
 * произведение этих двух величин и есть настоящая цена.
 *
 * Ничего не меняют в расчёте — только прибавляют единицы. Значит, сборка со
 * включёнными счётчиками даёт ровно те же цифры в тире, что и без них, и
 * сравнить выгрузку можно, ничего не отключая.
 *
 * Воркеры считают в своих процессах, поэтому счётчики переживают границу IPC
 * отдельным полем в ответе (см. tier-worker.ts).
 */

/** Что именно считаем. */
export type SimulationKind =
  /** `damagePerRound` при ранжировании юнита. */
  | 'damageRuns'
  /** Замер живучести (`survivabilityAgainstUnit`) из ранжирования. */
  | 'survivalRuns'
  /** Прогоны на дельту одноразовых эффектов (по два на юнит с такими способностями). */
  | 'onceDeltaRuns'
  /** Один замер стойки Ka'tah (по два на юнит со стойками). */
  | 'katahStanceScores'
  /** Замер одного архетипа внутри `damagePerRound` — по три Монте-Карло на фазу. */
  | 'archetypeRuns'
  /** Прогоны Монте-Карло в бою. */
  | 'monteCarloTrials'
  /** Бои в замере живучести (по одному на прогон каждого шаблона оружия). */
  | 'survivalTrials';

export type SimulationCounters = Record<SimulationKind, number>;

/**
 * Пояснение к каждому счётчику — печатается вместе с таблицей.
 *
 * Текст живёт здесь, а не в сборщике: смысл счётчика известен только здесь же, и
 * разносить его по двум файлам — значит со временем разъедутся.
 */
export const SIMULATION_COUNTER_LABELS: Record<SimulationKind, string> = {
  damageRuns: 'замеров урона при ранжировании',
  survivalRuns: 'замеров живучести при ранжировании',
  onceDeltaRuns: 'прогонов на дельту одноразовых эффектов',
  katahStanceScores: 'замеров стоек Ka’tah',
  archetypeRuns: 'замеров по одному архетипу',
  monteCarloTrials: 'боёв Монте-Карло (урон)',
  survivalTrials: 'боёв Монте-Карло (живучесть)',
};

const counters: SimulationCounters = {
  damageRuns: 0,
  survivalRuns: 0,
  onceDeltaRuns: 0,
  katahStanceScores: 0,
  archetypeRuns: 0,
  monteCarloTrials: 0,
  survivalTrials: 0,
};

/**
 * Отметить N вызовов.
 *
 * Считается пачкой, а не внутри цикла прогонов: иначе счётчик сам стал бы
 * основной нагрузкой — миллионы прибавлений вместо десятков тысяч.
 */
export function countSimulations(kind: SimulationKind, amount = 1): void {
  counters[kind] += amount;
}

/** Копия текущих значений: наружу отдаётся снимок, а не живой счётчик. */
export function simulationCounters(): SimulationCounters {
  return { ...counters };
}

/** Прибавить счётчики (например, собранные от воркера) к накопленным. */
export function addSimulationCounters(target: SimulationCounters, source: SimulationCounters): void {
  for (const kind of Object.keys(target) as SimulationKind[]) {
    target[kind] += source[kind] ?? 0;
  }
}

/** Обнулить: нужно тестам, чтобы один прогон не наследовал счётчики другого. */
export function resetSimulationCounters(): void {
  for (const kind of Object.keys(counters) as SimulationKind[]) counters[kind] = 0;
}
