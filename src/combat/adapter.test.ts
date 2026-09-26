/**
 * Тесты адаптера BSData → CombatUnit.
 *
 * Проверяем на реальных даташитах базы wh40k-11e: раскладку отряда по
 * ограничениям min/max, разбор оружейных профилей и то, что адаптер
 * действительно строит боеспособный отряд (есть оружие, есть T/W).
 */

import { describe, expect, it } from 'vitest';
import { bsFilesFromDir } from '../bsdata/node-source.ts';
import { loadBsData } from '../bsdata/load.ts';
import { parseBsDatabase } from '../bsdata/units.ts';
import type { BsDatasheet } from '../bsdata/types.ts';
import { adaptUnit } from './adapter.ts';
import { monteCarlo } from './simulate.ts';
import { withOnceEffects, rerollOptionsOf } from '../manual/abilities.ts';
import { detectUtilityFlags } from '../tier/utility.ts';
import { attachLeaderToUnit, leaderDefinitionsOf, type LeaderDefinition } from '../tier/leaders.ts';
import { createDefenderState, damageNextModel, upkeepBetweenRounds } from './simulate.ts';

const { datasheets } = parseBsDatabase(loadBsData(bsFilesFromDir('public/BSData/wh40k-11e')));
const find = (name: string): BsDatasheet => {
  const found = datasheets.find((sheet) => sheet.name === name);
  if (!found) throw new Error(`Нет даташита: ${name}`);
  return found;
};

describe('размер отряда по ограничениям', () => {
  it('минимальный состав берёт минимумы вариантов', () => {
    const boyz = adaptUnit(find('Boyz'), { size: 'min' });
    // 9-18 Boyz + 1-2 Nobz: 6 Boy + 1 Nob = 7 моделей.
    expect(boyz.unit.models).toHaveLength(7);
    expect(boyz.counts.size).toBe(2);
    expect(boyz.points).toBe(90);
  });

  it('максимальный состав не превышает максимум группы и лимиты снаряжения', () => {
    const boyz = adaptUnit(find('Boyz'), { size: 'max' });
    // Группы: 9-18 Boyz и 1-2 Nobz → 18 + 2 = 20 моделей.
    expect(boyz.unit.models).toHaveLength(20);
    expect(boyz.points).toBe(180);
  });

  it('одиночный даташит даёт ровно одну модель', () => {
    const warboss = adaptUnit(find('Warboss'), { size: 'max' });
    expect(warboss.unit.models).toHaveLength(1);
    expect(warboss.unit.models[0].toughness).toBeGreaterThan(0);
  });
});

describe('разбор профилей', () => {
  it('оружие и характеристики переносятся из BSData', () => {
    const boy = adaptUnit(find('Boyz'), { size: 'min' }).unit.models.find((m) => m.name === 'Boy');
    expect(boy).toBeDefined();
    expect(boy?.toughness).toBe(5);
    expect(boy?.wounds).toBe(1);
    expect(boy?.save).toBe(5);

    const choppa = boy?.weapons.find((w) => w.name === 'Choppa');
    expect(choppa).toBeDefined();
    expect(choppa?.kind).toBe('melee');
    expect(choppa?.range).toBeNull();
    expect(choppa?.skill).toBe(3);
    expect(choppa?.strength).toBe(5);
    expect(choppa?.ap).toBe(-1);
    expect(choppa?.attacks).toEqual({ count: 3, sides: 1, plus: 0 });

    const shoota = boy?.weapons.find((w) => w.name === 'Shoota');
    expect(shoota?.kind).toBe('ranged');
    expect(shoota?.range).toBe(18);
    expect(shoota?.skill).toBe(5);
  });

  it('дальность, кубы и кейворды разбираются из строк BSData', () => {
    const slugga = adaptUnit(find('Boyz'), { size: 'min' }).unit.models
      .find((m) => m.name === 'Boy')
      ?.weapons.find((w) => w.name === 'Slugga');
    expect(slugga?.range).toBe(12);
    expect(slugga?.attacks).toEqual({ count: 1, sides: 1, plus: 0 });
    // 'CLOSE-QUARTERS' и 'LETHAL HITS: non-MONSTER/VEHICLE' разбираются в канон.
    const names = slugga?.keywords.map((k) => k.name) ?? [];
    expect(names).toContain('close-quarters');
    expect(names).toContain('lethal');
    expect(slugga?.keywords.find((k) => k.name === 'lethal')?.condition).toEqual({
      keywords: ['MONSTER', 'VEHICLE'],
      negate: true,
    });
  });
});

