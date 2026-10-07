/**
 * Тесты разбора Feel No Pain.
 *
 * Модуль существует из-за одного свойства: правило FNP читалось в проекте
 * дважды, и обе копии расходились с боевой моделью. Тесты закрывают обе
 * половины этого — что именно считается защитой и что считается сильнее.
 */

import { describe, expect, it } from 'vitest';
import { fnpOf, isStrongerFnp, strongerFnp, type FnpReading } from './fnp.ts';

/** Минимальный даташит: модуль читает только правила и способности. */
const sheet = (
  items: Array<{ name: string; description: string }>
): { abilities: typeof items; rules: typeof items } => ({ abilities: items, rules: [] });

describe('направление сравнения FNP', () => {
  it('меньший порог сильнее: 3+ защищает больше ранений, чем 6+', () => {
    // Главная ошибка, которую закрывает модуль: в проекте сравнение порогов жило
    // в четырёх местах, и в трёх стоял Math.max — то есть более слабая защита
    // перебивала более сильную (аура FNP 5+ ухудшала модель с FNP 3+).
    expect(isStrongerFnp({ threshold: 3, scope: 'all' }, { threshold: 6, scope: 'all' })).toBe(true);
    expect(isStrongerFnp({ threshold: 6, scope: 'all' }, { threshold: 3, scope: 'all' })).toBe(false);
  });

  it('при равном пороге «all» сильнее «mortals»', () => {
    // Одна и та же защита мортидов, но 'all' добавляет обычный урон.
    expect(isStrongerFnp({ threshold: 5, scope: 'all' }, { threshold: 5, scope: 'mortals' })).toBe(true);
    expect(isStrongerFnp({ threshold: 5, scope: 'mortals' }, { threshold: 5, scope: 'all' })).toBe(false);
  });

  it('strongerFnp уважает отсутствие защиты', () => {
    expect(strongerFnp(null, { threshold: 5, scope: 'all' })).toEqual({ threshold: 5, scope: 'all' });
    expect(strongerFnp({ threshold: 5, scope: 'all' }, null)).toEqual({ threshold: 5, scope: 'all' });
    expect(strongerFnp(null, null)).toBeNull();
  });

  it('strongerFnp берёт из двух порогов более сильный', () => {
    const weak: FnpReading = { threshold: 6, scope: 'all' };
    const strong: FnpReading = { threshold: 3, scope: 'mortals' };
    expect(strongerFnp(weak, strong)).toBe(strong);
    expect(strongerFnp(strong, weak)).toBe(strong);
  });
});

describe('разбор правил BSData', () => {
  it('берёт порог из имени правила', () => {
    // Порог лежит в `name` («Feel No Pain 6+»), а не в описании.
    const readings = fnpOf(sheet([{ name: 'Feel No Pain 6+', description: 'Each time a model … would lose a wound …' }]));
    expect(readings.permanent).toEqual({ threshold: 6, scope: 'all' });
    expect(readings.reported).toEqual({ threshold: 6, scope: 'all' });
  });

  it('«against mortal wounds» ограничивает область, а не усиливает', () => {
    const readings = fnpOf(
      sheet([{ name: 'Feel No Pain 4+', description: 'Feel No Pain 4+ against mortal wounds.' }])
    );
    expect(readings.permanent).toEqual({ threshold: 4, scope: 'mortals' });
  });

  it('защита от психических атак не моделируется', () => {
    // Это защита от другого канала урона, а не невеличение ранений.
    const readings = fnpOf(
      sheet([{ name: 'Feel No Pain 3+', description: 'Feel No Pain 3+ against psychic attacks.' }])
    );
    expect(readings.permanent).toBeNull();
    expect(readings.reported).toBeNull();
  });

  it('служебная запись BSData не считается защитой', () => {
    // «Feel No Pain X+ … This ability always takes the form **Feel No Pain X+**» —
    // расшифровка механики. Без фильтра такая пара давала «FNP есть» юнитам без
    // защиты: Beastboss — самый крупный случай, таких юнитов 133.
    const readings = fnpOf(
      sheet([{ name: 'Feel No Pain 5+', description: 'This ability always takes the form **Feel No Pain X+**.' }])
    );
    expect(readings.permanent).toBeNull();
    expect(readings.reported).toBeNull();
  });

  it('берёт лучший из нескольких порогов', () => {
    const readings = fnpOf(
      sheet([
        { name: 'Feel No Pain 6+', description: 'Feel No Pain 6+' },
        { name: 'Daughter of the Abyss', description: 'This model has the Feel No Pain 3+ ability.' },
      ])
    );
    expect(readings.permanent).toEqual({ threshold: 3, scope: 'all' });
  });

  it('правила читаются из rules, а не только из abilities', () => {
    // Deep Strike и большинство FNP лежат в `rules`.
    const readings = fnpOf({
      abilities: [],
      rules: [{ name: 'Feel No Pain 5+', description: 'This ability always takes the form **Feel No Pain X+**.' }, { name: 'Feel No Pain 5+', description: '' }],
    });
    expect(readings.permanent).toEqual({ threshold: 5, scope: 'all' });
  });
});

describe('постоянный FNP против FNP «как на даташите»', () => {
  it('условный грант не достаёт в бой, но виден в отчёте', () => {
    const readings = fnpOf(
      sheet([
        {
          name: 'Ancient',
          description: 'While a friendly MONOCHAOS model is within 6" of this model, it has Feel No Pain 5+.',
        },
      ])
    );
    expect(readings.permanent).toBeNull();
    expect(readings.reported).toEqual({ threshold: 5, scope: 'all' });
  });

  it('«until the end of the turn» — тоже условный грант', () => {
    const readings = fnpOf(
      sheet([{ name: 'Shield of Faith', description: 'This model has Feel No Pain 4+ until the end of the turn.' }])
    );
    expect(readings.permanent).toBeNull();
    expect(readings.reported).toEqual({ threshold: 4, scope: 'all' });
  });
});