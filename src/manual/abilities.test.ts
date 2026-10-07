/**
 * Целостность ручного слоя (abilities.ts).
 *
 * Слой включается по id даташита, поэтому ошибка в id НЕ бросает исключения:
 * запись просто молча не срабатывает. Так и вышло с Knight-Centura — в id было
 * лишнее «2» (`7099-71b2-…` вместо `7099-71b-…`), и вместе с флагом на 3 балла
 * исчезла вся запись: юнит считался обычной пехотой без EPIC HERO.
 *
 * Вторая молчаливая ошибка того же рода — строка кейворда, которую движок не
 * знает: `parseKeywords` отбрасывает нераспознанное, и способность выглядит
 * описанной, а в бой ничего не даёт (у Shield-Captain так пропал RENDAX).
 *
 * Проверки ниже закрывают класс ошибок, а не перечисляют юнитов: падать они
 * должны на любой новой записи с опечаткой, а не на известных случаях.
 */

import { describe, expect, it } from 'vitest';
import { bsFilesFromDir } from '../bsdata/node-source.ts';
import { loadBsData } from '../bsdata/load.ts';
import { parseBsDatabase } from '../bsdata/units.ts';
import { CANONICAL_KEYWORD_NAMES, parseKeywords } from '../combat/keywords.ts';
import { leaderDefinitionsOf } from '../tier/leaders.ts';
import { UTILITY_CATEGORY, UTILITY_POINTS } from '../tier/utility.ts';
import { MANUAL_ABILITIES, MANUAL_UTILITY_FLAG_IDS, type ManualAbility } from './abilities.ts';

const { datasheets } = parseBsDatabase(loadBsData(bsFilesFromDir('public/BSData/wh40k-11e')));
const entries: Array<[string, ManualAbility]> = Object.entries(MANUAL_ABILITIES);

/**
 * Поля, строки из которых уходят в `parseKeywords`.
 *
 * `defensiveKeywords` здесь НЕ участвуют: это кейворды МОДЕЛЕЙ, leaders.ts
 * добавляет их как есть, минуя разбор (см. отдельную проверку ниже).
 */
function keywordStrings(ability: ManualAbility): Array<[field: string, raw: string]> {
  const out: Array<[string, string]> = [];
  const push = (field: string, values: readonly string[] | undefined): void => {
    for (const value of values ?? []) out.push([field, value]);
  };
  push('aura.weaponKeywords', ability.aura?.weaponKeywords);
  push('aura.onceMeleeKeywords', ability.aura?.onceMeleeKeywords);
  push('meleeWeaponKeywords', ability.meleeWeaponKeywords);
  push('onceRangedKeywords', ability.onceRangedKeywords);
  return out;
}