describe('пригодность к бою', () => {
  const boyz = () => adaptUnit(find('Boyz'), { size: 'min' }).unit;
  const inter = () => adaptUnit(find('Intercessor Squad'), { size: 'min' }).unit;

  it('Монте-Карло по Boyz против Intercessors даёт урон в обеих фазах', () => {
    // Постоянная шестёрка не годится: натуральная 6 всегда проходит сейв 3+,
    // поэтому берём серию прогонов с детерминированным сидом.
    const ranged = monteCarlo(boyz(), inter(), 200, { phase: 'ranged', distance: 12 });
    const melee = monteCarlo(boyz(), inter(), 200, { phase: 'melee' });

    expect(ranged.damage.mean).toBeGreaterThan(0);
    expect(melee.damage.mean).toBeGreaterThan(0);
    // Рукопашная Boyz (Choppa) ощутимо сильнее их же стрельбы.
    expect(melee.damage.mean).toBeGreaterThan(ranged.damage.mean);
    expect(ranged.weapons.every((w) => w.kind === 'ranged')).toBe(true);
  });

  it('у всех моделей выбранных отрядов есть T, W и оружие', () => {
    for (const name of ['Boyz', 'Intercessor Squad', 'Deff Dread', 'Warboss']) {
      const { unit } = adaptUnit(find(name), { size: 'max' });
      expect(unit.models.length, name).toBeGreaterThan(0);
      for (const model of unit.models) {
        expect(model.toughness, `${name}/${model.name}`).toBeGreaterThan(0);
        expect(model.wounds, `${name}/${model.name}`).toBeGreaterThan(0);
        expect(model.weapons.length, `${name}/${model.name}`).toBeGreaterThan(0);
      }
    }
  });

  it('один профиль оружия выбирается, а не превращается в два ствола', () => {
    const hellblaster = adaptUnit(find('Hellblaster Squad'), { size: 'min' });
    const oneModel = hellblaster.unit.models.find((model) => /Hellblaster Sergeant/.test(model.name));
    expect(oneModel).toBeDefined();
    // Инвариант теста: у Plasma Incinerator два РЕЖИМА, но это одно оружие —
    // в отряд оно попадает стволом, а не двумя.
    expect(
      oneModel?.weapons.filter((weapon) => /Plasma Incinerator/i.test(weapon.name)).length
    ).toBe(1);
    // Раньше здесь проверялось, что берётся Standard, а не Supercharge. Это
    // устаревшая политика выбора: по правилам игрок выбирает режим сам, и
    // оценивать нужно лучший. Теперь Supercharge и выигрывает по
    // ожидаемой ценности (атак × урон).
    expect(oneModel?.weapons.some((weapon) => /Supercharge/i.test(weapon.name))).toBe(true);
  });

  it('режим выбирается по ожидаемой ценности, а не по числу атак', () => {
    // У клинков профили — это РАЗНЫЕ удары, а не режимы: у Cerastus shock lance
    // «sweep» бьёт A10, но «strike» — A5 с S20/AP-3, то есть 5×8=40 против
    // 10×3=30. Выбор по одним атакам взял бы здесь худший вариант.
    const lancer = adaptUnit(find('Cerastus Knight Lancer'), { size: 'min' });
    const lances = lancer.unit.models[0]?.weapons.filter((w) => /lance/i.test(w.name)) ?? [];
    const melee = lances.filter((w) => w.kind === 'melee');
    const ranged = lances.filter((w) => w.kind === 'ranged');
    // Запись несёт профили ОБОИХ видов — оба должны доехать до отряда.
    expect(melee.length + ranged.length, 'оба вида ланса').toBeGreaterThanOrEqual(2);
    expect(melee[0]?.name, 'ожидается strike (A5 S20), а не sweep (A10 S10)').toMatch(/strike/i);
  });

  it('запись с профилями обоих видов не теряет ни один из них', () => {
    // Регрессия: выбор шёл по всей записи сразу, и профиль второго вида
    // пропадал вместе со своими кейвордами. У Abaddon «Talon of Horus» —
    // дальнобойный (Sustained Hits 1) и рукопашный (Devastating Wounds).
    const abaddon = adaptUnit(find('Abaddon the Despoiler'), { size: 'min' });
    const talon = abaddon.unit.models
      .flatMap((m) => m.weapons)
      .filter((w) => /talon/i.test(w.name));
    expect(talon.some((w) => w.kind === 'ranged'), 'дальнобойный профиль').toBe(true);
    expect(talon.some((w) => w.kind === 'melee'), 'рукопашный профиль').toBe(true);
    expect(
      talon.some((w) => w.keywords.some((k) => k.name === 'devastating')),
      'Devastating Wounds не должен теряться'
    ).toBe(true);
  });

  it('группа с min=5 и вариантами min=0 всё равно собирает отряд', () => {
    const veterans = adaptUnit(find('Deathwatch Veterans'), { size: 'min' });
    expect(veterans.unit.models.length).toBeGreaterThanOrEqual(5);
    expect(veterans.unit.models.every((model) => model.weapons.length > 0)).toBe(true);
  });

  it('модель без собственного Unit-профиля наследует профиль контейнера', () => {
    // В каталогах Space Marines/Agents of the Imperium профиль лежит на
    // родительском юните, а отдельные модели не дублируют его infoLink.
    const cases = [
      { name: 'Blood Claws', toughness: 4 },
      { name: 'Death Company Intercessors', toughness: 4 },
      { name: 'Grey Knights Terminator Squad', toughness: 5 },
    ];
    for (const { name, toughness } of cases) {
      const adapted = adaptUnit(find(name), { size: 'min' });
      expect(adapted.unit.models.length, name).toBeGreaterThan(0);
      for (const model of adapted.unit.models) {
        expect(model.toughness, `${name}/${model.name}`).toBe(toughness);
        expect(model.wounds, `${name}/${model.name}`).toBeGreaterThan(0);
      }
    }
  });

  it('наследование профиля также чинит общие модели каталога', () => {
    // У Necron Warriors отдельные варианты не дублируют Unit-профиль, но он
    // есть на родительском узле. После наследования отряд снова боеспособен.
    const warriors = adaptUnit(find('Necron Warriors'), { size: 'max' });
    expect(warriors.unit.models.length).toBeGreaterThan(0);
    expect(warriors.unit.models.every((model) => model.toughness > 0 && model.wounds > 0)).toBe(true);
  });
});

