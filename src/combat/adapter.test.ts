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
    expect(
      oneModel?.weapons.filter((weapon) => /Plasma Incinerator/i.test(weapon.name)).length
    ).toBe(1);
    expect(oneModel?.weapons.some((weapon) => /Standard/i.test(weapon.name))).toBe(true);
    expect(oneModel?.weapons.some((weapon) => /Supercharge/i.test(weapon.name))).toBe(false);
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
