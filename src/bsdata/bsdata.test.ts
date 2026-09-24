/**
 * Тесты BSData-парсера на реальной выгрузке (public/BSData/wh40k-11e).
 *
 * Проверяются фактические особенности данных, а не «идеальные» ожидания:
 *  - Boyz: две группы моделей (9-18 Boyz и 1-2 Nobz), базовое снаряжение
 *    Choppa+Slugga+Shoota, тир цены 90 → 180 при размере больше 10;
 *  - Intercessor Squad: у сержанта группы выбора оружия, у отряда два размера
 *    и лимит 'max:selections=2(unit)' на grenade launcher;
 *  - Necron Warriors: два взаимоисключающих варианта модели в одной группе;
 *  - Warboss: одиночный даташит (корень — модель) с профилем и ценой.
 */

import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { bsFilesFromDir } from './node-source.ts';
import { loadBsData } from './load.ts';
import { parseBsDatabase } from './units.ts';
import { weaponsOf } from './composition.ts';
import { pointsFor, sizeRangeOf, sizeTiersOf } from './points.ts';
import type { BsDatasheet, BsWargear } from './types.ts';

const database = loadBsData(bsFilesFromDir(resolve('public/BSData/wh40k-11e')));
const { datasheets, byId, report } = parseBsDatabase(database);

const findByName = (name: string): BsDatasheet => {
  const found = datasheets.find((datasheet) => datasheet.name === name);
  if (!found) throw new Error(`Даташит "${name}" не найден`);
  return found;
};

/** Все записи снаряжения даташита, включая вложенные. */
const allWargearOf = (datasheet: BsDatasheet): BsWargear[] => {
  const items: BsWargear[] = [];
  const visit = (list: BsWargear[]): void => {
    for (const item of list) {
      items.push(item);
      visit(item.nested);
    }
  };
  for (const variant of datasheet.variants) {
    visit(variant.defaultWargear);
    visit(variant.optionalWargear);
  }
  return items;
};

/** Минимально допустимая раскладка из n моделей: min-числа, остаток — в первый вариант. */
const countsOfSize = (datasheet: BsDatasheet, size: number): Map<string, number> => {
  const counts = new Map<string, number>();
  let remaining = size;
  for (const variant of datasheet.variants) {
    const take = Math.min(remaining, variant.min);
    if (take > 0) {
      counts.set(variant.id, take);
      remaining -= take;
    }
  }
  if (remaining > 0 && datasheet.variants.length > 0) {
    const first = datasheet.variants[0]!;
    counts.set(first.id, (counts.get(first.id) ?? 0) + remaining);
  }
  return counts;
};

/** Имена всего снаряжения варианта, включая вложенное. */
const wargearNamesOf = (datasheet: BsDatasheet): string[] => {
  const names: string[] = [];
  const visit = (items: BsWargear[]): void => {
    for (const item of items) {
      names.push(item.name, ...item.profiles.map((profile) => profile.name));
      visit(item.nested);
    }
  };
  for (const variant of datasheet.variants) {
    visit(variant.defaultWargear);
    visit(variant.optionalWargear);
    for (const choice of variant.choiceGroups) {
      for (const item of choice.choices) {
        names.push(item.name, ...item.profiles.map((profile) => profile.name));
        visit(item.nested);
      }
    }
  }
  return names;
};

/** Количество моделей по вариантам: 9 Boy + 1 Nob или 18 Boy + 2 Nobz. */
const boyzCounts = (datasheet: BsDatasheet, size: 10 | 20): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const variant of datasheet.variants) {
    if (variant.name === 'Boy') counts.set(variant.id, size === 10 ? 9 : 18);
    if (variant.name === 'Nob') counts.set(variant.id, size === 10 ? 1 : 2);
  }
  return counts;
};

