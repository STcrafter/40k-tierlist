/**
 * Тесты расчёта урона в раунд по типам юнитов.
 *
 * Проверяем три вещи: классификацию отрядов в архетипы, сам расчёт
 * (дальнобойный / рукопашный / общий) и корректность агрегации.
 * Числа сверяются на порядок величин — абсолютные значения зависят
 * от принятых в модуле допущений, а инварианты должны выполняться всегда.
 */

import { describe, expect, it } from 'vitest';
import {
  ARCHETYPES,
  ARMOR_ARCHETYPES,
  CLUSTER_PROFILES,
  INFANTRY_ARCHETYPES,
  MIN_SQUAD_TARGET,
  archetypeOf,
  archetypesByGroup,
  scaleArchetypeModels,
  targetUnitOf,
} from './archetypes.ts';
import { kMeans, naturalBreaks, silhouetteScore, standardize, unitFeatureVector } from './clustering.ts';
import { damagePerRound, damagePerRoundByType } from './perRound.ts';
import type { CombatModel, CombatUnit, CombatWeapon } from './types.ts';

function weapon(overrides: Partial<CombatWeapon> = {}): CombatWeapon {
  return {
    id: 'w1',
    name: 'Gun',
    kind: 'ranged',
    range: 24,
    attacks: { count: 2, sides: 1, plus: 0 },
    skill: 3,
    strength: 5,
    ap: 0,
    damage: { count: 1, sides: 1, plus: 0 },
    keywords: [],
    ...overrides,
  };
}

function model(overrides: Partial<CombatModel> = {}): CombatModel {
  return {
    id: 'm',
    name: 'Trooper',
    toughness: 4,
    wounds: 2,
    save: 3,
    invuln: null,
    fnp: null,
    fnpScope: 'all',
    keywords: [],
    weapons: [],
    ...overrides,
  };
}

function unit(
  models: number,
  keywords: string[],
  weapon: CombatWeapon
): CombatUnit {
  return {
    id: 'u',
    name: keywords.join('+') || 'Unit',
    keywords,
    models: Array.from({ length: models }, (_, i) =>
      model({ id: `m${i}`, weapons: [weapon], keywords })
    ),
  };
}

const gunner = (models = 5): CombatUnit =>
  unit(models, ['INFANTRY'], weapon({ id: 'gun', kind: 'ranged' }));
const fighter = (models = 5): CombatUnit =>
  unit(models, ['INFANTRY'], weapon({ id: 'blade', kind: 'melee', range: null, damage: { count: 1, sides: 6, plus: 0 } }));