/**
 * Feel No Pain в BSData встречается в трёх видах, и они НЕ равнозначны:
 *   1) обычный FNP — защита от любого урона, включая мортиды;
 *   2) «against mortal wounds» — ОГРАНИЧЕНИЕ: только мортиды;
 *   3) «against psychic attacks» — псионик, которого мы не моделируем.
 * Плюс встречаются временные/условные гранты: отряд не имеет FNP сам по
 * себе, а получает его на время или при выполнении условия.
 */
describe('разбор Feel No Pain', () => {
  const fnpOfName = (name: string) => {
    const model = adaptUnit(find(name), { size: 'min' }).unit.models[0];
    return model === undefined ? null : { fnp: model.fnp, scope: model.fnpScope };
  };

  it('обычный FNP действует против всего урона', () => {
    expect(fnpOfName('Aberrants')).toEqual({ fnp: 5, scope: 'all' });
    expect(fnpOfName('Abominant')).toEqual({ fnp: 5, scope: 'all' });
  });

  it('«against mortal wounds» — ограничение области, а не усиление', () => {
    // Регрессия: служебная пара BSData («Feel No Pain 5+» рядом с «This
    // ability always takes the form Feel No Pain X+») перебивала ограниченный
    // грант и превращала Aleya в обычный FNP 3+ против всего урона.
    expect(fnpOfName('Aleya')).toEqual({ fnp: 3, scope: 'mortals' });
    expect(fnpOfName('Canoness')).toEqual({ fnp: 4, scope: 'mortals' });
    expect(fnpOfName('Krieg Command Squad')).toEqual({ fnp: 6, scope: 'mortals' });
  });

  it('«against psychic and mortal wounds» сводится к мортидам', () => {
    // Из двух областей мы моделируем только мортиды: псионик в шаблонах
    // оружия отсутствует, а против него FNP не работает в любом случае.
    expect(fnpOfName('Prosecutors')).toEqual({ fnp: 3, scope: 'mortals' });
    expect(fnpOfName('Witchseekers')).toEqual({ fnp: 3, scope: 'mortals' });
  });

  it('временные и условные гранты не выдаются как постоянный FNP', () => {
    // Urien Rakarth: FNP 4+ только против атак с Damage 1. Quartermaster
    // Cadre: FNP 5+ лишь пока в отряде есть Medicae Servitors.
    expect(fnpOfName('Urien Rakarth [Legends]')).toEqual({ fnp: null, scope: 'all' });
    expect(fnpOfName('Quartermaster Cadre Squad [Legends]')).toEqual({ fnp: null, scope: 'all' });
  });

  it('отряды без FNP в даташите остаются без FNP', () => {
    for (const name of ['Intercessor Squad', 'Boyz', 'Leman Russ Battle Tank', 'Beastboss']) {
      expect(fnpOfName(name)?.fnp ?? null, name).toBeNull();
    }
  });
});


