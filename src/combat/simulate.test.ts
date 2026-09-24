/**
 * Тесты боевой последовательности 11-й редакции.
 *
 * Ключевая идея — детерминированный rng: `die(n)` всегда выдаёт грань n,
 * поэтому каждый шаг (попадание, ранение, сейв, урон) проверяется точно,
 * а не по распределению. Распределения проверяются отдельно Монте-Карло.
 *
 * Про порядок бросков (важно для `sequence`): дайсы атак → попадание →
 * ранение → сейв → урон; каждый куб тратит ровно один вызов rng.
 */

import { describe, expect, it } from 'vitest';
import { mulberry32 } from './dice.ts';
import { parseKeywords } from './keywords.ts';
import { woundThresholdByStrength } from './rules.ts';
import {
  createDefenderState,
  damageNextModel,
  damageSpill,
  meleeWeaponsOf,
  monteCarlo,
  nextTargetIndex,
  rangedWeaponsOf,
  simulateTrial,
} from './simulate.ts';
import type { CombatModel, CombatUnit, CombatWeapon, Rng } from './types.ts';

/** Генератор, всегда выдающий грань n (1…6). */
const die = (n: number): Rng => () => (n - 0.5) / 6;

/** Последовательность разных граней — когда броски идут в разном порядке. */
function sequence(values: number[]): Rng {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

/** `sides: 1` — фиксированное число (rollDice даёт 1 + floor(rng × 1) = 1). */
function weapon(overrides: Partial<CombatWeapon> = {}): CombatWeapon {
  return {
    id: 'w1',
    name: 'Test weapon',
    kind: 'ranged',
    range: 24,
    attacks: { count: 1, sides: 1, plus: 0 },
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
    id: 'm1',
    name: 'Trooper',
    toughness: 4,
    wounds: 2,
    save: 3,
    invuln: null,
    keywords: ['INFANTRY'],
    weapons: [weapon()],
    ...overrides,
  };
}

function unit(models: CombatModel[], keywords = ['INFANTRY']): CombatUnit {
  return { id: 'u1', name: 'Unit', keywords, models };
}

/** Отряд из одной стреляющей модели с заданным оружием. */
const gunner = (gun: CombatWeapon): CombatUnit => unit([model({ weapons: [gun] })]);


describe('порог ранения S/T', () => {
  it('даёт 2+/3+/4+/5+/6+ по таблице 11-й редакции', () => {
    expect(woundThresholdByStrength(10, 4)).toBe(2);
    expect(woundThresholdByStrength(5, 4)).toBe(3);
    expect(woundThresholdByStrength(4, 4)).toBe(4);
    expect(woundThresholdByStrength(3, 5)).toBe(5);
    expect(woundThresholdByStrength(2, 5)).toBe(6);
  });
});

describe('симуляция одного прогона', () => {
  it('попадание → ранение → сейв → урон по модели', () => {
    // Бросок 3: попадание по 2+, ранение 3+ (S5 против T4), сейв 4+ от 3 — отказ.
    const attacker = gunner(weapon({ skill: 2, strength: 5 }));
    const defender = unit([model({ toughness: 4, wounds: 5, save: 4 })]);
    const result = simulateTrial(attacker, defender, { rng: die(3) });

    expect(result.damage).toBe(1);
    expect(result.kills).toBe(0);
    expect(result.survivors).toBe(1);
    expect(result.weapons[0]).toMatchObject({
      attacks: 1,
      hits: 1,
      wounds: 1,
      unsaved: 1,
      damage: 1,
    });
  });

  it('промах не даёт ни ранений, ни урона', () => {
    const attacker = gunner(weapon({ skill: 2, strength: 5 }));
    const defender = unit([model({ toughness: 4, wounds: 5 })]);
    const result = simulateTrial(attacker, defender, { rng: die(1) });

    expect(result.damage).toBe(0);
    expect(result.weapons[0]).toMatchObject({ attacks: 1, hits: 0, wounds: 0, unsaved: 0 });
  });

  it('натуральная 6 попадает по 6+ и проходит сейв 6+', () => {
    const attacker = gunner(weapon({ skill: 6, strength: 5 }));
    const defender = unit([model({ toughness: 4, wounds: 5, save: 6 })]);
    const result = simulateTrial(attacker, defender, { rng: die(6) });
    expect(result.weapons[0]).toMatchObject({ hits: 1, wounds: 1, unsaved: 0, damage: 0 });
  });

  it('избыток урона не переносится на следующую модель', () => {
    // 2 атаки по 2 урона; первая модель имеет 1 рану, вторая — 3. Сейв 5+ от 4 отказывает.
    const attacker = gunner(
      weapon({ attacks: { count: 2, sides: 1, plus: 0 }, damage: { count: 1, sides: 1, plus: 1 } })
    );
    const defender = unit([
      model({ toughness: 4, wounds: 1, save: 5 }),
      model({ id: 'm2', wounds: 3, save: 5 }),
    ]);
    const result = simulateTrial(attacker, defender, { rng: die(4) });

    expect(result.kills).toBe(1);
    expect(result.survivors).toBe(1);
    // 1 рана первой модели + 2 урона второй; лишний урон первой сгорает.
    expect(result.damage).toBe(3);
  });
});

describe('сейвы, AP и укрытие', () => {
  it('AP ухудшает броню: сейв 3+ с AP-2 становится 5+', () => {
    const attacker = gunner(weapon({ skill: 2, strength: 5, ap: -2 }));
    const defender = unit([model({ toughness: 4, wounds: 9, save: 3 })]);
    // Ранение проходит, сейв 5+ от броска 4 — отказ.
    expect(simulateTrial(attacker, defender, { rng: die(4) }).damage).toBe(1);
  });

  it('инвуля 2+ лучше брони 6+ и спасает даже против AP', () => {
    const attacker = gunner(weapon({ skill: 2, strength: 5, ap: -3 }));
    const defender = unit([model({ toughness: 4, wounds: 9, save: 6, invuln: 2 })]);
    // AP-3 против Sv6+ дало бы 9+ (автоотказ), но инвуля 2+ проходит от броска 3.
    expect(simulateTrial(attacker, defender, { rng: die(3) }).damage).toBe(0);
  });

  it('укрытие улучшает сейв на 1 при стрельбе', () => {
    const defender = unit([model({ toughness: 4, wounds: 9, save: 4 })]);
    const attacker = gunner(weapon({ skill: 2, strength: 5 }));
    // Ранение 3+ проходит от броска 3. Сейв 4+: отказ; с укрытием 3+ — проход.
    expect(simulateTrial(attacker, defender, { rng: die(3) }).damage).toBe(1);
    expect(simulateTrial(attacker, defender, { rng: die(3), cover: true }).damage).toBe(0);
  });

  it('[IGNORES COVER] отменяет бонус укрытия', () => {
    const defender = unit([model({ toughness: 4, wounds: 9, save: 4 })]);
    const attacker = gunner(
      weapon({ skill: 2, strength: 5, keywords: parseKeywords(['Ignores Cover']) })
    );
    expect(simulateTrial(attacker, defender, { rng: die(3), cover: true }).damage).toBe(1);
  });
});


describe('кейворды 11-й редакции', () => {
  it('[TORRENT] даёт автопопадание независимо от броска', () => {
    const attacker = gunner(
      weapon({ skill: null, strength: 5, keywords: parseKeywords(['Torrent']) })
    );
    // Натуральная 1: при BS 3+ такой бросок был бы промахом, но [TORRENT]
    // попадание даёт автоматически — hits равен числу атак.
    const defender = unit([model({ toughness: 4, wounds: 9, save: 6 })]);
    const result = simulateTrial(attacker, defender, { rng: die(1) });
    expect(result.weapons[0]).toMatchObject({ attacks: 1, hits: 1 });
  });

  it('[TORRENT] с [BLAST] совмещается: автопопадание + доп. дайсы за 5+ моделей', () => {
    const attacker = gunner(
      weapon({ skill: null, strength: 5, keywords: parseKeywords(['Torrent', 'Blast 1']) })
    );
    // 10 моделей цели → +2 дайса атак, все попадают автоматически.
    const defender = unit(
      Array.from({ length: 10 }, (_, i) => model({ id: `t${i}`, wounds: 9, save: 6 }))
    );
    const result = simulateTrial(attacker, defender, { rng: die(4) });
    expect(result.weapons[0]).toMatchObject({ attacks: 3, hits: 3, wounds: 3 });
  });

  it('[RAPID FIRE X] добавляет дайсы атак только на половинной дальности', () => {
    const attacker = gunner(weapon({ range: 20, keywords: parseKeywords(['Rapid Fire 1']) }));
    const defender = unit([model({ toughness: 4, wounds: 99, save: 6 })]);
    // Полная дальность 20": половина — 10".
    const near = simulateTrial(attacker, defender, { rng: die(1), distance: 10 });
    const far = simulateTrial(attacker, defender, { rng: die(1), distance: 20 });
    expect(near.weapons[0].attacks).toBe(2);
    expect(far.weapons[0].attacks).toBe(1);
  });

  it('[MELTA X] добавляет урон только на половинной дальности', () => {
    const attacker = gunner(
      weapon({
        skill: 2,
        strength: 5,
        damage: { count: 1, sides: 6, plus: 0 },
        keywords: parseKeywords(['Melta 3']),
      })
    );
    const defender = unit([model({ toughness: 4, wounds: 99, save: 6 })]);
    // D6 от броска 4: 4 вблизи (полная дальность 24", половина 12") и 4 вдали.
    expect(simulateTrial(attacker, defender, { rng: die(4), distance: 5 }).damage).toBe(7);
    expect(simulateTrial(attacker, defender, { rng: die(4), distance: 20 }).damage).toBe(4);
  });

  it('[LETHAL HITS] ранит критическим попаданием без броска на ранение', () => {
    const attacker = gunner(
      weapon({ skill: 2, strength: 1, keywords: parseKeywords(['Lethal Hits']) })
    );
    // S1 против T10 — бросок на ранение 6+ прошёл бы (6 ≥ 6), поэтому берём
    // save 6+ и натуральную 6: попадание-шестёрка → авторанение.
    const defender = unit([model({ toughness: 10, wounds: 9, save: 6 })]);
    const result = simulateTrial(attacker, defender, { rng: die(6) });
    expect(result.weapons[0]).toMatchObject({ hits: 1, wounds: 1 });
  });

  it('[TWIN-LINKED] перебрасывает неудачное ранение', () => {
    const attacker = gunner(
      weapon({ skill: 2, strength: 5, keywords: parseKeywords(['Twin-linked']) })
    );
    const defender = unit([model({ toughness: 6, wounds: 9, save: 6 })]);
    // Порядок бросков: атака(1) → попадание(4) → ранение(2, провал) → переброс(3, провал).
    const result = simulateTrial(attacker, defender, {
      rng: sequence([0.5, 3.5 / 6, 1.5 / 6, 2.5 / 6]),
    });
    expect(result.weapons[0].wounds).toBe(0);
  });

  it('[ANTI-VEHICLE 4+] с [DEVASTATING WOUNDS] наносит мортиды в обход сейва', () => {
    const attacker = gunner(
      weapon({
        skill: 2,
        strength: 6,
        damage: { count: 3, sides: 6, plus: 0 },
        keywords: parseKeywords(['Anti-VEHICLE 4+', 'Devastating Wounds']),
      })
    );
    // Сейв 3+ прошёл бы от броска 4, но мортиды идут до сейва.
    const defender = unit([model({ toughness: 6, wounds: 99, save: 3, keywords: ['VEHICLE'] })], [
      'VEHICLE',
    ]);
    const result = simulateTrial(attacker, defender, { rng: die(4) });
    expect(result.weapons[0]).toMatchObject({ wounds: 1, unsaved: 1 });
    // 3D6 от броска 4 = 12 мортид, урон равен только мортидам.
    expect(result.weapons[0].mortals).toBe(12);
    expect(result.damage).toBe(12);
  });
});


describe('выбор оружия и стратегии', () => {
  it('в зоне боя стреляют только [PISTOL]/[CLOSE-QUARTERS]', () => {
    const trooper = model({
      weapons: [
        weapon({ id: 'bolter', name: 'Bolter', skill: 3 }),
        weapon({ id: 'pistol', name: 'Pistol', skill: 2, keywords: parseKeywords(['Pistol']) }),
      ],
    });
    expect(rangedWeaponsOf(trooper, 'auto', true).map((w) => w.id)).toEqual(['pistol']);
    // Вне зоны боя 'auto' берёт группу с большим ожидаемым уроном: BS 2+ выигрывает.
    expect(rangedWeaponsOf(trooper, 'auto', false).map((w) => w.id)).toEqual(['pistol']);
    expect(rangedWeaponsOf(trooper, 'other', false).map((w) => w.id)).toEqual(['bolter']);
  });

  it("мелти 'all' считает всё оружие, 'primary' — одно основное плюс [EXTRA ATTACKS]", () => {
    const fighter = model({
      weapons: [
        weapon({
          id: 'sword',
          name: 'Power Sword',
          kind: 'melee',
          skill: 3,
          damage: { count: 1, sides: 6, plus: 1 },
        }),
        weapon({
          id: 'fist',
          name: 'Power Fist',
          kind: 'melee',
          skill: 2,
          damage: { count: 1, sides: 6, plus: 0 },
        }),
        weapon({
          id: 'extra',
          name: 'Extra Blade',
          kind: 'melee',
          skill: 3,
          keywords: parseKeywords(['Extra Attacks']),
        }),
      ],
    });
    expect(meleeWeaponsOf(fighter, 'all').map((w) => w.id)).toEqual(['sword', 'fist', 'extra']);
    // Основное — по ожидаемому урону: Power Sword (3+, D6+1) сильнее Power Fist (2+, D6).
    expect(meleeWeaponsOf(fighter, 'primary').map((w) => w.id)).toEqual(['sword', 'extra']);
  });

  it('фаза melee считает только рукопашное оружие', () => {
    const attacker = unit([
      model({
        weapons: [weapon({ id: 'gun', name: 'Gun' }), weapon({ id: 'blade', name: 'Blade', kind: 'melee' })],
      }),
    ]);
    const defender = unit([model({ toughness: 4, wounds: 9, save: 3 })]);
    const result = simulateTrial(attacker, defender, { phase: 'melee' });
    expect(result.weapons.map((w) => w.weaponId)).toEqual(['blade']);
  });
});

describe('состояние защитника', () => {
  it('damageNextModel не переносит избыток, damageSpill — переносит', () => {
    const defender = unit([model({ id: 'a', wounds: 1 }), model({ id: 'b', wounds: 3 })]);

    const strict = createDefenderState(defender, 'first');
    expect(damageNextModel(strict, 3)).toBe(1);
    expect(strict.aliveCount).toBe(1);
    expect(strict.damage).toBe(1);

    const spill = createDefenderState(defender, 'first');
    expect(damageSpill(spill, 3)).toBe(3);
    expect(spill.kills).toBe(1);
    expect(spill.damage).toBe(3);
  });

  it('стратегия распределения меняет порядок целей', () => {
    const defender = unit([model({ id: 'a' }), model({ id: 'b' })]);
    expect(nextTargetIndex(createDefenderState(defender, 'first'))).toBe(0);
    expect(nextTargetIndex(createDefenderState(defender, 'last'))).toBe(1);
  });
});

describe('Монте-Карло', () => {
  const attacker = gunner(weapon({ attacks: { count: 2, sides: 6, plus: 0 } }));
  const defender = unit([model({ toughness: 4, wounds: 2, save: 3 })]);

  it('одинаковый seed даёт одинаковый результат', () => {
    const a = monteCarlo(attacker, defender, 50, { rng: mulberry32(7) });
    const b = monteCarlo(attacker, defender, 50, { rng: mulberry32(7) });
    expect(a.damage).toEqual(b.damage);
    expect(a.kills).toEqual(b.kills);
    expect(a.killProbability).toBe(b.killProbability);
  });

  it('прогоны различаются, агрегаты неотрицательны', () => {
    const result = monteCarlo(attacker, defender, 200);

    expect(result.trials).toBe(200);
    expect(result.damage.mean).toBeGreaterThan(0);
    expect(result.damage.stdev).toBeGreaterThan(0);
    expect(result.killProbability).toBeGreaterThan(0);
    expect(result.killProbability).toBeLessThanOrEqual(1);
    expect(result.weapons).toHaveLength(1);
    // Сумма урона по оружию совпадает с общим средним.
    expect(result.weapons[0].damageMean).toBeCloseTo(result.damage.mean, 6);
  });
});

