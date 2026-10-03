/**
 * Адаптер BSData → CombatUnit.
 *
 * Даташит описывает отряд ограничениями (min/max), а не конкретным набором
 * моделей, поэтому адаптер строит «экземплярный» отряд: число моделей по
 * группам (min или max) и снаряжение по умолчанию. Выборы игрока
 * (необязательное снаряжение, конкретные варианты в choice-группах)
 * задаются опциями.
 *
 * Что учитывается: профили моделей (T/W/Sv/InSv), оружейные профили из
 * обязательного снаряжения и из групп выбора (берётся `min` первых записей),
 * кейворды оружия приводятся к канону keywords.ts. Служебные записи ростера
 * (Warlord, Enhancements, Crusade) — не снаряжение модели, они игнорируются.
 *
 * Ограничения адаптера:
 *  - размер 'max' — это максимум каждой группы отдельно (Boyz: 18 + Nobz: 2 = 20),
 *    то есть отряд может быть больше «официального» максимума одной группы;
 *  - у равнозначных choice-групп берётся первая запись;
 *  - способности (abilities) в бой не переносятся — только кейворды и профили;
 *  - вариант без профиля Unit (нет T/W) в бой не попадает: в базе BSData
 *    так лишены профиля, например, Necron Warriors.
 */

import { diceMean, parseDice } from './dice.ts';
import { parseKeywords } from './keywords.ts';
import { pointsFor } from '../bsdata/points.ts';
import { manualAbilityOf, applyAuraToModels } from '../manual/abilities.ts';
import { applyKaTah, hasMartialKatah } from '../manual/katah.ts';
import type {
  BsDatasheet,
  BsModelGroup,
  BsModelVariant,
  BsWargear,
  BsWeaponProfile,
} from '../bsdata/types.ts';
import type {
  CombatModel,
  CombatUnit,
  CombatWeapon,
  FnpScope,
  ParsedKeyword,
} from './types.ts';

/** Как собирать отряд из ограничений даташита. */
export interface AdaptOptions {
  /** Размер отряда: минимальный ('min', по умолчанию) или максимальный ('max'). */
  size?: 'min' | 'max';
  /** Добавить необязательное снаряжение моделей (min = 0). */
  includeOptional?: boolean;
  /** Заменить одну запись choice-группы на указанный индекс. */
  choices?: Record<string, number>;
  /**
   * Выбрать профиль оружия внутри записи снаряжения.
   *
   * Запись может нести несколько профилей ОДНОГО оружия: у Flash Gitz это
   * Snazzgun с тремя профилями — Cutta (S9 AP-3), Dakka (S6 AP-1) и Kill Shot
   * (S8 AP-2). Раньше из них молча брался только один «лучший», и два других
   * не появлялись нигде — ни в расчёте, ни в панели.
   *
   * Ключ — id записи снаряжения. Индекс действует отдельно для стрелковых и
   * рукопашных профилей записи. Если индекс не задан, работает прежнее правило:
   * из профилей одного вида берётся лучший, а «обычный» — при равенстве.
   */
  profileChoices?: Record<string, number>;
  /**
   * Зафиксировать вариант модели в группе: ключ — `modelGroup:<индекс группы>`,
   * значение — индекс варианта в `group.variants`.
   *
   * Нужно, потому что у части юнитов альтернативное снаряжение закодировано НЕ
   * в choice-группе, а отдельными вариантами модели: Sekhetar Robots — это
   * «2-4 Sekhetar Robot w/ pyreflux meltagun» либо «… w/ warpflame projector
   * and claw». Без этого параметра всегда брался первый вариант, и второе
   * снаряжение не появлялось нигде.
   */
  variantChoices?: Record<string, number>;
}

export interface AdaptedUnit {
  unit: CombatUnit;
  /** Сколько моделей каждого варианта (id варианта → количество). */
  counts: Map<string, number>;
  /** Очки за полученный состав (по ценовой формуле BSData). */
  points: number;
}

/** Один вариант снаряжения, пригодный для сравнения и показа в UI. */
export interface LoadoutCandidate {
  id: string;
  name: string;
  unit: CombatUnit;
  points: number;
}

/**
 * Кейворд улучшения против MONSTER/VEHICLE (Paragon Warsuits).
 *
 * Живёт на оружии, а не в отдельном поле, потому что решение «применить ли
 * его» принимается в `rules.ts` по кейвордам конкретной цели в момент броска.
 */
function withAntiBonus(
  keywords: ParsedKeyword[],
  bonus: { hits: number; wounds: number }
): ParsedKeyword[] {
  if (keywords.some((keyword) => keyword.name === 'anti-bonus')) return keywords;
  return [
    ...keywords,
    {
      name: 'anti-bonus',
      raw: `Anti-Bonus ${bonus.hits}/${bonus.wounds}`,
      value: parseDice('1'),
      target: ['MONSTER', 'VEHICLE'],
      condition: null,
    },
  ];
}

/** '5+' → 5; '3' → 3; null/'-'/'' → null. */
function parseCharacteristic(text: string | null): number | null {
  if (text === null) return null;
  const match = /^\s*(\d+)/.exec(text);
  return match ? Number(match[1]) : null;
}

/** AP: '-2' → -2, '0' → 0, '-'/null/'+' → 0. */
function parseAp(text: string | null): number {
  if (text === null) return 0;
  const match = /^\s*([+-]?\d+)/.exec(text);
  return match ? Number(match[1]) : 0;
}

/** Дальность: '12"' → 12; 'Melee'/'Touch' → null. */
function parseRange(text: string | null): number | null {
  if (text === null) return null;
  const match = /^\s*(\d+)/.exec(text);
  return match ? Number(match[1]) : null;
}