describe('ручные ауры лидеров Sororitas', () => {
  const leader = (name: string) => adaptUnit(find(name), { size: 'min' });

  it('Junith Eruita: STEALTH и MELEE_EVASION себе и юниту', () => {
    const model = leader('Junith Eruita').unit.models[0];
    expect(model.keywords).toContain('STEALTH');
    // Кейворд нужен рукопашной защите: без него rules.ts не снимет попадание.
    expect(model.keywords).toContain('MELEE_EVASION');
  });

  it('Hospitaller: FNP 5+ и признак целителя', () => {
    const model = leader('Hospitaller').unit.models[0];
    expect(model.fnp).toBe(5);
    expect(model.reviveLeader).toBe(true);
  });

  it('Imagifier: save 2+ и invsv 4+', () => {
    const model = leader('Imagifier').unit.models[0];
    expect(model.save).toBe(2);
    expect(model.invuln).toBe(4);
  });

  it('Palatine: +1 мортида за ранение в рукопашной', () => {
    // Регрессия: эффект висит на ОРУЖИИ, и условие в адаптере одно время
    // проверяло не то поле — бонус молча пропадал у всего отряда.
    const weapons = leader('Palatine').unit.models[0].weapons;
    const melee = weapons.filter((weapon) => weapon.kind === 'melee');
    expect(melee.length, 'нужно рукопашное оружие').toBeGreaterThan(0);
    for (const weapon of melee) {
      expect(weapon.mortalPerWound).toEqual({ amount: 1, phase: 'melee' });
    }
    // Стрельбе бонус не выдаётся: способность рукопашная.
    for (const weapon of weapons.filter((weapon) => weapon.kind === 'ranged')) {
      expect(weapon.mortalPerWound).toBeUndefined();
    }
  });

  it('одноразовые баффы НЕ попадают в бой', () => {
    // Ключевое требование: «once per battle» не даёт постоянного преимущества.
    // Ministorum Priest в бою бьёт A3 S5, а не A4 S6.
    const priest = leader('Ministorum Priest');
    const melee = priest.unit.models[0].weapons.filter((weapon) => weapon.kind === 'melee');
    expect(melee[0]?.attacks?.count).toBe(3);
    expect(melee[0]?.strength).toBe(5);
  });

  it('с одноразовыми эффектами юнит отличается от боевого', () => {
    const { unit } = leader('Ministorum Priest');
    const boosted = withOnceEffects(unit);
    // Копия должна отличаться, иначе дельта была бы нулевой.
    expect(boosted).not.toBe(unit);
    expect(boosted.models[0].weapons[0]).not.toBe(unit.models[0].weapons[0]);
  });

  it('у юнита без одноразовых эффектов объект не меняется', () => {
    // withOnceEffects возвращает ТОТ ЖЕ объект: лишних прогонов не будет.
    const { unit } = leader('Daemonifuge');
    expect(withOnceEffects(unit)).toBe(unit);
  });

  it('флаги utility лидеров выставляются', () => {
    for (const name of ['Junith Eruita', 'Intranzia Fraye', 'Imagifier', 'Dialogus', 'Dogmata']) {
      const flags = detectUtilityFlags(find(name)).map((flag) => flag.id);
      expect(flags.some((id) => id.startsWith('Sororitas_')), name).toBe(true);
    }
  });
});



