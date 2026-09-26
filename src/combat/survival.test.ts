/**
 * Тесты модуля выживаемости.
 *
 * Проверяем: многoраундовую симуляцию боя, шаблоны оружия, нормировку
 * «урон на 100 очков» и сами инварианты выживаемости (чем крепче цель,
 * тем дольше она живёт и тем меньше урона приходится на 100 её очков).
 */

import { describe, expect, it } from 'vitest';
import { ARCHETYPES, archetypesByGroup, targetUnitOf } from './archetypes.ts';
import {
  WEAPON_ARCHETYPES,
  WEAPON_GROUPS,
  weaponById,
  weaponPointsOf,
  weaponUnitOf,
  toTemplateWeapon,
} from './weapons.ts';
import {
  survivabilityAgainstArchetype,
  survivabilityAgainstUnit,
  survivabilityTable,
} from './survival.ts';
import { per100Points } from './perRound.ts';
import {
  createDefenderState,
  resolveCombatOptions,
  simulateBattle,
  simulateRound,
} from './simulate.ts';
import type { CombatUnit } from './types.ts';

/**
 * Типы целей выведены из данных, поэтому обращаемся к ним ПО СМЫСЛУ, а не по
 * ручному id: id меняются при каждой смене K, и тест на 'infantry' после
 * рефакторинга был бы просто ссылкой на несуществующий тип.
 */
const weakestInfantry = archetypesByGroup('infantry')[0];
const armorTypes = archetypesByGroup('armor');
/** Самая живучая техника — для проверок на anti-armour. */
const toughestArmor = armorTypes[armorTypes.length - 1];

/** Цель с заданными T/W/Sv и числом моделей. */
function target(models: number, toughness: number, wounds: number, save: number | null): CombatUnit {
  return targetUnitOf(weakestInfantry, { models, toughness, wounds, save });
}

describe('многораундовая симуляция боя', () => {
  // Бросок 4: попадает по 3+ и ранит по 4+, но НЕ проходит сейв 6+.
  // (Натуральная 6 всегда проходит сейв, поэтому rng 0.99 для этих проверок не годится.)
  const roll4 = (): number => 0.5;

  it('слабая цель гибнет быстрее крепкой', () => {
    const attacker = weaponUnitOf(weaponById('assault-cannon'));
    const soft = simulateBattle(attacker, target(3, 4, 1, 6), { rng: roll4 });
    const tough = simulateBattle(attacker, target(3, 10, 6, 2), { rng: roll4 });

    expect(soft.targetDestroyed).toBe(true);
    expect(soft.rounds).toBeLessThan(tough.rounds);
    expect(tough.survivors).toBeGreaterThan(0);
  });

  it('урон по раундам копится, а счётчик убийств не превышает число моделей', () => {
    const attacker = weaponUnitOf(weaponById('bolt-pistol'));
    // Sv6+ от броска 4 отказывает — иначе весь урон болт-пистолета (S4) съедал бы сейв.
    const defender = target(4, 4, 2, 6);
    const battle = simulateBattle(attacker, defender, { rng: roll4 });

    expect(battle.damageByRound).toHaveLength(battle.rounds);
    expect(battle.damageByRound[0]).toBeGreaterThan(0);
    expect(battle.kills).toBeLessThanOrEqual(defender.models.length);
    expect(battle.damage).toBeGreaterThanOrEqual(battle.damageByRound[0]);
  });

  it('потолок раундов соблюдается', () => {
    const attacker = weaponUnitOf(weaponById('lasgun'));
    const battle = simulateBattle(attacker, target(10, 12, 12, 2), {
      rng: () => 0.5,
      maxRounds: 3,
    });
    expect(battle.rounds).toBe(3);
    expect(battle.targetDestroyed).toBe(false);
  });

  it('simulateRound мутирует состояние и возвращает урон за раунд', () => {
    const attacker = weaponUnitOf(weaponById('bolt-pistol'));
    const defender = target(2, 4, 2, 6);
    const state = createDefenderState(defender, 'first');
    const opts = resolveCombatOptions({ phase: 'all', rng: roll4 });

    const damage = simulateRound(attacker, state, opts);
    expect(damage).toBeGreaterThan(0);
    // Возвращённый урон совпадает с накопленным в состоянии.
    expect(state.damage).toBe(damage);
    // Второй раунд продолжает ту же серию, а не начинает заново.
    expect(simulateRound(attacker, state, opts)).toBeGreaterThanOrEqual(0);
    expect(state.damage).toBeGreaterThanOrEqual(damage);
  });
});