/** Есть ли в поддереве записи хоть один оружейный профиль (ростерные — нет). */
function containsWeapon(item: BsWargear): boolean {
  if (item.kind === 'roster') return false;
  if (item.profiles.length > 0) return true;
  return item.nested.some((nested) => containsWeapon(nested));
}

/**
 * Ожидаемая «ценность» профиля: среднее число атак × средний урон за атаку.
 *
 * Одних атак мало: у Cerastus shock lance «sweep» бьёт A10, но «strike» —
 * A5 с S20/AP-3, и 5×8=40 заведомо лучше, чем 10×3=30. Наоборот, у The
 * Wailing Doom A1 против A12 выигрывает именно число атак. Поэтому считаем
 * произведение — оно покрывает оба случая.
 */
function profileValue(profile: BsWeaponProfile): number {
  if (profile.attacks === null) return 0;
  const attacks = parseDice(profile.attacks);
  if (attacks === null) return 0;
  const damage = profile.damage === null ? null : parseDice(profile.damage);
  const perHit = damage === null ? 1 : diceMean(damage);
  return diceMean(attacks) * perHit;
}

/**
 * Профили режима для одной записи снаряжения — по ОДНОМУ лучшему на каждый вид.
 *
 * Запись — одно оружие, но у неё бывает НЕСКОЛЬКО профилей, и они не всегда
 * одного вида. Пример из BSData: у Abaddon «Talon of Horus» есть дальнобойный
 * профиль (Sustained Hits 1) И рукопашный (Devastating Wounds); у Cerastus
 * shock lance — дальнобойный (Assault, Sustained Hits 2) и два рукопашных
 * (strike со [LANCE] и sweep). Раньше выбор шёл по всей записи сразу, и
 * профиль второго вида ТЕРЯЛСЯ вместе со своими кейвордами: 58 таких записей,
 * из них в 39 юнитах один из видов не доезжал до боевого отряда вовсе.
 *
 * Поэтому: внутри каждого вида берётся профиль с наибольшей ожидаемой
 * ценностью, а сами виды не схлопываются. При равенстве остаётся обычный
 * режим (Standard/uncharged), чтобы поведение не менялось без нужды.
 */
function selectWeaponProfiles(item: BsWargear, profileIndex?: number): BsWeaponProfile[] {
  if (item.profiles.length === 0) return [];
  const selected: BsWeaponProfile[] = [];
  for (const kind of ['ranged', 'melee'] as const) {
    const ofKind = item.profiles.filter((profile) => profile.kind === kind);
    if (ofKind.length === 0) continue;
    const at =
      profileIndex !== undefined && ofKind.length > 1
        ? Math.min(profileIndex, ofKind.length - 1)
        : defaultProfileIndex(ofKind);
    selected.push(ofKind[at]);
  }
  return selected;
}

/**
 * Оружие одной записи снаряжения: её профили + вложенные записи.
 *
 * Главная тонкость — группа выбора (`kind: 'choice'`). Её записи взаимно
 * исключают друг друга, поэтому берётся ровно `min` записей, а не все:
 * 'Weapon 2' у Intercessor — это «одно рукопашное оружие», а не все пять.
 * При этом записи без оружия (апгрейды «Battlesuit support system»,
 * «Shield generator») пропускаются — на урон они не влияют, и иначе
 * Crisis Battlesuits остались бы вообще без оружия: первыми в группе
 * идут именно апгрейды, а стволы — дальше по списку.
 *
 * Порядок выбора приоритетен:
 *   1. явный выбор игрока (`choices`) — если он задан;
 *   2. `defaultChoiceIds` — документированное в вики BSData умолчание
 *      (`defaultSelectionEntryId`): именно эти записи BattleScribe кладёт в
 *      ростер, и в 356 группах базы это НЕ первая запись;
 *   3. иначе — эвристика «первые min записей» (BattleScribe добирает сам).
 */
function weaponsOf(
  item: BsWargear,
  ownerId: string,
  choices: Record<string, number> = {},
  profileChoices: Record<string, number> = {}
): CombatWeapon[] {
  if (item.kind === 'roster') return [];
  // Запись может нести профили ОБОИХ видов (ствол + клинок), поэтому берём
  // по одному лучшему на вид, а не один профиль на всю запись.
  const weapons = selectWeaponProfiles(item, profileChoices[item.id]).map((profile) =>
    toCombatWeapon(profile, ownerId)
  );

  if (item.kind !== 'choice') {
    for (const child of item.nested) {
      weapons.push(...weaponsOf(child, ownerId, choices, profileChoices));
    }
    return weapons;
  }

  const armed = item.nested.filter((nested) => containsWeapon(nested));
  const selectedIndex = choices[item.id];
  const chosen = selectedIndex === undefined
    ? defaultChoices(item, armed)
    : [armed[selectedIndex] ?? armed[0]].filter((value): value is BsWargear => value !== undefined);
  for (const choice of chosen) {
    weapons.push(...weaponsOf(choice, ownerId, choices, profileChoices));
  }
  return weapons;
}

/**
 * Всё оружие варианта модели.
 *
 * Обязательные группы выбора уже лежат в `defaultWargear` (у них min ≥ 1),
 * поэтому здесь берутся только опциональные группы (min = 0) — их состав
 * зависит от выбора игрока, и по умолчанию они не добавляются.
 */
function weaponsOfVariant(
  variant: BsModelVariant,
  includeOptional: boolean,
  choices: Record<string, number> = {},
  profileChoices: Record<string, number> = {}
): CombatWeapon[] {
  const weapons: CombatWeapon[] = [];
  for (const item of variant.defaultWargear) {
    weapons.push(...weaponsOf(item, variant.id, choices, profileChoices));
  }
  if (includeOptional) {
    for (const group of variant.choiceGroups) {
      if (group.min > 0) continue;
      for (const choice of group.choices.slice(0, 1)) {
        weapons.push(...weaponsOf(choice, variant.id, choices, profileChoices));
      }
    }
    for (const item of variant.optionalWargear) {
      weapons.push(...weaponsOf(item, variant.id, choices, profileChoices));
    }
  }
  return weapons;
}

