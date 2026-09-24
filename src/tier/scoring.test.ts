/**
 * Тесты скоринга и тиров.
 *
 * Формула проверяется по частям (Best in Slot, Melee Tax, utility, нормализация,
 * перцентили) плюс сквозная проверка инвариантов на реальных даташитах:
 * сумма весов равна 1, тиры покрывают весь набор, порядок не ломается.
 */

import { describe, expect, it } from 'vitest';
import { bsFilesFromDir } from '../bsdata/node-source.ts';
import { loadBsData } from '../bsdata/load.ts';
import { parseBsDatabase } from '../bsdata/units.ts';
import { adaptUnit } from '../combat/adapter.ts';
import {
  minMaxNormalize,
  meleeTax,
  percentileOf,
  rawScoreOf,
  SCORE_WEIGHTS,
  tierList,
  tierOf,
} from './scoring.ts';
import { detectUtilityFlags, utilityScoreOf, UTILITY_MAX } from './utility.ts';
import { attachLeaderToUnit, leaderDefinitionsOf } from './leaders.ts';
import type { BsDatasheet } from '../bsdata/types.ts';

const { datasheets } = parseBsDatabase(loadBsData(bsFilesFromDir('public/BSData/wh40k-11e')));
const find = (name: string): BsDatasheet => {
  const found = datasheets.find((sheet) => sheet.name === name);
  if (!found) throw new Error(`Нет даташита: ${name}`);
  return found;
};

/** Быстрые опции: мало прогонов — тестам важна форма, а не точность. */
const fast = {
  combat: { trials: 8, distance: 12 },
  survival: { trials: 6, maxRounds: 6, distance: 12 },
};

describe('Melee Tax', () => {
  it('стрелковый юнит не штрафуется', () => {
    expect(meleeTax('Ranged', false)).toEqual({ damage: 1, survivability: 1 });
    expect(meleeTax('Ranged', true)).toEqual({ damage: 1, survivability: 1 });
  });

  it('рукопашный с флаем/депт-страйком платит 0.85', () => {
    expect(meleeTax('Melee', true)).toEqual({ damage: 0.85, survivability: 0.85 });
  });

  it('рукопашный без флая платит 0.70 / 0.60', () => {
    expect(meleeTax('Melee', false)).toEqual({ damage: 0.7, survivability: 0.6 });
  });
});

describe('utility-флаги', () => {
  it('FNP 5+ даёт 2 балла', () => {
    // У Aberrants умение названо прямо в данных: «Feel No Pain 5+».
    const flags = detectUtilityFlags(find('Aberrants'));
    const fnp = flags.find((flag) => flag.id === 'FNP_5+');
    expect(fnp?.points).toBe(2);
  });

  it('FNP 6+ не путается с 5+', () => {
    const flags = detectUtilityFlags(find('Beastboss'));
    expect(flags.some((flag) => flag.id === 'FNP_6+')).toBe(true);
    expect(flags.some((flag) => flag.id === 'FNP_5+')).toBe(false);
  });

  it('OC 3+ даёт 2 балла', () => {
    // У Intercessors OC = 2, поэтому берём юнита с OC 4.
    const flags = detectUtilityFlags(find('Abaddon the Despoiler'));
    expect(flags.find((flag) => flag.id === 'OC_3+')?.points).toBe(2);
  });

  it('юнит с OC 2 флага OC_3+ не получает', () => {
    expect(detectUtilityFlags(find('Intercessor Squad')).some((f) => f.id === 'OC_3+')).toBe(
      false
    );
  });

  it('сумма ограничена потолком 20', () => {
    // Баллы намеренно копим выше потолка: 2+2+2+2+1+1+3+3+2+2+2 = 22 → обрезается до 20.
    const flags = [
      { id: 'Deep_Strike' as const, points: 2, reason: '' },
      { id: 'Reserves' as const, points: 2, reason: '' },
      { id: 'FNP_6+' as const, points: 2, reason: '' },
      { id: 'FNP_5+' as const, points: 2, reason: '' },
      { id: 'Fly' as const, points: 1, reason: '' },
      { id: 'Stealth' as const, points: 1, reason: '' },
      { id: 'Screening' as const, points: 3, reason: '' },
      { id: 'Tie_up' as const, points: 3, reason: '' },
      { id: 'OC_3+' as const, points: 2, reason: '' },
      { id: 'Aura_Ward' as const, points: 2, reason: '' },
      { id: 'Aura_Re_roll_1s' as const, points: 2, reason: '' },
    ];
    const sum = flags.reduce((total, flag) => total + flag.points, 0);
    expect(sum).toBeGreaterThan(UTILITY_MAX);
    expect(utilityScoreOf(flags)).toBe(UTILITY_MAX);
  });

  it('без флагов utility равен нулю', () => {
    expect(utilityScoreOf([])).toBe(0);
  });

  it('каждый флаг хранит причину', () => {
    for (const flag of detectUtilityFlags(find('Boyz'))) {
      expect(flag.reason.length, flag.id).toBeGreaterThan(0);
    }
  });
});