describe('ручной слой способностей', () => {
  it('Thurga и Dolan получают Devastating Wounds на своё оружие', () => {
    // Кейворд идёт ОТ способности: в BSData у Blade of Vigil и Scribe's staff
    // его нет, он встречается только в тексте ability. Без ручного слоя
    // критические ранения не превращались бы в мортиды.
    const thurga = adaptUnit(find('Aestred Thurga and Agathae Dolan'), { size: 'min' });
    const weapons = thurga.unit.models.flatMap((model) => model.weapons);
    expect(weapons.length, 'нужно оружие').toBeGreaterThan(0);
    for (const weapon of weapons) {
      expect(
        weapon.keywords.some((keyword) => keyword.name === 'devastating'),
        `Devastating Wounds отсутствует у «${weapon.name}»`
      ).toBe(true);
    }
  });

  it('слой не задевает юнитов, которых в нём нет', () => {
    // Слой включается по id даташита, поэтому обычные пехотные юниты должны
    // остаться без Devastating Wounds — даже если в базе он где-то встречается.
    for (const name of ['Boyz', 'Intercessor Squad', 'Kroot Carnivores']) {
      const unit = adaptUnit(find(name), { size: 'min' });
      const withDevastating = unit.unit.models
        .flatMap((model) => model.weapons)
        .filter((weapon) => weapon.keywords.some((keyword) => keyword.name === 'devastating'));
      expect(withDevastating.length, `Devastating Wounds не должен появляться у «${name}»`).toBe(0);
    }
  });

  it('Daemonifuge получает +1 мортида, но только в дальнобойной фазе', () => {
    const daemonifuge = adaptUnit(find('Daemonifuge'), { size: 'min' });
    const ranged = daemonifuge.unit.models
      .flatMap((model) => model.weapons)
      .filter((weapon) => weapon.kind === 'ranged');
    const melee = daemonifuge.unit.models
      .flatMap((model) => model.weapons)
      .filter((weapon) => weapon.kind === 'melee');
    expect(ranged.length, 'нужно дальнобойное оружие').toBeGreaterThan(0);
    for (const weapon of ranged) {
      expect(weapon.mortalDamageBonus).toEqual({ amount: 1, phase: 'ranged' });
    }
    // Регрессия: способность про стрельбу не должна висеть на клинке.
    expect(
      melee.every((weapon) => weapon.mortalDamageBonus === undefined),
      'на рукопашном оружии бонуса быть не должно'
    ).toBe(true);
  });

  it('Celestine получает регенерацию, а воскресать может только святая', () => {
    const celestine = adaptUnit(find('Saint Celestine'), { size: 'min' });
    const models = celestine.unit.models;
    expect(models.some((model) => model.regeneration === 1), 'регенерация 1 рана').toBe(true);
    // Регрессия: у Geminae Superia такого правила нет.
    const revivable = models.filter((model) => model.resurrectOnce === true);
    expect(revivable.length, 'воскрешаться должна одна модель').toBe(1);
    expect(revivable[0]?.name).toBe('Saint Celestine');
  });
});

