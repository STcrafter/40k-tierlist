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
import { sizeRangeOf } from '../bsdata/points.ts';
import { adaptUnit, loadoutVariantsOf } from './adapter.ts';
import { monteCarlo } from './simulate.ts';
import {
  withOnceEffects,
  rerollOptionsOf,
  applyAuraToModels,
  MANUAL_ABILITIES,
  ONCE_AURA_FIELDS,
  ONCE_EFFECT_FIELDS,
  WEAPON_EFFECT_FIELDS,
  type ManualAbility,
  type OnceAuraField,
  type OnceEffectField,
  type WeaponEffectField,
} from '../manual/abilities.ts';
import { detectUtilityFlags } from '../tier/utility.ts';
import { attachLeaderToUnit, leaderDefinitionsOf, type LeaderDefinition } from '../tier/leaders.ts';
import { createDefenderState, damageNextModel, upkeepBetweenRounds } from './simulate.ts';
import type { CombatUnit } from './types.ts';

/**
 * Образцы значений для проверки «поле применяется»: минимальные, но достаточные,
 * чтобы эффект был виден на оружии Gretchin.
 *
 * Ключ — имя поля, поэтому добавление нового поля в слой без образца падает
 * здесь же, а не молча в 89 записях.
 */
const SAMPLES_WEAPON: Record<WeaponEffectField, unknown> = {
  mortalDamageBonus: { amount: 1, phase: 'ranged' },
  meleeMortalPerWound: 1,
  extraAttacks: 1,
  antiBonus: { hits: 1, wounds: 1 },
  meleeWeaponKeywords: ['Lethal Hits'],
  weaponKeywordsAll: ['Lethal Hits'],
  weaponKeywordsOn: [{ weapon: 'shiv', keywords: ['Devastating Wounds'] }],
  sustainedHits: 1,
  meleeWeaponStats: { attacks: 1, skill: 0, strength: 1 },
  enemyApWorsening: 1,
};

const SAMPLES_ONCE: Record<OnceEffectField, unknown> = {
  onceRangedKeywords: ['Lethal Hits'],
  onceFnp: 4,
  onceDamageCapPerRound: 1,
  onceDevastating: true,
  onceExtraRangedVolley: true,
};

/** Одноразовые поля ауры проверяются на лидере: см. тест `ONCE_AURA_FIELDS`. */
const SAMPLES_AURA: Record<OnceAuraField, unknown> = {
  onceMeleeAttacks: 3,
  onceMeleeStrength: 3,
  onceMeleeKeywords: ['Devastating Wounds'],
};

const { datasheets } = parseBsDatabase(loadBsData(bsFilesFromDir('public/BSData/wh40k-11e')));
const find = (name: string): BsDatasheet => {
  const found = datasheets.find((sheet) => sheet.name === name);
  if (!found) throw new Error(`Нет даташита: ${name}`);
  return found;
};

