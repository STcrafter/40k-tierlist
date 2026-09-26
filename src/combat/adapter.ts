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

import { parseDice } from './dice.ts';
import { parseKeywords } from './keywords.ts';
import { pointsFor } from '../bsdata/points.ts';
import type {
  BsDatasheet,
  BsModelGroup,
  BsModelVariant,
  BsWargear,
  BsWeaponProfile,
} from '../bsdata/types.ts';
import type { CombatModel, CombatUnit, CombatWeapon, FnpScope } from './types.ts';

/** Как собирать отряд из ограничений даташита. */
export interface AdaptOptions {
  /** Размер отряда: минимальный ('min', по умолчанию) или максимальный ('max'). */
  size?: 'min' | 'max';
  /** Добавить необязательное снаряжение моделей (min = 0). */
  includeOptional?: boolean;
  /** Заменить одну запись choice-группы на указанный индекс. */
  choices?: Record<string, number>;
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
 * У одной записи может быть несколько профилей режима (Standard/Supercharge,
 * Frag/Krak). Это не несколько оружий: модель атакует одним выбранным режимом.
 * Для базовой оценки выбираем Standard/обычный режим, чтобы не завышать урон
 * заряженным вариантом. Если обычного режима нет, берём первый профиль.
 */
function selectWeaponProfile(item: BsWargear): BsWeaponProfile | null {
  if (item.profiles.length === 0) return null;
  const ordinary = item.profiles.find((profile) =>
    /standard|uncharged|normal|кредит/i.test(`${profile.name} ${profile.keywords.join(' ')}`)
  );
  return ordinary ?? item.profiles[0];
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
 * Эвристика: берём первые `min` записей, содержащих оружие. Какая именно
 * запись выбрана игроком, из данных не узнать, поэтому это приближение
 * (для отчёта оно даёт осмысленный порядок величин, но не точную цифру).
 */
function weaponsOf(item: BsWargear, ownerId: string, choices: Record<string, number> = {}): CombatWeapon[] {
  if (item.kind === 'roster') return [];
  const profile = selectWeaponProfile(item);
  const weapons = profile === null ? [] : [toCombatWeapon(profile, ownerId)];

  if (item.kind !== 'choice') {
    for (const child of item.nested) {
      weapons.push(...weaponsOf(child, ownerId, choices));
    }
    return weapons;
  }

  const armed = item.nested.filter((nested) => containsWeapon(nested));
  const selectedIndex = choices[item.id];
  const chosen = selectedIndex === undefined
    ? armed.slice(0, Math.max(1, item.min))
    : [armed[selectedIndex] ?? armed[0]].filter((value): value is BsWargear => value !== undefined);
  for (const choice of chosen) {
    weapons.push(...weaponsOf(choice, ownerId, choices));
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
  choices: Record<string, number> = {}
): CombatWeapon[] {
  const weapons: CombatWeapon[] = [];
  for (const item of variant.defaultWargear) {
    weapons.push(...weaponsOf(item, variant.id, choices));
  }
  if (includeOptional) {
    for (const group of variant.choiceGroups) {
      if (group.min > 0) continue;
      for (const choice of group.choices.slice(0, 1)) {
        weapons.push(...weaponsOf(choice, variant.id, choices));
      }
    }
    for (const item of variant.optionalWargear) {
      weapons.push(...weaponsOf(item, variant.id, choices));
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
    // У группы может быть min=5, а у каждого варианта min=0 (например,
    // Deathwatch Veterans). Сначала берём явные минимумы, затем добираем
    // оставшиеся модели до group.min в порядке вариантов.
    for (const variant of variants) {
      if (variant.min > 0) counts.set(variant.id, variant.min);
    }
    let remaining = 0;
    const explicitTotal = [...counts.values()].reduce((sum, value) => sum + value, 0);
    // Если варианты имеют явные минимумы, они уже описывают минимальный
    // состав (например Boyz: 6 Boy + 1 Nob, хотя группа называется 9-18).
    // Добирать до group.min в таком случае нельзя. Для наборов вроде
    // Deathwatch Veterans, где у всех вариантов min=0, group.min наоборот
    // является единственным источником размера.
    if (explicitTotal === 0) {
      remaining = Math.max(0, group.min);
    }
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
  choices: Record<string, number> = {}
): CombatModel[] {
  const profile = variant.profile;
  // Без профиля модели (или без T/W) в бою участвовать нечем — пропускаем.
  if (profile === null || count <= 0) return [];
  const toughness = parseCharacteristic(profile.toughness);
  const wounds = parseCharacteristic(profile.wounds);
  if (toughness === null || wounds === null) return [];

  const weapons = weaponsOfVariant(variant, includeOptional, choices);
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
  const unitKeywords = datasheet.keywords.map((keyword) => keyword.toUpperCase());
  // Stealth в BSData — способность, а не кейворд, но бой считает её через
  // кейворды цели, поэтому добавляем как STEALTH в список отряда.
  if (hasStealth(datasheet) && !unitKeywords.includes('STEALTH')) unitKeywords.push('STEALTH');
  const fnp = fnpOf(datasheet);
  const models: CombatModel[] = [];
  const counts = new Map<string, number>();
  for (const group of datasheet.modelGroups) {
    const allocation = allocateVariants(group.variants, group, size);
    for (const variant of group.variants) {
      const count = allocation.get(variant.id) ?? 0;
      if (count <= 0) continue;
      counts.set(variant.id, (counts.get(variant.id) ?? 0) + count);
      models.push(...expandVariant(variant, count, unitKeywords, includeOptional, fnp, choices));
    }
  }
  return {
    unit: { id: datasheet.id, name: datasheet.name, keywords: unitKeywords, models },
    counts,
    points: pointsFor(datasheet, counts).points,
  };
}

/** Рекурсивная стоимость выбранной записи снаряжения. */
function wargearCost(item: BsWargear): number {
  return item.cost + item.nested.reduce((sum, nested) => sum + wargearCost(nested), 0);
}

/**
 * Ограниченный перебор loadout-вариантов datasheet.
 *
 * Для каждой модели выбирается один вариант из каждой обязательной choice-группы.
 * Комбинации разных моделей объединяются в общий набор выборов, но число
 * вариантов ограничено: у больших отрядов иначе возникает комбинаторный взрыв.
 * Первый вариант всегда соответствует текущему дефолтному адаптеру.
 */
export function loadoutVariantsOf(
  datasheet: BsDatasheet,
  options: AdaptOptions & { limit?: number } = {}
): LoadoutCandidate[] {
  const size = options.size ?? 'min';
  const includeOptional = options.includeOptional ?? false;
  const groups = datasheet.modelGroups.flatMap((group) => group.variants).flatMap((variant) =>
    variant.defaultWargear
      .filter((item) => item.kind === 'choice' && item.min > 0)
      .map((item) => ({ variantId: variant.id, item }))
  );
  // Декартово произведение вариантов по всем choice-группам. Раньше здесь
  // перебирались только альтернативы последней группы, поэтому часть loadout-ов
  // получала неполный набор снаряжения.
  const combinations: Record<string, number>[] = [{}];
  for (const group of groups) {
    const alternatives = group.item.nested.filter((item) => containsWeapon(item));
    if (alternatives.length === 0) continue;
    const next: Record<string, number>[] = [];
    for (const current of combinations) {
      alternatives.forEach((_, index) => {
        next.push({ ...current, [group.item.id]: index });
      });
    }
    combinations.splice(0, combinations.length, ...next);
    if (combinations.length > (options.limit ?? 64)) {
      combinations.length = options.limit ?? 64;
      break;
    }
  }
  const candidates: LoadoutCandidate[] = [];
  for (const [index, choices] of combinations.entries()) {
    const adapted = adaptUnit(datasheet, { size, includeOptional, choices });
    if (adapted.unit.models.length === 0) continue;
    const extra = groups.reduce((sum, group) => {
    const selected = group.item.nested.filter((item) => containsWeapon(item))[choices[group.item.id] ?? 0];
    return sum + (selected ? wargearCost(selected) : 0);
  }, 0);
  const name = groups.length === 0
    ? 'Базовый'
    : groups
        .map((group) => group.item.nested.filter((item) => containsWeapon(item))[choices[group.item.id] ?? 0]?.name ?? '?')
        .join(' / ');
    candidates.push({
      id: `${datasheet.id}:loadout:${index}`,
      name,
      unit: adapted.unit,
      points: adapted.points + extra,
    });
  }
  return candidates;
}