/**
 * Лимит снаряжения на весь отряд ('max:selections=N(unit)'): столько моделей
 * максимум могут нести эту запись. null — ограничения нет.
 */
function unitCapOf(variant: BsModelVariant): number | null {
  let cap: number | null = null;
  const visit = (items: BsWargear[]): void => {
    for (const item of items) {
      if (item.unitWideMax !== null && item.kind !== 'roster') {
        cap = cap === null ? item.unitWideMax : Math.min(cap, item.unitWideMax);
      }
      visit(item.nested);
    }
  };
  visit([...variant.defaultWargear, ...variant.optionalWargear]);
  return cap;
}

/**
 * Раскладка моделей по вариантам внутри одной группы.
 *
 *  - 'min' — минимальный допустимый состав (минимумы вариантов);
 *  - 'max' — максимум группы, распределяемый по вариантам в порядке следования:
 *    сначала по минимуму, затем остаток добирается вариантами до их потолка.
 *    Верхняя граница варианта дополнительно режется лимитом снаряжения на отряд.
 */
function allocateVariants(
  variants: BsModelVariant[],
  group: BsModelGroup,
  size: 'min' | 'max'
): Map<string, number> {
  const counts = new Map<string, number>();
  if (size === 'min') {
    for (const variant of variants) {
      if (variant.min > 0) counts.set(variant.id, variant.min);
    }
    const explicitTotal = [...counts.values()].reduce((sum, value) => sum + value, 0);
    // Нижняя граница группы — это оба ограничения сразу: объявленный group.min
    // И сумма обязательных вариантов внутри группы. То же правило, что в
    // sizeRangeOf (bsdata/points.ts), чтобы минимальный размер считался везде
    // одинаково.
    //
    // Явные минимумы вариантов описывают СОСТАВ моделей, а не размер группы.
    // У Boyz это 6 Boy + 1 Nob, но group.min = 9, и по правилам отряд начинается
    // с 9 моделей. Раньше group.min игнорировался при непустых минимумах
    // вариантов, и отряд собирался из 7 моделей — то есть был недостроен и
    // получал доступ к меньшему набору опциональных профилей, чем заслуживал.
    // Для наборов вроде Deathwatch Veterans, где у всех вариантов min = 0,
    // group.min остаётся единственным источником размера.
    const target = Math.max(group.min > 0 ? group.min : 0, explicitTotal);
    let remaining = Math.max(0, target - explicitTotal);
    for (const variant of variants) {
      if (remaining <= 0) break;
      const current = counts.get(variant.id) ?? 0;
      const capacity = variant.max === null ? remaining : Math.max(0, variant.max - current);
      const take = Math.min(remaining, capacity);
      if (take > 0) {
        counts.set(variant.id, current + take);
        remaining -= take;
      }
    }
    return counts;
  }

  const capOf = (variant: BsModelVariant): number => {
    const cap = unitCapOf(variant);
    if (variant.max !== null) return cap === null ? variant.max : Math.min(variant.max, cap);
    return cap === null ? Number.POSITIVE_INFINITY : cap;
  };

  // У группы может не быть явного максимума — тогда берём сумму конечных
  // потолков вариантов: бесконечный потолок в расчёт не идёт, иначе пришлось бы
  // разворачивать бесконечное число моделей.
  const finiteCaps = variants
    .map((variant) => capOf(variant))
    .filter((cap) => Number.isFinite(cap));
  let remaining = group.max ?? finiteCaps.reduce((sum, cap) => sum + cap, 0);
  for (const variant of variants) {
    const cap = capOf(variant);
    const take = Math.max(0, Math.min(variant.min, remaining, cap));
    if (take <= 0) continue;
    counts.set(variant.id, take);
    remaining -= take;
  }
  for (const variant of variants) {
    if (remaining <= 0) break;
    const current = counts.get(variant.id) ?? 0;
    const take = Math.max(0, Math.min(remaining, capOf(variant) - current));
    if (take <= 0) continue;
    counts.set(variant.id, current + take);
    remaining -= take;
  }
  return counts;
}

export function toCombatWeapon(profile: BsWeaponProfile, ownerId: string): CombatWeapon {
  return {
    id: `${ownerId}:${profile.kind}:${profile.name}`,
    name: profile.name,
    kind: profile.kind,
    range: profile.kind === 'ranged' ? parseRange(profile.range) : null,
    attacks: parseDice(profile.attacks),
    skill: parseCharacteristic(profile.skill),
    strength: parseCharacteristic(profile.strength),
    ap: parseAp(profile.ap),
    damage: parseDice(profile.damage),
    keywords: parseKeywords(profile.keywords),
  };
}

/**
 * Постоянный Feel No Pain модели по текстам BSData, либо null.
 *
 * В базе встречаются три вида способности:
 *   «Feel No Pain 5+»                              → { 5, 'all' }
 *   «… 4+ Feel No Pain ability against mortal wounds» → { 4, 'mortals' }
 *   «… against psychic attacks»                    → не моделируется
 *
 * Важно: «against mortal wounds» — это ОГРАНИЧЕНИЕ области действия, а не
 * усиление. Такой FNP защищает только от мортидов и пропускает обычный урон.
 *
 * Отбрасываются временные и условные гранты, иначе модель получила бы
 * постоянный FNP, которого у неё нет:
 *   «unless it's unit is within 12" of … chaplains»  (Death Companion)
 *   «and an Objective Control characteristic of 15»  (Singular Purpose)
 *   «… ability instead», «until the end of the turn/phase»,
 *   ауры и способности, адресные «this model» другому отряду.
 */