describe('целостность ручного слоя', () => {
  it('слой не пуст — иначе проверки ниже ничего не проверяют', () => {
    expect(entries.length, 'записей в слое').toBeGreaterThan(20);
  });

  it('каждый ключ слоя — существующий id даташита', () => {
    const ids = new Set(datasheets.map((sheet) => sheet.id));
    const missing = entries.map(([id]) => id).filter((id) => !ids.has(id));
    expect(missing, `в BSData нет таких даташитов: ${missing.join(', ')}`).toEqual([]);
  });

  it('каждый кейворд ручного слоя — из известных движку', () => {
    // Регрессия: у Shield-Captain в списке стоял 'Active'. `parseKeyword` на
    // незнакомом тексте НЕ падает, а склеивает 'active' и отдаёт дальше, а ни
    // одно правило это имя не читает — то есть RENDAX ([LETHAL HITS]) исчез из
    // дельты, не дав ни одной ошибки. Проверять «разобралось ли» мало: проверять
    // надо «из списка настоящих ли оно».
    const known = new Set(CANONICAL_KEYWORD_NAMES);
    const unknown: string[] = [];
    for (const [id, ability] of entries) {
      for (const [field, raw] of keywordStrings(ability)) {
        for (const keyword of parseKeywords([raw])) {
          if (!known.has(keyword.name)) {
            unknown.push(`${id} · ${field} · «${raw}» → ${keyword.name}`);
          }
        }
      }
    }
    expect(unknown, `движок не знает этих имён: ${unknown.join(', ')}`).toEqual([]);
  });

  it('defensiveKeywords — кейворды моделей, и они в верхнем регистре', () => {
    // Граница между двумя списками зафиксирована намеренно: `defensiveKeywords`
    // читает rules.ts по защитнику, поэтому значение попадает в модель дословно.
    // Строчная буква не совпала бы ни с одним кейвордом в правилах — и способность
    // снова сработала бы «в никуда», только уже безошибочно.
    const used = entries.flatMap(([id, ability]) =>
      (ability.withLeader?.defensiveKeywords ?? []).map((keyword) => [id, keyword] as const)
    );
    expect(used.length, 'defensiveKeywords должен кем-то использоваться').toBeGreaterThan(0);
    const lowercased = used
      .filter(([, keyword]) => keyword !== keyword.toUpperCase())
      .map(([id, keyword]) => `${id} · «${keyword}»`);
    expect(lowercased, `регистр: ${lowercased.join(', ')}`).toEqual([]);
  });

  it('withLeader ссылается на существующих лидеров', () => {
    // Та же молчаливость: лидер с чужим id просто не нашёлся бы при поиске
    // присоединения, и способность не сработала бы ни для кого.
    const leaderIds = new Set(leaderDefinitionsOf(datasheets).map((leader) => leader.id));
    const missing: string[] = [];
    for (const [id, ability] of entries) {
      for (const leaderId of ability.withLeader?.leaderIds ?? []) {
        if (!leaderIds.has(leaderId)) missing.push(`${id} → ${leaderId}`);
      }
    }
    expect(missing, `нет таких лидеров: ${missing.join(', ')}`).toEqual([]);
  });

  it('allProfilesOn указывает на оружие, которое реально есть', () => {
    // Совпадение идёт по ПОДСТРОКЕ имени записи снаряжения, поэтому переименование
    // в BSData обрывает правило молча: способность просто исчезнет из отряда,
    // а адаптер вернётся к выбору одного профиля. Проверяем, что предмет найден.
    const missing: string[] = [];
    for (const [id, ability] of entries) {
      const sheet = datasheets.find((item) => item.id === id);
      if (sheet === undefined) continue;
      const names = sheet.modelGroups
        .flatMap((group) => group.variants)
        .flatMap((variant) => variant.defaultWargear)
        .map((item) => item.name.toLowerCase());
      for (const needle of ability.allProfilesOn ?? []) {
        if (!names.some((name) => name.includes(needle.toLowerCase()))) {
          missing.push(`${id} · «${needle}»`);
        }
      }
    }
    expect(
      entries.some(([, ability]) => (ability.allProfilesOn ?? []).length > 0),
      'allProfilesOn должен кем-то использоваться'
    ).toBe(true);
    expect(missing, `такого оружия в даташите нет: ${missing.join(', ')}`).toEqual([]);
  });

  it('у каждого utility-флага есть причина, а цена берётся из UTILITY_POINTS', () => {
    // Флаг попадает в отчёт и в интерфейс: без причины его нечем объяснить,
    // а нулевые баллы означают «стратегической ценности нет» — то есть флаг
    // врёт о самом себе.
    //
    // Проверяется НЕ поле `points` в записи (его больше нет), а единственный
    // источник цены: убрать бы его — и флаг молча стоил бы 0 баллов при
    // попадании в отчёт, то есть потерялся бы в тире без ошибки. Раньше цена
    // дублировалась в записи слоя и в UTILITY_POINTS, и расхождение было
    // невозможно заметить: обе величины просто выглядели правильно.
    for (const [id, ability] of entries) {
      for (const flag of ability.utilityFlags ?? []) {
        expect(flag.reason.trim().length, `${id} / ${flag.id}: пустая причина`).toBeGreaterThan(0);
        expect(
          UTILITY_POINTS[flag.id],
          `${id} / ${flag.id}: нет цены в UTILITY_POINTS — флаг будет стоить 0`
        ).toBeGreaterThan(0);
        expect(
          UTILITY_CATEGORY[flag.id],
          `${id} / ${flag.id}: нет категории — флаг не попадёт ни в одну ось`
        ).toBe('strategic');
      }
    }
  });

  it('ни один ручной флаг не остался без записи в MANUAL_ABILITIES', () => {
    // Обратная сторона: id в UTILITY_POINTS, который никто не выдаёт, — это
    // цена, которая молча не участвует в расчёте. Список id и таблица цен
    // обязаны описывать один и тот же набор флагов.
    const issued = new Set(
      entries.flatMap(([, ability]) => (ability.utilityFlags ?? []).map((flag) => flag.id))
    );
    const declared = MANUAL_UTILITY_FLAG_IDS.map((flagId) => flagId);
    const orphans = declared.filter((flagId) => !issued.has(flagId));
    expect(orphans, `объявлены, но никогда не выдаются: ${orphans.join(', ')}`).toEqual([]);
  });

  it('одноразовые эффекты не попадают в постоянный бой', () => {
    // Проверка на саму идею слоя: «once per battle» не имеет права висеть в
    // боевом расчёте постоянно — иначе способность стоит весь бой. Здесь
    // контролируется, что одноразовые поля вообще не дублируются в
    // постоянные: если бы кто-то завёл и то и другое у одного юнита, дельта
    // и бой считали бы эффект дважды.
    for (const [id, ability] of entries) {
      const aura = ability.aura;
      if (aura === undefined) continue;
      if (aura.onceMeleeAttacks !== undefined) {
        expect(aura.extraAttacks, `${id}: +N атак и разово, и постоянно`).toBeUndefined();
      }
      if (aura.onceMeleeStrength !== undefined) {
        expect(aura.onceMeleeStrength, `${id}: поле одноразовое`).toBeGreaterThan(0);
      }
    }
  });
});
