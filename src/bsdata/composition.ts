/**
 * Разбор состава даташита BSData: группы моделей → варианты → снаряжение.
 *
 * Как это устроено в данных (проверено на выгрузке wh40k-11e):
 *   Boyz → selectionEntryGroup '9-18 Boyz' (min 9 / max 18) → selectionEntry
 *   'Boy' (max 18 / min 6) → entryLinks 'Choppa' (min1/max1), 'Slugga' (min1/max1),
 *   'Shoota' (min1/max1 — вариант комплектации).
 *   Necron Warriors → в одной группе ДВА варианта модели: 'Warrior w/ gauss
 *   flayer' и 'Warrior w/ gauss reaper'.
 *   Intercessor Squad → 'Intercessor Sergeant' (min1/max1), 'Intercessor' (min4/max9)
 *   и 'Intercessor w/ Grenade Launcher' (max 2, лимит на отряд).
 *   Aquila Kill Team → группа 'Unit composition' со ссылками на целые отряды:
 *   такие ссылки раскрываются рекурсивно (с защитой от циклов).
 *
 * Три уровня ограничений:
 *   group.min/max   — сколько моделей группы в отряде (9-18 Boyz);
 *   variant.min/max — сколько моделей варианта (Sergeant: ровно 1);
 *   wargear.min/max — сколько раз взять снаряжение у модели (Choppa: ровно 1).
 */

import { asArray, type BsDatabase } from './load.ts';
import {
  hasNonPtsCost,
  isRosterScoped,
  pointsCost,
  selectionLimits,
  unitWideLimit,
} from './constraints.ts';
import { abilityProfileOf, modelProfileOf, weaponProfilesOf } from './profiles.ts';
import type { BsEntryLinkRaw, BsSelectionNodeRaw } from './raw/types.ts';
import type {
  BsAbility,
  BsChoiceGroup,
  BsModelGroup,
  BsModelVariant,
  BsWargear,
  BsWargearKind,
  BsWeaponProfile,
} from './types.ts';

/**
 * Определение по ссылке. Возвращаются и «группы» (узлы без поля `type`):
 * в данных на них ссылаются так же, как на записи снаряжения.
 */
function targetOf(link: BsEntryLinkRaw, db: BsDatabase): BsSelectionNodeRaw | null {
  const target = db.definition(link.targetId);
  if (!target || typeof target !== 'object') return null;
  if ('name' in target || 'selectionEntries' in target || 'entryLinks' in target) {
    return target as BsSelectionNodeRaw;
  }
  return null;
}

const isHidden = (node: { hidden?: boolean }): boolean => node.hidden === true;

/** Объединяет ограничения ссылки и определения: ссылка задаёт контекст даташита. */
function mergedLimits(
  link: BsEntryLinkRaw,
  target: BsSelectionNodeRaw
): { min: number; max: number | null; unitMax: number | null } {
  const linkLimits = selectionLimits(link);
  const ownLimits = selectionLimits(target);
  return {
    min: Math.max(linkLimits.min, ownLimits.min),
    max: linkLimits.max ?? ownLimits.max,
    unitMax: unitWideLimit(link) ?? unitWideLimit(target),
  };
}

type Visited = Set<string>;

/** Максимальная глубина разбора снаряжения (защита от зацикленных ссылок). */
const MAX_WARGEAR_DEPTH = 10;

/**
 * Служебные группы уровня ростера: они есть у каждого даташита и снаряжением
 * модели не являются (Warlord — маркер, Enhancements — апгрейды детача,
 * Crusade — кампания).
 */
const ROSTER_NAMES = new Set([
  'Warlord',
  'Enhancements',
  'Enhancements - Upgrades',
  'Crusade',
  'Weapon Upgrades',
]);

/** Ростерная запись: оплата не в очках, служебная область ограничений или имя. */
function isRosterNode(node: BsSelectionNodeRaw, db: BsDatabase): boolean {
  return (
    hasNonPtsCost(node, db) || isRosterScoped(node) || ROSTER_NAMES.has(String(node.name ?? ''))
  );
}

/** Есть ли в поддереве оружие с боевым профилем. */
function containsWeapon(items: BsWargear[]): boolean {
  return items.some((item) => item.kind === 'weapon' || containsWeapon(item.nested));
}

/**
 * Заход в поддерево определения: расширенный набор посещённых id либо null,
 * если сюда уже заходили (в данных встречаются циклические ссылки).
 */
function enter(node: BsSelectionNodeRaw, visited: Visited): Visited | null {
  if (node.id === undefined) return new Set(visited);
  const id = String(node.id);
  if (visited.has(id)) return null;
  return new Set(visited).add(id);
}

