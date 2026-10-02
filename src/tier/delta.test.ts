/**
 * Инварианты дельты «отряд + лидер».
 *
 * Дельта отвечает на вопрос «насколько отряд стал лучше из-за лидера» — это
 * величина, ради которой затевался пересчёт группировок. Тесты фиксируют её
 * контракт ДО появления самого расчёта, чтобы реализация шага 2–4 не могла
 * сделать что-то незаметно неверное.
 *
 * Ключевой приём: фикстура-лидер с НУЛЕВЫМИ бонусами и НУЛЕВЫМ числом моделей.
 * Пара с ним совпадает с голым отрядом до последнего разряда, поэтому дельта
 * обязана быть ровно нулём. Так ловится и потерянный бонус, и случайно
 * подставленная модель лидера в телохранителя.
 *
 * Отдельно проверяется, что лидер с моделью, но без бонусов даёт ненулевую
 * дельту живучести и нулевую дельту урона: модель лидера — это реальные раны,
 * и забывать о них нельзя. Это не баг, а поведение, которое стоит зафиксировать.
 */

import { describe, expect, it } from 'vitest';
import { bsFilesFromDir } from '../bsdata/node-source.ts';
import { loadBsData } from '../bsdata/load.ts';
import { parseBsDatabase } from '../bsdata/units.ts';
import { adaptUnit } from '../combat/adapter.ts';
import { rawScoreOf, type RawScore } from './scoring.ts';
import { attachLeaderToUnit, leaderDefinitionsOf, type LeaderBonuses } from './leaders.ts';
import type { BsDatasheet } from '../bsdata/types.ts';
import type { CombatModel } from '../combat/types.ts';

const { datasheets } = parseBsDatabase(loadBsData(bsFilesFromDir('public/BSData/wh40k-11e')));

const find = (name: string): BsDatasheet => {
  const found = datasheets.find((sheet) => sheet.name === name);
  if (found === undefined) throw new Error(`Нет даташита: ${name}`);
  return found;
};

/**
 * Много прогонов и фиксированные сиды: тесты проверяют равенство величин, а не
 * их величину, поэтому шум не должен влиять на результат.
 */
const options = {
  combat: { trials: 40, distance: 12, seed: 20_260_201 },
  survival: { trials: 24, maxRounds: 8, distance: 12, seed: 20_260_202 },
  mode: 'combined' as const,
  targetParadigm: 'all' as const,
};

/** Отряд-телохранитель, у которого в базе есть лидеры. */
const squadSheet = find('Intercessor Squad');
const squad = adaptUnit(squadSheet, { size: 'min' });

const noBonuses = (): LeaderBonuses => ({
  toughness: 0,
  wounds: 0,
  save: 0,
  invuln: 0,
  leadership: 0,
  objectiveControl: 0,
  weaponAttacks: 0,
  weaponSkill: 0,
  weaponStrength: 0,
  weaponDamage: 0,
  weaponKeywords: [],
  rerollHitOn: [],
  rerollWoundOn: [],
  rerollSaveOn: [],
});

function leaderModel(wounds: number): CombatModel {
  return {
    id: 'test-leader-model',
    name: 'Test Leader',
    toughness: 4,
    wounds,
    save: 3,
    invuln: null,
    fnp: null,
    fnpScope: 'all',
    keywords: ['Leader'],
    weapons: [],
  };
}

/** Фикстура-лидер: сколько моделей он несёт, столько и добавляет отряду. */
function fakeLeader(models: CombatModel[], bonuses: Partial<LeaderBonuses> = {}): import('./leaders.ts').LeaderDefinition {
  return {
    id: 'test-leader',
    name: 'Test Leader',
    faction: 'Imperium',
    factions: ['Imperium'],
    points: 0,
    keywords: ['Leader'],
    allowedUnitIds: [squadSheet.id],
    bonuses: { ...noBonuses(), ...bonuses },
    abilities: [],
    unit: { id: 'test-leader', name: 'Test Leader', keywords: ['Leader'], models },
  };
}