describe('размер отряда по ограничениям', () => {
  it('минимальный состав добирает каждую группу до её group.min', () => {
    const boyz = adaptUnit(find('Boyz'), { size: 'min' });
    // Группы: 9-18 Boyz и 1-2 Nobz → 9 + 1 = 10 моделей. Явные минимумы
    // вариантов (6 Boy + 1 Nob) описывают состав моделей внутри группы, но не
    // её размер: если у группы задан group.min, он и есть нижняя граница.
    // Это то же правило, что в sizeRangeOf (bsdata/points.ts).
    // Числа — из BSData на коммите cc1830f: стоимость Boyz снижена 90 → 85,
    // верхний тир (20 моделей) 180 → 170.
    expect(boyz.unit.models).toHaveLength(10);
    expect(boyz.counts.size).toBe(2);
    expect(boyz.points).toBe(85);
  });

  it('минимальный состав совпадает с sizeRangeOf', () => {
    // Раньше эти два модуля считали минимум по-разному: sizeRangeOf брал
    // group.min, а allocateVariants — только явные минимумы вариантов. Из-за
    // расхождения 66 юнитов собирались меньше разрешённого минимума.
    const rows = ['Boyz', 'Kroot Farstalkers', 'Cadian Recon Squad', 'Battle Sisters Squad'].map((name) => {
      const sheet = find(name);
      return {
        name,
        actual: adaptUnit(sheet, { size: 'min' }).unit.models.length,
        expected: sizeRangeOf(sheet).min,
      };
    });
    // Ожидаемое значение подставляем в обе колонки, чтобы при падении diff
    // показывал, какой именно юнит разошёлся с ожиданием.
    expect(rows).toEqual(rows.map((row) => ({ ...row, actual: row.expected })));
  });

  it('максимальный состав не превышает максимум группы и лимиты снаряжения', () => {
    const boyz = adaptUnit(find('Boyz'), { size: 'max' });
    // Группы: 9-18 Boyz и 1-2 Nobz → 18 + 2 = 20 моделей.
    expect(boyz.unit.models).toHaveLength(20);
    expect(boyz.points).toBe(170);
  });

  it('перебирает все профили одного оружия, а не только профиль по умолчанию', () => {
    // Регрессия: у Flash Gitz Snazzgun — одна запись снаряжения с тремя
    // профилями (Cutta S9 AP-3, Dakka S6 AP-1, Kill Shot S8 AP-2). Такая запись
    // не choice-группа, и перебор её не видел: в панели оставался только Dakka,
    // хотя в игре стрелять можно и остальными двумя.
    const flash = loadoutVariantsOf(find('Flash Gitz'), { size: 'min', limit: 128 });
    const ranged = new Set(
      flash.flatMap((loadout) =>
        (loadout.unit.models[0]?.weapons ?? [])
          .filter((weapon) => weapon.kind === 'ranged')
          .map((weapon) => weapon.name)
      )
    );
    expect([...ranged].sort()).toEqual([
      '➤ Snazzgun - Cutta',
      '➤ Snazzgun - Dakka',
      '➤ Snazzgun - Kill Shot',
    ]);
  });

  it('подпись сборки совпадает с оружием, а не с нулевым профилем', () => {
    // Подпись считалась по индексу 0, а оружие выбиралось по «лучшему»: у
    // Snazzgun это Dakka (индекс 1), и сборка подписывалась именем Cutta.
    const flash = loadoutVariantsOf(find('Flash Gitz'), { size: 'min', limit: 128 });
    for (const loadout of flash) {
      const weapon = loadout.unit.models[0]?.weapons.find((item) => item.kind === 'ranged');
      expect(loadout.name, loadout.name).toContain(weapon?.name ?? 'нет оружия');
    }
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
      // Прочность Terminator в BSData поднята с 5 до 6 (коммит cc1830f).
      { name: 'Grey Knights Terminator Squad', toughness: 6 },
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
    // Repentia перенесена на кейворды (полный переброс), поэтому списков у неё
    // больше нет — фаза задана тем, что кейворды висят только на рукопашном
    // оружии. Проверка самого эффекта — в тесте «Repentia: полный переброс…».
    const repentia = datasheets.find(
      (d) => d.name === 'Repentia Squad' && d.faction === 'Adepta Sororitas'
    );
    expect(rerollOptionsOf(repentia!.id, 'melee')).toEqual({});
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

/**
 * Ручной слой Adeptus Custodes.
 *
 * Каждая проверка — регрессия на конкретную ошибку, а не описание способности:
 * в комментарии сказано, что именно стояло не так. Общий мотив всех семи —
 * правило либо висело не на том носителе (оружие вместо модели), либо терялось
 * из-за опечатки в id, либо было неверно по смыслу.
 */
describe('ручной слой Adeptus Custodes', () => {
  const of = (name: string) => adaptUnit(find(name), { size: 'min' }).unit;
  const leaderOf = (name: string): LeaderDefinition => {
    const found = leaderDefinitionsOf(datasheets).find((item) => item.name === name);
    if (!found) throw new Error(`лидер ${name} не найден`);
    return found;
  };

  it('Valerian: Golden Laurels ухудшает чужую атаку, а не усиливает свою', () => {
    // Регрессия: стояло apDelta: -1, а это поле меняет AP СОБСТВЕННОГО оружия,
    // то есть клинок Valerian становился AP-2 вместо AP-3 — незаработанный
    // атакующий бафф вместо правила. Теперь эффект защитный и лежит на модели.
    const model = of('Valerian').models[0];
    expect(model.keywords, 'защитный кейворд должен быть на модели').toContain('MELEE_AP_EVASION');
    const melee = model.weapons.filter((weapon) => weapon.kind === 'melee');
    expect(melee.length, 'нужно рукопашное оружие').toBeGreaterThan(0);
    for (const weapon of melee) {
      expect(weapon.ap, `«${weapon.name}»: AP своего оружия способность не улучшает`).toBeLessThanOrEqual(0);
    }
  });

  it('Custodian Wardens: Resolute Will не отнимает раны у самих Стражей', () => {
    // Регрессия: правило стояло как woundsPenalty, то есть минус рана у КАЖДОЙ
    // модели за способность, ДАННУЮ ОТРЯДУ (W3 → W2, минус треть живучести).
    // Правило ухудшает бросок ранения АТАКУЮЩЕГО, а не собственные ранки.
    const wardens = of('Custodian Wardens');
    expect(wardens.models.length, 'нужны Стражи').toBeGreaterThan(0);
    for (const model of wardens.models) {
      expect(model.wounds, `${model.name} не должен терять рану`).toBe(3);
      // Без лидера способность не активна, значит и кейворда нет.
      expect(model.keywords, `${model.name} без лидера`).not.toContain('RESOLUTE_WILL');
    }
  });

  it('Custodian Wardens с героем получают RESOLUTE_WILL, а не минус рану', () => {
    const wardens = of('Custodian Wardens');
    const attached = attachLeaderToUnit(wardens, leaderOf('Trajann Valoris'));
    const bodyguard = attached.models.slice(0, wardens.models.length);
    expect(bodyguard.length, 'телохранители на месте').toBe(wardens.models.length);
    for (const model of bodyguard) {
      expect(model.wounds, `${model.name} не должен терять рану`).toBe(3);
      expect(model.keywords, `${model.name} без RESOLUTE_WILL`).toContain('RESOLUTE_WILL');
    }
    // Способность ОТРЯДА: сам герой её не получает.
    const hero = attached.models[wardens.models.length];
    expect(hero?.keywords ?? [], 'герой не должен получать способность отряда').not.toContain('RESOLUTE_WILL');
  });

  it('No Foe Shall Stand: Lethal Hits разовый и только на стрельбе', () => {
    // Регрессия: кейворд висел на отряде постоянно и попадал на ВСЁ оружие, а
    // Ignores Cover не учитывался вовсе. По тексту правила — «Once per battle …
    // ranged weapons … [LETHAL HITS] и [IGNORES COVER]», то есть разово и
    // только стрельба.
    const base = of('Custodian Guard with Adrasite and Pyrithite spears');
    const weapons = base.models.flatMap((model) => model.weapons);
    expect(
      weapons.filter((weapon) => weapon.kind === 'ranged').length,
      'нужна стрелковая способность'
    ).toBeGreaterThan(0);
    // В бою способности нет: она разовая.
    for (const weapon of weapons) {
      expect(
        weapon.keywords.map((k) => k.name),
        `«${weapon.name}»: Ignores Cover в бою быть не должно`
      ).not.toContain('ignores-cover');
    }
    // В одноразовых эффектах — и только на стрельбе. (На рукопашном копье
    // [LETHAL HITS] приходит отдельно, из стойки RENDAX, — это не способность.)
    for (const weapon of withOnceEffects(base).models.flatMap((model) => model.weapons)) {
      const names = weapon.keywords.map((k) => k.name);
      if (weapon.kind === 'ranged') {
        expect(names, `«${weapon.name}» без разового Lethal Hits`).toContain('lethal');
        expect(names, `«${weapon.name}» без разового Ignores Cover`).toContain('ignores-cover');
      } else {
        expect(names, `«${weapon.name}» — рукопашное, разовые кейворды не достаются`).not.toContain('ignores-cover');
      }
    }
  });

  it('Living Fortress: FNP 4+ разовый, а не постоянный', () => {
    // Регрессия: FNP 4+ стоял в ауре, то есть действовал весь бой и стоил примерно
    // половины живучести отряда. Способность работает один раз и до конца фазы,
    // поэтому в бою её нет, а в одноразовых эффектах — есть.
    const wardens = of('Custodian Wardens');
    for (const model of wardens.models) {
      expect(model.fnp, `${model.name} без FNP в бою`).toBeNull();
    }
    for (const model of withOnceEffects(wardens).models) {
      expect(model.fnp, `${model.name} без разового FNP`).toBe(4);
      // Область из способности: 'mortals' был бы ограничением, а не защитой.
      expect(model.fnpScope, `${model.name}: область`).toBe('all');
    }
  });

  it('Shield-Captain: Master of the Stances даёт обе стойки, а не «Active»', () => {
    // Регрессия: в списке стояло 'Active' — такого кейворда нет ни в одном правиле
    // движка, поэтому RENDAX ([LETHAL HITS]) молча терялся, и в дельту попадало
    // ровно то, что отряд и так получает от DACATARAI.
    const captain = withOnceEffects(of('Shield-Captain'));
    const melee = captain.models.flatMap((model) => model.weapons).filter((weapon) => weapon.kind === 'melee');
    expect(melee.length, 'нужно рукопашное оружие').toBeGreaterThan(0);
    for (const weapon of melee) {
      const names = weapon.keywords.map((k) => k.name);
      expect(names, `«${weapon.name}» без SUSTAINED HITS 1 (DACATARAI)`).toContain('sustained');
      expect(names, `«${weapon.name}» без LETHAL HITS (RENDAX)`).toContain('lethal');
      expect(names, `«${weapon.name}»: неизвестный кейворд 'active'`).not.toContain('active');
    }
  });

  it('Knight-Centura: флаг EPIC HERO находится по правильному id', () => {
    // Регрессия: в слое стояло '7099-71b2-…' вместо '7099-71b-…', и такого
    // даташита в базе просто нет. Запись молча не срабатывала — вместе с флагом
    // на 3 балла.
    expect(
      datasheets.some((sheet) => sheet.id === '7099-71b2-56e8-7191'),
      'опечатка в id не должна существовать в базе'
    ).toBe(false);
    const flag = detectUtilityFlags(find('Knight-Centura')).find((item) => item.id === 'Custodes_Knight_Centura');
    expect(flag, 'флаг не найден — сверь id в abilities.ts').toBeDefined();
    expect(flag?.points).toBe(3);
  });

  it('Aleya: переброса попадания у неё нет', () => {
    // Регрессия: rerollHitOn: [1] давал отряду постоянный переброс, которого нет ни
    // в одном её правиле. Из её текста в бой идёт FNP 3+ против психики и мортид,
    // остальное живёт флагом.
    const aleya = find('Aleya');
    expect(rerollOptionsOf(aleya.id, 'melee').rerollHitOn ?? []).toEqual([]);
    expect(rerollOptionsOf(aleya.id, 'ranged').rerollHitOn ?? []).toEqual([]);
    // Штатный переброс Stand Vigil у копий остался: это другой юнит.
    const spears = find('Custodian Guard with Adrasite and Pyrithite spears');
    expect(rerollOptionsOf(spears.id, 'ranged').rerollWoundOn).toEqual([1]);
  });

  it('Allarus: полный переброс ранения только по монстрам, технике и персонажам', () => {
    // Slayers of Tyrants: «each time a model in this unit makes an attack that
    // targets a Character, Monster or Vehicle unit, you can re-roll the Wound
    // roll». Полный переброс И с условием по цели — в ручном слое стояло
    // `rerollWoundOn: [1]` по любой цели, то есть одновременно слабее правила и
    // шире его. Правило говорит «attack», без указания фазы, поэтому кейворд
    // достаётся всему оружию, а не только рукопашному.
    const weapons = of('Allarus Custodians').models.flatMap((model) => model.weapons);
    expect(weapons.length, 'нужно оружие').toBeGreaterThan(0);
    for (const weapon of weapons) {
      const keyword = weapon.keywords.find((k) => k.name === 'wound-reroll');
      expect(keyword, `«${weapon.name}»: переброс должен достаться всему оружию`).toBeDefined();
      expect(keyword?.target, `«${weapon.name}»: условие по цели`).toEqual([
        'CHARACTER',
        'MONSTER',
        'VEHICLE',
      ]);
    }
    // Списка перебросов больше нет — он бы дублировал кейворд «единицами».
    expect(rerollOptionsOf(find('Allarus Custodians').id, 'combined')).toEqual({});
  });

  it('слой не задевает соседние юниты Custodes', () => {
    // Проверка на «лишний радиус»: способности соседей не должны протекать в
    // отряд, у которого их нет. У Trajann нет ни одного из новых кейвордов.
    const trajann = of('Trajann Valoris').models[0];
    expect(trajann.keywords).not.toContain('MELEE_AP_EVASION');
    expect(trajann.keywords).not.toContain('RESOLUTE_WILL');
    const wardens = of('Custodian Wardens');
    for (const model of wardens.models) {
      expect(model.keywords, `${model.name}`).not.toContain('MELEE_AP_EVASION');
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

it('Repentia: полный переброс попадания и ранения в рукопашной', () => {
    // Overseer of Redemption: «each time a Sisters Repentia model in that unit
    // makes a melee attack, you can re-roll the Hit roll and you can re-roll the
    // Wound roll». Это полный переброс, а в слое стоял переброс единиц.
    const { unit } = adaptUnit(sororitas('Repentia Squad'), { size: 'min' });
    const melee = unit.models.flatMap((model) => model.weapons).filter((w) => w.kind === 'melee');
    const ranged = unit.models.flatMap((model) => model.weapons).filter((w) => w.kind === 'ranged');
    expect(melee.length, 'нужно рукопашное оружие').toBeGreaterThan(0);
    for (const weapon of melee) {
      const names = weapon.keywords.map((k) => k.name);
      expect(names, `«${weapon.name}»: полный переброс попадания`).toContain('hit-reroll');
      expect(names, `«${weapon.name}»: полный переброс ранения`).toContain('wound-reroll');
    }
    // Bolt pistol у Superior — не рукопашная атака, переброс его не касается.
    for (const weapon of ranged) {
      const names = weapon.keywords.map((k) => k.name);
      expect(names, `«${weapon.name}»: способность о рукопашной`).not.toContain('hit-reroll');
      expect(names, `«${weapon.name}»: способность о рукопашной`).not.toContain('wound-reroll');
    }
    expect(rerollOptionsOf(unit.id, 'melee')).toEqual({});
    expect(rerollOptionsOf(unit.id, 'ranged')).toEqual({});
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

  it('аура лидера отдаёт кейворды оружию ПРИСОЕДИНЁННОГО юнита, а не лидеру', () => {
    // Регрессия: `LeaderAura.rerollHitOn/rerollWoundOn` были объявлены и
    // заполнялись (Morvenn), но не читались НИГДЕ — `applyAuraToModels` их
    // игнорировал. Способность лидера, которая касается только присоединённого
    // отряда, выражена отдельным полем: общий `weaponKeywords` достаётся и
    // самому лидеру, потому что нужен ему лично (LANCE у Morvenn).
    const { unit } = adaptUnit(sororitas('Sisters Novitiate Squad'), { size: 'min' });
    const namesOf = (models: CombatUnit['models']): Set<string> =>
      new Set(models.flatMap((model) => model.weapons.flatMap((w) => w.keywords.map((k) => k.name))));
    const attached = applyAuraToModels(
      unit.models,
      { unitWeaponKeywords: ['Reroll hits'] },
      unit.keywords,
      true
    );
    expect(namesOf(attached.models).has('hit-reroll'), 'отряд должен получить переброс попаданий').toBe(true);
    // Тот же вызов БЕЗ присоединённого юнита — это собственные модели лидера,
    // и способность отряда к ним отношения не имеет.
    const own = applyAuraToModels(unit.models, { unitWeaponKeywords: ['Reroll hits'] }, unit.keywords);
    expect(namesOf(own.models).has('hit-reroll'), 'лидер не должен получать способность отряда').toBe(false);
  });
});

/*
 * Кустодезы, добавленные в ручной слой.
 *
 * Проверяется не «записано ли поле в MANUAL_ABILITIES», а что поле ДОШЛО до
 * боевой модели: запись в слое, которая потерялась при переносе в адаптер,
 * выглядит снаружи как полностью настроенная способность.
 */
describe('способности кустодесов доходят до боевой модели', () => {
  const of = (name: string) => adaptUnit(find(name), { size: 'min' }).unit;

  it('Vigilators: MELEE_EVASION на модели и FNP 3+ против мортид', () => {
    for (const model of of('Vigilators').models) {
      // Защитный кейворд лежит на модели, а не на оружии: удар получает юнит.
      expect(model.keywords).toContain('MELEE_EVASION');
      expect(model.fnp).toBe(3);
      // 'mortals' — это ОГРАНИЧЕНИЕ области: обычный урон он не невелирует.
      expect(model.fnpScope).toBe('mortals');
    }
  });

  it('Prosecutors и Witchseekers получают то же FNP 3+ против мортид', () => {
    for (const name of ['Prosecutors', 'Witchseekers']) {
      const model = of(name).models[0];
      expect(model.fnp, name).toBe(3);
      expect(model.fnpScope, name).toBe('mortals');
    }
  });

  it('Vigilators не получают MELEE_EVASION на оружии', () => {
    // Регрессия: если бы кейворд попал на клинок, он бы улучшал СОБСТВЕННУЮ
    // атаку отряда вместо того, чтобы ухудшать чужую.
    for (const model of of('Vigilators').models) {
      for (const weapon of model.weapons) {
        expect(weapon.keywords.map((k) => k.name)).not.toContain('melee-evasion');
      }
    }
  });

  it('Telemon теряет единицу урона, остальные ничем не отличаются', () => {
    expect(of('Telemon Heavy Dreadnought').models[0].damageTakenPenalty).toBe(1);
    // Сосед по кодуксту — контроль: у него такого поля быть не должно вовсе.
    expect(of('Contemptor-Achillus Dreadnought').models[0].damageTakenPenalty ?? 0).toBe(0);
  });

  it('Caladius: Lethal Hits на двух стволах, но не на третьем', () => {
    const datasheet = find('Caladius Grav-tank');
    const base = of('Caladius Grav-tank');
    // Оба ствола под правилом есть не в одной сборке: база несёт Iliastus,
    // а Arachnus приходит альтернативной сборкой. Поэтому проверяются ВСЕ
    // варианты — иначе правило молча проверилось бы только на половине.
    const variants = [base, ...loadoutVariantsOf(datasheet, { size: 'min', limit: 32 }).map((l) => l.unit)];
    const namesOf = (unit: typeof base): string[] =>
      unit.models.flatMap((m) => m.weapons.map((w) => w.name.toLowerCase()));
    const all = variants.flatMap(namesOf);
    expect(all.some((n) => n.includes('iliastus')), 'нет Twin iliastus').toBe(true);
    expect(all.some((n) => n.includes('arachnus')), 'нет Twin arachnus').toBe(true);

    for (const unit of variants) {
      for (const model of unit.models) {
        for (const weapon of model.weapons) {
          const name = weapon.name.toLowerCase();
          const keywords = weapon.keywords.map((k) => k.name);
          const covered = name.includes('iliastus') || name.includes('arachnus');
          // Регрессия на широту правила: Twin Lastrum bolt cannon и корпус
          // «Armoured hull» под него не подпадают.
          if (covered) expect(keywords, weapon.name).toContain('lethal');
          else expect(keywords, weapon.name).not.toContain('lethal');
        }
      }
    }
  });

  it('Ares: мортид по кубику на каждую модель цели, в любом режиме', () => {
    const dice = of('Ares Gunship').mortalDice;
    expect(dice?.phase).toBe('all');
    expect(dice?.perDefenderModel, 'число бросков зависит от размера цели').toBe(true);
    expect(dice?.table[6]).toEqual({ sides: 0, min: 1 });
  });

  it('Achillus: те же мортид, но только в ближнем бою', () => {
    const dice = of('Contemptor-Achillus Dreadnought').mortalDice;
    expect(dice?.phase).toBe('melee');
    expect(dice?.perDefenderModel, 'бросок один, а не на модель цели').toBe(false);
    // Оба исхода хранятся раздельно: на 6 правило даёт 3 мортиды ГАРАНТИРОВАННО.
    expect(dice?.table[6]).toEqual({ sides: 0, min: 3 });
    expect(dice?.table[4]).toEqual({ sides: 3, min: 0 });
  });

  it('Venerable Contemptor лечится при гибели отряда', () => {
    expect(of('Venerable Contemptor Dreadnought').models[0].healOnDeath).toEqual({
      chance: 2,
      sides: 6,
    });
  });

  it('Anathema Psykana Rhino регенерирует рану', () => {
    expect(of('Anathema Psykana Rhino').models[0].regeneration).toBe(1);
  });

  it('Contemptor-Galatus: MELEE_WOUND_PENALTY на модели, не на оружии', () => {
    const model = of('Contemptor-Galatus Dreadnought').models[0];
    expect(model.keywords).toContain('MELEE_WOUND_PENALTY');
    // Кейворд защитный и живёт на модели: удар получает юнит, а не клинок.
    for (const weapon of model.weapons) {
      expect(weapon.keywords.map((k) => k.name), weapon.name).not.toContain('melee-wound-penalty');
    }
  });

  it('Sagittarum: Devastating Wounds только в одноразовой копии отряда', () => {
    const base = of('Sagittarum Custodians');
    const once = withOnceEffects(base);
    const devastating = (unit: typeof base): boolean =>
      unit.models.some((model) =>
        model.weapons.some((w) => w.keywords.map((k) => k.name).includes('devastating'))
      );
    // Разовый эффект не должен попасть в постоянный бой: иначе юнит получил бы
    // постоянный бафф за однократную способность.
    expect(devastating(base), 'в базовом отряде не должно быть').toBe(false);
    expect(devastating(once), 'в одноразовой копии должно появиться').toBe(true);
  });

  it('у соседей по кустодесам новых полей нет', () => {
    // Контроль на расползание: способность не должна «протекать» на юниты,
    // для которых она не описана.
    for (const name of ['Custodian Guard', 'Sagittarum Custodians']) {
      const model = of(name).models[0];
      expect(model.damageTakenPenalty ?? 0, name).toBe(0);
      expect(model.healOnDeath ?? null, name).toBeNull();
      expect(of(name).mortalDice ?? null, name).toBeNull();
    }
  });
});

describe('ручной слой орков', () => {
  const ork = (name: string): BsDatasheet => {
    const found = datasheets.find((sheet) => sheet.name === name && sheet.faction === 'Orks');
    if (!found) throw new Error(`юнит ${name} не найден среди орков`);
    return found;
  };
  const of = (name: string) => adaptUnit(ork(name), { size: 'min' }).unit;
  const flagPoints = (name: string, flagId: string): number | undefined =>
    detectUtilityFlags(ork(name)).find((flag) => flag.id === flagId)?.points;

  it('utility-флаги вожаков стоят назначенных баллов', () => {
    // Каждый флаг платит только за то, чего нет в разборе: Deep Strike,
    // Infiltrators, Stealth, Da Boss, SMOKE и Lone Operative разбираются из
    // данных сами. Если какой-то из них начнёт разбираться автоматически,
    // флаг задвоится — поэтому проверка именно на цифры, а не на наличие.
    const expected: Array<[string, string, number]> = [
      ['Boss Snikrot', 'Orks_Boss_Snikrot', 2],
      ['Ghazghkull Thraka', 'Orks_Ghazghkull_Thraka', 2],
      ['Mozrog Skragbad', 'Orks_Mozrog_Skragbad', 1],
      ['Nazdreg', 'Orks_Nazdreg', 2],
      ['Wazdakka Gutsmek', 'Orks_Wazdakka_Gutsmek', 2],
    ];
    for (const [name, flagId, points] of expected) {
      expect(flagPoints(name, flagId), `${name}: ${flagId}`).toBe(points);
    }
    // Zodgrod получает только боевой бонус гретчинам,utility-флага у него нет.
    expect(detectUtilityFlags(ork('Zodgrod Wortsnagga')).some((f) => f.id.startsWith('Orks_'))).toBe(false);
  });

  it('Mozrog: полный переброс ранения по MONSTER/VEHICLE, а не по единичкам', () => {
    // Da Bigger Dey Iz: «this unit's melee attacks that target a MONSTER/VEHICLE
    // unit can re-roll wounds rolls». Переброс ПОЛНЫЙ, поэтому списком
    // rerollWoundOn его выразить нельзя — в бой уходит кейворд с условием на цель.
    const sheet = ork('Mozrog Skragbad');
    const weapons = of('Mozrog Skragbad').models.flatMap((model) => model.weapons);
    const rerollable = weapons.filter((weapon) =>
      weapon.keywords.some((k) => k.name === 'wound-reroll')
    );
    // Способность говорит о рукопашных атаках: Thump Gun её не касается.
    expect(rerollable.map((weapon) => weapon.kind)).toEqual(['melee', 'melee']);
    for (const weapon of rerollable) {
      const keyword = weapon.keywords.find((k) => k.name === 'wound-reroll');
      expect(keyword?.target, `«${weapon.name}»: условие по цели`).toEqual(['MONSTER', 'VEHICLE']);
    }
    // Списков перебросов больше нет: кейворд заменил «единички», а не дополнил их.
    expect(rerollOptionsOf(sheet.id, 'combined')).toEqual({});
  });

  it('Nazdreg: Kustom Blasta X стреляет всеми тремя профилями', () => {
    // Адаптер по умолчанию берёт ОДИН профиль на вид, поэтому способность
    // «стреляет всеми тремя» без ручного поля оставила бы в отряде один Gatler.
    const ranged = of('Nazdreg')
      .models.flatMap((model) => model.weapons)
      .filter((weapon) => weapon.name.startsWith('Kustom Blasta X -'))
      .map((weapon) => weapon.name);
    expect(ranged.sort()).toEqual([
      'Kustom Blasta X - Gatler',
      'Kustom Blasta X - Shoota',
      'Kustom Blasta X - Skorcha',
    ]);
    // Рукопашный профиль той же записи остаётся один.
    const melee = of('Nazdreg')
      .models.flatMap((model) => model.weapons)
      .filter((weapon) => weapon.kind === 'melee')
      .map((weapon) => weapon.name);
    expect(melee.filter((name) => name === 'Kustom Blasta X')).toHaveLength(1);
  });

  it('Nazdreg: профили Blasta не перебираются как сборки снаряжения', () => {
    // Выбор профиля у этого оружия не существует: применяются все. Перебор
    // дал бы три одинаковых loadout'а с разными подписями (Skorcha/Gatler/…),
    // то есть три кандидата в расчёт вместо одного.
    expect(loadoutVariantsOf(ork('Nazdreg')).map((loadout) => loadout.name)).toEqual(['Базовый']);
  });

  it('Zodgrod: гретчины с ним получают +1 A, +1 WS и +1 S', () => {
    const gretchin = of('Gretchin');
    const leader = leaderDefinitionsOf(datasheets).find((item) => item.name === 'Zodgrod Wortsnagga');
    if (!leader) throw new Error('Zodgrod Wortsnagga не найден среди лидеров');
    const attached = attachLeaderToUnit(gretchin, leader);
    const bodyguard = attached.models.slice(0, gretchin.models.length);
    expect(bodyguard.length, 'телохранители на месте').toBe(gretchin.models.length);

    const shivBefore = gretchin.models[0].weapons.filter((w) => w.kind === 'melee');
    const shivAfter = bodyguard[0].weapons.filter((w) => w.kind === 'melee');
    expect(shivBefore.length, 'нужно рукопашное оружие').toBeGreaterThan(0);
    for (const [before, after] of shivBefore.map((weapon, i) => [weapon, shivAfter[i]] as const)) {
      // BSData: Scavenged Shivs A1 WS5+ S2 → A2 WS4+ S3.
      expect(after.attacks?.count).toBe((before.attacks?.count ?? 0) + 1);
      expect(after.skill).toBe(Math.max(2, (before.skill ?? 2) - 1));
      expect(after.strength).toBe((before.strength ?? 0) + 1);
    }
    // Стрелковое оружие не затрагивается: правило говорит о рукопашном.
    const rangedBefore = gretchin.models[0].weapons.filter((w) => w.kind === 'ranged');
    const rangedAfter = bodyguard[0].weapons.filter((w) => w.kind === 'ranged');
    const line = (weapon: (typeof rangedBefore)[number]): string =>
      `${weapon.name} A${weapon.attacks?.count ?? '-'} WS${weapon.skill ?? '-'} S${weapon.strength ?? '-'}`;
    expect(rangedBefore.length, 'нужно стрелковое оружие').toBeGreaterThan(0);
    expect(rangedAfter.map(line)).toEqual(rangedBefore.map(line));
  });

  it('без Zodgrod гретчины остаются A1 WS5+ S2', () => {
    // Проверка на «отрицательный» случай: бонус двусторонний, поэтому у
    // отряда без этого лидера он появляться не должен.
    const shiv = of('Gretchin').models[0].weapons.find((weapon) => weapon.kind === 'melee');
    expect(shiv?.attacks?.count).toBe(1);
    expect(shiv?.skill).toBe(5);
    expect(shiv?.strength).toBe(2);
  });
});

describe('каждое поле ручного слоя применяется', () => {
  /**
   * Носитель для проверки — Gretchin: у него два оружия разных видов
   * (Scavenged Shivs в рукопашной, Grot Blasta в стрельбе), поэтому видно,
   * куда именно попал эффект, а не только «что-то изменилось».
   */
  const host = (): BsDatasheet => {
    const found = datasheets.find((sheet) => sheet.name === 'Gretchin' && sheet.faction === 'Orks');
    if (!found) throw new Error('Gretchin не найден среди орков');
    return found;
  };
  const sheet = host();
  const keywordsOf = (unit: CombatUnit, kind: 'melee' | 'ranged'): Set<string> =>
    new Set(
      unit.models
        .flatMap((model) => model.weapons)
        .filter((weapon) => weapon.kind === kind)
        .flatMap((weapon) => weapon.keywords.map((keyword) => keyword.name))
    );

  /**
   * Ставит временную запись слоя на Gretchin, выполняет действие и убирает её.
   *
   * Запись должна жить ВО ВРЕМЯ действия: `withOnceEffects` сам читает
   * `manualAbilityOf(unit.id)`, поэтому отряд, собранный «на временной»
   * способности и переживший её удаление, эффекта бы уже не нёс.
   */
  const duringTemporaryAbility = <T>(
    ability: Record<string, unknown>,
    action: (unit: CombatUnit) => T
  ): T => {
    const saved = MANUAL_ABILITIES[sheet.id];
    MANUAL_ABILITIES[sheet.id] = ability as ManualAbility;
    try {
      return action(adaptUnit(sheet, { size: 'min' }).unit);
    } finally {
      if (saved === undefined) delete MANUAL_ABILITIES[sheet.id];
      else MANUAL_ABILITIES[sheet.id] = saved;
    }
  };
  /** Оружие отряда — строкой: сравнение целиком не зависит от порядка ключей. */
  const armsOf = (unit: CombatUnit): string =>
    JSON.stringify(unit.models.map((model) => model.weapons));
  const modelsOf = (unit: CombatUnit): string => JSON.stringify(unit.models);
  const baseline = adaptUnit(sheet, { size: 'min' }).unit;

  it.each(WEAPON_EFFECT_FIELDS)('оружие-эффект %s доезжает до оружия', (field) => {
    // Регрессия на класс «поле объявлено, но не попало в список применения».
    // Именно так были потеряны meleeMortalPerWound (Palatine) и
    // weaponKeywordsOn (Caladius): оба разбирались в коде, но предикат их не
    // видел, и весь блок не выполнялся. Тест ставит в слой ТОЛЬКО это поле —
    // поэтому любое поле, потерянное по дороге, даёт «эффекта нет».
    duringTemporaryAbility({ [field]: SAMPLES_WEAPON[field] }, (unit) => {
      expect(armsOf(unit), `«${field}» не изменил ни одного оружия`).not.toBe(armsOf(baseline));
    });
  });

  it.each(ONCE_EFFECT_FIELDS)('одноразовый эффект %s попадает в дельту', (field) => {
    // Второй ручной перечень того же класса: `hasOnce`. Забытое поле означало бы
    // нулевую дельту способности — и заметить это можно только по сдвигу тиров.
    duringTemporaryAbility({ [field]: SAMPLES_ONCE[field] }, (unit) => {
      const once = withOnceEffects(unit);
      // Сравниваем МОДЕЛИ, а не только оружие: часть одноразовых эффектов
      // меняет модель (FNP, потолок урона за раунд), а не ствол.
      expect(once, `«${field}»: копия не создана — эффект не применён`).not.toBe(unit);
      expect(modelsOf(once), `«${field}» не изменил одноразовую копию`).not.toBe(modelsOf(unit));
    });
  });

  it.each(ONCE_AURA_FIELDS)('одноразовое поле ауры %s попадает в дельту', (field) => {
    // Одноразовые эффекты ауры (Trajann, Shield-Captain) живут на уровне лидера,
    // поэтому и проверяются отдельно: способность лежит в `aura`, а применяется
    // к оружию при расчёте дельты.
    duringTemporaryAbility({ aura: { [field]: SAMPLES_AURA[field] } }, (unit) => {
      const once = withOnceEffects(unit);
      expect(armsOf(once), `аура «${field}» не дала эффекта в одноразовой копии`).not.toBe(armsOf(unit));
    });
  });

  it('«только рукопашное» и «всему оружию» остаются разными', () => {
    // Проверка не только «что-то изменилось», но и КУДА попал кейворд: иначе
    // опечатка в условии фазы сделала бы способность шире правила молча.
    const meleeOnly = duringTemporaryAbility(
      { meleeWeaponKeywords: ['Lethal Hits'] },
      (unit) => unit
    );
    const everywhere = duringTemporaryAbility(
      { weaponKeywordsAll: ['Lethal Hits'] },
      (unit) => unit
    );
    expect(keywordsOf(meleeOnly, 'ranged').has('lethal'), 'рукопашное поле не должно достаться стволу').toBe(false);
    expect(keywordsOf(meleeOnly, 'melee').has('lethal'), 'рукопашное поле обязательно на клинке').toBe(true);
    expect(keywordsOf(everywhere, 'ranged').has('lethal'), 'поле «всему оружию» обязано быть и на стволе').toBe(true);
  });
});

describe('транспортный флаг разбирается из кейворда', () => {
  it('ставится транспорту и не ставится остальным', () => {
    const has = (name: string): boolean =>
      detectUtilityFlags(find(name)).some((flag) => flag.id === 'Transport');
    // Транспорт разбирается из ДАННЫХ, а не задан списком: иначе новый транспорт
    // в обновлении BSData просто не получил бы флаг.
    expect(has('Venerable Land Raider')).toBe(true);
    expect(has('Orion Assault Dropship')).toBe(true);
    expect(has('Coronus Grav-carrier')).toBe(true);
    expect(has('Anathema Psykana Rhino')).toBe(true);
    // Ares Gunship — летающая пушка, а не транспорт: в BSData у него нет
    // кейворда TRANSPORT, и выдумывать его в тесте означало бы проверять не код.
    expect(has('Ares Gunship'), ' gunship не транспорт').toBe(false);
    expect(has('Custodian Guard'), 'пехота не транспорт').toBe(false);
    expect(has('Custodian Guard with Adrasite and Pyrithite spears')).toBe(false);
  });
});

describe('[ONE SHOT] → флаг onceOnly', () => {
  it('адаптер ставит флаг по кейворду one-shot', () => {
    // Seeker missile у Manta — классический [ONE SHOT]: выстрелил один раз
    // и весь бой стреляет только «вечным» оружием.
    const manta = adaptUnit(find('Manta')).unit;
    const seekers = manta.models.flatMap((model) => model.weapons).filter((w) => w.onceOnly === true);
    expect(seekers.length, 'нужен одинноразовый ствол').toBeGreaterThan(0);
    // Флаг стоит только у одноразовых: обычное оружие не помечено.
    const steady = manta.models.flatMap((model) => model.weapons).filter((w) => w.onceOnly !== true);
    expect(steady.length, 'должно остаться постоянное оружие').toBeGreaterThan(0);
  });

  it('юниты с one-shot не теряют всё оружие в постоянном расчёте', () => {
    // Инвариант, выведенный исследованием: у всех юнитов с one-shot профилями
    // остаётся хотя бы одна модель с постоянным оружием — иначе отряд в базовом
    // прогоне молчал бы целиком и занижал свой тир без всякой компенсации.
    const offenders: string[] = [];
    for (const datasheet of datasheets) {
      let unit;
      try {
        unit = adaptUnit(datasheet).unit;
      } catch {
        continue; // даташиты, которые адаптер не собирает — не наши
      }
      const hasOnce = unit.models.some((model) =>
        model.weapons.some((weapon) => weapon.onceOnly === true)
      );
      if (!hasOnce) continue;
      const hasSteady = unit.models.some((model) =>
        model.weapons.some((weapon) => weapon.onceOnly !== true)
      );
      if (!hasSteady) offenders.push(datasheet.name);
    }
    expect(offenders, 'юниты, остающиеся без постоянного оружия').toEqual([]);
  });

  it('withOnceEffects снимает флаг у копии, возвращая залп в расчёт', () => {
    const base = adaptUnit(find('Repulsor')).unit;
    const boosted = withOnceEffects(base);
    expect(boosted, 'копия должна строиться — залп иначе не попадёт в дельту').not.toBe(base);
    const onceInBase = base.models.flatMap((m) => m.weapons).filter((w) => w.onceOnly === true);
    expect(onceInBase.length).toBeGreaterThan(0);
    for (const weapon of boosted.models.flatMap((m) => m.weapons)) {
      expect(weapon.onceOnly !== true, `«${weapon.name}» должен стать постоянным в копии`).toBe(true);
    }
  });
});

