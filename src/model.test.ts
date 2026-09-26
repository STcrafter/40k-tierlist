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
import { isTargetParadigm } from '../web/src/model.ts';
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