function fnpOf(datasheet: BsDatasheet): { threshold: number; scope: FnpScope } | null {
  let best: { threshold: number; scope: FnpScope } | null = null;
  // При равном пороге 'all' сильнее ограниченного 'mortals'; более низкий
  // порог (4+ лучше 5+) — тоже сильнее.
  const consider = (threshold: number, scope: FnpScope): void => {
    if (best === null || threshold > best.threshold) {
      best = { threshold, scope };
    } else if (threshold === best.threshold && best.scope === 'mortals' && scope === 'all') {
      best = { threshold, scope };
    }
  };
  for (const item of [...datasheet.abilities, ...datasheet.rules]) {
    // Служебная пара BSData: «Feel No Pain 5+» + «Feel No Pain» с текстом
    // «This ability always takes the form **Feel No Pain X+**». Это НЕ грант
    // отряду, а расшифровка самой механики — её нельзя трактовать как
    // постоянный FNP для всех моделей.
    if (/always takes the form/i.test(item.description)) continue;
    // Порог живёт в ИМЕНИ способности («Feel No Pain 6+»), а условие
    // области — в описании, поэтому текст собираем из обоих полей.
    const text = `${item.name} ${item.description}`;
    if (!/feel\s*no\s*pain/i.test(text)) continue;
    // Отбрасываем ВРЕМЕННЫЕ и УСЛОВНЫЕ гранты: модель не должна получать
    // постоянный FNP, которого у неё нет по умолчанию.
    if (
      /\bunless\b|while |at the (start|end)|until the end|instead|this turn|each turn|for a turn|in your \w+ phase|objective control characteristic|spiritual backlash|\bbound\b|unbound|empowered|whilst |as long as |while this|each time an attack/i.test(
        text
      )
    ) {
      continue;
    }
    // «against mortal wounds» — это ОГРАНИЧЕНИЕ области (защита только от
    // мортидов), а не усиление. Псионические атаки мимо FNP в любом случае,
    // поэтому «against psychic and mortal wounds» сводится к 'mortals':
    // из двух областей мы моделируем только мортиды.
    const mentionsMortal = /\bmortal\s+wounds?\b/i.test(text);
    const mentionsPsychic = /\bpsychic\s+attacks?\b/i.test(text);
    if (mentionsPsychic && !mentionsMortal) continue;
    const scope: FnpScope = mentionsMortal ? 'mortals' : 'all';
    for (const match of text.matchAll(/feel\s*no\s*pain\s*(\d)\s*\*?\+/gi)) {
      consider(Number(match[1]), scope);
    }
  }
  return best;
}

/** Есть ли у отряда Stealth (в BSData это способность, а не кейворд даташита). */
function hasStealth(datasheet: BsDatasheet): boolean {
  if (datasheet.keywords.some((keyword) => keyword.trim().toLowerCase() === 'stealth')) return true;
  return datasheet.abilities.some((ability) => {
    const text = `${ability.name} ${ability.description}`;
    return /(^|[^\p{L}])(stealth|penumbral puppetry)([^\p{L}]|$)/iu.test(text);
  });
}

/** Развёртывает вариант в нужное число экземпляров моделей отряда. */
function expandVariant(
  variant: BsModelVariant,
  count: number,
  unitKeywords: string[],
  includeOptional: boolean,
  fnp: { threshold: number; scope: FnpScope } | null,
  choices: Record<string, number> = {},
  profileChoices: Record<string, number> = {}
): CombatModel[] {
  const profile = variant.profile;
  // Без профиля модели (или без T/W) в бою участвовать нечем — пропускаем.
  if (profile === null || count <= 0) return [];
  const toughness = parseCharacteristic(profile.toughness);
  const wounds = parseCharacteristic(profile.wounds);
  if (toughness === null || wounds === null) return [];

  const weapons = weaponsOfVariant(variant, includeOptional, choices, profileChoices);
  const models: CombatModel[] = [];
  for (let i = 0; i < count; i += 1) {
    models.push({
      id: `${variant.id}#${i}`,
      name: variant.name || profile.name,
      toughness,
      wounds,
      save: parseCharacteristic(profile.save),
      invuln: parseCharacteristic(profile.invulnerableSave),
      fnp: fnp === null ? null : fnp.threshold,
      fnpScope: fnp === null ? 'all' : fnp.scope,
      keywords: unitKeywords,
      weapons,
    });
  }
  return models;
}

/**
 * BSData-даташит → боевой отряд.
 *
 * Размер отряда собирается по группам моделей: 'min' — минимальный состав,
 * 'max' — максимум группы с учётом лимитов снаряжения на отряд. Очки считаются
 * по ценовой формуле BSData (bsdata/points.ts) для получившегося состава.
 */
