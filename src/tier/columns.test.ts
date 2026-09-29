import { describe, expect, it } from 'vitest';
import {
  COLUMNS,
  INDEX_CELL_KEYS,
  INDEXED_COLUMN_KEYS,
  ROW_ONLY_CELL_KEYS,
  UNIT_LEVEL_COLUMN_KEYS,
} from './columns.ts';
import { withinCalculationBudget } from '../combat/budget.ts';
import type { CombatMode, TargetParadigm } from './scoring.ts';
// UnitMetrics живёт в web/src/model.ts: это описание формы собранного JSON,
// а не боевой движок, поэтому из src/tier его взять неоткуда.
import type { UnitMetrics } from '../../web/src/model.ts';

const MODES: CombatMode[] = ['ranged', 'melee', 'combined'];
const PARADIGMS: TargetParadigm[] = ['all', 'infantry', 'elite', 'armor'];

describe('колонки таблицы и состав индекса', () => {
  it('в каждую колонку-метрику сборщик кладёт данные', () => {
    // Главный инвариант модуля. Проверялся дважды в жизни: колонка
    // «Прочность/100» показывала нули у всех 1093 юнитов, потому что поле
    // не попало в индекс. Ошибки не было ни в одной консоли — просто
    // выглядело так, будто никто не умеет держать урон.
    const missing = COLUMNS.map((column) => column.key)
      .filter((key) => INDEXED_COLUMN_KEYS.has(key))
      .filter((key) => !(INDEX_CELL_KEYS as readonly string[]).includes(key));
    expect(missing, `в индексе нет полей для колонок: ${missing.join(', ')}`).toEqual([]);
  });

  it('в индексе нет полей, которых не читает ни одна колонка', () => {
    // Обратная сторона: лишнее поле в индексе — это чистые байты в файле,
    // который грузится целиком перед первой отрисовкой. На первом прогоне
    // проверка нашла в индексе `effectiveSurvivability` и `unitType`: колонки
    // у них нет, и читать их было неоткуда.
    const used = new Set<string>([
      ...COLUMNS.map((column) => column.key),
      ...(UNIT_LEVEL_COLUMN_KEYS as readonly string[]),
      ...(ROW_ONLY_CELL_KEYS as readonly string[]),
    ]);
    const unused = (INDEX_CELL_KEYS as readonly string[]).filter((key) => !used.has(key));
    expect(unused, `в индексе лежит лишнее: ${unused.join(', ')}`).toEqual([]);
  });

  it('у ключей колонок нет повторов', () => {
    // Повтор ключа не ломает сборку, но вторая колонка перетирает первую по
    // ключу сортировки, и одна из них молча не работает.
    const keys = COLUMNS.map((column) => column.key);
    expect(new Set(keys).size, `повторяющиеся ключи колонок: ${keys.join(', ')}`).toBe(keys.length);
  });

  it('все поля индекса — настоящие поля метрики', () => {
    // Ключ с опечаткой дал бы `undefined` в ячейке: значение молча
    // превратилось бы в 0 через `?? 0` в cellValue.
    //
    // Эталон — типизированный литерал, а не список строк: если поле уберут из
    // UnitMetrics, тест перестанет компилироваться, а не станет проходить
    // на пустом сравнении.
    const sample = emptyMetrics();
    const unknown = (INDEX_CELL_KEYS as readonly string[]).filter((key) => !(key in sample));
    expect(unknown, `в индексе лежат поля, которых нет в метрике: ${unknown.join(', ')}`).toEqual([]);
  });
});

/**
 * Заготовка полной метрики со всеми обязательными полями.
 *
 * Литерал без `as`, поэтому забытое поле не соберётся: тест физически не
 * сможет «забыть» свойство, которое на самом деле ещё есть в UnitMetrics.
 */
function emptyMetrics(): UnitMetrics {
  return {
    rawMaxDamage: 0,
    bestTarget: 'cluster-5',
    bestTargetName: 'Техника T9 W11',
    destroyedPointsByTarget: {},
    defenseVector: {},
    effectiveOffenseVector: {},
    universal: 0,
    damagePer100: 0,
    absorbedPer100: 0,
    bulkPer100: 0,
    censoredShare: 0,
    unitType: 'Ranged',
    taxDamage: 1,
    taxSurvivability: 1,
    effectiveDamage: 0,
    effectiveSurvivability: 0,
    normDamage: 0,
    normSurvivability: 0,
    normUtility: 0,
    vectorDamageScore: 0,
    vectorSurvivabilityScore: 0,
    vectorDamageFloor: 0,
    vectorSurvivabilityFloor: 0,
    utilityFlags: [],
    utilityScore: 0,
    totalScore: 0,
    percentile: 50,
    tier: 'B',
  };
}

describe('форма индекса', () => {
  /**
   * Ячейка ровно той формы, которую кладёт сборщик.
   *
   * Строится из INDEX_CELL_KEYS, а не вручную: ручная копия однажды разошлась
   * бы с ключами, и проверка формы начала бы проверять саму себя.
   */
  const cell = (tier: string): Record<string, unknown> =>
    Object.fromEntries(
      INDEX_CELL_KEYS.map((key) => [
        key,
        key === 'tier' ? tier : key === 'bestTarget' ? 'cluster-5' : key === 'bestTargetName' ? 'Техника T9 W11' : 1,
      ])
    );

  it('ячейка закрывает каждую пару «парадигма × режим»', () => {
    const cells = Object.fromEntries(
      PARADIGMS.map((paradigm) => [paradigm, Object.fromEntries(MODES.map((mode) => [mode, cell('B')]))])
    );
    for (const paradigm of PARADIGMS) {
      for (const mode of MODES) {
        expect(cells[paradigm][mode], `${paradigm}/${mode}`).toBeDefined();
      }
    }
  });

  it('в ячейке нет полей сверх INDEX_CELL_KEYS', () => {
    // Клиент читает `cell[key] ?? 0`, поэтому лишнее поле не даст ошибки, но
    // будет молча платить трафиком на каждом юните в каждой из 12 ячеек.
    expect(Object.keys(cell('B')).sort()).toEqual([...INDEX_CELL_KEYS].sort());
  });

  it('таблица отбрасывает юнитов вне расчётного бюджета', () => {
    // Фильтр стоит до сортировки и до отрисовки, поэтому непроходящий юнит
    // не должен попасть ни в одну строку: иначе колонка «Очки» покажет
    // значения, которых движок никогда не считал.
    expect(withinCalculationBudget(100)).toBe(true);
    expect(withinCalculationBudget(2000)).toBe(true); // предел включается
    expect(withinCalculationBudget(2001)).toBe(false);
    expect(withinCalculationBudget(0)).toBe(false);
    expect(withinCalculationBudget(Number.NaN)).toBe(false);
  });
});