describe('шаблоны оружия', () => {
  it('все шаблоны валидны и принадлежат известным группам', () => {
    const ids = WEAPON_ARCHETYPES.map((weapon) => weapon.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const weapon of WEAPON_ARCHETYPES) {
      expect(WEAPON_GROUPS, weapon.id).toContain(weapon.group);
      expect(weapon.models, weapon.id).toBeGreaterThan(0);
      expect(weapon.pointsPerModel, weapon.id).toBeGreaterThan(0);
      expect(weapon.strength, weapon.id).toBeGreaterThan(0);
    }
  });

  it('шаблон превращается в боевой профиль с разобранными характеристиками', () => {
    const bolter = toTemplateWeapon(weaponById('bolter'));
    expect(bolter).toMatchObject({
      id: 'bolter',
      name: 'Болтер',
      kind: 'ranged',
      range: 24,
      skill: 3,
      strength: 4,
      ap: -1,
      attacks: { count: 1, sides: 1, plus: 0 },
      damage: { count: 2, sides: 1, plus: 0 },
    });
  });

  it('типовой стрельющий — нужной численности и стоимости', () => {
    const bolter = weaponById('bolter');
    const unit = weaponUnitOf(bolter);
    expect(unit.models).toHaveLength(10);
    expect(unit.models[0].weapons[0].id).toBe('bolter');
    expect(weaponPointsOf(bolter)).toBe(120);
    // Численность можно переопределить (например, один болтер у героя).
    expect(weaponUnitOf(bolter, { models: 1 }).models).toHaveLength(1);
  });

  it('кейворды стрельщего соответствуют группе оружия', () => {
    // Танковое орудие не должно выглядеть пехотой.
    expect(weaponUnitOf(weaponById('lascannon')).keywords).toEqual(['VEHICLE']);
    expect(weaponUnitOf(weaponById('crushing-fists')).keywords).toEqual(['MONSTER']);
    expect(weaponUnitOf(weaponById('bolter')).keywords).toEqual(['INFANTRY']);
  });
});

describe('нормировка «урон на 100 очков»', () => {
  it('сырой урон приводится к 100 очкам', () => {
    const empty = { byArchetype: {}, overall: { mean: 0, stdev: 0 } };
    const damage = {
      ranged: { ...empty, overall: { mean: 4, stdev: 1 }, destroyedPoints: { ...empty } },
      melee: { ...empty, overall: { mean: 2, stdev: 1 }, destroyedPoints: { ...empty } },
      total: { ...empty, overall: { mean: 6, stdev: 1 }, destroyedPoints: { ...empty } },
    };
    expect(per100Points(damage, 50)).toEqual({ ranged: 8, melee: 4, total: 12 });
    expect(per100Points(damage, 100)).toEqual({ ranged: 4, melee: 2, total: 6 });
  });

  it('при нулевых очках нормировка не делит на ноль', () => {
    const empty = { byArchetype: {}, overall: { mean: 0, stdev: 0 } };
    const damage = {
      ranged: { ...empty, overall: { mean: 4, stdev: 1 }, destroyedPoints: { ...empty } },
      melee: { ...empty, overall: { mean: 2, stdev: 1 }, destroyedPoints: { ...empty } },
      total: { ...empty, overall: { mean: 6, stdev: 1 }, destroyedPoints: { ...empty } },
    };
    expect(per100Points(damage, 0)).toEqual({ ranged: 0, melee: 0, total: 0 });
  });
});