describe('loadBsData', () => {
  it('индексирует определения и резолвит ссылки каталогов', () => {
    expect(database.documents.length).toBeGreaterThan(40);
    expect(database.definitionCount).toBeGreaterThan(20000);
    // Нерезолвленными остаются только служебные infoGroup-ссылки.
    expect(report.unresolvedLinks).toBeLessThan(database.definitionCount / 10);
  });

  it('берёт типы профилей и стоимостей из gameSystem', () => {
    expect(database.gameSystem).not.toBeNull();
    expect(database.meta.ptsCostTypeId).not.toBeNull();
    expect(database.meta.profileTypeIds.unit).not.toBeNull();
    expect(database.meta.profileTypeIds.ranged).not.toBeNull();
    expect(database.meta.characteristicIds.get('M')).toBeTruthy();
    expect(database.meta.costTypeNames.get(database.meta.ptsCostTypeId ?? '')).toBe('pts');
  });
});

describe('parseBsDatabase', () => {
  it('разбирает практически все даташиты и группирует по фракциям', () => {
    expect(report.datasheets).toBeGreaterThan(1300);
    expect(report.catalogues).toBeGreaterThan(40);
    expect(report.datasheetsByFaction['Orks']).toBeGreaterThan(15);
    expect(report.skippedNoCost.length).toBeLessThan(50);
    expect(report.datasheetsWithoutModels.length).toBeLessThan(50);
  });

  it('дедуплицирует даташиты библиотечных каталогов', () => {
    const ids = new Set(datasheets.map((datasheet) => datasheet.id));
    expect(ids.size).toBe(datasheets.length);
    expect(byId.size).toBe(datasheets.length);
  });
});

describe('Boyz', () => {
  const boyz = findByName('Boyz');

  it('имеет две группы моделей с границами из данных', () => {
    expect(boyz.kind).toBe('unit');
    expect(boyz.faction).toBe('Orks');

    const groups = boyz.modelGroups.map((group) => ({
      name: group.name,
      min: group.min,
      max: group.max,
    }));
    expect(groups).toContainEqual({ name: '9-18 Boyz', min: 9, max: 18 });
    expect(groups).toContainEqual({ name: '1-2 Nobz', min: 1, max: 2 });
  });

  it('отдаёт профили моделей и полный набор базового оружия', () => {
    const boy = boyz.variants.find((variant) => variant.name === 'Boy');
    const nob = boyz.variants.find((variant) => variant.name === 'Nob');
    expect(boy?.profile?.toughness).toBe('5');
    expect(boy?.profile?.wounds).toBe('1');
    expect(nob?.profile?.wounds).toBe('3');

    const names = wargearNamesOf(boyz);
    expect(names).toContain('Choppa');
    expect(names).toContain('Slugga');
    expect(names).toContain('Shoota');

    const choppa = boy?.defaultWargear.find((item) => item.name === 'Choppa');
    expect(choppa?.min).toBe(1);
    expect(choppa?.max).toBe(1);
    expect(choppa?.profiles[0]?.kind).toBe('melee');
    expect(choppa?.profiles[0]?.strength).toBe('5');
  });

  it('рассчитывает тир цены 90 → 180 при размере больше 10', () => {
    expect(boyz.cost.base).toBe(90);
    const tier = boyz.cost.modifiers.find((modifier) => modifier.value === 180);
    expect(tier).toBeDefined();
    expect(tier?.uncertain).toBe(false);
    expect(tier?.conditions[0]?.target).toBe('total-models');

    expect(pointsFor(boyz, boyzCounts(boyz, 10)).points).toBe(90);
    expect(pointsFor(boyz, boyzCounts(boyz, 20)).points).toBe(180);
  });

  it('знает границы размера отряда 10-20', () => {
    const range = sizeRangeOf(boyz);
    expect(range.min).toBe(10);
    expect(range.max).toBe(20);
    expect(sizeTiersOf(boyz).map((tier) => tier.models)).toContain(10);
  });
});

