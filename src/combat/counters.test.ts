/**
 * Тесты счётчиков вычислений.
 *
 * Счётчик — инструмент оптимизации, а оптимизация по неверной цифре хуже, чем её
 * отсутствие. Поэтому проверяется не только арифметика модуля, но и то, что
 * отметки действительно стоят в горячих точках: если кто-то снесёт вызов
 * countSimulations из `damagePerRound`, тест это заметит, а не молча покажет
 * сборщику неполную картину.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  addSimulationCounters,
  countSimulations,
  resetSimulationCounters,
  simulationCounters,
  type SimulationCounters,
} from './counters.ts';
import { damagePerRound } from './perRound.ts';
import { survivabilityAgainstUnit } from './survival.ts';
import { weaponById, weaponUnitOf, WEAPON_ARCHETYPES } from './weapons.ts';
import { archetypesByGroup, targetUnitOf } from './archetypes.ts';

/** Цель и атакующий берутся из настоящих архетипов и шаблонов — id меняются. */
const weakestInfantry = archetypesByGroup('infantry')[0];
const attacker = weaponUnitOf(weaponById('assault-cannon'));
const target = targetUnitOf(weakestInfantry, { models: 3, toughness: 3, wounds: 1, save: 6 });

beforeEach(() => {
  resetSimulationCounters();
});

describe('счётчики вычислений', () => {
  it('начинают с нулей', () => {
    expect(Object.values(simulationCounters()).every((value) => value === 0)).toBe(true);
  });

  it('снимок не является живым счётчиком', () => {
    const snapshot = simulationCounters();
    snapshot.damageRuns = 999;
    // Иначе сумма по воркерам «съела» бы чужие правки главного процесса.
    expect(simulationCounters().damageRuns).toBe(0);
  });

  it('считает пачками, а не по одному', () => {
    countSimulations('monteCarloTrials', 900);
    countSimulations('monteCarloTrials');
    expect(simulationCounters().monteCarloTrials).toBe(901);
  });

  it('сливает счётчики воркеров и терпит неполный набор', () => {
    const total = simulationCounters();
    const worker: SimulationCounters = { ...simulationCounters(), damageRuns: 3, survivalTrials: 7 };
    addSimulationCounters(total, worker);
    expect(total.damageRuns).toBe(3);
    expect(total.survivalTrials).toBe(7);
    // Ответ старого воркера без новых полей не должен ломать суммирование.
    const partial = { damageRuns: 2 } as SimulationCounters;
    addSimulationCounters(total, partial);
    expect(total.damageRuns).toBe(5);
    expect(Number.isNaN(total.survivalTrials)).toBe(false);
  });

  it('обнуление сбрасывает всё', () => {
    countSimulations('katahStanceScores', 4);
    resetSimulationCounters();
    expect(simulationCounters().katahStanceScores).toBe(0);
  });
});

describe('отметки стоят в горячих точках', () => {
  it('damagePerRound отмечает замер по архетипу и все бои трёх фаз', () => {
    // Одна цель, три прогона: на каждый архетип уходит по Монте-Карло на фазу
    // (ranged/melee/total), то есть ровно 3 × 3 боёв.
    damagePerRound(attacker, { trials: 3, targets: [weakestInfantry.id] });
    const counters = simulationCounters();
    expect(counters.archetypeRuns).toBe(1);
    expect(counters.monteCarloTrials).toBe(9);
  });

  it('замер живучести отмечает бои по каждому шаблону оружия', () => {
    survivabilityAgainstUnit(target, 100, {
      trials: 2,
      maxRounds: 3,
      weapons: ['assault-cannon'],
    });
    // Один шаблон оружия × два прогона.
    expect(simulationCounters().survivalTrials).toBe(2);
  });

  it('больше шаблонов оружия — больше боёв', () => {
    // Именно этот счётчик показывает, дорога ли живучесть: шаблонов столько,
    // сколько групп оружия, и на каждый уходит свой набор прогонов. Шаблоны
    // берутся из каталога, а не пишутся руками: id меняются вместе с группами.
    const two = WEAPON_ARCHETYPES.slice(0, 2);
    survivabilityAgainstUnit(target, 100, {
      trials: 1,
      maxRounds: 2,
      weapons: two.map((weapon) => weapon.id),
    });
    expect(simulationCounters().survivalTrials).toBe(two.length);
  });
});