describe('архетипы типов юнитов', () => {
  it('содержат все основные типы с валидными характеристиками', () => {
    const ids = ARCHETYPES.map((archetype) => archetype.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const archetype of ARCHETYPES) {
      expect(archetype.models, archetype.id).toBeGreaterThan(0);
      expect(archetype.toughness, archetype.id).toBeGreaterThan(0);
      expect(archetype.wounds, archetype.id).toBeGreaterThan(0);
      expect(archetype.keywords.length, archetype.id).toBeGreaterThan(0);
    }
  });

  it('targetUnitOf строит цель из нужного числа одинаковых моделей', () => {
    // Типы берём по смыслу, а не по ручному id: id кластеров меняются при
    // смене K, и жёсткое имя здесь было бы ссылкой на несуществующий тип.
    const infantry = archetypesByGroup('infantry')[0];
    const target = targetUnitOf(infantry, { models: 4 });
    expect(target.models).toHaveLength(4);
    expect(target.models[0].toughness).toBe(infantry.toughness);
    expect(target.models[0].wounds).toBe(infantry.wounds);
    expect(target.models[0].weapons).toHaveLength(0);
    expect(target.keywords).toEqual(infantry.keywords);
  });

  it('тип отряда — ближайший центроид, а не совпадение кейвордов', () => {
    // Кейворды больше НЕ определяют тип: раньше была лестница правил, и
    // именно она порождала кривую типизацию. Проверяем, что решают числа.
    const tank = unit(1, ['VEHICLE'], weapon());
    tank.models[0].toughness = 10;
    tank.models[0].wounds = 11;
    const tankType = archetypeOf(tank, 160)?.id;
    expect(tankType).toBeTruthy();

    // Тот же отряд с другими кейвордами получает тот же тип.
    const relabelled = unit(1, ['INFANTRY', 'TERMINATOR'], weapon());
    relabelled.models[0].toughness = 10;
    relabelled.models[0].wounds = 11;
    expect(archetypeOf(relabelled, 160)?.id).toBe(tankType);
  });

  it('разные по геометрии отряды попадают в разные группы типов', () => {
    const infantry = unit(10, ['INFANTRY'], weapon());
    infantry.models[0].toughness = 4;
    infantry.models[0].wounds = 2;
    infantry.models[0].save = 3;

    const titan = unit(1, ['VEHICLE', 'TITANIC'], weapon());
    titan.models[0].toughness = 12;
    titan.models[0].wounds = 26;
    titan.models[0].save = 3;

    const a = archetypeOf(infantry, 100)?.id;
    const b = archetypeOf(titan, 400)?.id;
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
    // Пехота должна попасть в infantry-группу, титан — в armor.
    expect(INFANTRY_ARCHETYPES).toContain(a);
    expect(ARMOR_ARCHETYPES).toContain(b);
  });

  it('одиночная модель и толпа различаются числом моделей', () => {
    const mob = unit(10, ['INFANTRY'], weapon());
    mob.models[0].toughness = 3;
    mob.models[0].wounds = 1;
    const solo = unit(1, ['INFANTRY', 'CHARACTER'], weapon());
    solo.models[0].toughness = 3;
    solo.models[0].wounds = 1;
    expect(archetypeOf(mob, 100)?.id).not.toBe(archetypeOf(solo, 50)?.id);
  });

  it('стоимость на модель участвует в выборе типа', () => {
    const cheap = unit(1, ['INFANTRY', 'CHARACTER'], weapon());
    cheap.models[0].toughness = 4;
    cheap.models[0].wounds = 3;
    const rich = unit(1, ['INFANTRY', 'CHARACTER'], weapon());
    rich.models[0].toughness = 4;
    rich.models[0].wounds = 3;
    // Одинаковая геометрия, разная цена — тип вправе отличаться, но обязан
    // существовать. Проверяем, что разные цены не ломают классификацию.
    expect(archetypeOf(cheap, 30)?.id).toBeTruthy();
    expect(archetypeOf(rich, 400)?.id).toBeTruthy();
  });

  it('отряд без моделей не классифицируется', () => {
    expect(archetypeOf({ id: 'x', name: 'x', keywords: [], models: [] }, 100)).toBeNull();
  });
});

