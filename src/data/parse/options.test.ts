import { describe, expect, it } from 'vitest';
import type { OptionRow } from '../raw/types.ts';
import type { WeaponGroup } from '../types/unit.ts';
import { matchScope, parseLoadoutOptions } from './options.ts';

const NAMES = [
  'Kustom Choppa',
  'Power Klaw',
  'Kustom Shoota',
  'Kombi-rokkit',
  'Kombi-skorcha',
  'Kustom Krumpa',
  'Big Skorcha',
  'Big Choppa',
  'assault bolters',
  'plasma exterminators',
  'Oversight Drone',
  'neutron blaster',
  "T'au flamer",
  'gun drone',
  'marker drone',
  'Watcher in the Dark',
  'heavy bolters',
  'autocannons',
  'lascannons',
  'Big Shoota',
];

const CATALOG: WeaponGroup[] = NAMES.map((name) => ({
  id: name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
  name,
  profiles: [],
}));

function optionRows(descriptions: string[]): OptionRow[] {
  return descriptions.map((description, index) => ({
    datasheet_id: '000000001',
    line: String(index + 1),
    button: description.startsWith('*') ? '*' : '•',
    description,
  }));
}

function parseOne(description: string) {
  return parseLoadoutOptions(
    { datasheetId: '000000001', catalog: CATALOG },
    optionRows([description])
  );
}

describe('matchScope: семейства формулировок', () => {
  const cases: Array<[string, string]> = [
    ["This model's Kustom Choppa can be replaced with 1 Power Klaw.", 'this-model'],
    ["Each of this model's shuriken catapults can be replaced with 1 flamer.", 'each-of-weapon'],
    ["2 of this model's heavy bolters can be replaced with one of the following", 'n-of-weapon'],
    ['This model can be equipped with 1 Watcher in the Dark.', 'this-model'],
    ['This unit can be equipped with 1 Watcher in the Dark.', 'unit-add'],
    [
      'Any number of models can each have their Kustom Shoota replaced with 1 Kombi-rokkit.',
      'any-number',
    ],
    [
      'All models in this unit can each have their assault bolters replaced with 1 plasma exterminators.',
      'all-models',
    ],
    [
      'For every 5 models in this unit, 1 model can have their Kustom Krumpa and Kustom Shoota replaced with 1 Big Skorcha and 1 Kustom Choppa.',
      'per-n',
    ],
    ['Up to 2 Kommando models can each be equipped with 1 Kustom Shoota.', 'up-to-n'],
    [
      'If this unit contains 10 models, one model can be equipped with demolition gear.',
      'model-add',
    ],
    ['The Vespid Strain Leader can be equipped with 1 Oversight Drone.', 'model-add'],
  ];

  it.each(cases)('%s → %s', (text, family) => {
    expect(matchScope(text)?.family).toBe(family);
  });

  it('не выдумывает семейство для нерелевантного текста', () => {
    expect(matchScope('One of the following:')).toBeNull();
  });
});