export function adaptUnit(datasheet: BsDatasheet, options: AdaptOptions = {}): AdaptedUnit {
  const size = options.size ?? 'min';
  const includeOptional = options.includeOptional ?? false;
  const choices = options.choices ?? {};
  const profileChoices = options.profileChoices ?? {};
  const variantChoices = options.variantChoices ?? {};
  const unitKeywords = datasheet.keywords.map((keyword) => keyword.toUpperCase());
  // Stealth в BSData — способность, а не кейворд, но бой считает её через
  // кейворды цели, поэтому добавляем как STEALTH в список отряда.
  if (hasStealth(datasheet) && !unitKeywords.includes('STEALTH')) unitKeywords.push('STEALTH');
  const fnp = fnpOf(datasheet);
  const models: CombatModel[] = [];
  const counts = new Map<string, number>();
  for (const [index, group] of datasheet.modelGroups.entries()) {
    // Зафиксированный вариант: берём его и набираем ровно столько моделей,
    // сколько требует нижняя граница группы. Так loadout с «warpflame projector
    // and claw» имеет ту же численность, что и базовый, и они сравнимы.
    const forced = variantChoices[`modelGroup:${index}`];
    if (forced !== undefined) {
      const variant = group.variants[forced];
      if (variant === undefined) continue;
      const cap = unitCapOf(variant);
      const wanted = group.min ?? 1;
      const count = Math.max(
        0,
        Math.min(wanted, variant.max ?? wanted, group.max ?? wanted, cap ?? wanted)
      );
      if (count <= 0) continue;
      counts.set(variant.id, (counts.get(variant.id) ?? 0) + count);
      models.push(...expandVariant(variant, count, unitKeywords, includeOptional, fnp, choices, profileChoices));
      continue;
    }
    const allocation = allocateVariants(group.variants, group, size);
    for (const variant of group.variants) {
      const count = allocation.get(variant.id) ?? 0;
      if (count <= 0) continue;
      counts.set(variant.id, (counts.get(variant.id) ?? 0) + count);
      models.push(...expandVariant(variant, count, unitKeywords, includeOptional, fnp, choices, profileChoices));
    }
  }
  return {
    unit: applyManualAbilities(
      { id: datasheet.id, name: datasheet.name, keywords: unitKeywords, models },
      datasheet
    ),
    counts,
    points: pointsFor(datasheet, counts).points,
  };
}

/**
 * Накладывает ручной слой способностей (src/manual/abilities.ts) на готовый
 * боевой отряд.
 *
 * Слой применяется ПОСЛЕ сборки отряда, а не внутри expandVariant: так он
 * работает одинаково для обычного юнита и для юнита с лидером, и не требует
 * знать про ручные правила на каждом шаге построения.
 */
function applyManualAbilities(unit: CombatUnit, datasheet: BsDatasheet): CombatUnit {
  // Martial Ka'tah берётся из правил BSData, а не из ручной таблицы: набор
  // юнитов с этой способностью меняется при обновлении базы, и список id
  // пришлось бы поддерживать руками.
  //
  // Применяется в конце, на готовом отряде: стойка выбирается перебором по
  // оружию, поэтому всё, что навешено выше (Trajann с +6 атаками, Custodian
  // Guard с Lethal Hits), обязано попасть в отряд ДО выбора стойки.
  const withKaTah = (built: CombatUnit): CombatUnit =>
    hasMartialKatah(datasheet.rules) ? applyKaTah(built) : built;

  const ability = manualAbilityOf(datasheet.id);
  if (ability === null) return withKaTah(unit);

  // Аура накладывается на собственные модели лидера: способности Sororitas
  // действуют «себе и юниту», и половина (себе) достаётся тут, вторая — при
  // присоединении лидера (см. leaders.ts).
  const auraApplied =
    ability.aura === undefined
      ? { models: unit.models, keywords: unit.keywords }
      : applyAuraToModels(unit.models, ability.aura, unit.keywords);
  const models = auraApplied.models.map((model) => {
    const bonus = ability.mortalDamageBonus;
    // FNP/атаки/сейв/кейворды в рукопашной — все причины пересобрать оружие
    // и профиль. Полный список обязателен: проверка по неполному молча
    // теряла эффекты (см. регрессию с meleeMortalPerWound у Palatine).
    const needsWeapons =
      bonus !== undefined ||
      ability.meleeMortalPerWound !== undefined ||
      ability.extraAttacks !== undefined ||
      (ability.meleeWeaponKeywords ?? []).length > 0 ||
      ability.antiBonus !== undefined;
    const weapons = !needsWeapons
      ? model.weapons
      : model.weapons.map((weapon) => {
            const next = { ...weapon };
            if (bonus !== undefined) {
              // Бонус вешается только на оружие своей фазы: способность
              // Daemonifuge про стрельбу не должна висеть на клинке.
              if (bonus.phase === weapon.kind) next.mortalDamageBonus = { ...bonus };
            }
            if (ability.meleeMortalPerWound !== undefined && weapon.kind === 'melee') {
              // Palatine: мортида за обычное ранение в рукопашной, а не за
              // критическое — поэтому это отдельное поле от mortalDamageBonus.
              next.mortalPerWound = { amount: ability.meleeMortalPerWound, phase: 'melee' };
            }
            if (ability.extraAttacks !== undefined && weapon.attacks !== null) {
              // Arco-Flagellants: +2 атаки всему оружию.
              next.attacks = { ...weapon.attacks, count: weapon.attacks.count + ability.extraAttacks };
            }
            if (ability.antiBonus !== undefined) {
              // Paragon Warsuits: улучшение против монстров/техники. Переносится
              // на оружие кейвордом: условие на цель проверяется в rules.ts.
              next.keywords = withAntiBonus(next.keywords, ability.antiBonus);
            }
            if (weapon.kind === 'melee' && (ability.meleeWeaponKeywords ?? []).length > 0) {
              // Zephyrim: кейворды только на рукопашном оружии.
              const extra = parseKeywords(ability.meleeWeaponKeywords!).filter(
                (keyword) => !weapon.keywords.some((existing) => existing.name === keyword.name)
              );
              if (extra.length > 0) next.keywords = [...next.keywords, ...extra];
            }
            return next;
          });
    const next: CombatModel = { ...model, weapons };
    // FNP из ручного слоя (Arco-Flagellants, Penitent Engines): в BSData его
    // нет, он идёт от способности. Уже имеющийся FNP не ухудшается.
    if (ability.fnp !== undefined) {
      const granted = ability.fnp.value;
      next.fnp = model.fnp === null ? granted : Math.max(model.fnp, granted);
      // Область из способности важнее: 'mortals' ограничивает и не защищает.
      next.fnpScope = ability.fnp.scope ?? 'all';
    }
    if (ability.saveAtLeast !== undefined) {
      // Mortifiers: save 4+ из BSData ухудшается до 3+ (меньше = лучше).
      next.save = model.save === null ? ability.saveAtLeast : Math.min(model.save, ability.saveAtLeast);
    }
    // Регенерация задаётся отряду целиком. Воскрешение — только модели, у которой
    // оно описано: у Celestine это СВЯТАЯ, а не её спутницы. Иначе погибшая
    // Geminae Superia тоже возвращалась бы в бой.
    if (ability.regeneration !== undefined) next.regeneration = ability.regeneration;
    if (ability.resurrectOnceModels !== undefined) {
      next.resurrectOnce = (ability.resurrectOnceModels ?? []).includes(model.name);
    }
    if (ability.reviveModelPerRound !== undefined && ability.reviveModelPerRound > 0) {
      // Целитель: возврат павших моделей в присоединённый юнит. Отмечается
      // МОДЕЛЬ, а не отряд, потому что способность держится на живости
      // самого целителя: погибший Hospitaller ничего не возвращает.
      next.reviveLeader = true;
    }
    return next;
  });
  return withKaTah({ ...unit, models, keywords: auraApplied.keywords });
}