describe('выживаемость', () => {
  const options = { trials: 40, maxRounds: 12, distance: 12, seed: 5 };

  it('считает метрики по каждому шаблону оружия', () => {
    const result = survivabilityAgainstArchetype(weakestInfantry, options);
    expect(result.weapons).toHaveLength(WEAPON_ARCHETYPES.length);
    for (const threat of result.weapons) {
      expect(threat.damagePerRound.mean, threat.weaponId).toBeGreaterThanOrEqual(0);
      expect(threat.roundsToKill.mean, threat.weaponId).toBeGreaterThan(0);
      expect(threat.killProbability, threat.weaponId).toBeLessThanOrEqual(1);
    }
  });

  it('крепкая цель получает меньше урона на 100 очков, чем хрупкая', () => {
    const soft = survivabilityAgainstUnit(target(5, 4, 1, 6), 100, options);
    const tough = survivabilityAgainstUnit(target(5, 12, 12, 2), 500, options);

    expect(tough.overall.takenPer100Points.mean).toBeLessThan(
      soft.overall.takenPer100Points.mean
    );
    expect(tough.overall.roundsToKill.mean).toBeGreaterThan(soft.overall.roundsToKill.mean);
  });

  it('антибронебойное оружие эффективнее стрелкового против техники', () => {
    const result = survivabilityAgainstArchetype(toughestArmor, options);
    const find = (id: string) => result.weapons.find((w) => w.weaponId === id);
    // Лазган (S3) почти не пробивает T11 с Sv2+, ланс (S12 AP-5) — наоборот.
    expect(find('lance')!.roundsToKill.mean).toBeLessThan(find('lasgun')!.roundsToKill.mean);
    expect(find('lance')!.damagePerRound.mean).toBeGreaterThan(
      find('lasgun')!.damagePerRound.mean
    );
  });

  it('нормировка на 100 очков: нанесённый и пережитый урон считаются раздельно', () => {
    const result = survivabilityAgainstArchetype(toughestArmor, options);
    const threat = result.weapons.find((w) => w.weaponId === 'bolter');
    // Болтер наносит свой урон на 100 своих очков (10 × 12 = 120 очков),
    // а монстр «переживает» его на 100 своих (100 очков).
    expect(threat?.dealtPer100Points.mean).toBeGreaterThan(0);
    expect(threat?.takenPer100Points.mean).toBeGreaterThan(0);
    // Стоимость эталона берётся у самого кластера: раньше здесь стояло
    // жёсткое 100, а после перехода на данные у «крепкой техники» это 395.
    expect(result.target.points).toBe(toughestArmor.points);
    expect(result.target.points).toBeGreaterThan(0);
  });

  it('фильтр групп оружия сужает набор', () => {
    const result = survivabilityAgainstArchetype(weakestInfantry, {
      ...options,
      groups: ['melee-infantry'],
    });
    expect(result.weapons.every((threat) => threat.group === 'melee-infantry')).toBe(true);
    expect(Object.keys(result.byGroup)).toEqual(['melee-infantry']);
  });

  it('одинаковый seed даёт одинаковый результат', () => {
    const first = survivabilityAgainstArchetype(toughestArmor, options);
    const second = survivabilityAgainstArchetype(toughestArmor, options);
    expect(first.overall.roundsToKill).toEqual(second.overall.roundsToKill);
    expect(first.overall.takenPer100Points).toEqual(second.overall.takenPer100Points);
  });

  it('сводная таблица содержит строку на каждый тип юнита', () => {
    const table = survivabilityTable({ ...options, groups: ['small-arms'] });
    expect(table).toHaveLength(ARCHETYPES.length);
    for (const row of table) {
      expect(row.totalWounds, row.archetype).toBeGreaterThan(0);
      expect(row.points, row.archetype).toBeGreaterThan(0);
      expect(row.takenPer100Points.mean, row.archetype).toBeGreaterThan(0);
    }
  });
});