describe('нормализация и перцентили', () => {
  it('min-max даёт шкалу 0–100', () => {
    expect(minMaxNormalize([10, 20, 30])).toEqual([0, 50, 100]);
  });

  it('при одинаковых значениях все получают 50', () => {
    expect(minMaxNormalize([7, 7, 7])).toEqual([50, 50, 50]);
    expect(minMaxNormalize([])).toEqual([]);
  });

  it('перцентиль считается по рангу, а не по значению', () => {
    const sorted = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    // Минимум — 0-й перцентиль, максимум — 100-й (10 из 11 юнитов не круче).
    expect(percentileOf(sorted, 0)).toBe(0);
    expect(percentileOf(sorted, 100)).toBe(100);
    // Значение 50 стоит ровно посередине массива из 11 элементов.
    expect(percentileOf(sorted, 50)).toBeCloseTo(50, 6);
    // Ключевое свойство: значение ниже 100 может иметь высокий перцентиль.
    // (Именно на этом ломалось распределение по тирам: скора не достигают 100.)
    const compressed = [10, 20, 30, 40, 50];
    expect(percentileOf(compressed, 50)).toBe(100);
  });

  it('совпадающие значения делят своё плато', () => {
    const sorted = [1, 2, 2, 2, 5];
    // Три «двойки» занимают позиции 1–3, середина плато — позиция 2 из 4.
    expect(percentileOf(sorted, 2)).toBeCloseTo(50, 6);
  });

  it('пустой набор даёт середину', () => {
    expect(percentileOf([], 50)).toBe(50);
    expect(percentileOf([5], 5)).toBe(50);
  });

  it('тиры назначаются по границам перцентилей', () => {
    expect(tierOf(95)).toBe('S');
    expect(tierOf(80)).toBe('A');
    expect(tierOf(60)).toBe('B');
    expect(tierOf(30)).toBe('C');
    expect(tierOf(10)).toBe('D');
  });

  it('сумма весов равна единице', () => {
    const sum = SCORE_WEIGHTS.damage + SCORE_WEIGHTS.survivability + SCORE_WEIGHTS.utility;
    expect(sum).toBeCloseTo(1, 10);
  });
});