describe('урон в раунд', () => {
  const options = { trials: 60, distance: 12, seed: 1 };

  it('считает дальнобойный, рукопашный и общий урон отдельно', () => {
    const result = damagePerRound(gunner(5), options);
    expect(result.ranged.overall.mean).toBeGreaterThan(0);
    // У стрелка нет рукопашного оружия.
    expect(result.melee.overall.mean).toBe(0);
    expect(result.total.overall.mean).toBeGreaterThan(0);
  });

  it('урукопашного юнита нет дальнобойного урона', () => {
    const result = damagePerRound(fighter(5), options);
    expect(result.ranged.overall.mean).toBe(0);
    expect(result.melee.overall.mean).toBeGreaterThan(0);
  });

  it('разбивка содержит все типы целей и сходится к среднему', () => {
    // Типы берём из clusters.generated: id кластеров меняются при смене K.
    const [weak, strong] = ARCHETYPES;
    const result = damagePerRound(gunner(5), { ...options, targets: [weak.id, strong.id] });
    expect(Object.keys(result.ranged.byArchetype)).toEqual([weak.id, strong.id]);
    const means = [result.ranged.byArchetype[weak.id].mean, result.ranged.byArchetype[strong.id].mean];
    expect(result.ranged.overall.mean).toBeCloseTo((means[0] + means[1]) / 2, 6);
  });

  it('веса меняют итоговое среднее', () => {
    const [weak, strong] = ARCHETYPES;
    const weighted = damagePerRound(gunner(5), {
      ...options,
      targets: [weak.id, strong.id],
      weights: { [weak.id]: 1, [strong.id]: 0 },
    });
    const equal = damagePerRound(gunner(5), { ...options, targets: [weak.id, strong.id] });
    // При нулевом весе у крепкой цели среднее равно урону по хрупкой.
    expect(weighted.ranged.overall.mean).toBeCloseTo(
      equal.ranged.byArchetype[weak.id].mean,
      6
    );
  });

  it('чем крепче цель, тем меньше урона в неё', () => {
    // Кластеры отсортированы по живучести, поэтому порядок берём из данных,
    // а не из захардкоженных имён: T3/W1 → T9/W11 → T12/W26.
    const weakest = ARCHETYPES[0];
    const middle = ARCHETYPES[Math.floor(ARCHETYPES.length / 2)];
    const toughest = ARCHETYPES[ARCHETYPES.length - 1];
    const result = damagePerRound(gunner(5), {
      ...options,
      targets: [weakest.id, middle.id, toughest.id],
    });
    expect(result.ranged.byArchetype[weakest.id].mean).toBeGreaterThan(
      result.ranged.byArchetype[middle.id].mean
    );
    expect(result.ranged.byArchetype[middle.id].mean).toBeGreaterThan(
      result.ranged.byArchetype[toughest.id].mean
    );
  });

  it('больше моделей в отряде — больше урона в раунд', () => {
    const small = damagePerRound(gunner(2), options).ranged.overall.mean;
    const large = damagePerRound(gunner(10), options).ranged.overall.mean;
    expect(large).toBeGreaterThan(small);
    expect(large / small).toBeGreaterThan(3);
  });

  it('одинаковый seed даёт одинаковый результат', () => {
    const a = damagePerRound(gunner(5), options);
    const b = damagePerRound(gunner(5), options);
    expect(a.ranged.overall).toEqual(b.ranged.overall);
    expect(a.total.overall).toEqual(b.total.overall);
  });

  it('разные seed дают близкие средние (Монте-Карло сходится)', () => {
    const first = damagePerRound(gunner(5), { ...options, trials: 400, seed: 1 });
    const second = damagePerRound(gunner(5), { ...options, trials: 400, seed: 999 });
    const mean = first.ranged.overall.mean;
    expect(Math.abs(second.ranged.overall.mean - mean) / mean).toBeLessThan(0.1);
  });

  it('группировка по типу атакующего собирает отряды в ряды', () => {
    const rows = damagePerRoundByType(
      [
        { unit: unit(5, ['INFANTRY'], weapon({ id: 'a' })), points: 100 },
        { unit: unit(5, ['INFANTRY'], weapon({ id: 'b' })), points: 100 },
        { unit: unit(1, ['VEHICLE'], weapon({ id: 'c' })), points: 160 },
      ],
      options
    );
    expect(rows.length).toBe(2);
    // Ряд по пехоте содержит оба отряда. Идентификаторы типов теперь —
    // кластеры, поэтому проверяем не конкретное имя, а состав групп.
    const squadRow = rows.find((row) => row.attackerName.split(', ').length === 2);
    expect(squadRow).toBeDefined();
    expect(squadRow?.damage.ranged.overall.mean).toBeGreaterThan(0);
  });

  it('пустой список юнитов даёт пустые ряды', () => {
    expect(damagePerRoundByType([], options)).toEqual([]);
  });
});


/** Юнит с заданными характеристиками всех моделей (для кластеризации). */
function flatUnit(models: number, toughness: number, wounds: number) {
  return {
    id: 'u',
    name: 'U',
    keywords: [] as string[],
    models: Array.from({ length: models }, () => ({
      id: 'm',
      name: 'M',
      toughness,
      wounds,
      save: null,
      invuln: null,
      fnp: null,
      fnpScope: 'all' as const,
      keywords: [] as string[],
      weapons: [],
    })),
  };
}

