/**
 * Сводка по лидерам: насколько хорош лидер сам по себе.
 *
 * Пара «отряд + лидер» отвечает на вопрос «насколько хороша вот эта связка».
 * Но игроку нужен и другой ответ: «какого лидера стоит взять». Считать его из
 * пар напрямую нельзя, и вот почему:
 *
 *  - лидер с ОДНОЙ парой наследует качество своего единственного отряда целиком;
 *  - лидер, который цепляется к сильным отрядам, выглядит отличным, даже не
 *    сделав ничего.
 *
 * Поэтому у лидера две величины, и они отвечают на разные вопросы:
 *
 *  - `lift` (подъём) — насколько лидер ПРИБАВИЛ своим отрядам. Средняя дельта
 *    перцентиля по его парам.
 *  - `result` (результат) — во что отряды ПРЕВРАЩАЮТСЯ. Средний перцентиль пар.
 *
 * Лидер, который садится только на плохие отряды и не делает их хорошими,
 * проваливается по обоим сразу: lift около нуля, result низкий.
 *
 * Усадка. У 53% лидеров меньше трёх пар, и среднее по одной паре — это шум,
 * поданный как осмысленный балл. Поэтому итоговое значение стягивается к
 * среднему по всем лидерам: (n·своё + k·общее) / (n + k). Лидер с одной парой
 * получает примерно треть своего сигнала и две трети «среднего по рынку».
 * Это эмпирическое Байеса, а не украшение: `pairs` в payload показывает, чего
 * стоит верить конкретной строке.
 *
 * `score` — это `result` после усадки, то есть «качество пар этого лидера».
 * `lift` в него не входит намеренно: result УЖЕ включает эффект лидера, и
 * добавление lift сверху посчитало бы вклад дважды.
 */

/**
 * Минимум, который сводка берёт из строки пары.
 *
 * Объявлено структурно, а не импортом из `scripts/prepare-units.ts`: модуль
 * живёт в `src` и не должен зависеть от слоя сборки — тем более что этот же
 * тип нужен клиенту, который про `scripts/` не знает.
 */
export interface AttachedPairLike {
  leaderId: string | null;
  percentile: number;
  deltaPercentile: number;
}

/** Пара, свёрнутая до двух величин, нужных сводке. */
export interface LeaderPairMetric {
  percentile: number;
  deltaPercentile: number;
}

/** Лидер на входе: имя и цена из базы, пары — из сетки. */
export interface LeaderScoreInput {
  id: string;
  name: string;
  faction: string;
  points: number;
  pairs: LeaderPairMetric[];
}

/** Строка сводки по лидеру — то, что уезжает в leaders.json. */
export interface LeaderScoreRow {
  id: string;
  name: string;
  faction: string;
  points: number;
  /** Сколько пар у лидера: столько данных стоит за его баллом. */
  pairs: number;
  /** Средняя дельта перцентиля: что лиде�� добавляет своим отрядам. */
  lift: number;
  /** Средний перцентиль пар: во что отряды превращаются. */
  result: number;
  /** Обе величины после усадки к среднему по всем лидерам. */
  liftShrunk: number;
  resultShrunk: number;
  /** Итоговый балл лидера = resultShrunk. */
  score: number;
  /** Доля пар, в которых лидер реально поднял отряд. */
  improvedShare: number;
}

const mean = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

/**
 * Сила усадки в «фальшивых парах».
 *
 * Три — потому что столько пар нужно, чтобы среднее перестало определяться
 * одной случайной парой. У лидера с 3 парами сигнал и глобальное среднее в
 * равных долях; у лидера с 16 парами глобальное почти не слышно.
 */
const DEFAULT_SHRINKAGE = 3;

/**
 * Свёртка пар одного лидера.
 *
 * Сортировка — по `score` по убыванию: итоговый балл с усадкой, а не сырой
 * result. Иначе лидер с одной удачной парой встал бы на первое место таблицы.
 */
export function leaderScoresOf(
  inputs: LeaderScoreInput[],
  shrinkage: number = DEFAULT_SHRINKAGE
): LeaderScoreRow[] {
  // Глобальное среднее — по всем парам, а не по средним лидеров. Иначе лидер
  // с 16 парами весил бы столько же, сколько лидер с одной.
  const allPairs = inputs.flatMap((input) => input.pairs);
  const globalLift = mean(allPairs.map((pair) => pair.deltaPercentile));
  const globalResult = mean(allPairs.map((pair) => pair.percentile));

  const rows = inputs.map((input): LeaderScoreRow => {
    const n = input.pairs.length;
    const lift = mean(input.pairs.map((pair) => pair.deltaPercentile));
    const result = mean(input.pairs.map((pair) => pair.percentile));
    const weight = n + shrinkage;
    const liftShrunk = (n * lift + shrinkage * globalLift) / weight;
    const resultShrunk = (n * result + shrinkage * globalResult) / weight;
    return {
      id: input.id,
      name: input.name,
      faction: input.faction,
      points: input.points,
      pairs: n,
      lift,
      result,
      liftShrunk,
      resultShrunk,
      score: resultShrunk,
      improvedShare:
        n === 0 ? 0 : input.pairs.filter((pair) => pair.deltaPercentile > 0).length / n,
    };
  });

  return rows.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

/** Группировка строк пар по лидеру: вход для leaderScoresOf. */
export function groupByLeader(
  rows: AttachedPairLike[],
  leaders: ReadonlyArray<{ id: string; name: string; faction: string; points: number }>
): LeaderScoreInput[] {
  const byLeader = new Map<string, LeaderPairMetric[]>();
  for (const row of rows) {
    if (row.leaderId === null) continue;
    const pairs = byLeader.get(row.leaderId) ?? [];
    pairs.push({ percentile: row.percentile, deltaPercentile: row.deltaPercentile });
    byLeader.set(row.leaderId, pairs);
  }
  return leaders
    .filter((leader) => byLeader.has(leader.id))
    .map((leader) => ({
      id: leader.id,
      name: leader.name,
      faction: leader.faction,
      points: leader.points,
      pairs: byLeader.get(leader.id) ?? [],
    }));
}