describe('Intercessor Squad', () => {
  const squad = findByName('Intercessor Squad');

  it('видит сержанта, отряд и вариант с гранатомётом', () => {
    const names = squad.variants.map((variant) => variant.name);
    expect(names).toContain('Intercessor Sergeant');
    expect(names).toContain('Intercessor');

    const sergeant = squad.variants.find((variant) => variant.name === 'Intercessor Sergeant');
    expect(sergeant?.min).toBe(1);
    expect(sergeant?.max).toBe(1);

    const weaponNames = (sergeant?.choiceGroups ?? [])
      .flatMap((group) => group.choices)
      .map((choice) => choice.name);
    expect(weaponNames).toContain('Power weapon');
    expect(weaponNames).toContain('Power fist');
    expect(sergeant?.choiceGroups.map((group) => group.min)).toEqual([1, 1]);
  });

  it('сохраняет лимит снаряжения на весь отряд', () => {
    const launcher = squad.variants
      .flatMap((variant) => [...variant.defaultWargear, ...variant.optionalWargear])
      .find((item) => item.name === 'Astartes grenade launcher');
    expect(launcher).toBeDefined();
    expect(launcher?.unitWideMax).toBe(2);
  });

  it('имеет второй ценовой тир для большого отряда', () => {
    expect(squad.cost.base).toBe(80);
    expect(squad.cost.modifiers.some((modifier) => modifier.value === 150)).toBe(true);
  });
});

describe('Necron Warriors', () => {
  const warriors = findByName('Necron Warriors');

  it('хранит два взаимоисключающих варианта модели в одной группе', () => {
    const group = warriors.modelGroups[0];
    expect(group.min).toBe(10);
    expect(group.max).toBe(20);
    expect(group.variants.map((variant) => variant.name)).toEqual([
      'Warrior w/ gauss flayer',
      'Warrior w/ gauss reaper',
    ]);
  });

  it('отдаёт профиль оружия обоих вариантов', () => {
    const names = wargearNamesOf(warriors);
    expect(names).toContain('Gauss flayer');
    expect(names).toContain('Gauss reaper');

    const flayer = warriors.variants[0]?.defaultWargear.find(
      (item) => item.name === 'Gauss flayer'
    );
    expect(flayer?.profiles[0]?.range).toBe('24"');
    const reaper = warriors.variants[1]?.defaultWargear.find(
      (item) => item.name === 'Gauss reaper'
    );
    expect(reaper?.profiles[0]?.range).toBe('12"');
  });
});

describe('одиночный даташит', () => {
  const warboss = findByName('Warboss');

  it('корень-модель превращается в одну модель с профилем и ценой', () => {
    expect(warboss.kind).toBe('model');
    expect(warboss.modelGroups).toHaveLength(1);

    const variant = warboss.variants[0];
    expect(variant.profile?.movement).toBe('6"');
    expect(variant.profile?.toughness).toBe('6');
    expect(variant.profile?.wounds).toBe('6');
    expect(warboss.cost.base).toBe(100);
  });
});

describe('Cadian Shock Troops', () => {
  const cadian = findByName('Cadian Shock Troops');

  /** Состав по вариантам: N Trooper + 1 Sergeant, остальные — 0. */
  const countsAt = (troopers: number, sergeants: number): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const variant of cadian.variants) {
      if (variant.name === 'Shock Trooper') counts.set(variant.id, troopers);
      else if (variant.name === 'Shock Trooper Sergeant') counts.set(variant.id, sergeants);
      else counts.set(variant.id, 0);
    }
    return counts;
  };

  it('раскрывает контейнеры размера в одну группу с вариантами моделей', () => {
    expect(cadian.kind).toBe('unit');
    const group = cadian.modelGroups[0];
    const names = group.variants.map((variant) => variant.name);
    expect(names).toContain('Shock Trooper');
    expect(names).toContain('Shock Trooper Sergeant');
    expect(names).toContain('Shock Trooper w/ Meltagun');
  });

  it('хранит границы специализированных моделей и их базовое оружие', () => {
    const melta = cadian.variants.find((variant) => variant.name === 'Shock Trooper w/ Meltagun');
    expect(melta?.min).toBe(0);
    expect(melta?.max).toBe(1);
    const names = (melta?.defaultWargear ?? []).map((item) => item.name);
    expect(names).toContain('Meltagun');
    expect(names).toContain('Close combat weapon');

    const trooper = cadian.variants.find((variant) => variant.name === 'Shock Trooper');
    expect(trooper?.min).toBe(6);
    expect(trooper?.max).toBe(18);
  });

  it('пересчитывает цену «set 145, если моделей > 10»', () => {
    expect(cadian.cost.base).toBe(70);
    // 9 Trooper + 1 Sergeant = 10 моделей — базовый тир.
    expect(pointsFor(cadian, countsAt(9, 1)).points).toBe(70);
    // 19 + 1 = 20 моделей — тир «set 145».
    expect(pointsFor(cadian, countsAt(19, 1)).points).toBe(145);
  });
});