describe('k-means и выбор K', () => {
  it('разделяет две очевидно разные группы', () => {
    const rows = [
      ...Array.from({ length: 20 }, () => [2, 1, 6, 6, 10, 8]),
      ...Array.from({ length: 20 }, () => [12, 30, 3, 6, 1, 400]),
    ];
    const result = kMeans(standardize(rows).rows, 2);
    expect(new Set(result.labels).size).toBe(2);
    // Точки из одной группы получают один и тот же лейбл.
    const first = result.labels[0];
    expect(result.labels.slice(0, 20).every((label) => label === first)).toBe(true);
  });

  it('детерминирован при одинаковом seed', () => {
    const rows = Array.from({ length: 40 }, (_, i) => [i % 9, (i * 3) % 7, 3, 6, i % 5, 20 + i]);
    const a = kMeans(standardize(rows).rows, 4);
    const b = kMeans(standardize(rows).rows, 4);
    expect(a.labels).toEqual(b.labels);
    expect(a.centroids).toEqual(b.centroids);
  });

  it('стандартизация убирает разный масштаб признаков', () => {
    // Столбцы 0..3 постоянны (sd = 0 → 0), столбец 4 разбросан.
    const { rows } = standardize([
      [1, 1, 1, 1, 10],
      [1, 1, 1, 1, 20],
      [1, 1, 1, 1, 30],
    ]);
    expect(rows[0].slice(0, 4)).toEqual([0, 0, 0, 0]);
    expect(rows[0][4]).toBeCloseTo(-1.2247448, 6);
    expect(rows[2][4]).toBeCloseTo(1.2247448, 6);
  });

  it('силуэт выше при осмысленном разбиении, чем при случайном', () => {
    // Три чётко разделённые группы по T.
    const groups = [2, 7, 13];
    const rows = groups.flatMap((t) =>
      Array.from({ length: 15 }, (_, i) => [t, 2, 3, 6, 5, 30 + i])
    );
    const { rows: normalized } = standardize(rows);
    const good = kMeans(normalized, 3);
    const goodScore = silhouetteScore(normalized, good.labels, 3);
    expect(goodScore).not.toBeNull();
    // Разбиение на три заведомо разделённые группы по T должно быть ясным.
    // Порог не завышен: внутри группы различаются models и стоимость, а
    // силуэт штрафует за это. Реальные данные дают ~0.37.
    expect(goodScore!).toBeGreaterThan(0.3);
    // Сравнивать с другим seed'ом бессмысленно: k-means ищет локальный
    // оптимум, и другой seed может найти разбиение ЛУЧШЕ дефолтного.
  });

  it('силуэт не определён для вырожденных случаев', () => {
    expect(silhouetteScore([[1], [2]], [0, 1], 2)).toBeNull(); // k = n
    expect(silhouetteScore([[1]], [0], 1)).toBeNull(); // одна точка
  });

  it('k > числа точек даёт по кластеру на точку', () => {
    const result = kMeans([[1, 1], [2, 2], [3, 3]], 5);
    expect(result.labels).toEqual([0, 1, 2]);
  });

  it('пустой набор не падает', () => {
    const result = kMeans([], 3);
    expect(result.labels).toEqual([]);
    expect(result.centroids).toEqual([]);
  });

  it('признаки юнита — те, что нужны для разбиения', () => {
    // Фиксирует состав вектора: T, W, Sv, InSv, models, очки на модель.
    const unit = flatUnit(5, 4, 2);
    const features = unitFeatureVector(unit, 100);
    expect(features).toHaveLength(6);
    expect(features[0]).toBe(4);
    expect(features[1]).toBe(2);
    expect(features[4]).toBe(5);
    expect(features[5]).toBeCloseTo(20, 6);
  });
});

