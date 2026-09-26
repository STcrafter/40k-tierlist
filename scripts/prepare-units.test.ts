/**
 * Регрессия на порядок ключей при параллельной сборке.
 *
 * Воркеры рапортуют о комбинациях в случайном порядке — кто быстрее посчитал.
 * Если бы сетка «парадигма × режим» создавалась по факту сообщения, ключи в JSON
 * вставлялись бы именно в этом порядке: значения те же, а файл байт в байт
 * другой. Такая сборка не воспроизводима и ломает любое сравнение с эталоном.
 */
import { describe, expect, it } from 'vitest';
import { emptyParadigmGrid } from './prepare-units.ts';

const paradigms = ['all', 'infantry', 'elite', 'armor'] as const;
const modes = ['ranged', 'melee', 'combined'] as const;

describe('emptyParadigmGrid', () => {
  it('создаёт все комбинации заранее, а не по мере прихода результатов', () => {
    const grid = emptyParadigmGrid(paradigms, modes, () => []);
    expect(Object.keys(grid)).toEqual([...paradigms]);
    for (const paradigm of paradigms) {
      expect(Object.keys(grid[paradigm])).toEqual([...modes]);
    }
  });

  it('даёт одинаковый порядок ключей при заполнении вразнобой', () => {
    const shape = () => Object.keys(emptyParadigmGrid(paradigms, modes, () => [])).join(',');

    // Первый сетка заполняется «как повезло»: ключи уже созданы, порядок не меняется.
    const first = emptyParadigmGrid(paradigms, modes, () => []);
    for (const paradigm of [...paradigms].reverse()) {
      for (const mode of [...modes].reverse()) {
        first[paradigm][mode] = [];
      }
    }

    // Второй заполняется в прямом порядке.
    const second = emptyParadigmGrid(paradigms, modes, () => []);
    for (const paradigm of paradigms) {
      for (const mode of modes) {
        second[paradigm][mode] = [];
      }
    }

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(shape()).toBe(shape());
  });
});
