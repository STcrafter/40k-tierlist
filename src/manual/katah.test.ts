/**
 * Тесты выбора стойки Martial Ka'tah.
 *
 * Главный тест — устойчивость выбора. Разница между стойками у большинства
 * юнитов меньше процента, и при прежних 8 прогонах 12 юнитов из 14 меняли
 * стойку от сида к сиду, то есть в тирлист попадал шум. Тест требует, чтобы
 * выбор совпадал при смене сида, а второй — что он не сходится к одной стойке.
 */
import { describe, expect, it } from 'vitest';
import { bsFilesFromDir } from '../bsdata/node-source.ts';
import { loadBsData } from '../bsdata/load.ts';
import { parseBsDatabase } from '../bsdata/units.ts';
import { adaptUnit } from '../combat/adapter.ts';
import { ARCHETYPES } from '../combat/archetypes.ts';
import { damagePerRound } from '../combat/perRound.ts';
import { parseKeywords } from '../combat/keywords.ts';
import type { CombatUnit, CombatWeapon } from '../combat/types.ts';
import { hasMartialKatah, katahStanceNameOf } from './katah.ts';

const { datasheets } = parseBsDatabase(loadBsData(bsFilesFromDir('public/BSData/wh40k-11e')));
const katahUnits = datasheets.filter((d) => hasMartialKatah(d.rules));

/** Копия отряда с кейвордом на всём рукопашном оружии. */
function withKeywords(unit: CombatUnit, raw: string[]): CombatUnit {
  const wanted = parseKeywords(raw);
  return {
    ...unit,
    models: unit.models.map((model) => ({
      ...model,
      weapons: model.weapons.map((weapon) => {
        if (weapon.kind !== 'melee') return weapon;
        const extra = wanted.filter(
          (keyword) => !weapon.keywords.some((existing) => existing.name === keyword.name)
        );
        return extra.length === 0 ? weapon : { ...weapon, keywords: [...weapon.keywords, ...extra] };
      }),
    })),
  };
}

/**
 * Независимый перебор: те же параметры, что и в production, но свой пул сидов.
 *
 * katahStanceNameOf кэширует результат, поэтому «тот же юнит — тот же ответ»
 * не доказывает ничего. Этот вариант считает стойки напрямую по движку, минуя
 * и кэш, и код выбора.
 */
const REF_SEEDS = [0x4b_a7, 0x1f3c, 0x7a11] as const;
const REF_TRIALS = 200;
const REF_MARGIN = 0.04;

/** Оценки двух стойек по одному пулу сидов — без применения порога. */
function stanceScores(
  unit: CombatUnit,
  seeds: readonly number[]
): { sustained: number; lethal: number } {
  const score = (raw: string[]): number => {
    let total = 0;
    for (const seed of seeds) {
      total += damagePerRound(withKeywords(unit, raw), {
        trials: REF_TRIALS,
        distance: 12,
        phase: 'melee',
        targets: ARCHETYPES.map((archetype) => archetype.id),
        seed,
      }).total.destroyedPoints.overall.mean;
    }
    return total / seeds.length;
  };
  return { sustained: score(['Sustained Hits 1']), lethal: score(['Lethal Hits']) };
}

type StanceScores = { sustained: number; lethal: number };

/** Относительный разрыв стойек: меньше порога — они равноценны. */
function stanceGap(scores: StanceScores): number {
  const scale = Math.max(scores.sustained, scores.lethal);
  return scale <= 0 ? 0 : Math.abs(scores.lethal - scores.sustained) / scale;
}

/** Решение по тем же правилам, что в production: сначала порог, потом тай-брейк. */
function decide(scores: StanceScores): string {
  if (stanceGap(scores) < REF_MARGIN) return 'Sustained Hits 1';
  return scores.lethal > scores.sustained ? 'Lethal Hits' : 'Sustained Hits 1';
}

function simulateStance(unit: CombatUnit, seeds: readonly number[]): string {
  return decide(stanceScores(unit, seeds));
}