describe('Best in Slot и метрики', () => {
  it('берётся лучший destroyed points по конкретному типу цели', () => {
    const datasheet = find('Intercessor Squad');
    const { unit, points } = adaptUnit(datasheet, { size: 'min' });
    const raw = rawScoreOf(datasheet, unit, points, fast);
    const best = Math.max(...Object.values(raw.destroyedPointsByTarget));
    expect(raw.rawMaxDamage).toBeCloseTo(best, 10);
    expect(raw.bestSlot).toBe('infantry');
    expect(raw.bestTarget).toBeTruthy();
  });

  it('все типы целей считаются в одной шкале — «на 100 очков»', () => {
    // Регрессия: слоты по пехоте/броне считались в сыром уроне, а универсальный
    // — уже нормированный. Из-за разнокалибровки «best slot» всегда был «infantry».
    const datasheet = find('Leman Russ Battle Tank');
    const { unit, points } = adaptUnit(datasheet, { size: 'min' });
    const raw = rawScoreOf(datasheet, unit, points, fast);
    // Все слоты — одной природы: у «тяжёлого» юнита за 100 очков они
    // не могут быть в разы больше, чем у дешёвой пехоты.
    expect(raw.vsInfantry).toBeLessThan(1000);
    expect(raw.vsArmor).toBeLessThan(1000);
    expect(raw.universal).toBeLessThan(1000);
    expect(raw.rawMaxDamage).toBeCloseTo(
      Math.max(...Object.values(raw.destroyedPointsByTarget)),
      8
    );

    // Слоты различаются: у Abominant (S-профиль против T11+) броня выгоднее пехоты.
    const abominant = find('Abominant');
    const adapted = adaptUnit(abominant, { size: 'min' });
    const heavy = rawScoreOf(abominant, adapted.unit, adapted.points, fast);
    expect(heavy.vsArmor).toBeGreaterThan(heavy.vsInfantry);
    expect(heavy.bestTarget).toBeTruthy();
  });

  it('штраф применяется к урону и живучести', () => {
    const datasheet = find('Ghazghkull Thraka');
    const { unit, points } = adaptUnit(datasheet, { size: 'min' });
    const raw = rawScoreOf(datasheet, unit, points, fast);
    if (raw.unitType === 'Melee') {
      expect(raw.tax.damage).toBeLessThan(1);
      expect(raw.effectiveDamage).toBeCloseTo(raw.rawMaxDamage * raw.tax.damage, 10);
      expect(raw.effectiveSurvivability).toBeCloseTo(
        raw.baseSurvivability * raw.tax.survivability,
        10
      );
    }
  });

  it('живучесть направлена так же, как урон: больше = лучше', () => {
    // Крепкая цель должна получать меньше пережитого урона на 100 очков.
    const soft = rawScoreOf(find('Intercessor Squad'), ...parts('Intercessor Squad'), fast);
    const tough = rawScoreOf(find('Leman Russ Battle Tank'), ...parts('Leman Russ Battle Tank'), fast);
    expect(tough.takenPer100).toBeLessThan(soft.takenPer100);
    expect(tough.baseSurvivability).toBeGreaterThan(soft.baseSurvivability);
  });
});

/** Адаптированный отряд и очки для проверок. */
function parts(name: string): [ReturnType<typeof adaptUnit>['unit'], number] {
  const { unit, points } = adaptUnit(find(name), { size: 'min' });
  return [unit, points];
}