/**
 * Записи группы выбора, которые берутся по умолчанию.
 *
 * Приоритет: `defaultChoiceIds` из BSData → первые `min` записей. Первое —
 * документированный в вики способ узнать комплект юнита; в 356 группах базы
 * умолчание указывает не на первую запись, и эвристика без него молча ставила
 * не то оружие (у Aeldari — Scorpion Chainsword вместо Star Glaive).
 */
function defaultChoices(item: BsWargear, armed: BsWargear[]): BsWargear[] {
  if (armed.length === 0) return armed;
  const defaults = item.defaultChoiceIds;
  if (defaults && defaults.size > 0) {
    const byDefault = armed.filter((choice) => defaults.has(choice.id));
    if (byDefault.length > 0) {
      // Умолчание может называть меньше записей, чем требует min (BSData так
      // оформляет «1 из 2»), поэтому добираем остаток эвристикой.
      const wanted = Math.max(1, item.min);
      if (byDefault.length >= wanted) return byDefault.slice(0, wanted);
      const rest = armed.filter((choice) => !byDefault.includes(choice));
      return [...byDefault, ...rest.slice(0, wanted - byDefault.length)];
    }
  }
  return armed.slice(0, Math.max(1, item.min));
}

/** Рекурсивная стоимость выбранной записи снаряжения. */
function wargearCost(item: BsWargear): number {
  return item.cost + item.nested.reduce((sum, nested) => sum + wargearCost(nested), 0);
}

/**
 * Варианты модели закодированы как АЛЬТЕРНАТИВЫ, если у всех вариантов группы
 * совпадает имя профиля модели: это одна и та же модель с разным снаряжением
 * («Robot w/ pyreflux meltagun» / «Robot w/ warpflame projector and claw»).
 *
 * Если имена профилей различаются, варианты — разные РОЛИ в отряде (сержант и
 * боец, отдельные типы оружейных отделений), и перебирать их как loadout
 * бессмысленно: в отряде они сосуществуют, а не заменяют друг друга.
 */
function alternativeVariantGroups(datasheet: BsDatasheet): number[] {
  const result: number[] = [];
  datasheet.modelGroups.forEach((group, index) => {
    if (group.variants.length < 2) return;
    const names = new Set(group.variants.map((variant) => variant.profile?.name ?? variant.name));
    if (names.size !== 1) return;
    // Если все варианты несут одно и то же оружие — выбирать нечего.
    const signatures = new Set(
      group.variants.map((variant) => weaponSignatureOf(variant).join('|'))
    );
    if (signatures.size < 2) return;
    result.push(index);
  });
  return result;
}

/** Подпись оружия варианта — чтобы отличить «разные стволы» от «одних и тех же». */
function weaponSignatureOf(variant: BsModelVariant): string[] {
  const names: string[] = [];
  const collect = (items: BsWargear[]): void => {
    for (const item of items) {
      for (const profile of item.profiles) names.push(profile.name);
      collect(item.nested);
    }
  };
  collect(variant.defaultWargear);
  return names.sort();
}

/**
 * Имя первого оружия варианта — запасная подпись для вариантов без имени.
 *
 * Нужна немногим юнитам (Sekhetar Robots, «w/ warpflame projector and claw»),
 * где ни у варианта, ни у профиля имени нет, а различать сборки приходится
 * именно по оружию.
 */
function firstWeaponNameOf(variant: BsModelVariant): string | null {
  for (const item of [...variant.defaultWargear, ...variant.optionalWargear]) {
    const weapon = item.profiles.find((profile) => profile.kind === 'ranged' || profile.kind === 'melee');
    if (weapon) return weapon.name;
  }
  return null;
}

/**
 * Боевой отпечаток отряда: что реально влияет на бой.
 *
 * Название оружия в отпечаток НЕ входит намеренно. В базе много вариантов,
 * различающихся только именем при одинаковых характеристиках, и такие
 * loadout'ы считаются отдельно впустую: на 128 перечисленных вариантах
 * боевых профилей меньше пяти.
 *
 * Отпечаток используется и для отбрасывания дублирующих loadout'ов, и как
 * ключ кеша замеров в perRound: сид там зависит только от цели, поэтому
 * одинаковый отпечаток означает буквально те же числа и повторный расчёт не
 * нужен.
 */
export function combatFingerprintOf(unit: CombatUnit): string {
  const weaponFingerprint = (weapon: CombatWeapon): unknown[] => [
    weapon.kind,
    weapon.range,
    weapon.attacks,
    weapon.skill,
    weapon.strength,
    weapon.ap,
    weapon.damage,
    weapon.keywords.map((keyword) => keyword.name).sort(),
  ];
  return JSON.stringify({
    keywords: [...unit.keywords].sort(),
    models: unit.models.map((model) => [
      model.toughness,
      model.wounds,
      model.save,
      model.invuln,
      model.fnp,
      model.fnpScope,
      model.weapons.map(weaponFingerprint).sort(),
    ]),
  });
}