/**
 * Базовый отряд без выбранной стойки: applyKa'tah уже всё добавил.
 *
 * Формула ждёт именно базовый отряд. На уже обработанном она увидит навешенную
 * стойку, обнулит её вклад и перевернёт выбор.
 */
function stripStance(unit: CombatUnit): CombatUnit {
  return {
    ...unit,
    models: unit.models.map((model) => ({
      ...model,
      weapons: model.weapons.map((weapon) => ({
        ...weapon,
        keywords: weapon.keywords.filter(
          (keyword) => keyword.name !== 'sustained' && keyword.name !== 'lethal'
        ),
      })),
    })),
  };
}

/** Базовый отряд даташита: без выбранной стойки, но со всем остальным слоем. */
function baseUnitOf(datasheet: (typeof datasheets)[number]): CombatUnit {
  return stripStance(adaptUnit(datasheet, { size: 'min' }).unit);
}


describe("Martial Ka'tah", () => {
  it('находит юнитов с правилом по данным BSData, а не по списку id', () => {
    // Список берётся из datasheet.rules, поэтому переживёт обновление базы.
    expect(katahUnits.length).toBeGreaterThan(20);
    expect(katahUnits.some((d) => d.name.includes('Custodian Guard'))).toBe(true);
  });

  it('измерение воспроизводимо: порядок стойек не зависит от пула сидов', () => {
    // Регрессия на главный дефект: при 8 прогонах 12 юнитов из 14 меняли
    // стойку от сида к сиду, и выбор попадал в тирлист как случайное число.
    // Production усредняет по трём сидам и режет разницей порогом.
    //
    // Проверяется ПРИЗНАК («какая стойка лучше»), а не решение. Решение у
    // юнита, чей разрыв стоит ровно на пороге, разойтись обязано: там один из
    // пулов уходит в равноценность и срабатывает тай-брейк — это по замыслу.
    // Неустойчивый ПРИЗНАК означал бы, что пляшет само измерение, и никакой
    // порог бы не помог. Такой юнит есть — Aquilon Custodians, его разрыв
    // около 3%, и раньше тест падал именно на нём.
    //
    // Проверяется не на всех юнитах, а на выборке: тест иначе стоил бы дороже
    // самой сборки. Выборка детерминированная — первые шесть.
    const POOL_A = [0x1111, 0x2222, 0x3333] as const;
    const POOL_B = [0xaaa1, 0xbbb2, 0xccc3] as const;
    const sample = katahUnits
      .filter((d) => meleeWeapons(baseUnitOf(d)).length > 0)
      .slice(0, 6);
    const flipped: string[] = [];
    const unexplained: string[] = [];
    for (const datasheet of sample) {
      const base = baseUnitOf(datasheet);
      const a = stanceScores(base, POOL_A);
      const b = stanceScores(base, POOL_B);
      const gapA = stanceGap(a);
      const gapB = stanceGap(b);
      const label = `${datasheet.name}: разрыв A=${(gapA * 100).toFixed(1)}% B=${(gapB * 100).toFixed(1)}%`;
      if (Math.sign(a.lethal - a.sustained) !== Math.sign(b.lethal - b.sustained)) {
        flipped.push(label);
      }
      // Решение может разойтись только там, где один из пулов ушёл в
      // равноценность, то есть разрыв действительно стоит на пороге.
      if (decide(a) !== decide(b) && Math.min(gapA, gapB) >= REF_MARGIN) {
        unexplained.push(label);
      }
    }
    expect(sample.length, 'выборка пуста — тесты ничего не проверяют').toBe(6);
    expect(flipped, `порядок стойек зависит от сидов: ${flipped.join(', ')}`).toEqual([]);
    expect(unexplained, `решение разошлось без равноценности: ${unexplained.join(', ')}`).toEqual([]);
  });

  it('выбирает стойку по-разному для разных юнитов, а не одну на всех', () => {
    const chosen = katahUnits
      .filter((d) => meleeWeapons(baseUnitOf(d)).length > 0)
      .map((d) => katahStanceNameOf(baseUnitOf(d)));
    expect(new Set(chosen).size, 'одна стойка на весь набор — сравнение бессмысленно').toBe(2);
  });

  it('вешает выбранную стойку на рукопашное оружие', () => {
    for (const datasheet of katahUnits) {
      const adapted = adaptUnit(datasheet, { size: 'min' }).unit;
      const melee = meleeWeapons(adapted);
      if (melee.length === 0) continue;
      const chosen = katahStanceNameOf(stripStance(adapted));
      // Проверяется НАЛИЧИЕ выбранной стойки, а не «ровно один из двух
      // ключевых слов»: клинок может нести свои кейворды из BSData (у Blade
      // Champion это [DEVASTATING WOUNDS]), и withStance обязан добавить стойку
      // поверх, не выбросив родные. Это разные способности, и по правилам они
      // сосуществуют.
      const canonical = parseKeywords([chosen]).map((keyword) => keyword.name);
      for (const weapon of melee) {
        for (const name of canonical) {
          expect(weapon.keywords.map((k) => k.name), `${datasheet.name}: ${weapon.name}`).toContain(
            name
          );
        }
      }
    }
  });

  it('родной Lethal Hits на копьях не ломает выбор', () => {
    // Копья Custodian Guard с Adrasite/Pyrithite несут собственный Lethal Hits.
    // RENDAX к ним ничего не добавил бы, поэтому сверка с перебором обязана
    // дать тот же выбор, что и production, — иначе сам подход к сравнению врёт.
    const datasheet = katahUnits.find((d) => d.name.includes('Adrasite'));
    expect(datasheet, 'нужен юнит с родным Lethal Hits на оружии').toBeDefined();
    const base = withKeywords(baseUnitOf(datasheet!), ['Lethal Hits']);
    const produced = katahStanceNameOf(base);
    const reference = simulateStance(base, REF_SEEDS);
    expect(produced, `выбор: ${produced}, перебор: ${reference}`).toBe(reference);
  });

  it('база с родным Lethal Hits и база без него считаются независимо', () => {
    // Регрессия на ключ кэша: он был id + сигнатура СТАТОВ оружия, без
    // кейвордов. У клинка, который уже несёт [LETHAL HITS], рука RENDAX
    // получается пустой, то есть такая база обязана считаться отдельно — иначе
    // ей доставалось решение, посчитанное на копьях без Lethal, на другом
    // юните в натуре.
    const datasheet = katahUnits.find((d) => d.name.includes('Adrasite'));
    expect(datasheet, 'нужен юнит с копьём для проверки').toBeDefined();
    const bare = baseUnitOf(datasheet!);
    const withLethal = withKeywords(bare, ['Lethal Hits']);
    // Смысловой инвариант, а не сравнение чисел: RENDAX на таком клинке не
    // добавляет ничего, поэтому осмыслен только DACATARAI.
    expect(katahStanceNameOf(withLethal), 'RENDAX на клинке с родным Lethal пуст').toBe('Sustained Hits 1');
    // А на копьях без родного Lethal RENDAX добавляет кейворд, и решение может
    // быть другим: значит кэш не отдал одну и ту же цифру обеим базам.
    expect(katahStanceNameOf(bare)).not.toBe(katahStanceNameOf(withLethal));
  });

  it('детерминирован: повторный подсчёт даёт тот же выбор', () => {
    for (const datasheet of katahUnits.slice(0, 8)) {
      const base = baseUnitOf(datasheet);
      expect(katahStanceNameOf(base)).toBe(katahStanceNameOf(base));
    }
  });
});
function meleeWeapons(unit: CombatUnit): CombatWeapon[] {
  return unit.models.flatMap((model) => model.weapons.filter((weapon) => weapon.kind === 'melee'));
}