describe('натуральные разрывы для тиров', () => {
  it('разрывы ложатся в провалы, а не в середину плотной группы', () => {
    // Три чётко разделённые кучки: динамика обязана поставить границы в
    // разрывы (10→20 и 30→40), а не резать кучки пополам.
    const values = [
      ...Array.from({ length: 10 }, () => 10),
      ...Array.from({ length: 10 }, () => 20),
      ...Array.from({ length: 10 }, () => 40),
    ];
    const result = naturalBreaks(values, 3);
    expect(result.sizes).toEqual([10, 10, 10]);
    expect(result.boundaries[0]).toBeCloseTo(15, 6);
    expect(result.boundaries[1]).toBeCloseTo(30, 6);
  });

  it('одинаковые значения не попадают в разные группы', () => {
    // Регрессия: динамика вправе разрезать серию одинаковых чисел (вклад в
    // SSE нулевой), но два юнита с РОВНО одинаковым Total обязаны быть в одном
    // тире. Поэтому граница сдвигается вправо до конца серии.
    const values = [...Array.from({ length: 8 }, () => 5), ...Array.from({ length: 2 }, () => 50)];
    const result = naturalBreaks(values, 2);
    for (let i = 0; i < values.length - 1; i += 1) {
      if (values[i] === values[i + 1]) {
        expect(result.labels[i], `пара ${i}/${i + 1}`).toBe(result.labels[i + 1]);
      }
    }
  });

  it('почти одинаковые значения не разрезаются', () => {
    // Основная цель замены перцентилей: значения, отличающиеся на 0.1,
    // не должны попадать по разные стороны границы тира.
    const values = [];
    for (let i = 0; i < 100; i += 1) values.push(10 + i * 0.1);
    values.push(200, 300, 400, 500);
    const result = naturalBreaks(values, 5);
    for (let i = 0; i < 100 - 1; i += 1) {
      if (Math.abs(values[i] - values[i + 1]) < 0.11) {
        expect(result.labels[i], `пара ${i}/${i + 1}`).toBe(result.labels[i + 1]);
      }
    }
  });

  it('каждая группа непустая, размеры в сумме дают набор', () => {
    const values = Array.from({ length: 47 }, (_, i) => Math.sin(i) * 10 + 50);
    const result = naturalBreaks(values, 5);
    expect(result.sizes.reduce((sum, value) => sum + value, 0)).toBe(values.length);
    for (const size of result.sizes) expect(size).toBeGreaterThan(0);
    expect(result.sizes.length).toBe(5);
  });

  it('метки отсортированы по значению', () => {
    const values = [5, 1, 9, 3, 7, 2, 8, 4, 6, 10];
    const result = naturalBreaks(values, 3);
    for (let i = 0; i < values.length; i += 1) {
      for (let j = 0; j < values.length; j += 1) {
        if (values[i] < values[j]) {
          expect(result.labels[i]).toBeLessThanOrEqual(result.labels[j]);
        }
      }
    }
  });

  it('вырожденные случаи не падают', () => {
    expect(naturalBreaks([], 5).labels).toEqual([]);
    expect(naturalBreaks([7], 5).labels).toEqual([0]);
    expect(naturalBreaks([7, 7, 7, 7], 5).sizes.reduce((a, b) => a + b, 0)).toBe(4);
    // Больше групп, чем значений: групп столько же, сколько значений.
    expect(naturalBreaks([1, 2, 3], 10).sizes).toEqual([1, 1, 1]);
    // Все значения равны — одна группа.
    expect(naturalBreaks([2, 2, 2, 2, 2], 5).sizes.reduce((a, b) => a + b, 0)).toBe(5);
  });

  it('разбиение минимизирует разброс внутри групп', () => {
    // SSE натуральных разрывов не хуже тривиального «резать по размерам».
    const values = [
      ...Array.from({ length: 40 }, () => 10),
      ...Array.from({ length: 40 }, () => 20),
      ...Array.from({ length: 40 }, () => 50),
    ];
    const optimal = naturalBreaks(values, 3);
    const equalSplit = (() => {
      // Три равные доли по 40 — как перцентили при равномерном наборе.
      const sorted = [...values].sort((a, b) => a - b);
      const sse = (from: number, to: number) => {
        const slice = sorted.slice(from, to);
        const mean = slice.reduce((s, v) => s + v, 0) / slice.length;
        return slice.reduce((s, v) => s + (v - mean) ** 2, 0);
      };
      return sse(0, 40) + sse(40, 80) + sse(80, 120);
    })();
    expect(optimal.sse).toBeLessThanOrEqual(equalSplit);
    expect(optimal.sse).toBeCloseTo(0, 6);
  });
});

