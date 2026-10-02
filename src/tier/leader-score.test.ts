/**
 * Тесты сводки по лидерам.
 *
 * Модуль чистый: на вход пары, на выходе строки. Проверяется ровно то, ради чего
 * сводка затевалась, — что лидер с одной парой не может выиграть таблицу.
 */

import { describe, expect, it } from 'vitest';
import { groupByLeader, leaderScoresOf, type LeaderScoreInput } from './leader-score.ts';

/** Лидер с заданными парами: пара = [перцентиль, дельта перцентиля]. */
function leader(id: string, pairs: Array<[number, number]>): LeaderScoreInput {
  return {
    id,
    name: id,
    faction: 'Test',
    points: 50,
    pairs: pairs.map(([percentile, deltaPercentile]) => ({ percentile, deltaPercentile })),
  };
}

describe('сводка по лидерам', () => {
  it('lift — средняя дельта, result — средний перцентиль', () => {
    const [row] = leaderScoresOf([leader('A', [[80, 10], [60, -2]])]);
    expect(row.lift).toBe(4); // (10 + -2) / 2
    expect(row.result).toBe(70); // (80 + 60) / 2
    expect(row.pairs).toBe(2);
  });

  it('лидер без пар не попадает в сводку', () => {
    // Фильтрует groupByLeader — он и решает, какие лидеры вообще попадают
    // в таблицу. leaderScoresOf честно считает всё, что ему дали, включая
    // пустое: прятать пустые строки на обоих концах — значит забыть про
    // один из них и потом гадать, откуда взялась лишняя строка.
    const inputs = groupByLeader([{ leaderId: 'B', percentile: 50, deltaPercentile: 0 }], [
      { id: 'A', name: 'A', faction: 'Test', points: 50 },
      { id: 'B', name: 'B', faction: 'Test', points: 50 },
    ]);
    expect(inputs.map((input) => input.id)).toEqual(['B']);
  });

  it('лидер с одной парой не обгоняет лидера с той же парой и полными данными', () => {
    // Сердце усадки. Фон — лидер с потёмком слабых пар: он тянет среднее по
    // рынку вниз. Без такого фона среднее совпало бы с собственным средним
    // каждого лидера и усадке было бы нечего сжимать (так и вышло в первой
    // версии этого теста — он проходил вхолостую).
    const background = leader('bg', Array.from({ length: 100 }, () => [10, 0] as [number, number]));
    const many = leader('many', Array.from({ length: 9 }, () => [90, 20] as [number, number]));
    const one = leader('one', [[90, 20]]);
    const byId = new Map(leaderScoresOf([background, many, one]).map((row) => [row.id, row]));

    // Сырое среднее у обоих одинаковое — разница создаёт только усадка.
    expect(byId.get('many')!.lift).toBeCloseTo(20, 10);
    expect(byId.get('one')!.lift).toBeCloseTo(20, 10);
    expect(byId.get('many')!.liftShrunk).toBeGreaterThan(byId.get('one')!.liftShrunk!);
  });

  it('чем меньше пар, тем сильнее балл стягивается к среднему', () => {
    // Тот же приём с фоном: без него глобальное среднее совпадает со значением
    // всех трёх лидеров, и разрыв после усадки был бы нулевым.
    const background = leader('bg', Array.from({ length: 100 }, () => [10, 0] as [number, number]));
    const lift = 30;
    const rows = leaderScoresOf([
      background,
      leader('n1', Array.from({ length: 1 }, () => [50, lift] as [number, number])),
      leader('n2', Array.from({ length: 2 }, () => [50, lift] as [number, number])),
      leader('n9', Array.from({ length: 9 }, () => [50, lift] as [number, number])),
    ]);
    const byId = new Map(rows.map((row) => [row.id, row.liftShrunk]));
    expect(byId.get('n1')!).toBeLessThan(byId.get('n2')!);
    expect(byId.get('n2')!).toBeLessThan(byId.get('n9')!);
    // Содержательное свойство, а не выдуманный порог: лидер с 9 парами после
    // усадки остаётся БЛИЖЕ к своему сырому значению, чем лидер с одной.
    // (Процент тут не годится: при k=3 и подъёме на 30 девять пар сжимаются
    // примерно до 23, и «осталось 78%» ничего не значит само по себе.)
    const distance = (id: string): number => Math.abs(lift - byId.get(id)!);
    expect(distance('n9')).toBeLessThan(distance('n2'));
    expect(distance('n2')).toBeLessThan(distance('n1'));
  });

  it('усадка не переворачивает знак вывода: лидер с плохим result остаётся плохим', () => {
    // Усадка тянет к среднему, но не обязана делать хорошим плохого лидера.
    // Все пары в 10 перцентиля, lift отрицательный — итог обязан быть ниже,
    // чем у лидера с сильными парами, несмотря на сжатие к среднему.
    const rows = leaderScoresOf([
      leader('bad', Array.from({ length: 4 }, () => [10, -5] as [number, number])),
      leader('good', Array.from({ length: 4 }, () => [90, 5] as [number, number])),
    ]);
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get('bad')!.score).toBeLessThan(byId.get('good')!.score);
    expect(byId.get('bad')!.lift).toBeLessThan(0);
  });

  it('score = resultShrunk, и lift в него не входит', () => {
    // Намеренное решение: result уже включает эффект лидера, поэтому добавление
    // lift сверху посчитало бы вклад дважды. Закреплено тестом, чтобы формулу
    // не «улучшили» позже, не заметив двойного счёта.
    for (const row of leaderScoresOf([leader('A', [[70, 15], [50, 5]])])) {
      expect(row.score).toBe(row.resultShrunk);
      expect(row.score).not.toBe(row.liftShrunk + row.resultShrunk);
    }
  });

  it('improvedShare считает долю пар, где лидер поднял отряд', () => {
    const [row] = leaderScoresOf([leader('A', [[80, 10], [60, -2], [70, 0]])]);
    // Положительная дельта строго больше нуля; ноль — не подъём.
    expect(row.improvedShare).toBeCloseTo(1 / 3, 10);
  });

  it('группировка собирает пары по лидеру и пропускает строки без лидера', () => {
    const rows = [
      { leaderId: 'A', percentile: 80, deltaPercentile: 10 },
      { leaderId: 'A', percentile: 60, deltaPercentile: -2 },
      { leaderId: null, percentile: 99, deltaPercentile: 99 },
    ];
    const inputs = groupByLeader(rows, [
      { id: 'A', name: 'Alpha', faction: 'X', points: 40 },
      { id: 'B', name: 'Beta', faction: 'Y', points: 60 },
    ]);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].id).toBe('A');
    expect(inputs[0].pairs).toHaveLength(2);
  });

  it('лидер, у которого нет ни одной пары, в сводку не попадает', () => {
    const inputs = groupByLeader([], [
      { id: 'Z', name: 'Zeta', faction: 'X', points: 40 },
    ]);
    expect(inputs).toHaveLength(0);
  });

  it('пустой набор пар не роняет расчёт', () => {
    expect(leaderScoresOf([])).toEqual([]);
    const [row] = leaderScoresOf([leader('A', [])]);
    expect(row.lift).toBe(0);
    expect(row.result).toBe(0);
    expect(row.improvedShare).toBe(0);
  });
});