describe('режим боя', () => {
  // Intercessor Squad — эталон «и стреляет, и бьёт»: болтер + силовой меч.
  const datasheet = find('Intercessor Squad');
  const { unit, points } = adaptUnit(datasheet, { size: 'min' });

  it('ranged берёт только стрелковый урон', () => {
    const combined = rawScoreOf(datasheet, unit, points, fast);
    const ranged = rawScoreOf(datasheet, unit, points, { ...fast, mode: 'ranged' });
    // В режиме стрельбы игнорируется рукопашная составляющая.
    expect(ranged.universal).toBeLessThan(combined.universal);
    expect(ranged.universal).toBeGreaterThan(0);
  });

  it('melee берёт только рукопашный урон', () => {
    const combined = rawScoreOf(datasheet, unit, points, fast);
    const melee = rawScoreOf(datasheet, unit, points, { ...fast, mode: 'melee' });
    expect(melee.universal).toBeLessThan(combined.universal);
    expect(melee.universal).toBeGreaterThan(0);
  });

  it('у юнита без рукопашного оружия режим melee даёт нулевой урон', () => {
    // У техники в BSData есть таран «Armoured Hull» (A3 WS4 S6), поэтому Leman Russ
    // не подходит — убираем рукопашные профили вручную.
    const tank = find('Leman Russ Battle Tank');
    const adapted = adaptUnit(tank, { size: 'min' });
    const gunOnly = {
      ...adapted.unit,
      models: adapted.unit.models.map((model) => ({
        ...model,
        weapons: model.weapons.filter((weapon) => weapon.kind === 'ranged'),
      })),
    };
    const melee = rawScoreOf(tank, gunOnly, adapted.points, { ...fast, mode: 'melee' });
    const ranged = rawScoreOf(tank, gunOnly, adapted.points, { ...fast, mode: 'ranged' });
    expect(melee.rawMaxDamage).toBe(0);
    expect(ranged.rawMaxDamage).toBeGreaterThan(0);
  });

  it('у юнита без стрельбы режим ranged даёт нулевой урон', () => {
    const meleeOnly = {
      ...unit,
      models: unit.models.map((model) => ({
        ...model,
        weapons: model.weapons.filter((weapon) => weapon.kind === 'melee'),
      })),
    };
    const ranged = rawScoreOf(datasheet, meleeOnly, points, { ...fast, mode: 'ranged' });
    expect(ranged.rawMaxDamage).toBe(0);
  });

  it('по умолчанию режим combined', () => {
    const combined = rawScoreOf(datasheet, unit, points, fast);
    const explicit = rawScoreOf(datasheet, unit, points, { ...fast, mode: 'combined' });
    expect(explicit.universal).toBeCloseTo(combined.universal, 8);
  });

  it('в тирлисте режим меняет и тиры', () => {
    const entries = ['Intercessor Squad', 'Boyz', 'Leman Russ Battle Tank', 'Deff Dread'].map((name) => {
      const sheet = find(name);
      const adapted = adaptUnit(sheet, { size: 'min' });
      return { datasheet: sheet, unit: adapted.unit, points: adapted.points };
    });
    const combined = tierList(entries, fast);
    const ranged = tierList(entries, { ...fast, mode: 'ranged' });
    expect(combined).toHaveLength(ranged.length);
    // Порядок обязан отличаться: танк в стрельбе хорош, в рукопашной — нет.
    const order = (rows: typeof combined): string[] => rows.map((row) => row.name);
    expect(order(combined)).not.toEqual(order(ranged));
  });
});

  it('тирлист исключает модели дороже 2000 очков и [Legends]', () => {
    const expensive = find('Manta');
    const expensiveUnit = adaptUnit(expensive, { size: 'min' });
    expect(expensiveUnit.points).toBeGreaterThan(2000);

    const legends = find('Crisis Battlesuits [Legends]');
    const legendsUnit = adaptUnit(legends, { size: 'min' });

    const entries = ['Intercessor Squad', 'Boyz'].map((name) => {
      const datasheet = find(name);
      const adapted = adaptUnit(datasheet, { size: 'min' });
      return { datasheet, unit: adapted.unit, points: adapted.points };
    });
    entries.push({ datasheet: expensive, unit: expensiveUnit.unit, points: expensiveUnit.points });
    entries.push({ datasheet: legends, unit: legendsUnit.unit, points: legendsUnit.points });

    const rows = tierList(entries, fast);
    expect(rows).toHaveLength(2);
    expect(rows.some((row) => row.id === expensive.id)).toBe(false);
    expect(rows.some((row) => row.id === legends.id)).toBe(false);
  });

