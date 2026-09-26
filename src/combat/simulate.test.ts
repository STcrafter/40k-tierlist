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
  distinctMeleeWeapons,
  meleeWeaponsOf,
  monteCarlo,
  nextTargetIndex,
  rangedWeaponsOf,
  resolveCombatOptions,
  simulateRound,
  simulateTrial,
} from './simulate.ts';
import type { CombatModel, CombatUnit, CombatWeapon, Rng } from './types.ts';

/** Генератор, всегда выдающий грань n (1…6). */
const die = (n: number): Rng => () => (n - 0.5) / 6;

/**
 * Последовательность заданных граней (1…6) — когда броски идут в разном порядке.
 *
 * Грань переводится в [0, 1) так же, как `die`: rollDie считает
 * `1 + floor(rng() * 6)`, поэтому возврат сырого значения дал бы 1 + floor(6*6).
 */
function sequence(values: number[]): Rng {
  let i = 0;
  return () => (values[Math.min(i++, values.length - 1)] - 0.5) / 6;
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
    fnp: null,
    fnpScope: 'all',
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


describe('Feel No Pain', () => {
  // Порядок вызовов rng в ядре (важно для sequence):
  //   1) кубики атаки (по одному на кубик, даже при sides: 1),
  //   2) попадание, 3) ранение, 4) сейв, 5) кубики урона, 6) кубики FNP.
  // Сейв 6+ проваливается только на натуральной 1 — используем его, чтобы
  // проверять FNP, а не спасброски.
  // Механику проверяем напрямую через damageNextModel: полный прогон боя
  // добавляет свои броски (атака, попадание, ранение, сейв) и делает тест
  // хрупким, а здесь важно только правило невелирования.
  // У защитника нет оружия, чтобы он не отвечал встречным огнём.
  const dummy = (overrides: Partial<CombatModel> = {}): CombatModel =>
    model({ weapons: [], ...overrides });

  it('невелирует по 1 урону за каждый кубик ≥ порога', () => {
    const state = createDefenderState(unit([dummy({ wounds: 5, fnp: 5 })]));
    // Три 5+ из трёх — весь урон в 3 невелируется.
    expect(damageNextModel(state, 3, sequence([6, 6, 6]))).toBe(0);
    expect(state.woundsLeft[0]).toBe(5);

    const mixed = createDefenderState(unit([dummy({ wounds: 5, fnp: 5 })]));
    // Два 5+ и один 1 — невелируется 2, остаётся 1.
    expect(damageNextModel(mixed, 3, sequence([6, 6, 1]))).toBe(1);
    expect(mixed.woundsLeft[0]).toBe(4);
  });

  it('оверфлоу не уменьшает число кубиков (правило из ТЗ)', () => {
    // Ключевое требование: у модели 1 рана, атака на 3 урона — кубиков всё
    // равно 3. Три 5+ → выживает, два 5+ → умирает.
    const survives = createDefenderState(unit([dummy({ wounds: 1, fnp: 5 })]));
    expect(damageNextModel(survives, 3, sequence([6, 6, 6]))).toBe(0);
    expect(survives.aliveCount).toBe(1);

    const dies = createDefenderState(unit([dummy({ wounds: 1, fnp: 5 })]));
    expect(damageNextModel(dies, 3, sequence([6, 6, 2]))).toBe(1);
    expect(dies.aliveCount).toBe(0);
  });

  it('модель без FNP получает весь урон', () => {
    const state = createDefenderState(unit([dummy({ wounds: 9, fnp: null })]));
    expect(damageNextModel(state, 3, sequence([6, 6, 1]))).toBe(3);
  });

  it('обычный FNP защищает и от мортидов', () => {
    // Мортиды идут через damageSpill, и обычный FNP (scope 'all') действует
    // там: это отличие от «FNP против мортальных ран» — то ограничение.
    const state = createDefenderState(unit([dummy({ wounds: 3, fnp: 5 })]));
    expect(damageSpill(state, 3, sequence([6, 6, 6]))).toBe(0);
    expect(state.aliveCount).toBe(1);
  });

  it('FNP «против мортальных ран» не защищает от обычного урона', () => {
    // Ограничение области: scope 'mortals' от обычного урона не спасает.
    const state = createDefenderState(unit([dummy({ wounds: 3, fnp: 5, fnpScope: 'mortals' })]));
    expect(damageNextModel(state, 3, sequence([6, 6, 6]))).toBe(3);
    expect(state.aliveCount).toBe(0);
  });

  it('FNP «против мортальных ран» защищает ровно от мортидов', () => {
    const state = createDefenderState(unit([dummy({ wounds: 3, fnp: 5, fnpScope: 'mortals' })]));
    expect(damageSpill(state, 3, sequence([6, 6, 6]))).toBe(0);
    expect(state.aliveCount).toBe(1);
  });

  it('псионические атаки идут мимо FNP в любом случае', () => {
    // Псионик не моделируется как шаблон оружия, но флаг есть: атака с
    // psychic=true не должна невелиться даже при обычном FNP 5+.
    const state = createDefenderState(unit([dummy({ wounds: 5, fnp: 5 })]));
    expect(damageNextModel(state, 3, sequence([6, 6, 6]), true)).toBe(3);
    expect(state.woundsLeft[0]).toBe(2);
  });
});

describe('Stealth', () => {
  it('снижает попадание дальнобойной атаки на 1', () => {
    // die(3) даёт бросок 3: по BS 3+ он попадает, по BS 4+ — уже нет.
    const gun = weapon({ skill: 3, strength: 5 });
    const open = unit([model({ toughness: 4, wounds: 9, save: 6, keywords: ['INFANTRY'] })], ['INFANTRY']);
    const stealthy = unit([model({ toughness: 4, wounds: 9, save: 6, keywords: ['STEALTH'] })], ['STEALTH']);

    expect(simulateTrial(gunner(gun), open, { rng: die(3) }).weapons[0].hits).toBe(1);
    expect(simulateTrial(gunner(gun), stealthy, { rng: die(3) }).weapons[0].hits).toBe(0);
  });

  it('в рукопашной не действует', () => {
    const gun = weapon({ kind: 'melee', skill: 3, strength: 5, range: null });
    const stealthy = unit([model({ toughness: 4, wounds: 9, save: 6, keywords: ['STEALTH'] })], ['STEALTH']);
    const result = simulateTrial(gunner(gun), stealthy, { rng: die(3), phase: 'melee' });
    expect(result.weapons[0].hits).toBe(1);
  });
});

describe('кейворды 11-й редакции', () => {
  it('условный [LETHAL HITS: non-MONSTER/VEHICLE] не работает по технике', () => {
    // Регрессия: правило проверяло только имя кейворда и не смотрело на
    // условие, поэтому «Lethal Hits: non-MONSTER/VEHICLE» автоматически
    // ранил бы и MONSTER, и VEHICLE. В BSData так оформлено 81 оружие.
    const gun = weapon({ skill: 2, strength: 2, keywords: parseKeywords(['Lethal Hits: non-MONSTER/VEHICLE']) });
    // S2 против T11 — порог 6+, бросок 3 промахивается. Если бы Lethal
    // применялся, было бы авторанение.
    const vehicle = unit([model({ toughness: 11, wounds: 20, save: 6, keywords: ['VEHICLE'] })], ['VEHICLE']);
    const vsVehicle = simulateTrial(gunner(gun), vehicle, { rng: die(3) });
    expect(vsVehicle.weapons[0].wounds).toBe(0);

    // Та же ствола против пехоты: крит. попадание (натуральная 6) ранит.
    const infantry = unit([model({ toughness: 11, wounds: 20, save: 6, keywords: ['INFANTRY'] })], ['INFANTRY']);
    const vsInfantry = simulateTrial(gunner(gun), infantry, { rng: die(6) });
    expect(vsInfantry.weapons[0].wounds).toBe(1);
  });

  it('условный [DEVASTATING WOUNDS] тоже уважает условие', () => {
    const gun = weapon({
      skill: 2,
      strength: 20,
      keywords: parseKeywords(['Devastating Wounds: non-MONSTER/VEHICLE']),
    });
    // Критическое ранение (натуральная 6) по VEHICLE: D не применяется.
    const vehicle = unit([model({ toughness: 11, wounds: 20, save: 3, keywords: ['VEHICLE'] })], ['VEHICLE']);
    const vsVehicle = simulateTrial(gunner(gun), vehicle, { rng: sequence([6, 6, 1]) });
    expect(vsVehicle.weapons[0].mortals).toBe(0);
  });

  it('[IGNORES COVER] снимает укрытие, а обычный болтер — нет', () => {
    // Цель в укрытии: без [IGNORES COVER] болтер получает +1 к сейву.
    const cover = true;
    const plain = weapon({ ap: 0 });
    const vsCover = simulateTrial(gunner(plain), unit([model({ save: 3, wounds: 9 })]), { rng: die(3), cover });
    // 3+ с укрытием → 4+, бросок 3 не проходит; без укрытия прошёл бы.
    expect(vsCover.weapons[0].unsaved).toBe(0);
  });

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
      rng: sequence([1, 4, 2, 3]),
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

  it('лидерские reroll попаданий увеличивают шанс попадания', () => {
    const attacker = gunner(weapon({ skill: 5, attacks: { count: 1, sides: 1, plus: 0 } }));
    const defender = unit([model({ toughness: 4, wounds: 99, save: 6 })]);
    // Первый бросок — промах 1, reroll — попадание 6.
    const result = simulateTrial(attacker, defender, { rng: sequence([1, 6]), rerollHitOn: [1] });
    expect(result.weapons[0].hits).toBe(1);
  });

  it('фазa melee считает только рукопашное оружие', () => {
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

/**
 * Регрессии по кейвордам оружия, найденные при сверке с текстами правил
 * BSData (gameSystem 'Warhammer 40,000.json').
 */
describe('кейворды: регрессии', () => {
  it('[LANCE] даёт +1 к ранению после зарядки', () => {
    // Порог по S/T: S5 против T4 → 3+. С зарядкой Lance → 2+.
    // Ранение проходит от броска 2, но без Lance тот же бросок 2 не проходит.
    const lance = weapon({ skill: 2, strength: 5, keywords: parseKeywords(['Lance']) });
    const defender = unit([model({ toughness: 4, wounds: 9, save: 6 })]);

    const charged = simulateTrial(gunner(lance), defender, { rng: die(2), charged: true });
    expect(charged.weapons[0].wounds).toBe(1);

    // Без зарядки (или без самого кейворда) 2+ не хватает.
    const notCharged = simulateTrial(gunner(lance), defender, { rng: die(2), charged: false });
    expect(notCharged.weapons[0].wounds).toBe(0);
  });

  it('[LANCE] не меняет порог, если оружия нет', () => {
    const plain = weapon({ skill: 2, strength: 5 });
    const defender = unit([model({ toughness: 4, wounds: 9, save: 6 })]);
    expect(simulateTrial(gunner(plain), defender, { rng: die(2), charged: true }).weapons[0].wounds).toBe(0);
  });

  it('[ANTI-X] учитывает ВСЕ anti-кейворды оружия, а не только первый', () => {
    // Регрессия: брался только первый Anti. Здесь первым идёт Anti-MONSTER 4+,
    // а против техники решает второй — Anti-VEHICLE 3+ (порог 3).
    // Ранение 3+ от броска 3 должно быть критическим.
    const gun = weapon({
      skill: 2,
      strength: 5,
      keywords: parseKeywords(['Anti-MONSTER 4+', 'Anti-VEHICLE 3+', 'Devastating Wounds']),
    });
    const vehicle = unit([model({ toughness: 4, wounds: 9, save: 6, keywords: ['VEHICLE'] })]);
    // Сейв 6+ отказывает; Devastating Wounds на критическом ранении даёт мортиды
    // в обход сейва, поэтому урон равен D оружия.
    const result = simulateTrial(gunner(gun), vehicle, { rng: die(3) });
    expect(result.weapons[0].mortals).toBe(1);
  });

  it('[ANTI-X] с условием не срабатывает, когда условие нарушено', () => {
    // 'Anti-VEHICLE 4+: non-FLYER' — против FLYER условие не выполнено,
    // поэтому крит. ранения не будет и мортидов не будет.
    const gun = weapon({
      skill: 2,
      strength: 5,
      keywords: parseKeywords(['Anti-VEHICLE 4+: non-FLYER', 'Devastating Wounds']),
    });
    const flyer = unit([model({ toughness: 4, wounds: 9, save: 6, keywords: ['FLYER'] })]);
    expect(simulateTrial(gunner(gun), flyer, { rng: die(4) }).weapons[0].mortals).toBe(0);
  });

  it('[PSYCHIC] игнорирует штраф попадания от Stealth', () => {
    // Stealth добавляет +1 к порогу попадания. Псионическая атака его игнорирует,
    // поэтому бросок 3 по BS 3+ попадает и без Stealth.
    const gun = weapon({ skill: 3, strength: 5, keywords: parseKeywords(['Psychic']) });
    const plain = unit([model({ toughness: 4, wounds: 9, save: 6, keywords: ['INFANTRY'] })]);
    const hidden = unit([model({ toughness: 4, wounds: 9, save: 6, keywords: ['STEALTH'] })]);

    // По BS 3+ бросок 3 попадает всегда → ранение есть.
    expect(simulateTrial(gunner(gun), hidden, { rng: die(3) }).weapons[0].wounds).toBe(1);
    // Без [PSYCHIC] тот же бросок против Stealth-цели промахивается.
    const normal = weapon({ skill: 3, strength: 5 });
    expect(simulateTrial(gunner(normal), hidden, { rng: die(3) }).weapons[0].wounds).toBe(0);
    expect(simulateTrial(gunner(normal), plain, { rng: die(3) }).weapons[0].wounds).toBe(1);
  });

  it('[PSYCHIC] игнорирует бонус [HEAVY]', () => {
    // [HEAVY] улучшает попадание на 1, но псионическая атака игнорирует
    // модификаторы — бросок 3 по BS 4+ без Heavy должен промахнуться.
    const gun = weapon({ skill: 4, strength: 5, keywords: parseKeywords(['Psychic', 'Heavy']) });
    const defender = unit([model({ toughness: 4, wounds: 9, save: 6 })]);
    expect(simulateTrial(gunner(gun), defender, { rng: die(3), stationary: true }).weapons[0].hits).toBe(0);
    // Без [PSYCHIC] тот же Heavy превращает 3 в попадание.
    const heavy = weapon({ skill: 4, strength: 5, keywords: parseKeywords(['Heavy']) });
    expect(simulateTrial(gunner(heavy), defender, { rng: die(3), stationary: true }).weapons[0].hits).toBe(1);
  });

  it('[BLAST] считается от моделей в отряде, а не от живых', () => {
    // Регрессия: считалось от живых на момент броска, и Blast терял бонус
    // по мере убийства. 10 моделей с [BLAST] всегда дают +2 кубика атаки.
    const gun = weapon({ skill: 2, strength: 5, keywords: parseKeywords(['Blast']) });
    const many = unit(Array.from({ length: 10 }, (_, i) => model({ id: `m${i}`, wounds: 1, save: 6 })));
    // 1 атака + 2 от Blast = 3; бросок 4 попадает по BS 2+.
    const result = simulateTrial(gunner(gun), many, { rng: die(4) });
    expect(result.weapons[0].attacks).toBe(3);
  });

  it('[BLAST] не теряет бонус после смертей в том же бою', () => {
    // Первая атака убивает часть моделей, но у следующей атаки число кубиков
    // остаётся прежним: [BLAST] считается от состава отряда, а не от живых.
    // Регрессия: при aliveCount у второй атаки было бы 2 кубика вместо 3.
    const gun = weapon({ skill: 2, strength: 5, keywords: parseKeywords(['Blast']) });
    const many = unit(
      Array.from({ length: 10 }, (_, i) => model({ id: `m${i}`, wounds: 1, save: 6 }))
    );
    const state = createDefenderState(many);
    // Убиваем 5 моделей до начала атаки.
    for (let i = 0; i < 5; i += 1) damageNextModel(state, 1, die(6));
    expect(state.aliveCount).toBe(5);
    expect(state.initialModelCount).toBe(10);

    const usages = new Map();
    simulateRound(gunner(gun), state, resolveCombatOptions({ rng: die(1) }), usages);
    // 1 базовый кубик + 2 от Blast (10 моделей в отряде) = 3, несмотря на 5 смертей.
    expect(usages.get(gun.id)?.attacks).toBe(3);
  });
});


describe('одинаковые оружия в рукопашной фазе', () => {
  const sword = (id: string, keywords: string[] = []): CombatWeapon => ({
    id,
    name: 'Chainsword',
    kind: 'melee',
    range: null,
    attacks: { count: 4, sides: 1, plus: 0 },
    skill: 3,
    strength: 4,
    ap: -1,
    damage: { count: 1, sides: 1, plus: 0 },
    keywords: parseKeywords(keywords),
  });

  it('два одинаковых без [EXTRA ATTACKS] в ближнем бью схлопываются в одно', () => {
    // Правило 11-й редакции: бить несколькими одинаковыми оружиями можно
    // только при наличии [EXTRA ATTACKS]. Замер по базе нашёл 4 такие модели.
    expect(distinctMeleeWeapons([sword('a'), sword('b')])).toHaveLength(1);
  });

  it('с [EXTRA ATTACKS] одинаковые оружия остаются оба', () => {
    expect(
      distinctMeleeWeapons([sword('a', ['Extra Attacks']), sword('b', ['Extra Attacks'])])
    ).toHaveLength(2);
  });

  it('разные оружия не схлопываются', () => {
    const hammer = { ...sword('b'), strength: 8, damage: { count: 2, sides: 1, plus: 0 } };
    expect(distinctMeleeWeapons([sword('a'), hammer])).toHaveLength(2);
  });

  it('дальнобойные дубли правилом не ограничены', () => {
    // Двумя одинаковыми стволами стрелять можно всегда — правило касается
    // только рукопашной фазы.
    const gun = (id: string): CombatWeapon => ({ ...sword(id), kind: 'ranged', range: 24 });
    const model: CombatModel = {
      id: 'm',
      name: 'M',
      toughness: 6,
      wounds: 6,
      save: 3,
      invuln: null,
      fnp: null,
      fnpScope: 'all',
      keywords: [],
      weapons: [gun('a'), gun('b')],
    };
    expect(rangedWeaponsOf(model, 'auto', false)).toHaveLength(2);
  });
});