describe('Aquila Kill Team', () => {
  const aquila = findByName('Aquila Kill Team');

  it('раскрывает ссылки на другие отряды в модели своего состава', () => {
    expect(aquila.kind).toBe('unit');
    const names = aquila.variants.map((variant) => variant.name);
    expect(names).toContain('Kill Team Sergeant');
    expect(names).toContain('Deathwatch Veteran w/ stalker bolt rifle');
    expect(names).toContain('Gravis Veteran w/ infernus heavy bolter');
  });

  it('сохраняет границы вариантов из исходных отрядов и их снаряжение', () => {
    const sergeant = aquila.variants.find((variant) => variant.name === 'Kill Team Sergeant');
    expect(sergeant?.min).toBe(1);
    expect(sergeant?.max).toBe(1);
    const wargear = (sergeant?.defaultWargear ?? []).map((item) => item.name);
    expect(wargear).toContain('Plasma pistol');
    expect(wargear).toContain('Power weapon');

    const veteran = aquila.variants.find(
      (variant) => variant.name === 'Deathwatch Veteran w/ stalker bolt rifle'
    );
    expect(veteran?.min).toBe(1);
    expect(veteran?.max).toBe(2);
  });
});

describe('профили, способности и транспорт', () => {
  it('оружие различает ranged/melee и сохраняет навык', () => {
    const boyz = findByName('Boyz');
    const ranged = boyz.variants
      .flatMap((variant) => variant.defaultWargear)
      .flatMap((item) => item.profiles)
      .filter((profile) => profile.kind === 'ranged');
    expect(ranged.length).toBeGreaterThan(0);
    expect(ranged[0]?.skill).toBeTruthy();
  });

  it('способности содержат текст описания', () => {
    const boyz = findByName('Boyz');
    const ability = boyz.abilities.find((entry) => entry.name === 'Tide of Muscle');
    expect(ability?.description).toContain('LETHAL HITS');
  });

  it('транспорт отдаёт грузоподъёмность', () => {
    const trukk = findByName('Trukk');
    expect(trukk.transportCapacity).not.toBeNull();
  });
});

/**
 * Разбор групп снаряжения: в данных оружие лежит в «полках» ('Wargear') и в
 * группах выбора, поэтому проверяются оба случая, а также пометка кампанийных
 * записей, которые не являются снаряжением модели.
 */