/**
 * Содержимое узла: снаряжение, группы выбора и ростерные записи.
 *
 * Группа без ограничения `max` — не выбор, а «полка» ('Wargear'): её содержимое
 * поднимается в родителя, иначе обязательное оружие внутри такой группы терялось
 * бы. Группа с ограничением ('Kustom Choppa' {min1,max1}, 'Drones (0-2)' {max2})
 * остаётся узлом выбора kind='choice'.
 */
function contentOf(
  node: BsSelectionNodeRaw,
  db: BsDatabase,
  visited: Visited,
  depth = 0,
  rosterParent = false
): BsWargear[] {
  if (depth > MAX_WARGEAR_DEPTH) return [];
  const items: BsWargear[] = [];

  for (const child of asArray(node.selectionEntries)) {
    if (isHidden(child)) continue;
    const limits = selectionLimits(child);
    const item = buildWargear(
      child,
      { ...limits, unitMax: unitWideLimit(child) },
      db,
      visited,
      depth,
      null,
      rosterParent
    );
    if (item) items.push(item);
  }

  for (const link of asArray(node.entryLinks)) {
    if (isHidden(link)) continue;
    const target = targetOf(link, db);
    if (!target) continue;
    const limits = mergedLimits(link, target);
    // Ссылка может вести на группу ('Drones (0-2)'): ограничение max делает её
    // узлом выбора, отсутствие ограничения — «полкой» с обычными записями.
    const groupKind =
      target.type === undefined && limits.max !== null ? ('choice' as const) : null;
    const item = buildWargear(target, limits, db, visited, depth, groupKind, rosterParent);
    if (item) items.push(item);
  }

  for (const group of asArray(node.selectionEntryGroups)) {
    if (isHidden(group)) continue;
    const limits = selectionLimits(group);
    if (limits.max === null) {
      items.push(...contentOf(group, db, visited, depth + 1, rosterParent));
      continue;
    }
    const item = buildWargear(
      group,
      { ...limits, unitMax: unitWideLimit(group) },
      db,
      visited,
      depth,
      'choice',
      rosterParent
    );
    if (item) items.push(item);
  }

  return items;
}

/** Собирает запись снаряжения (или узел выбора) вместе с вложенным содержимым. */
function buildWargear(
  definition: BsSelectionNodeRaw,
  limits: { min: number; max: number | null; unitMax: number | null },
  db: BsDatabase,
  visited: Visited,
  depth: number,
  groupKind: BsWargearKind | null = null,
  rosterParent = false
): BsWargear | null {
  const entered = enter(definition, visited);
  if (entered === null) return null;

  const profiles = weaponProfilesOf(definition, db);
  // Ростерность спускается вниз: всё под 'Weapon Upgrades' — тоже кампания, а не
  // снаряжение модели. Вверх она поднимается только для «пустых» контейнеров
  // ('Mighty Champions'): если у записи есть своё оружие или оружие в поддереве,
  // вложенные апгрейды кампании не делают её ростерной.
  const rosterDown = rosterParent || isRosterNode(definition, db);
  const nested = contentOf(definition, db, entered, depth + 1, rosterDown);
  const roster =
    rosterDown ||
    (nested.length > 0 &&
      nested.every((item) => item.kind === 'roster') &&
      profiles.length === 0 &&
      !containsWeapon(nested));

  const kind: BsWargearKind = roster
    ? 'roster'
    : (groupKind ?? (profiles.length > 0 || containsWeapon(nested) ? 'weapon' : 'upgrade'));

  return {
    id: String(definition.id ?? ''),
    name: String(definition.name ?? ''),
    min: limits.min,
    max: limits.max,
    unitWideMax: limits.unitMax,
    kind,
    ability: abilityProfileOf(definition, db),
    profiles,
    cost: pointsCost(definition, db),
    nested,
  };
}

/**
 * Снаряжение узла (варианта модели): плоский список, в котором «полки» уже
 * раскрыты, обязательные предметы имеют min ≥ 1, а группы выбора — kind='choice'.
 */
export function wargearOf(
  node: BsSelectionNodeRaw,
  db: BsDatabase,
  visited: Visited = new Set()
): BsWargear[] {
  return contentOf(node, db, visited);
}

/** Все оружейные профили записи, включая вложенные в неё. */
export function weaponsOf(item: BsWargear): BsWeaponProfile[] {
  return [...item.profiles, ...item.nested.flatMap((nested) => weaponsOf(nested))];
}