describe('дельта «отряд + лидер»', () => {
  it('лидер без бонусов и без моделей даёт нулевую дельту', () => {
    // Опорный тест. Дельта = метрика пары минус метрика голого отряда; при
    // лидере, который не добавляет ничего, она обязана быть нулём ПОТОМУ ЧТО:
    // тот же отряд, тот же сид, тот же набор целей.
    const bare = rawScoreOf(squadSheet, squad.unit, squad.points, options);
    const paired = rawScoreOf(squadSheet, squad.unit, squad.points, {
      ...options,
      leader: fakeLeader([]),
    });
    expect(paired.rawMaxDamage - bare.rawMaxDamage).toBe(0);
    expect(paired.damagePer100 - bare.damagePer100).toBe(0);
    expect(paired.universal - bare.universal).toBe(0);
    expect(paired.effectiveSurvivability - bare.effectiveSurvivability).toBe(0);
  });

  it('лидер без бонусов, но со моделью даёт нулевую дельту урона', () => {
    // Модель лидера без оружия не стреляет и не бьёт — урон не меняется ни на
    // йоту. Если дельта урона ненулевая, в отряд попало что-то лишнее.
    const bare = rawScoreOf(squadSheet, squad.unit, squad.points, options);
    const paired = rawScoreOf(squadSheet, squad.unit, squad.points, {
      ...options,
      leader: fakeLeader([leaderModel(2)]),
    });
    expect(paired.rawMaxDamage - bare.rawMaxDamage).toBe(0);
    expect(paired.damagePer100 - bare.damagePer100).toBe(0);
  });

  it('модель лидера без оружия увеличивает живучесть, а не урон', () => {
    // Второе лицо того же свойства, и оно ловит реальный класс ошибок: раны
    // модели лидера — это настоящие раны, их обязательно видно в живучести.
    // На уроне такой лидер не виден вообще, поэтому проверка только урона
    // пропустила бы потерю модели.
    const bare = rawScoreOf(squadSheet, squad.unit, squad.points, options);
    const paired = rawScoreOf(squadSheet, squad.unit, squad.points, {
      ...options,
      leader: fakeLeader([leaderModel(2)]),
    });
    expect(paired.effectiveSurvivability, 'раны модели лидера должны дать прирост').toBeGreaterThan(
      bare.effectiveSurvivability
    );
  });

  it('модель лидера добавляется в конец и не трогает телохранителя', () => {
    // Телохранитель и лидер — разные модели: их нельзя смешивать, иначе лидер
    // получил бы оружие и статы отряда.
    const attached = attachLeaderToUnit(squad.unit, fakeLeader([leaderModel(2)]));
    expect(attached.models).toHaveLength(squad.unit.models.length + 1);
    for (const [index, model] of squad.unit.models.entries()) {
      expect(attached.models[index].toughness, `модель ${index}`).toBe(model.toughness);
      expect(attached.models[index].wounds, `модель ${index}`).toBe(model.wounds);
      expect(attached.models[index].save, `модель ${index}`).toBe(model.save);
    }
    expect(attached.models.at(-1)?.wounds).toBe(2);
  });

  it('настоящий лидер с боевым бонусом даёт положительную дельту урона', () => {
    // Если бы дельта была нулевой и тут, лидеры вообще не влияли бы на
    // результат — а это главная гипотеза, ради которой всё затевалось.
    const withBonus = leaderDefinitionsOf(datasheets).find(
      (leader) => leader.bonuses.weaponAttacks > 0 || leader.bonuses.weaponDamage > 0
    );
    expect(withBonus, 'нужен лидер с боевым бонусом').toBeDefined();
    const leader = withBonus!;
    const sheet = datasheets.find((item) => leader.allowedUnitIds.includes(item.id));
    expect(sheet, `у «${leader.name}» должен быть хотя бы один допустимый отряд`).toBeDefined();
    const target = adaptUnit(sheet!, { size: 'min' });

    const bare = rawScoreOf(sheet!, target.unit, target.points, options);
    const paired = rawScoreOf(sheet!, target.unit, target.points, { ...options, leader });
    expect(
      paired.damagePer100 - bare.damagePer100,
      `«${sheet!.name} + ${leader.name}» не сильнее голого отряда`
    ).toBeGreaterThan(0);
  });
});
describe('каждый бонус лидера виден в своей метрике', () => {
  // ГЛАВНЫЙ блок. Фикстура с нулевыми бонусами не способна поймать потерю
  // бонуса: там `model.wounds + 0` и забытое `+ bonuses.wounds` совпадают.
  //
  // Нужен ещё один приём: сравнивать надо лидера С бонусом и БЕЗ него при
  // одинаковых моделях, а не с голым отрядом. Модель лидера сама по себе
  // добавляет раны и живучести, поэтому сравнение с голым отрядом показывало
  // бы прирост даже при полностью потерянном бонусе.
  const withLeader = (bonuses: Partial<LeaderBonuses>) =>
    rawScoreOf(squadSheet, squad.unit, squad.points, {
      ...options,
      leader: fakeLeader([leaderModel(2)], bonuses),
    });
  // Прирост от САМОГО бонуса: тот же лидер, те же модели, различается только
  // величина бонуса.
  const bonusGain = (bonuses: Partial<LeaderBonuses>, pick: (row: RawScore) => number) =>
    pick(withLeader(bonuses)) - pick(withLeader({}));

  it('+1 рана увеличивает живучесть', () => {
    expect(
      bonusGain({ wounds: 1 }, (row) => row.effectiveSurvivability),
      'бонус ран не дошёл до отряда'
    ).toBeGreaterThan(0);
  });

  it('+1 прочность увеличивает живучесть', () => {
    expect(bonusGain({ toughness: 1 }, (row) => row.effectiveSurvivability)).toBeGreaterThan(0);
  });

  it('+1 атака увеличивает урон', () => {
    expect(bonusGain({ weaponAttacks: 1 }, (row) => row.damagePer100)).toBeGreaterThan(0);
  });

  it('+1 урон оружия увеличивает урон', () => {
    expect(bonusGain({ weaponDamage: 1 }, (row) => row.damagePer100)).toBeGreaterThan(0);
  });

  it('бонус ран не подменяет собой бонус урона', () => {
    // Оси разные, и ошибка «прибавили не туда» дала бы прирост на неверной
    // метрике. Ран должны двигать только живучесть, урон — не трогать.
    expect(bonusGain({ wounds: 1 }, (row) => row.damagePer100)).toBe(0);
  });
});