/**
 * Индекс профиля, который берётся по умолчанию, в списке профилей одного вида.
 *
 * Единый источник правды для `selectWeaponProfiles` и для подписей loadout'ов:
 * раньше подпись считалась по нулевому индексу, а оружие выбиралось по
 * «лучшему», и у Flash Gitz сборка с Cutta подписывалась именем Cutta, а
 * стреляла из Dakka.
 */
function defaultProfileIndex(ofKind: BsWeaponProfile[]): number {
  if (ofKind.length === 0) return 0;
  const ordinary = ofKind.findIndex((profile) =>
    /standard|uncharged|normal|кредит/i.test(`${profile.name} ${profile.keywords.join(' ')}`)
  );
  let best = ordinary >= 0 ? ordinary : 0;
  let bestValue = profileValue(ofKind[best]);
  for (let index = 0; index < ofKind.length; index += 1) {
    const value = profileValue(ofKind[index]);
    if (value > bestValue) {
      best = index;
      bestValue = value;
    }
  }
  return best;
}

/** Сколько вариантов профиля перебирается у записи: больше всех профилей одного вида. */
function profileAlternativeCount(item: BsWargear): number {
  let count = 0;
  for (const kind of ['ranged', 'melee'] as const) {
    count = Math.max(count, item.profiles.filter((profile) => profile.kind === kind).length);
  }
  return count;
}

/**
 * Индекс профиля по умолчанию для записи — тот, что встанет в базовую сборку.
 *
 * Берётся первый вид, у которого больше одного профиля, чтобы совпадать с
 * `profileLabelOf`. -1 означает «перебирать нечего».
 */
function defaultProfileIndexOfItem(item: BsWargear): number {
  for (const kind of ['ranged', 'melee'] as const) {
    const ofKind = item.profiles.filter((profile) => profile.kind === kind);
    if (ofKind.length >= 2) return defaultProfileIndex(ofKind);
  }
  return -1;
}

/**
 * Подпись выбранного профиля оружия внутри записи снаряжения.
 *
 * Индекс выбирается по той же схеме, что и в `selectWeaponProfiles`: отдельно
 * для стрелковых и рукопашных профилей. Берётся тот вид, где альтернатив
 * больше одного. Если индекс не задан, подписывается профиль по умолчанию —
 * иначе имя разошлось бы с реально выбранным оружием.
 */
function profileLabelOf(item: BsWargear, index?: number): string | null {
  for (const kind of ['ranged', 'melee'] as const) {
    const ofKind = item.profiles.filter((profile) => profile.kind === kind);
    if (ofKind.length < 2) continue;
    const at = index === undefined ? defaultProfileIndex(ofKind) : Math.min(index, ofKind.length - 1);
    return ofKind[at].name;
  }
  return null;
}

/**
 * Ограниченный перебор loadout-вариантов datasheet.
 *
 * Перебираются ТРИ вида альтернатив:
 *   1. choice-группы в снаряжении («Blast / Cleave»);
 *   2. варианты МОДЕЛИ, если группа имитирует одну модель с разным снаряжением;
 *   3. профили ОДНОГО оружия внутри записи снаряжения.
 *
 * Пункт 2 добавлен после разбора Sekhetar Robots: там альтернативное оружие
 * лежит не в choice-группе, а в отдельных вариантах модели, поэтому перебор
 * видел только первый вариант и всегда выдавал «Базовый».
 *
 * Пункт 3 добавлен после разбора Flash Gitz: у них Snazzgun — одна запись
 * снаряжения с тремя профилями (Cutta / Dakka / Kill Shot). Такая запись не
 * choice-группа, поэтому перебор её не видел и в панели оставался только
 * профиль по умолчанию — выглядело так, будто стрелять можно только «катером».
 *
 * Комбинации объединяются в общий набор выборов, но их число ограничено: у
 * больших отрядов иначе возникает комбинаторный взрыв. Первый вариант всегда
 * соответствует текущему дефолтному адаптеру.
 */