/**
 * Копия снаряжения без ростерных записей (кампания, апгрейды детача, Warlord).
 * Нужна, когда нужен только боевой набор модели: в данных кампанийное поддерево
 * висит под каждым оружием и занимает больше половины объёма.
 */
export function withoutRoster(items: BsWargear[]): BsWargear[] {
  return items
    .filter((item) => item.kind !== 'roster')
    .map((item) => ({ ...item, nested: withoutRoster(item.nested) }));
}

/**
 * Способности, описанные у снаряжения ('Smoke Launchers', 'Chaff Launcher'):
 * в данных они лежат на записи снаряжения, а не на профиле юнита.
 */
export function wargearAbilitiesOf(items: BsWargear[]): BsAbility[] {
  const found: BsAbility[] = [];
  for (const item of items) {
    if (item.ability !== null && item.kind !== 'roster') {
      found.push({ name: item.name, description: item.ability, kind: 'wargear' });
    }
    found.push(...wargearAbilitiesOf(item.nested));
  }
  return found;
}

/** Проекция записи-выбора в группу выбора (для UI и отчётов). */
export function asChoiceGroup(item: BsWargear): BsChoiceGroup {
  return { id: item.id, name: item.name, min: item.min, max: item.max, choices: item.nested };
}

/** Группы выбора варианта (записи kind='choice') — проекция для UI и отчётов. */
export function choiceGroupsOf(
  node: BsSelectionNodeRaw,
  db: BsDatabase,
  visited: Visited = new Set()
): BsChoiceGroup[] {
  return wargearOf(node, db, visited)
    .filter((item) => item.kind === 'choice')
    .map(asChoiceGroup);
}

/** Максимальная глубина раскрытия вложенных контейнеров состава. */
const MAX_COMPOSITION_DEPTH = 8;

/**
 * Добавляет вариант модели в набор. Один и тот же профиль может встретиться в
 * нескольких контейнерах размера ('1 Sergeant and 9 Troopers' и
 * '1 Sergeant and 19 Troopers' ссылаются на одних моделей): ограничения
 * объединяются — min = минимум, max = максимум (null сильнее числа). Это даёт
 * корректный диапазон 'Sergeant 1-1 / Trooper 9-19' вместо дублей вариантов.
 */
function addVariant(out: Map<string, BsModelVariant>, variant: BsModelVariant): void {
  const existing = out.get(variant.id);
  if (existing === undefined) {
    out.set(variant.id, variant);
    return;
  }
  existing.min = Math.min(existing.min, variant.min);
  existing.max =
    variant.max === null || existing.max === null
      ? null
      : Math.max(existing.max, variant.max);
}

/**
 * Рекурсивно собирает варианты моделей из узла состава.
 *
 * В данных (wh40k-11e) под группой состава лежат не только модели:
 *  - «варианты размера» — записи-контейнеры ('1 Sergeant and 9 Troopers'),
 *    внутри которых ссылки на модели; тип у таких записей обычно 'upgrade';
 *  - ссылки на целые отряды (kill team собирается из готовых отрядов);
 *  - вложенные подгруппы.
 * Поэтому обходим всё поддерево (с защитой от циклов по id контейнеров),
 * собирая только узлы type='model'. Лимиты ссылки применяются к модели;
 * лимиты контейнера целиком во «флэт»-представлении не выражаются и потому
 * не переносятся на модели.
 */
function collectVariants(
  node: BsSelectionNodeRaw,
  db: BsDatabase,
  visited: Visited,
  depth: number,
  out: Map<string, BsModelVariant>,
  skipIds: Set<string> | null = null
): void {
  if (depth > MAX_COMPOSITION_DEPTH) return;

  // Защита от циклов применяется только при рекурсии: корневой узел юнита
  // на входе уже может быть в visited (modelGroupsOf засеивает его id),
  // и тогда без guard'а по глубине мы бы вышли, не собрав ни одной модели.
  const nodeId = node.id === undefined ? null : String(node.id);
  if (depth > 0 && node.type !== 'model' && nodeId !== null) {
    if (visited.has(nodeId)) return;
    if (skipIds?.has(nodeId)) return;
  }
  const inner: Visited =
    depth > 0 && node.type !== 'model' && nodeId !== null ? new Set(visited).add(nodeId) : visited;

  for (const child of asArray(node.selectionEntries)) {
    if (isHidden(child)) continue;
    if (child.type === 'model') {
      addVariant(out, buildVariant(child, selectionLimits(child), db, new Set(inner)));
      continue;
    }
    collectVariants(child, db, inner, depth + 1, out, skipIds);
  }

  for (const group of asArray(node.selectionEntryGroups)) {
    if (isHidden(group)) continue;
    collectVariants(group, db, inner, depth + 1, out, skipIds);
  }

  for (const link of asArray(node.entryLinks)) {
    if (isHidden(link)) continue;
    const target = targetOf(link, db);
    if (!target) continue;
    if (target.type === 'model') {
      const limits = mergedLimits(link, target);
      addVariant(
        out,
        buildVariant(target, { min: limits.min, max: limits.max }, db, new Set(inner))
      );
      continue;
    }
    collectVariants(target, db, inner, depth + 1, out, skipIds);
  }
}