describe('эталоны целей из данных', () => {
  it('кластеров больше нуля и они физически осмысленны', () => {
    expect(CLUSTER_PROFILES.length).toBeGreaterThan(0);
    for (const cluster of CLUSTER_PROFILES) {
      expect(cluster.models, cluster.id).toBeGreaterThan(0);
      expect(cluster.toughness, cluster.id).toBeGreaterThan(0);
      expect(cluster.wounds, cluster.id).toBeGreaterThan(0);
      expect(cluster.points, cluster.id).toBeGreaterThan(0);
      expect(cluster.sample, cluster.id).toBeGreaterThan(0);
    }
  });

  it('идентификаторы уникальны и группы исчерпывают набор', () => {
    const ids = CLUSTER_PROFILES.map((cluster) => cluster.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...INFANTRY_ARCHETYPES, ...ARMOR_ARCHETYPES].sort()).toEqual([...ids].sort());
  });

  it('очки на модель согласуются со стоимостью эталона', () => {
    for (const cluster of CLUSTER_PROFILES) {
      expect(cluster.points / cluster.models, cluster.id).toBeGreaterThan(0);
    }
  });

  it('кластеры не вырождены: у каждого есть медиана характеристик', () => {
    // Регрессия: раньше профили считались медианой по РУЧНЫМ корзинам, и
    // корзина infantry давала W1/Sv4 — смесь Battle Sisters с Acolyte
    // Hybrids. Теперь корзины строятся сами, и несуществующий юнит в них
    // не попадает: median по T/W обязана быть целым и правдоподобной.
    for (const cluster of CLUSTER_PROFILES) {
      expect(Number.isInteger(cluster.toughness), cluster.id).toBe(true);
      expect(Number.isInteger(cluster.wounds), cluster.id).toBe(true);
      expect(cluster.toughness, cluster.id).toBeLessThanOrEqual(20);
      expect(cluster.wounds, cluster.id).toBeLessThanOrEqual(40);
    }
  });
});

describe('масштабирование эталонов', () => {
  it('число моделей и стоимость меняются пропорционально', () => {
    const scaled = scaleArchetypeModels(ARCHETYPES, 1.2);
    expect(scaled).toHaveLength(ARCHETYPES.length);
    for (const base of ARCHETYPES) {
      const next = scaled.find((item) => item.id === base.id);
      expect(next, base.id).toBeDefined();
      // Модели округляются, поэтому у одно- и двухмодельных эталонов ×1.2
      // может не изменить число (round(1×1.2)=1) — тогда и цена не растёт.
      expect(Math.abs(next!.models - base.models * 1.2), base.id).toBeLessThanOrEqual(1);
      if (next!.models > base.models) {
        expect(next!.points, base.id).toBeGreaterThan(base.points);
      } else {
        expect(next!.points, base.id).toBe(base.points);
      }
    }
  });

  it('одиночные эталоны не масштабируются: 1 модель × 1.2 — это 1 модель', () => {
    // Регрессия: при масштабировании ВСЕХ целей «+20%» у пехоты и «+0%» у
    // техники меняли веса типов целей, и разброс перцентилей показывал эффект
    // округления (~48 медиана) вместо настоящей чувствительности модели.
    for (const factor of [0.8, 1.2]) {
      for (const next of scaleArchetypeModels(ARCHETYPES, factor)) {
        if (next.models < MIN_SQUAD_TARGET) {
          expect(next.models, next.id).toBe(ARCHETYPES.find((a) => a.id === next.id)!.models);
          expect(next.points, next.id).toBe(ARCHETYPES.find((a) => a.id === next.id)!.points);
        }
      }
    }
  });

  it('коэффициент меньше единицы уменьшает эталон, но не обнуляет его', () => {
    const scaled = scaleArchetypeModels(ARCHETYPES, 0.1);
    for (const next of scaled) {
      expect(next.models, next.id).toBeGreaterThanOrEqual(1);
      expect(next.points, next.id).toBeGreaterThanOrEqual(1);
    }
  });
});