describe('тирлист', () => {
    const names = [
      'Intercessor Squad',
      'Boyz',
      'Deff Dread',
      'Leman Russ Battle Tank',
      'Hormagaunts',
      'Killa Kans',
      'Warboss',
    ];
  const entries = names
    .map((name) => {
      const datasheet = find(name);
      const { unit, points } = adaptUnit(datasheet, { size: 'min' });
      return { datasheet, unit, points };
    })
    .filter((entry) => entry.unit.models.length > 0);

  it('Ancient образует сочетания с отрядами Astartes', () => {
    const ancient = leaderDefinitionsOf(datasheets).find((leader) => leader.name === 'Ancient');
    expect(ancient).toBeDefined();
    const allowed = new Set(ancient?.allowedUnitIds ?? []);
    const intercessors = find('Intercessor Squad');
    expect(allowed.has(intercessors.id)).toBe(true);

    const adapted = adaptUnit(intercessors, { size: 'min' });
    const attached = attachLeaderToUnit(adapted.unit, ancient!);
    expect(attached.name).toBe('Intercessor Squad + Ancient');
    expect(attached.models.length).toBe(adapted.unit.models.length + (ancient?.unit.models.length ?? 0));
  });

  it('находит поддержку без кейворда Leader/Support и сохраняет чаптерные пары', () => {
    const definitions = leaderDefinitionsOf(datasheets);
    const techPriest = definitions.find((leader) => leader.name === 'Tech-Priest Dominus');
    expect(techPriest?.faction).toBe('Adeptus Mechanicus');
    expect(techPriest?.allowedUnitIds.length).toBeGreaterThan(0);

    const lysander = definitions.find((leader) => leader.name === 'Darnath Lysander');
    expect(lysander?.faction).toBe('Imperial Fists');
    expect(lysander?.allowedUnitIds.length).toBeGreaterThan(0);
  });

  it('строка содержит нормированные величины и тир', () => {
    const rows = tierList(entries, fast);
    expect(rows).toHaveLength(entries.length);
    for (const row of rows) {
      expect(row.totalScore, row.name).toBeGreaterThanOrEqual(0);
      expect(row.totalScore, row.name).toBeLessThanOrEqual(100);
      expect(['S', 'A', 'B', 'C', 'D']).toContain(row.tier);
      expect(row.utilityScore, row.name).toBeLessThanOrEqual(UTILITY_MAX);
    }
  });

  it('Total считается по заданным весам', () => {
    const rows = tierList(entries, fast);
    for (const row of rows) {
      const expected =
        row.normDamage * SCORE_WEIGHTS.damage +
        row.normSurvivability * SCORE_WEIGHTS.survivability +
        row.normUtility * SCORE_WEIGHTS.utility;
      expect(row.totalScore, row.name).toBeCloseTo(expected, 8);
    }
  });

  it('строки отсортированы по убыванию Total', () => {
    const rows = tierList(entries, fast);
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i - 1].totalScore).toBeGreaterThanOrEqual(rows[i].totalScore);
    }
  });

  it('тир тем выше, чем больше перцентиль', () => {
    const rows = tierList(entries, fast);
    const rank = { S: 5, A: 4, B: 3, C: 2, D: 1 } as const;
    for (let i = 1; i < rows.length; i += 1) {
      expect(rank[rows[i - 1].tier], `${rows[i - 1].name} → ${rows[i].name}`).toBeGreaterThanOrEqual(
        rank[rows[i].tier]
      );
    }
  });

  it('нормализация одинакова для всех юнитов набора', () => {
    const rows = tierList(entries, fast);
    const damages = rows.map((row) => row.normDamage);
    expect(Math.max(...damages)).toBeCloseTo(100, 6);
    expect(Math.min(...damages)).toBeCloseTo(0, 6);
  });

  it('перцентили покрывают весь диапазон, а не прилипают к нулю', () => {
    // Регрессия: раньше перцентиль считался как само значение Total, который
    // не достигает 100, и весь набор (кроме единиц) уезжал в тир D.
    const rows = tierList(entries, fast);
    const percentiles = rows.map((row) => row.percentile);
    expect(Math.max(...percentiles)).toBeCloseTo(100, 6);
    expect(Math.min(...percentiles)).toBeCloseTo(0, 6);
    // Лучший юнит набора обязан быть выше 90-го перцентиля.
    expect(rows[0].tier).toBe('S');
    // Худший — ниже 25-го.
    expect(rows[rows.length - 1].tier).toBe('D');
  });
});