function variantsOf(group: BsSelectionNodeRaw, db: BsDatabase, visited: Visited): BsModelVariant[] {
  const out = new Map<string, BsModelVariant>();
  collectVariants(group, db, visited, 0, out);
  return [...out.values()];
}

/**
 * Группы моделей даташита. Модели лежат либо в selectionEntryGroups (отряды),
 * либо прямо в selectionEntries/entryLinks юнита (одиночные даташиты).
 */
export function modelGroupsOf(node: BsSelectionNodeRaw, db: BsDatabase): BsModelGroup[] {
  const groups: BsModelGroup[] = [];
  const visited: Visited = new Set(node.id === undefined ? [] : [String(node.id)]);

  for (const group of asArray(node.selectionEntryGroups)) {
    if (isHidden(group)) continue;
    const variants = variantsOf(group, db, new Set(visited));
    if (variants.length === 0) continue;

    // В данных ограничения группы часто пустые ('1-2 Nobz' без constraints):
    // тогда границы берём из вариантов — иначе размер отряда «плывёт».
    const limits = selectionLimits(group);
    const min = limits.min > 0 ? limits.min : variants.reduce((sum, v) => sum + v.min, 0);
    const max =
      limits.max !== null
        ? limits.max
        : variants.every((variant) => variant.max !== null)
          ? variants.reduce((sum, variant) => sum + (variant.max ?? 0), 0)
          : null;

    groups.push({ id: String(group.id ?? ''), name: String(group.name ?? ''), min, max, variants });
  }

  // Прямые модели юнита (мимо групп). Рекурсия из корня находит и модели из
  // групп выше — их нужно исключить по id, иначе каждая модель попадёт
  // и в именованную группу, и в «прямую» (двойной учёт в размере отряда).
  const direct = variantsOf(node, db, new Set(visited));
  const claimed = new Set(
    groups.flatMap((group) => group.variants.map((variant) => variant.id))
  );
  const extra = direct.filter((variant) => !claimed.has(variant.id));
  if (extra.length > 0) {
    groups.push({
      id: `${String(node.id ?? '')}:models`,
      name: String(node.name ?? ''),
      min: extra.reduce((sum, variant) => sum + variant.min, 0),
      max: extra.every((variant) => variant.max !== null)
        ? extra.reduce((sum, variant) => sum + (variant.max ?? 0), 0)
        : null,
      variants: extra,
    });
  }

  // Одиночный даташит: сам корневой узел является моделью (Warboss, Trukk).
  if (groups.length === 0 && node.type === 'model') {
    groups.push({
      id: `${String(node.id ?? '')}:self`,
      name: String(node.name ?? ''),
      min: 1,
      max: 1,
      variants: [buildVariant(node, { min: 1, max: 1 }, db, new Set(visited))],
    });
  }

  return groups;
}

/**
 * Собирает вариант модели из узла (или цели entryLink).
 *
 * Разделение простое: min ≥ 1 — обязательное снаряжение, min = 0 — опциональное.
 * Группы выбора попадают и в общий список, и в `choiceGroups`: обязательную
 * группу тоже нужно выбрать (у Warboss — 'Kustom Choppa или Power Klaw').
 */
function buildVariant(
  node: BsSelectionNodeRaw,
  limits: { min: number; max: number | null },
  db: BsDatabase,
  visited: Visited = new Set()
): BsModelVariant {
  const wargear = wargearOf(node, db, new Set(visited));
  return {
    id: String(node.id ?? ''),
    name: String(node.name ?? ''),
    min: limits.min,
    max: limits.max,
    profile: modelProfileOf(node, db),
    defaultWargear: wargear.filter((item) => item.min >= 1),
    optionalWargear: wargear.filter((item) => item.min === 0),
    choiceGroups: wargear.filter((item) => item.kind === 'choice').map(asChoiceGroup),
  };
}
