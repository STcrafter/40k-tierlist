import { describe, expect, it } from 'vitest';
import {
  diceMean,
  parseArmourPenetration,
  parseDice,
  parseFlag,
  parseMovement,
  parseRange,
  parseRangeBounds,
  parseSave,
} from './numbers.ts';
import { matchByName, nameVariants, scoreNameMatch, singularize } from './match.ts';
import { cleanText, parseCountWord, slug, splitListItems, stripDashTail } from './text.ts';

describe('parseDice', () => {
  it('разбирает плоские значения и дайсы (реальные значения датасета)', () => {
    expect(parseDice('3')).toEqual({ kind: 'flat', value: 3 });
    expect(parseDice('2D3')).toEqual({ kind: 'dice', count: 2, sides: 3, modifier: 0 });
    expect(parseDice('D6')).toEqual({ kind: 'dice', count: 1, sides: 6, modifier: 0 });
    expect(parseDice('D6+3')).toEqual({ kind: 'dice', count: 1, sides: 6, modifier: 3 });
    expect(parseDice('2D6+6 ')).toEqual({ kind: 'dice', count: 2, sides: 6, modifier: 6 });
    expect(parseDice('D3+1')).toEqual({ kind: 'dice', count: 1, sides: 3, modifier: 1 });
  });

  it('возвращает null для мусора вместо выдуманного значения', () => {
    expect(parseDice('')).toBeNull();
    expect(parseDice('-')).toBeNull();
    expect(parseDice('N/A')).toBeNull();
    expect(parseDice('D')).toBeNull();
  });

  it('считает среднее', () => {
    expect(diceMean({ kind: 'flat', value: 4 })).toBe(4);
    expect(diceMean({ kind: 'dice', count: 2, sides: 6, modifier: 6 })).toBe(13);
    expect(diceMean(null)).toBeNull();
  });
});

describe('характеристики', () => {
  it('parseSave / parseMovement / parseRange / parseArmourPenetration', () => {
    expect(parseSave('3+')).toBe(3);
    expect(parseSave('7+')).toBe(7);
    expect(parseSave('-')).toBeNull();
    expect(parseSave('N/A')).toBeNull();

    expect(parseMovement('6"')).toBe(6);
    expect(parseMovement('-')).toBeNull();
    expect(parseMovement('20+"')).toBe(20);

    expect(parseRange('Melee')).toEqual({ kind: 'melee' });
    expect(parseRange('24"')).toEqual({ kind: 'ranged', inches: 24 });
    expect(parseRange('N/A')).toBeNull();
    expect(parseRange('')).toBeNull();

    expect(parseArmourPenetration('')).toBe(0);
    expect(parseArmourPenetration('-2')).toBe(-2);
    expect(parseArmourPenetration('+1')).toBe(1);
  });

  it('parseFlag и parseRangeBounds', () => {
    expect(parseFlag('true')).toBe(true);
    expect(parseFlag('false')).toBe(false);
    expect(parseFlag('')).toBe(false);

    expect(parseRangeBounds('1-5')).toEqual({ from: 1, to: 5 });
    expect(parseRangeBounds('3')).toEqual({ from: 3, to: 3 });
    expect(parseRangeBounds('')).toEqual({ from: null, to: null });
  });
});

describe('текстовые хелперы', () => {
  it('cleanText убирает HTML и нормализует типографику', () => {
    expect(cleanText('<b>This model’s</b> Kustom Choppa&nbsp;can be replaced.')).toBe(
      "This model's Kustom Choppa can be replaced."
    );
  });

  it('slug / stripDashTail / parseCountWord / splitListItems', () => {
    expect(slug('Burna Boyz')).toBe('burna boyz');
    expect(stripDashTail('1 Kaptin Badrukk – EPIC HERO')).toBe('1 Kaptin Badrukk');
    expect(parseCountWord('two')).toBe(2);
    expect(parseCountWord('3')).toBe(3);
    expect(parseCountWord('many')).toBeNull();
    expect(splitListItems('1 flamer and 1 close combat weapon')).toEqual([
      '1 flamer',
      '1 close combat weapon',
    ]);
  });
});

describe('сопоставление имён', () => {
  it('singularize и nameVariants', () => {
    expect(singularize('spanners')).toBe('spanner');
    expect(singularize('lootas')).toBe('loota');
    expect(singularize('grot tanks')).toBe('grot tank');
    expect(nameVariants('Burna Boyz')).toContain('burna boy');
  });

  it('scoreNameMatch покрывает реальные пары из датасета', () => {
    expect(scoreNameMatch('1-2 Spanners', 'Spanner')).toBeGreaterThan(0.9);
    expect(scoreNameMatch('9-18 Boy models', 'Boy')).toBeGreaterThan(0.9);
    expect(scoreNameMatch('4-8 Burna Boyz', 'Burna Boy')).toBeGreaterThan(0.9);
    expect(scoreNameMatch('1 Venerable Land Raider', 'Venerable Land Raider')).toBe(1);
    expect(scoreNameMatch('Nob', 'Boy')).toBeLessThan(0.5);
  });

  it('matchByName не угадывает при неоднозначности', () => {
    const models = [{ name: 'Nob' }, { name: 'Boy' }];
    expect(matchByName('Nob', models, (m) => m.name)?.item.name).toBe('Nob');
    expect(matchByName('Deffkopta', models, (m) => m.name)).toBeNull();
  });
});
