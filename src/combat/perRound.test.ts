/**
 * Тесты расчёта урона в раунд по типам юнитов.
 *
 * Проверяем три вещи: классификацию отрядов в архетипы, сам расчёт
 * (дальнобойный / рукопашный / общий) и корректность агрегации.
 * Числа сверяются на порядок величин — абсолютные значения зависят
 * от принятых в модуле допущений, а инварианты должны выполняться всегда.
 */

import { describe, expect, it } from 'vitest';
import { ARCHETYPES, archetypeById, archetypeOf, targetUnitOf } from './archetypes.ts';
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
    const target = targetUnitOf(archetypeById('infantry'), { models: 4 });
    expect(target.models).toHaveLength(4);
    expect(target.models[0].toughness).toBe(4);
    expect(target.models[0].wounds).toBe(2);
    expect(target.models[0].weapons).toHaveLength(0);
    expect(target.keywords).toContain('INFANTRY');
  });

  it('архетип реального отряда определяется по кейвордам', () => {
    expect(archetypeOf(unit(1, ['VEHICLE', 'WALKER'], weapon()))?.id).toBe('walker');
    expect(archetypeOf(unit(1, ['VEHICLE'], weapon()))?.id).toBe('vehicle');
    expect(archetypeOf(unit(1, ['VEHICLE', 'FLY'], weapon()))?.id).toBe('flyer');
    expect(archetypeOf(unit(1, ['VEHICLE', 'TRANSPORT'], weapon()))?.id).toBe('transport');
    expect(archetypeOf(unit(1, ['INFANTRY', 'TERMINATOR'], weapon()))?.id).toBe('terminator');
    expect(archetypeOf(unit(1, ['INFANTRY', 'SWARM'], weapon()))?.id).toBe('swarm');
    expect(archetypeOf(unit(1, ['INFANTRY', 'JUMP PACK'], weapon()))?.id).toBe('jetpack');
    expect(archetypeOf(unit(1, ['FORTIFICATION'], weapon()))?.id).toBe('fortification');
    expect(archetypeOf(unit(1, ['VEHICLE', 'BATTLESUIT'], weapon()))?.id).toBe('battlesuit');
  });

  it('пехота без спецкейвордов делится по числу ран и Sv', () => {
    const weak = unit(10, ['INFANTRY'], weapon());
    expect(archetypeOf(weak)?.id).toBe('infantry');

    // Одиночный герой-пехота (W6 у Warboss) — усиленная пехота, не кавалерия.
    const hero = unit(1, ['INFANTRY', 'CHARACTER'], weapon());
    hero.models[0].wounds = 6;
    expect(archetypeOf(hero)?.id).toBe('infantry-veteran');

    const tough = unit(5, ['INFANTRY'], weapon());
    tough.models[0].save = 2;
    expect(archetypeOf(tough)?.id).toBe('infantry-veteran');

    // Кавалерия — отряд из нескольких моделей.
    const mounted = unit(5, ['CAVALRY', 'MOUNTED'], weapon());
    mounted.models[0].wounds = 4;
    expect(archetypeOf(mounted)?.id).toBe('cavalry');
  });

  it('шагоход важнее транспорта, одиночная скоростная машина — не кавалерия', () => {
    // Stompa: T14/W30 с обоими кейвордами — по живучести это шагоход.
    const stompa = unit(1, ['VEHICLE', 'WALKER', 'TRANSPORT'], weapon());
    stompa.models[0].toughness = 14;
    stompa.models[0].wounds = 30;
    expect(archetypeOf(stompa)?.id).toBe('walker');

    // Kill Tank: только [TRANSPORT], без [WALKER] — уходит в транспорт.
    // Сам архетип (T9/W10) ему тесноват, но метрики живучести всё равно
    // считаются по реальному профилю T12/W24, а не по шаблону.
    const killTank = unit(1, ['VEHICLE', 'TRANSPORT'], weapon());
    killTank.models[0].toughness = 12;
    killTank.models[0].wounds = 24;
    expect(archetypeOf(killTank)?.id).toBe('transport');

    // Одиночная [MOUNTED] T8/W10 — это зверь, а не отряд всадников.
    const gutsmek = unit(1, ['MOUNTED', 'CHARACTER'], weapon());
    gutsmek.models[0].toughness = 8;
    gutsmek.models[0].wounds = 10;
    expect(archetypeOf(gutsmek)?.id).toBe('monster');
  });

  it('зверь без машинных кейвордов и с T/W монстра — монстр', () => {
    const beast = unit(1, ['BEAST', 'CHARACTER'], weapon());
    beast.models[0].wounds = 10;
    beast.models[0].toughness = 9;
    expect(archetypeOf(beast)?.id).toBe('monster');
  });

  it('отряд без моделей или без подходящих кейвордов не классифицируется', () => {
    expect(archetypeOf({ id: 'x', name: 'x', keywords: [], models: [] })).toBeNull();
    expect(archetypeOf(unit(1, ['Grenades'], weapon()))).toBeNull();
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
    const result = damagePerRound(gunner(5), { ...options, targets: ['infantry', 'vehicle'] });
    expect(Object.keys(result.ranged.byArchetype)).toEqual(['infantry', 'vehicle']);
    const means = [result.ranged.byArchetype.infantry.mean, result.ranged.byArchetype.vehicle.mean];
    expect(result.ranged.overall.mean).toBeCloseTo((means[0] + means[1]) / 2, 6);
  });

  it('веса меняют итоговое среднее', () => {
    const weighted = damagePerRound(gunner(5), {
      ...options,
      targets: ['infantry', 'vehicle'],
      weights: { infantry: 1, vehicle: 0 },
    });
    const equal = damagePerRound(gunner(5), { ...options, targets: ['infantry', 'vehicle'] });
    // При нулевом весе у техники среднее равно урону по пехоте.
    expect(weighted.ranged.overall.mean).toBeCloseTo(
      equal.ranged.byArchetype.infantry.mean,
      6
    );
  });

  it('чем крепче цель, тем меньше урона в неё', () => {
    const result = damagePerRound(gunner(5), { ...options, targets: ['swarm', 'infantry', 'vehicle'] });
    const swarm = result.ranged.byArchetype.swarm.mean;
    const infantry = result.ranged.byArchetype.infantry.mean;
    const vehicle = result.ranged.byArchetype.vehicle.mean;
    expect(swarm).toBeGreaterThan(infantry);
    expect(infantry).toBeGreaterThan(vehicle);
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
        unit(5, ['INFANTRY'], weapon({ id: 'a' })),
        unit(5, ['INFANTRY'], weapon({ id: 'b' })),
        unit(1, ['VEHICLE'], weapon({ id: 'c' })),
      ],
      options
    );
    expect(rows.map((row) => row.attackerType)).toEqual(['infantry', 'vehicle']);
    expect(rows[0].damage.ranged.overall.mean).toBeGreaterThan(0);
    // Ряд по пехоте содержит оба отряда.
    expect(rows[0].attackerName.split(', ')).toHaveLength(2);
  });

  it('пустой список юнитов даёт пустые ряды', () => {
    expect(damagePerRoundByType([], options)).toEqual([]);
  });
});

