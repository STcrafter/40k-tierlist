/**
 * Регрессия на выбор парадигмы цели.
 *
 * Проверка принадлежности стояла на Object.keys по массиву парадигм, а
 * Object.keys(['all']) даёт ['0']. Проверка всегда была ложна, поэтому
 * metricsOf откатывался на парадигму all: переключатель «Парадигма цели» менял
 * подпись, но цифры оставались от all, а матрица в панели показывала прочерки.
 * Значений это не портило, но переключатель не работал вовсе.
 */
import { describe, expect, it } from 'vitest';
import { isTargetParadigm, LEADER_COLUMN_KEYS } from '../web/src/model.ts';
import { leaderScoresOf, type LeaderScoreRow } from './tier/leader-score.ts';
import type { TargetParadigm } from './tier/scoring.ts';

const paradigms: TargetParadigm[] = ['all', 'infantry', 'elite', 'armor'];

describe('isTargetParadigm', () => {
  it('принимает каждую парадигму из списка', () => {
    for (const paradigm of paradigms) {
      expect(isTargetParadigm(paradigm, paradigms)).toBe(true);
    }
  });

  it('отвергает значения, которых нет в списке', () => {
    expect(isTargetParadigm('vehicles', paradigms)).toBe(false);
    expect(isTargetParadigm('', paradigms)).toBe(false);
    // Числовые индексы: именно их возвращал Object.keys вместо значений.
    expect(isTargetParadigm('0', paradigms)).toBe(false);
  });

  it('не путает индексы массива с его значениями', () => {
    // Проверка, которая стояла вместо нормальной: Object.keys по массиву.
    const broken = (value: string): boolean =>
      (Object.keys(paradigms) as string[]).includes(value);
    expect(Object.keys(paradigms)).toEqual(['0', '1', '2', '3']);
    expect(broken('all')).toBe(false);
    expect(isTargetParadigm('all', paradigms)).toBe(true);
  });
});

/**
 * Связь вкладки «Лидеры» с данными сборки.
 *
 * Колонки рисуются по ключам-строкам, поэтому опечатка в ключе или переименование
 * поля в сборке не дают ошибки: `Number(undefined)` — это NaN, сравнение всегда
 * ложно, и таблица молча замирает в произвольном порядке.
 */
describe('колонки сводки по лидерам', () => {
  const rows: LeaderScoreRow[] = leaderScoresOf([
    {
      id: 'a',
      name: 'Alpha',
      faction: 'X',
      points: 50,
      pairs: [
        { percentile: 80, deltaPercentile: 2 },
        { percentile: 70, deltaPercentile: -1 },
      ],
    },
    {
      id: 'b',
      name: 'Beta',
      faction: 'Y',
      points: 30,
      pairs: [{ percentile: 60, deltaPercentile: 1 }],
    },
  ]);

  it('каждый ключ колонки есть в строке сводки', () => {
    const known = new Set(Object.keys(rows[0]));
    const unknown = LEADER_COLUMN_KEYS.filter((key) => !known.has(key));
    expect(
      unknown,
      `в web/src/model.ts колонки, которых нет в LeaderScoreRow: ${unknown.join(', ')}`
    ).toEqual([]);
  });

  it('все значения колонок — числа, сортировка по ним будет определена', () => {
    // Проверка именно на NaN/undefined: сравнение с ними всегда ложно, и
    // сортировка выглядит работающей, а на деле ничего не сортирует.
    for (const row of rows) {
      for (const key of LEADER_COLUMN_KEYS) {
        if (key === 'name' || key === 'faction') continue;
        const value = row[key as keyof LeaderScoreRow];
        expect(typeof value, `${row.name}.${key} — не число`).toBe('number');
        expect(Number.isFinite(value as number), `${row.name}.${key} — не конечное число`).toBe(true);
      }
    }
  });

  it('балл совпадает с результатом после усадки, а подъём в него не входит', () => {
    // Оба утверждения зафиксированы решением в leader-score.ts: score — это
    // resultShrunk, а не «result + lift». Если это поменять, сводка начнёт
    // платить за вклад лидера дважды.
    for (const row of rows) {
      expect(row.score).toBe(row.resultShrunk);
    }
    // Лидер без пар не должен получать выдуманный балл.
    const empty = leaderScoresOf([{ id: 'c', name: 'Gamma', faction: 'Z', points: 10, pairs: [] }]);
    expect(empty[0].score).toBe(empty[0].resultShrunk);
  });
});