describe('ручные способности отрядов Sororitas', () => {
  const of = (name: string) => adaptUnit(find(name), { size: 'min' });

  it('Arco-Flagellants получают FNP 5+ и +2 атаки', () => {
    // В BSData FNP у них НЕТ — он идёт от способности, поэтому проверка на
    // реальном даташите: без ручного слоя модель осталась бы без FNP.
    const model = of('Arco-Flagellants').unit.models[0];
    expect(model.fnp).toBe(5);
    expect(model.fnpScope).toBe('all');
    const melee = model.weapons.filter((weapon) => weapon.kind === 'melee');
    expect(melee[0]?.attacks?.count, '+2 атаки к базовым A4').toBe(6);
  });

  it('Penitent Engines получают FNP 5+', () => {
    // Регрессия: в BSData FNP отсутствует, добавляется только из слоя.
    expect(of('Penitent Engines').unit.models[0].fnp).toBe(5);
  });

  it('Mortifiers ухудшаются до save 3+', () => {
    // В BSData save 4+; способность даёт save 3+, то есть ХУЖЕ (3+ легче).
    expect(of('Mortifiers').unit.models[0].save).toBe(3);
  });

  it('Sororitas Rhino регенерирует 1 рану в ход', () => {
    expect(of('Sororitas Rhino').unit.models[0].regeneration).toBe(1);
  });

  it('Zephyrim получают Sustained Hits и Lethal в рукопашной', () => {
    const weapons = of('Zephyrim Squad').unit.models[0].weapons;
    const melee = weapons.filter((weapon) => weapon.kind === 'melee');
    for (const weapon of melee) {
      expect(weapon.keywords.map((k) => k.name)).toContain('sustained');
      expect(weapon.keywords.map((k) => k.name)).toContain('lethal');
    }
    // Стрельбе кейворды не выдаются.
    for (const weapon of weapons.filter((weapon) => weapon.kind === 'ranged')) {
      expect(weapon.keywords.map((k) => k.name)).not.toContain('sustained');
    }
  });

  it('Paragon Warsuits получают anti-bonus на всё оружие', () => {
    const weapons = of('Paragon Warsuits').unit.models[0].weapons;
    expect(weapons.length, 'нужно оружие').toBeGreaterThan(0);
    for (const weapon of weapons) {
      const bonus = weapon.keywords.find((k) => k.name === 'anti-bonus');
      expect(bonus, `нет anti-bonus у «${weapon.name}»`).toBeDefined();
      // Условие на цель: MONSTER/VEHICLE.
      expect(bonus?.target).toEqual(['MONSTER', 'VEHICLE']);
    }
  });

  it('перебросы ограничены своей фазой', () => {
    // Retributor: reroll 1 только на стрельбу; в рукопашной его нет.
    const retributor = datasheets.find(
      (d) => d.name === 'Retributor Squad' && d.faction === 'Adepta Sororitas'
    );
    expect(rerollOptionsOf(retributor!.id, 'ranged').rerollHitOn).toEqual([1]);
    expect(rerollOptionsOf(retributor!.id, 'melee'), 'в melee reroll не действует').toEqual({});
    // Repentia — наоборот: reroll только в рукопашной.
    const repentia = datasheets.find(
      (d) => d.name === 'Repentia Squad' && d.faction === 'Adepta Sororitas'
    );
    expect(rerollOptionsOf(repentia!.id, 'melee').rerollWoundOn).toEqual([1]);
    expect(rerollOptionsOf(repentia!.id, 'ranged')).toEqual({});
  });

  it('у юнита без перебросов опции пустые', () => {
    const boyz = datasheets.find((d) => d.name === 'Boyz');
    expect(rerollOptionsOf(boyz!.id, 'combined')).toEqual({});
  });

  it('utility-флаги отрядов Sororitas выставляются', () => {
    const cases: Array<[string, string, number]> = [
      ['Battle Sisters Squad', 'Sororitas_Battle_Sisters', 3],
      ['Immolator', 'Sororitas_Immolator', 2],
      ['Dominion Squad', 'Sororitas_Dominion', 2],
      ['Seraphim Squad', 'Sororitas_Seraphim', 1],
      ['Castigator', 'Sororitas_Castigator', 1],
      ['Exorcist', 'Sororitas_Exorcist', 1],
      ['Sisters Novitiate Squad', 'Sororitas_Novitiates', 2],
      ['Penitent Engines', 'Sororitas_Penitent_Engines', 2],
    ];
    for (const [name, flagId, points] of cases) {
      const flag = detectUtilityFlags(find(name)).find((f) => f.id === flagId);
      expect(flag, `нет флага ${flagId} у «${name}»`).toBeDefined();
      expect(flag?.points).toBe(points);
    }
  });
});

