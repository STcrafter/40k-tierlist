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
  residualizeOnLogPoints,
  SCORE_WEIGHTS,
  tierByGroup,
  tierList,
  tierOf,
} from './scoring.ts';
import { detectUtilityFlags, utilityScoreOf, UTILITY_MAX, UTILITY_POINTS } from './utility.ts';
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

  it('OC 3+ даёт 1 балл', () => {
    // Замер на 1093 юнитах: OC 3+ встречался у 27.6% набора, но в S-тир
    // попадал в 82.7% — самый высокий подъём среди флагов. Способность почти
    // не влияет на исход боя, поэтому и стоит 1 балл, а не 2.
    const flags = detectUtilityFlags(find('Abaddon the Despoiler'));
    expect(flags.find((flag) => flag.id === 'OC_3+')?.points).toBe(1);
  });

  it('Infiltrator и Scouts стоят дороже OC', () => {
    // Оба решают ввод в бой вне фазы развёртывания — редкие и решающие.
    expect(UTILITY_POINTS.Infiltrator).toBeGreaterThan(UTILITY_POINTS['OC_3+']);
    expect(UTILITY_POINTS.Scouts).toBeGreaterThan(UTILITY_POINTS['OC_3+']);
  });

  it('способность, которую отряд ПОТЕРЯЛ, не засчитывается', () => {
    // Регрессия: в BSData есть апгрейды «it loses the Scouts 9" ability».
    // Без вырезания отрицаний такие отряды считались бы обладателями Scouts.
    const lost = detectUtilityFlags(find('Front-line Commander [Crucible]'));
    expect(lost.some((flag) => flag.id === 'Scouts')).toBe(false);
  });

  it('дым определяется по кейворду SMOKE', () => {
    // 188 юнитов BSData несут кейворд SMOKE — это структурное поле, а не текст.
    const flags = detectUtilityFlags(find('Baneblade'));
    expect(flags.some((flag) => flag.id === 'Smoke')).toBe(true);
  });

  it('дым даётся и способностью, выдающей кейворд', () => {
    // Не у всех носителей SMOKE это кейворд даташита: у Achilles Ridgerunners
    // его даёт способность «Flare launcher» («has the SMOKE keyword»).
    const byAbility = detectUtilityFlags(find('Achilles Ridgerunners'));
    const byKeyword = detectUtilityFlags(find('Baneblade'));
    expect(byKeyword.find((flag) => flag.id === 'Smoke')?.points).toBe(UTILITY_POINTS.Smoke);
    expect(byAbility.find((flag) => flag.id === 'Smoke')?.points).toBe(UTILITY_POINTS.Smoke);
  });

  it('юнит с OC 2 флага OC_3+ не получает', () => {
    expect(detectUtilityFlags(find('Intercessor Squad')).some((f) => f.id === 'OC_3+')).toBe(
      false
    );
  });

  it('сумма ограничена потолком 20', () => {
    // Баллы намеренно копим выше потолка, чтобы проверить обрезку.
    const flags = [
      { id: 'Deep_Strike' as const, points: 3, reason: '' },
      { id: 'Infiltrator' as const, points: 3, reason: '' },
      { id: 'Scouts' as const, points: 3, reason: '' },
      { id: 'Reserves' as const, points: 2, reason: '' },
      { id: 'FNP_6+' as const, points: 2, reason: '' },
      { id: 'FNP_5+' as const, points: 2, reason: '' },
      { id: 'Stealth' as const, points: 2, reason: '' },
      { id: 'Smoke' as const, points: 2, reason: '' },
      { id: 'Screening' as const, points: 3, reason: '' },
      { id: 'OC_3+' as const, points: 1, reason: '' },
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

  it('tierOf по перцентилю оставлен для совместимости', () => {
    // Сами тиры теперь назначает naturalBreaks + tierByGroup; эта функция
    // осталась только для внешних отчётов.
    expect(tierOf(95)).toBe('S');
    expect(tierOf(80)).toBe('A');
    expect(tierOf(60)).toBe('B');
    expect(tierOf(30)).toBe('C');
    expect(tierOf(10)).toBe('D');
  });

  it('tierByGroup сопоставляет группы тирам по возрастанию', () => {
    expect(tierByGroup(0)).toBe('D');
    expect(tierByGroup(1)).toBe('C');
    expect(tierByGroup(2)).toBe('B');
    expect(tierByGroup(3)).toBe('A');
    expect(tierByGroup(4)).toBe('S');
    // Вне диапазона не вылетает.
    expect(tierByGroup(-3)).toBe('D');
    expect(tierByGroup(99)).toBe('S');
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

    // Слоты различаются: у Cerastus Knight Lancer (копьё = +1 к ранению,
    // антиброневый профиль) техника выгоднее пехоты.
    //
    // Раньше здесь стоял Abominant, но после перехода на кластеры это
    // перестало быть верным: его цеп и S-профиль пробивают пехоту, а новые
    // armor-цели (T9/W11 … T12/W26) он уже не продавливает. Это не регресс
    // модели, а смена определения «броня» — ручной список типов был мягче.
    const lancer = find('Cerastus Knight Lancer');
    const adapted = adaptUnit(lancer, { size: 'min' });
    const heavy = rawScoreOf(lancer, adapted.unit, adapted.points, fast);
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
    expect(lysander?.faction).toBe('Adeptus Astartes');
    expect(lysander?.factions).toContain('Imperial Fists');
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

  it('векторная шкала сжата в диапазон и не прилипает к краям', () => {
    // Регрессия min-max: раньше metrics[0] всегда равнялась ровно 100, и
    // одного удачного матчапа хватало для верха шкалы. Теперь 100 и 0
    // недостижимы для набора, где никто не доминирует по всем целям сразу,
    // но разброс по юнитам сохраняется.
    const rows = tierList(entries, fast);
    const damages = rows.map((row) => row.normDamage);
    for (const value of damages) {
      expect(value, 'значение на шкале 0–100').toBeGreaterThanOrEqual(0);
      expect(value, 'значение на шкале 0–100').toBeLessThanOrEqual(100);
    }
    const min = Math.min(...damages);
    const max = Math.max(...damages);
    // Ширина шкалы: верх и низ заметно разделены, иначе все юниты слиплись бы.
    expect(max - min).toBeGreaterThan(20);
    // Никто не забирает весь верх шкалы: это и есть смысл векторной модели.
    expect(max).toBeLessThan(100);
    expect(min).toBeGreaterThan(0);
  });

  it('один удачный матчап не поднимает юнита до верха шкалы', () => {
    // Ключевое свойство векторной модели: узкий специалист (силён против
    // одной цели, слаб против остальных) не должен получать максимум.
    const rows = tierList(entries, fast);
    for (const row of rows) {
      const components = Object.values(row.effectiveOffenseVector);
      if (components.length < 2) continue;
      const best = Math.max(...components);
      const worst = Math.min(...components);
      if (best === worst) continue;
      // Специалист обязан быть заметно ниже юнита, равномерно сильного.
      expect(row.vectorDamageFloor).toBeLessThanOrEqual(row.normDamage + 1e-9);
      expect(row.normDamage).toBeLessThan(100);
    }
  });

  it('векторы урона и защиты заполнены по всем компонентам', () => {
    const rows = tierList(entries, fast);
    for (const row of rows) {
      expect(Object.keys(row.effectiveOffenseVector).length, row.name).toBeGreaterThan(0);
      expect(Object.keys(row.defenseVector).length, row.name).toBeGreaterThan(0);
      for (const [group, value] of Object.entries(row.defenseVector)) {
        expect(Number.isFinite(value), `${row.name}/${group}`).toBe(true);
        expect(value, `${row.name}/${group}`).toBeGreaterThan(0);
      }
      // Нижний квартиль не может превышать среднее по рангам.
      expect(row.vectorDamageFloor).toBeLessThanOrEqual(row.vectorDamageScore + 1e-9);
      expect(row.vectorSurvivabilityFloor).toBeLessThanOrEqual(row.vectorSurvivabilityScore + 1e-9);
    }
  });

  it('в режиме стрельбы melee-штраф не применяется', () => {
    // Рукопашная фаза в 'ranged' не участвует — штраф за неё был бы двойным.
    const meleeFirst = entries.find((entry) => entry.datasheet.name === 'Boyz');
    if (meleeFirst === undefined) return;
    const ranged = rawScoreOf(
      meleeFirst.datasheet,
      meleeFirst.unit,
      meleeFirst.points,
      { ...fast, mode: 'ranged' }
    );
    expect(ranged.tax.damage).toBe(1);
    expect(ranged.tax.survivability).toBe(1);
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


/** Пирсонова корреляция — для проверки, что остатки действительно убирают связь. */
function pearson(xs: number[], ys: number[]): number {
  if (xs.length !== ys.length || xs.length < 2) return 0;
  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < xs.length; i += 1) {
    cov += (xs[i] - meanX) * (ys[i] - meanY);
    varX += (xs[i] - meanX) ** 2;
    varY += (ys[i] - meanY) ** 2;
  }
  if (varX === 0 || varY === 0) return 0;
  return cov / Math.sqrt(varX * varY);
}

describe('остаточная нормализация живучести', () => {
  it('остатки ортогональны log(цены) по построению', () => {
    // Ключевое свойство МНК-остатков: их сумма равна нулю и ковариация с
    // регрессором равна нулю. Именно это, а не корреляция Пирсона, означает
    // «остаток не содержит информации о цене». (Пирсон тут даёт ±0.5: при
    // трёх точках и двух параметрах остаётся одна степень свободы.)
    const points = [20, 50, 100, 200, 400, 800, 1600];
    const values = [30, 45, 55, 70, 80, 95, 105];
    const xs = points.map(Math.log);
    const residuals = residualizeOnLogPoints(points, values);

    expect(residuals.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 8);
    const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
    const meanR = residuals.reduce((a, b) => a + b, 0) / residuals.length;
    const cov = xs.reduce((sum, x, i) => sum + (x - meanX) * (residuals[i] - meanR), 0);
    expect(cov).toBeCloseTo(0, 6);
  });

  it('юнит, живучесть которого выше тренда цены, получает положительный остаток', () => {
    // Строим «обычный» тренд в log(цене) и один выброс: дешёвый юнит, который
    // живучее, чем предсказывает его цена. Именно его модель должна награждать.
    const points = [50, 100, 200, 400, 800];
    const trend = points.map((point) => 20 + 30 * Math.log(point / 50));
    const values = [...trend];
    values[0] += 25; // дешёвый юнит аномально живучий для своей цены
    const residuals = residualizeOnLogPoints(points, values);
    expect(residuals[0]).toBeGreaterThan(5);
    // Дорогие юниты, лежащие на тренде, остаются около нуля.
    expect(Math.abs(residuals[4])).toBeLessThan(Math.abs(residuals[0]));
  });

  it('корреляция цены и живучести падает после регрессии', () => {
    // Нужно достаточно точек: при n=3 остаток ровно один и корреляция Пирсона
    // с одним элементом бессмысленна (всегда ±1).
    const points = [20, 50, 100, 200, 400, 800, 1600];
    const values = [30, 45, 55, 70, 80, 95, 105];
    const xs = points.map(Math.log);
    const before = pearson(xs, values);
    const after = pearson(xs, residualizeOnLogPoints(points, values));
    expect(before).toBeGreaterThan(0.9);
    expect(Math.abs(after)).toBeLessThan(Math.abs(before));
  });

  it('вырожденные случаи не дают NaN', () => {
    expect(residualizeOnLogPoints([], [])).toEqual([]);
    expect(residualizeOnLogPoints([100], [50])).toEqual([0]);
    // Все юниты одной цены — дисперсия log(цены) нулевая.
    const same = residualizeOnLogPoints([100, 100, 100], [10, 20, 30]);
    for (const value of same) expect(Number.isFinite(value)).toBe(true);
  });

  it('в тирлисте живучесть больше не награждает за цену', () => {
    // Сквозная проверка на реальных даташитах: после остаточной нормализации
    // связь log(цены) с нормированной живучестью должна исчезнуть. До правки
    // она была r ≈ 0.69, из-за чего верх живучести занимали титаны.
    // Набор — 50 равномерно взятых юнитов, чтобы тест не гонял все 1093.
    const entries = datasheets
      .filter((sheet) => !sheet.name.includes('[Legends]'))
      .map((sheet) => {
        const adapted = adaptUnit(sheet, { size: 'min' });
        return { datasheet: sheet, unit: adapted.unit, points: adapted.points };
      })
      .filter((entry) => entry.unit.models.length > 0 && entry.points > 0)
      .filter((_, index) => index % 20 === 0)
      .slice(0, 50);
    expect(entries.length).toBeGreaterThanOrEqual(30);

    const rows = tierList(entries, {
      combat: { trials: 3, distance: 12 },
      survival: { trials: 3, maxRounds: 8, distance: 12 },
    });
    const costs = rows.map((row) => Math.log(Math.max(1, row.points)));
    const survivability = rows.map((row) => row.normSurvivability);
    expect(Math.abs(pearson(costs, survivability))).toBeLessThan(0.25);
  });
});