describe('снаряжение: группы, выбор и виды записей', () => {
  const warboss = findByName('Warboss');
  const barbgaunts = findByName('Barbgaunts');
  const abaddon = findByName('Abaddon the Despoiler');
  const broadside = findByName('Broadside Battlesuits');

  it('раскрывает «полку» Wargear и предлагает выбор из настоящего оружия', () => {
    const choppa = warboss.variants[0]?.choiceGroups.find(
      (group) => group.name === 'Kustom Choppa'
    );
    expect(choppa).toBeDefined();
    expect(choppa?.min).toBe(1);
    expect(choppa?.max).toBe(1);

    const names = (choppa?.choices ?? []).map((choice) => choice.name).sort();
    expect(names).toEqual(['Kustom Choppa', 'Power Klaw']);

    const klaw = choppa?.choices.find((choice) => choice.name === 'Power Klaw');
    expect(klaw?.kind).toBe('weapon');
    expect(klaw?.profiles[0]?.kind).toBe('melee');

    // Обязательный выбор попадает и в базовое снаряжение модели.
    const defaults = (warboss.variants[0]?.defaultWargear ?? []).map((item) => item.name);
    expect(defaults).toContain('Kustom Choppa');

    const shoota = warboss.variants[0]?.choiceGroups.find(
      (group) => group.name === 'Kustom Shoota'
    );
    expect(shoota?.choices.map((choice) => choice.name)).toContain('Kombi-rokkit');
  });

  it('поднимает содержимое группы-полки в модель (Barbgaunts)', () => {
    const variant = barbgaunts.variants.find((entry) => entry.name === 'Barbgaunt');
    const names = (variant?.defaultWargear ?? []).map((item) => item.name);
    expect(names).toContain('Barblauncher');
    expect(names).toContain('Chitinous claws and teeth');

    const launcher = variant?.defaultWargear.find((item) => item.name === 'Barblauncher');
    expect(launcher?.kind).toBe('weapon');
    expect(launcher?.min).toBe(1);
    expect(launcher?.profiles[0]?.kind).toBe('ranged');
    expect(variant?.choiceGroups.map((group) => group.name)).not.toContain('Wargear');
  });

  it('отдаёт оружие одиночной модели, описанное прямо в её записи', () => {
    const variant = abaddon.variants[0];
    const names = (variant?.defaultWargear ?? []).map((item) => item.name);
    expect(names).toContain('Talon of Horus');
    expect(names).toContain("Drach'nyen");

    const talon = variant?.defaultWargear.find((item) => item.name === 'Talon of Horus');
    expect(talon?.kind).toBe('weapon');
    expect(talon?.profiles.map((profile) => profile.kind).sort()).toEqual(['melee', 'ranged']);
  });

  it('сохраняет вложенный выбор внутри группы (Secondary Weapons)', () => {
    const variant = broadside.variants.find((entry) => entry.name === 'Broadside Shas’ui');
    const drones = variant?.choiceGroups.find((group) => group.name === 'Drones (0-2)');
    expect(drones?.max).toBe(2);
    const gunDrone = drones?.choices.find((choice) => choice.name === 'Gun Drone');
    expect(weaponsOf(gunDrone as BsWargear).map((profile) => profile.name)).toEqual([
      'Twin pulse carbine',
    ]);

    const systems = variant?.choiceGroups.find((group) => group.name === 'Support Systems (0-2)');
    expect(systems?.max).toBe(2);
    const secondary = systems?.choices.find((choice) => choice.name === 'Secondary Weapons');
    expect(secondary?.kind).toBe('choice');
    expect(secondary?.nested.map((item) => item.name).sort()).toEqual([
      'Twin plasma rifle',
      'Twin smart missile system',
    ]);
    expect(weaponsOf(secondary as BsWargear)).toHaveLength(2);
  });

  it('помечает кампанийные записи и не считает их оружием', () => {
    const wargear = allWargearOf(warboss);
    const rosterNames = wargear.filter((item) => item.kind === 'roster').map((item) => item.name);
    expect(rosterNames).toContain('Weapon Upgrades');
    expect(rosterNames).toContain('Finely Balanced (BS/WS+1)');
    expect(rosterNames).toContain('Warlord');

    // У оружия внутри кампанийные апгрейды, но само оно остаётся оружием.
    const klaw = wargear.find((item) => item.name === 'Power Klaw');
    expect(klaw?.kind).toBe('weapon');
    expect(weaponsOf(klaw as BsWargear).map((profile) => profile.name)).toEqual(['Power Klaw']);

    const modifications = wargear.find((item) => item.name === 'Weapon Modifications');
    expect(modifications?.kind).toBe('roster');
    expect(weaponsOf(modifications as BsWargear)).toHaveLength(0);
  });

  it('забирает способности снаряжения в abilities с видом wargear', () => {
    const ridgerunners = findByName('Achilles Ridgerunners');
    const flare = ridgerunners.abilities.find((ability) => ability.name === 'Flare launcher');
    expect(flare?.kind).toBe('wargear');
    expect(flare?.description.length).toBeGreaterThan(10);
  });

  it('держит покрытие оружием практически на всей базе', () => {
    expect(report.weapons).toBeGreaterThan(10000);
    // Без оружия остаются только фортификации и террейн.
    expect(report.datasheetsWithoutWeapons.length).toBeLessThan(25);
    expect(report.datasheetsWithoutWeapons).toContain('Aegis Defence Line');
    // Снаряжение без боевого профиля — это щиты, дроны и прочие апгрейды.
    expect(report.wargearWithoutProfile).toBeLessThan(3000);
    expect(report.rosterEntries).toBeGreaterThan(100000);
  });

  it('ростерная надбавка за копии отряда: Soul Grinder и Fiends', () => {
    // Soul Grinder: 180 за экземпляр; +15 за каждую дополнительную копию в ростере.
    const grinder = findByName('Khorne Soul Grinder');
    const perCopy = grinder.cost.modifiers.find(
      (modifier) => modifier.type === 'increment-per-unit-copy',
    );
    expect(perCopy?.value).toBe(15);
    expect(perCopy?.uncertain).toBe(false);
    expect(pointsFor(grinder, countsOfSize(grinder, 1)).points).toBe(180);
    expect(pointsFor(grinder, countsOfSize(grinder, 2)).points).toBe(180);
    expect(pointsFor(grinder, countsOfSize(grinder, 3)).points).toBe(180);

    // Fiends: 90 до тира, set 190 при >= 4 моделей; надбавка за копии не в цене.
    const fiends = findByName('Fiends');
    expect(pointsFor(fiends, countsOfSize(fiends, 3)).points).toBe(90);
    expect(pointsFor(fiends, countsOfSize(fiends, 4)).points).toBe(190);
    expect(pointsFor(fiends, countsOfSize(fiends, 6)).points).toBe(190);
  });

  it('ростерные условия остаются только у честно неопределимых юнитов', () => {
    // Виндрайдеры (тир зависит от присоединённого лидера) — uncertain.
    const windriders = findByName('Windriders');
    expect(windriders.cost.modifiers.some((modifier) => modifier.uncertain)).toBe(true);

    // Ассасины: надбавка действует вне родной фракции — external-условие.
    const vindicare = findByName('Vindicare Assassin');
    const bump = vindicare.cost.modifiers.find((modifier) => modifier.uncertain);
    expect(bump?.type).toBe('increment');

    // Ростерные надбавки за копии распознаны по всей базе, uncertain немного.
    expect(
      datasheets.filter((datasheet) =>
        datasheet.cost.modifiers.some((modifier) => modifier.type === 'increment-per-unit-copy'),
      ).length,
    ).toBeGreaterThan(300);
    expect(report.uncertainCosts.length).toBeLessThan(60);
  });

  it('отбрасывает ростерные записи в режиме roster: drop', () => {
    const lean = parseBsDatabase(database, { roster: 'drop' });
    const warbossLean = lean.datasheets.find((datasheet) => datasheet.name === 'Warboss');
    expect(warbossLean).toBeDefined();

    const wargear = allWargearOf(warbossLean ?? warboss);
    expect(wargear.some((item) => item.kind === 'roster')).toBe(false);

    // Оружие и группы выбора при этом остаются на месте.
    expect(wargear.find((item) => item.name === 'Power Klaw')?.kind).toBe('weapon');
    const choppa = warbossLean?.variants[0]?.choiceGroups.find(
      (group) => group.name === 'Kustom Choppa'
    );
    expect((choppa?.choices ?? []).map((choice) => choice.name).sort()).toEqual([
      'Kustom Choppa',
      'Power Klaw',
    ]);

    // Исходный даташит не портится: ростерные записи в нём остались.
    expect(allWargearOf(warboss).some((item) => item.kind === 'roster')).toBe(true);
  });
});