describe('buildOption на реальных формулировках датасета', () => {
  it('замена оружия модели', () => {
    const parsed = parseOne("This model's Kustom Choppa can be replaced with 1 Power Klaw.");
    expect(parsed.unparsed).toHaveLength(0);
    const option = parsed.options[0];

    expect(option.action).toBe('replace');
    expect(option.capacity).toBe(1);
    expect(option.base.map((ref) => ref.name)).toEqual(['Kustom Choppa']);
    expect(option.choices[0].weapons.map((ref) => ref.name)).toEqual(['Power Klaw']);
    expect(option.exclusive).toBe(false);
  });

  it('замена с выбором одного из списка (взаимоисключающие варианты)', () => {
    const parsed = parseOne(
      'This model’s Kustom Shoota can be replaced with one of the following:' +
        '<ul class="dsUlC"><li>1 Kombi-rokkit</li><li>1 Kombi-skorcha</li></ul>'
    );
    const option = parsed.options[0];

    expect(parsed.unparsed).toHaveLength(0);
    expect(option.exclusive).toBe(true);
    expect(option.allowDuplicates).toBe(false);
    expect(option.choices).toHaveLength(2);
    expect(option.choices.map((choice) => choice.weapons[0].groupId)).toEqual([
      'kombi rokkit',
      'kombi skorcha',
    ]);
  });

  it('«For every 5 models» — perModels и два оружия в варианте', () => {
    const parsed = parseOne(
      'For every 5 models in this unit, 1 model can have their Kustom Krumpa and Kustom Shoota ' +
        'replaced with 1 Big Skorcha and 1 Kustom Choppa.'
    );
    const option = parsed.options[0];

    expect(option.family).toBe('per-n');
    expect(option.perModels).toBe(5);
    expect(option.capacity).toBeNull();
    expect(option.base.map((ref) => ref.name)).toEqual(['Kustom Krumpa', 'Kustom Shoota']);
    expect(option.choices[0].weapons.map((ref) => ref.name)).toEqual([
      'Big Skorcha',
      'Kustom Choppa',
    ]);
  });

  it('«Up to 2 Kommando models» — лимит и имя модели', () => {
    const option = parseOne('Up to 2 Kommando models can each be equipped with 1 Kustom Shoota.')
      .options[0];

    expect(option.family).toBe('up-to-n');
    expect(option.capacity).toBe(2);
    expect(option.modelName).toBe('Kommando');
    expect(option.action).toBe('add');
    expect(option.choices[0].weapons[0].name).toBe('Kustom Shoota');
  });

  it('«up to two of the following, and can take duplicates» — не эксклюзивно', () => {
    const option = parseOne(
      'This model can be equipped with up to two of the following, and can take duplicates:' +
        '<ul style="list-style-type:circle"><li>1 gun drone</li><li>1 marker drone</li></ul>'
    ).options[0];

    expect(option.capacity).toBe(2);
    expect(option.allowDuplicates).toBe(true);
    expect(option.exclusive).toBe(false);
    expect(option.choices).toHaveLength(2);
  });

  it('«If this unit contains 10 models:<ul>…</ul>» — каждая <li> отдельная опция', () => {
    const parsed = parseOne(
      'If this unit contains 10 models:<ul style="list-style-type:circle">' +
        '<li>The Vespid Strain Leader can be equipped with 1 Oversight Drone.</li>' +
        '<li>1 Vespid Stingwing can replace its neutron blaster with 1 T’au flamer</li></ul>'
    );

    expect(parsed.unparsed).toHaveLength(0);
    expect(parsed.options).toHaveLength(2);
    expect(parsed.options.map((option) => option.minUnitModels)).toEqual([10, 10]);
    expect(parsed.options[0].action).toBe('add');
    expect(parsed.options[0].modelName).toBe('Vespid Strain Leader');
    expect(parsed.options[1].action).toBe('replace');
    expect(parsed.options[1].modelName).toBe('Vespid Stingwing');
    expect(parsed.options[1].base.map((ref) => ref.name)).toEqual(['neutron blaster']);
  });

  it('«2 of this model’s heavy bolters» — лимит и вариант с двумя стволами', () => {
    const option = parseOne(
      '2 of this model’s heavy bolters can be replaced with one of the following:' +
        '<ul style="list-style-type:circle"><li>2 autocannons</li><li>2 lascannons</li></ul>'
    ).options[0];

    expect(option.family).toBe('n-of-weapon');
    expect(option.capacity).toBe(2);
    expect(option.base[0].name).toBe('heavy bolters');
    expect(option.choices[0].weapons[0]).toEqual({
      name: 'autocannons',
      groupId: 'autocannons',
      count: 2,
    });
  });

  it('«up to 4 Big Shoota» — вместимость из текста результата', () => {
    const option = parseOne('This model can be equipped with up to 4 Big Shoota.').options[0];

    expect(option.capacity).toBe(4);
    expect(option.choices[0].weapons[0].name).toBe('Big Shoota');
  });

  it('None пропускается, ограничение цепляется к предыдущей опции', () => {
    const parsed = parseLoadoutOptions({ datasheetId: '000000001', catalog: CATALOG }, optionRows([
      'Any number of models can each have their Kustom Shoota replaced with 1 Kombi-rokkit.',
      'None',
      '* You cannot select the same weapon from this list more than once per unit.',
    ]));

    expect(parsed.skippedNone).toBe(1);
    expect(parsed.options).toHaveLength(1);
    expect(parsed.restrictions).toHaveLength(1);
    expect(parsed.options[0].duplicateLimit).toBe(1);
  });

  it('ненайденное оружие не теряется: опция создаётся, имя остаётся с groupId=null', () => {
    const option = parseOne("This model's Kustom Choppa can be replaced with 1 Unknown Blade.")
      .options[0];

    expect(option.choices[0].weapons[0].groupId).toBeNull();
    expect(option.choices[0].weapons[0].name).toBe('Unknown Blade');
  });

  it('нераспознанный текст попадает в unparsed с причиной', () => {
    const parsed = parseOne('This unit can contain a maximum of 10 models.');

    expect(parsed.options).toHaveLength(0);
    expect(parsed.unparsed).toHaveLength(1);
    expect(parsed.unparsed[0].reason).toContain('действие');
  });

  it('«Each of this model\x27s» и текст без действия не создают мусорных опций', () => {
    const each = parseOne("Each of this model's shuriken catapults can be replaced with 1 flamer.")
      .options[0];
    expect(each.family).toBe('each-of-weapon');
    expect(each.base[0].name).toBe('shuriken catapults');

    const noise = parseOne('One of the following:');

    expect(noise.options).toHaveLength(0);
    expect(noise.unparsed).toHaveLength(1);
  });
});