export function loadoutVariantsOf(
  datasheet: BsDatasheet,
  options: AdaptOptions & { limit?: number } = {}
): LoadoutCandidate[] {
  const size = options.size ?? 'min';
  const includeOptional = options.includeOptional ?? false;
  const limit = options.limit ?? 64;
  const variantGroupIndexes = alternativeVariantGroups(datasheet);
  const groups = datasheet.modelGroups.flatMap((group) => group.variants).flatMap((variant) =>
    variant.defaultWargear
      .filter((item) => item.kind === 'choice' && item.min > 0)
      .map((item) => ({ variantId: variant.id, item }))
  );
  // Декартово произведение вариантов по всем choice-группам. Раньше здесь
  // перебирались только альтернативы последней группы, поэтому часть loadout-ов
  // получала неполный набор снаряжения.
  interface Combo {
    choices: Record<string, number>;
    variants: Record<string, number>;
    profiles: Record<string, number>;
  }
  /**
   * Записи с несколькими профилями ОДНОГО вида оружия — третье измерение.
   *
   * Берём только записи, у которых профилей одного вида больше одного: у
   * Flash Gitz это Snazzgun (3 стрелковых профиля), тогда как записи вида
   * «ствол + клинок» имеют по одному профилю каждого вида и перебору не
   * подлежат — там и раньше правильно брался лучший профиль на вид.
   */
  const profileItems = datasheet.modelGroups
    .flatMap((group) => group.variants)
    .flatMap((variant) => variant.defaultWargear)
    .filter((item) => {
      if (item.profiles.length < 2) return false;
      const ranged = item.profiles.filter((profile) => profile.kind === 'ranged').length;
      const melee = item.profiles.filter((profile) => profile.kind === 'melee').length;
      return ranged > 1 || melee > 1;
    });
  /**
   * Записи с ОДИНАКОВЫМ набором профилей — одно измерение перебора.
   *
   * У Flash Gitz Snazzgun есть и у модели, и у Kaptin'а: это две записи с
   * одинаковыми альтернативами, и перебирать их надо ВМЕСТЕ. Раздельный перебор
   * даёт 3×3 = 9 комбинаций вместо трёх, причём четыре из них — мусорные
   * копии (у модели Cutta, у Kaptin'а Dakka), которые выглядели бы как
   * несуществующие сборки. Индекс применяется ко всем записям группы сразу.
   */
  const profileGroups: BsWargear[][] = [];
  for (const item of profileItems) {
    const key = item.profiles.map((profile) => profile.name).join('|');
    const existing = profileGroups.find(
      (group) => group[0].profiles.map((profile) => profile.name).join('|') === key
    );
    if (existing) existing.push(item);
    else profileGroups.push([item]);
  }
  const combinations: Combo[] = [{ choices: {}, variants: {}, profiles: {} }];
  for (const group of groups) {
    const alternatives = group.item.nested.filter((item) => containsWeapon(item));
    if (alternatives.length === 0) continue;
    const next: Combo[] = [];
    for (const current of combinations) {
      alternatives.forEach((_, index) => {
        next.push({
          choices: { ...current.choices, [group.item.id]: index },
          variants: current.variants,
          profiles: current.profiles,
        });
      });
    }
    combinations.splice(0, combinations.length, ...next);
    if (combinations.length > limit) {
      combinations.length = limit;
      break;
    }
  }
  // Второе измерение: альтернативные варианты МОДЕЛИ. Вариант 0 — базовый,
  // поэтому комбинации с ним уже есть и повторно не добавляются.
  for (const groupIndex of variantGroupIndexes) {
    const variantCount = datasheet.modelGroups[groupIndex]?.variants.length ?? 0;
    if (variantCount < 2) continue;
    const base = combinations.slice();
    for (let variantIndex = 1; variantIndex < variantCount; variantIndex += 1) {
      for (const current of base) {
        combinations.push({
          choices: { ...current.choices },
          variants: { ...current.variants, [`modelGroup:${groupIndex}`]: variantIndex },
          profiles: { ...current.profiles },
        });
      }
    }
    if (combinations.length > limit) {
      combinations.length = limit;
      break;
    }
  }
  // Третье измерение: профили одного оружия внутри записи.
  //
  // Пропускается индекс, который и так стоит в базовой сборке. Это не обязательно
  // нулевой: у Snazzgun профили идут [Cutta, Dakka, Kill Shot], а по умолчанию
  // берётся Dakka. Если пропускать нулевой, Cutta не перебирался бы никогда —
  // ровно тот случай, который заметил пользователь.
  for (const groupItems of profileGroups) {
    const representative = groupItems[0];
    const count = profileAlternativeCount(representative);
    if (count < 2) continue;
    const skip = defaultProfileIndexOfItem(representative);
    const base = combinations.slice();
    for (let index = 0; index < count; index += 1) {
      if (index === skip) continue;
      for (const current of base) {
        const profileChoices: Record<string, number> = {};
        // Индекс ставится ВСЕМ записям группы: иначе у Kaptin'а остался бы
        // профиль по умолчанию, и появились бы сборки, которых в игре нет.
        for (const item of groupItems) profileChoices[item.id] = index;
        combinations.push({
          choices: { ...current.choices },
          variants: { ...current.variants },
          profiles: { ...current.profiles, ...profileChoices },
        });
      }
    }
    if (combinations.length > limit) {
      combinations.length = limit;
      break;
    }
  }
  const candidates: LoadoutCandidate[] = [];
  for (const [index, combo] of combinations.entries()) {
    const { choices, variants, profiles } = combo;
    const adapted = adaptUnit(datasheet, {
      size,
      includeOptional,
      choices,
      variantChoices: variants,
      profileChoices: profiles,
    });
    if (adapted.unit.models.length === 0) continue;
    const extra = groups.reduce((sum, group) => {
    const selected = group.item.nested.filter((item) => containsWeapon(item))[choices[group.item.id] ?? 0];
    return sum + (selected ? wargearCost(selected) : 0);
  }, 0);
  const parts: string[] = [];
  // Имя варианта модели идёт первым: у Sekhetar Robots именно по нему видно,
  // что отряд вооружён «w/ warpflame projector and claw», а не «Базовый».
  for (const groupIndex of variantGroupIndexes) {
    const variant = datasheet.modelGroups[groupIndex]?.variants[variants[`modelGroup:${groupIndex}`] ?? 0];
    // У части вариантов модели нет ни имени, ни имени профиля — у Sekhetar
    // Robots это «w/ warpflame projector and claw». Заглушка '?' в названии
    // ничего не сообщает, поэтому берём имя оружия варианта.
    if (variant) parts.push(variant.name || variant.profile?.name || firstWeaponNameOf(variant) || 'Без названия');
  }
  for (const group of groups) {
    const chosen = group.item.nested.filter((item) => containsWeapon(item))[choices[group.item.id] ?? 0];
    parts.push(chosen?.name ?? 'Базовый вариант');
  }
  // Имя выбранного профиля оружия: иначе у Flash Gitz все три сборки с
  // Cutta / Dakka / Kill Shot подписались бы одинаково.
  for (const groupItems of profileGroups) {
    const label = profileLabelOf(groupItems[0], profiles[groupItems[0].id]);
    if (label) parts.push(label);
  }
  const name = parts.length === 0 ? 'Базовый' : [...new Set(parts)].join(' / ');
    candidates.push({
      id: `${datasheet.id}:loadout:${index}`,
      name,
      unit: adapted.unit,
      points: adapted.points + extra,
    });
  }
  return candidates;
}