describe('способности, зависящие от присоединённого лидера', () => {
  const leaderOf = (name: string): LeaderDefinition => {
    const found = leaderDefinitionsOf(datasheets).find((item) => item.name === name);
    if (!found) throw new Error(`лидер ${name} не найден`);
    return found;
  };
  const sororitas = (name: string): BsDatasheet => {
    const found = datasheets.find((d) => d.name === name && d.faction === 'Adepta Sororitas');
    if (!found) throw new Error(`юнит ${name} не найден`);
    return found;
  };

  it('Celestian Sacresants не убиваются штрафом за лидера', () => {
    // Важная проверка «отрицательного» случая: в BSData у Sacresants W1, то
    // есть потеря 1 раны за лидера УЖЕ в данных. Вычитать ещё раз нельзя —
    // модель с одной раной погибла бы при постановке, и юнит с лидером исчез бы
    // из ростера. Поэтому штраф применяется с полом в 1 рану.
    const { unit } = adaptUnit(sororitas('Celestian Sacresants'), { size: 'min' });
    expect(unit.models[0]?.wounds).toBe(1);
    const attached = attachLeaderToUnit(unit, leaderOf('Junith Eruita'));
    const bodyguard = attached.models.slice(0, unit.models.length);
    expect(bodyguard.length, 'телохранители на месте').toBe(unit.models.length);
    for (const model of bodyguard) {
      expect(model.wounds, `${model.name} не должен погибнуть от штрафа`).toBeGreaterThan(0);
    }
  });

  it('Sanctifiers с Министорумом получают Sustained Hits и целителя D3', () => {
    const { unit } = adaptUnit(sororitas('Sanctifiers'), { size: 'min' });
    const attached = attachLeaderToUnit(unit, leaderOf('Ministorum Priest'));

    // Министорум возвращает D3 = 3 модели за раунд, пока сам жив.
    const healers = attached.models.filter((m) => m.reviveLeader === true);
    expect(healers.length, 'целитель должен быть один').toBe(1);
    expect(healers[0]?.reviveCount, 'D3 = 3 модели за раунд').toBe(3);

    // Sustained Hits 1 — только на рукопашном оружии телохранителя.
    const withSustained = attached.models.filter((m) =>
      m.weapons.some((w) => w.kind === 'melee' && w.keywords.some((k) => k.name === 'sustained'))
    );
    expect(withSustained.length, 'рукопашный sustained должен появиться').toBeGreaterThan(0);
  });

  it('с чужим лидером Sanctifiers ничего не получают', () => {
    const { unit } = adaptUnit(sororitas('Sanctifiers'), { size: 'min' });
    const attached = attachLeaderToUnit(unit, leaderOf('Junith Eruita'));
    expect(
      attached.models.some((m) => m.reviveLeader === true),
      'целителя быть не должно'
    ).toBe(false);
  });

  it('целитель возвращает reviveCount моделей за раунд', () => {
    // Фикстуры модели строятся здесь, а не берутся из simulate.test.ts: тот файл
    // про другое, и переносить его помощники сюда незачем.
    const fighter = (id: string) => ({
      id,
      name: id,
      toughness: 3,
      wounds: 2,
      save: 3,
      invuln: null,
      fnp: null,
      fnpScope: 'all' as const,
      keywords: ['INFANTRY'],
      weapons: [],
    });
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].map(fighter);
    const healer = { ...fighter('heal'), reviveLeader: true, reviveCount: 3 };
    const state = createDefenderState({
      id: 'u',
      name: 'Unit',
      keywords: ['INFANTRY'],
      models: [...six, healer],
    });
    // Убиваем всех шестерых, целитель остаётся жив.
    for (let i = 0; i < 6; i += 1) damageNextModel(state, 2);
    expect(state.aliveCount).toBe(1);
    expect(upkeepBetweenRounds(state)).toBe(true);
    expect(state.aliveCount, 'D3 = три модели вернулись').toBe(4);
  });
});

