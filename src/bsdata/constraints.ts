/**
 * Ограничения и стоимости BattleScribe.
 *
 *  - `constraints` field='selections' — min/max числа выборов: сколько моделей в
 *    группе, сколько раз можно взять снаряжение. scope='parent' — относительно
 *    родителя, 'unit' — на весь отряд, 'self' — служебные счётчики (Crusade);
 *  - цена: `costs[name='pts']` + `modifiers` (field = id типа стоимости 'pts').
 *    Модификаторы описывают тиры: «если моделей больше 10, цена = 180».
 *    Отдельный вид — «increment + before»: надбавка за каждую дополнительную
 *    копию отряда в ростере (11-я редакция); сохраняется как
 *    'increment-per-unit-copy' и к цене одного экземпляра не применяется.
 */

import { asArray } from './load.ts';
import type {
  BsCostCondition,
  BsCostExpr,
  BsCostModifier,
  BsCostFormula,
} from './types.ts';
import type {
  BsConditionGroupRaw,
  BsConditionRaw,
  BsConstraintRaw,
  BsModifierRaw,
  BsSelectionNodeRaw,
} from './raw/types.ts';

export interface Limits {
  min: number;
  max: number | null;
}

/**
 * Области ограничений, которые относятся к ростеру/деталь-уровню ('Enhancements'
 * ограничен по детачу, 'force' — по армии), а не к модели или отряду.
 */
const ROSTER_SCOPES = new Set(['self', 'roster', 'force']);

/** Есть ли у узла ограничения служебных областей — признак ростерной записи. */
export function isRosterScoped(node: BsSelectionNodeRaw): boolean {
  for (const constraint of asArray(node.constraints) as BsConstraintRaw[]) {
    if (constraint.field !== 'selections') continue;
    if (ROSTER_SCOPES.has(constraint.scope ?? 'parent')) return true;
  }
  return false;
}

/**
 * Оплата не в очках ('Enhancements', 'Crusade Points', 'Blackstone Fragments'):
 * у обычного снаряжения такие стоимости нулевые, а у ростерных записей — реальные.
 */
export function hasNonPtsCost(
  node: BsSelectionNodeRaw,
  db: { meta: { ptsCostTypeId: string | null } }
): boolean {
  const ptsId = db.meta.ptsCostTypeId;
  for (const cost of asArray(node.costs)) {
    if (ptsId !== null ? cost.typeId === ptsId : cost.name === 'pts') continue;
    if (cost.name === 'pts') continue;
    if ((Number(cost.value) || 0) !== 0) return true;
  }
  return false;
}

/** min/max числа выборов для данной области (по умолчанию — относительно родителя). */
export function selectionLimits(node: BsSelectionNodeRaw, scope = 'parent'): Limits {
  let min = 0;
  let max: number | null = null;

  for (const constraint of asArray(node.constraints) as BsConstraintRaw[]) {
    if (constraint.field !== 'selections') continue;
    if ((constraint.scope ?? 'parent') !== scope) continue;
    const value = Number(constraint.value);
    if (Number.isNaN(value)) continue;
    if (constraint.type === 'min') min = Math.max(min, value);
    if (constraint.type === 'max') max = max === null ? value : Math.min(max, value);
  }

  return { min, max };
}

/** Лимит на весь отряд ('max:selections=N(unit)'), иначе null. */
export function unitWideLimit(node: BsSelectionNodeRaw): number | null {
  return selectionLimits(node, 'unit').max;
}

/** Стоимость в очках из `costs` (0, если блока нет). */
export function pointsCost(
  node: BsSelectionNodeRaw,
  db: { meta: { ptsCostTypeId: string | null } }
): number {
  const ptsId = db.meta.ptsCostTypeId;
  const cost = asArray(node.costs).find((entry) =>
    ptsId === null ? entry.name === 'pts' : entry.typeId === ptsId || entry.name === 'pts'
  );
  return cost ? Number(cost.value) || 0 : 0;
}

const COMPARE_WORDS: Record<string, string> = {
  atLeast: '>=',
  atMost: '<=',
  greaterThan: '>',
  lessThan: '<',
  equalTo: '=',
  notEqualTo: '!=',
  instanceOf: '=',
  notInstanceOf: '!=',
};

export function describeCondition(condition: BsCostCondition): string {
  const suffix = `${condition.compare} ${condition.value}`;
  if (condition.target === 'total-models') return `моделей ${suffix}`;
  if (condition.target === 'variant') return `моделей варианта ${condition.targetId} ${suffix}`;
  if (condition.target === 'group') return `моделей группы ${condition.targetId} ${suffix}`;
  return `внешние выборы (${condition.targetId ?? '?'}) ${suffix}`;
}

/**
 * Приводит условие модификатора к доменному виду.
 * `knownIds` — id групп и вариантов текущего даташита: по ним узнаём, что
 * условие говорит о моделях этого отряда, а не о внешних выборах.
 */
function mapConditionRaw(
  condition: BsConditionRaw,
  knownIds: Set<string>
): BsCostCondition {
  const compare = COMPARE_WORDS[String(condition.type)] ?? String(condition.type);
  const value = Number(condition.value) || 0;
  const field = String(condition.field ?? '');
  const childId = condition.childId ? String(condition.childId) : null;
  const scope = String(condition.scope ?? '');

  if (field === 'selections') {
    if (childId === null || childId === 'any' || childId === 'model') {
      return { target: 'total-models', targetId: null, compare, value };
    }
    if (knownIds.has(childId)) return { target: 'variant', targetId: childId, compare, value };
    return { target: 'external', targetId: childId, compare, value };
  }

  // В данных childId иногда указывает на конкретную модель без field='selections'.
  if (childId !== null && knownIds.has(childId)) {
    return { target: 'variant', targetId: childId, compare, value };
  }
  if (scope !== '' && knownIds.has(scope)) {
    return { target: 'total-models', targetId: null, compare, value };
  }
  return { target: 'external', targetId: childId ?? (scope === '' ? null : scope), compare, value };
}

/** Условия модификатора, собранные в булево дерево (группы 'and'/'or'). */
function mapExpr(
  modifier: BsModifierRaw,
  knownIds: Set<string>
): { expr: BsCostExpr; leaves: BsCostCondition[] } {
  const leaves: BsCostCondition[] = [];

  const mapCondition = (condition: BsConditionRaw): BsCostCondition => {
    const mapped = mapConditionRaw(condition, knownIds);
    leaves.push(mapped);
    return mapped;
  };

  /** Поддерево группы: её условия и вложенные группы объединяет её тип ('and'/'or'). */
  const buildGroup = (group: BsConditionGroupRaw): BsCostExpr => {
    const items: Array<BsCostExpr | BsCostCondition> = [];
    for (const condition of asArray(group.conditions)) items.push(mapCondition(condition));
    for (const nested of asArray(group.conditionGroups)) items.push(buildGroup(nested));
    for (const nested of asArray(group.localConditionGroups)) items.push(buildGroup(nested));
    return { op: String(group.type) === 'or' ? 'or' : 'and', items };
  };

  const top: Array<BsCostExpr | BsCostCondition> = [];
  for (const condition of asArray(modifier.conditions)) top.push(mapCondition(condition));
  for (const group of asArray(modifier.conditionGroups)) top.push(buildGroup(group));

  return { expr: { op: 'and', items: top }, leaves };
}

/** Есть ли в дереве условия, которые парсер не может вычислить сам. */
function hasExternal(items: Array<BsCostExpr | BsCostCondition>): boolean {
  return items.some((item) =>
    'op' in item ? hasExternal(item.items) : item.target === 'external'
  );
}

/** Текст дерева условий: 'моделей > 3 и (... или ...)', для отчёта. */
function describeExpr(node: BsCostExpr | BsCostCondition): string {
  if ('op' in node) {
    if (node.items.length === 0) return 'истина';
    const joiner = node.op === 'or' ? ' или ' : ' и ';
    const text = node.items.map(describeExpr).join(joiner);
    return node.op === 'or' && node.items.length > 1 ? `(${text})` : text;
  }
  return describeCondition(node);
}

/**
 * Поиск условия типа 'before' ('эта модель не первая') в любом месте
 * дерева условий модификатора — включая вложенные localConditionGroups.
 */
function hasBeforeCondition(groups: BsConditionGroupRaw[]): boolean {
  for (const group of groups) {
    for (const condition of asArray(group.conditions)) {
      if (condition.type === 'before') return true;
    }
    if (hasBeforeCondition(asArray(group.localConditionGroups))) return true;
  }
  return false;
}

/**
 * Паттерн «increment + before»: счётчик «выборов до текущего» в родителе.
 * Проверено по выгрузке (396 записей на корнях даташитов, ни одной на
 * апгрейдах внутри отряда): это ростерная цена за дополнительную копию отряда
 * — «2-й и 3-й Bloodcrushers дороже на 40». К одиночному отряду неприменима,
 * поэтому в цену одного даташита не включается, но сохраняется явно.
 */
export function unitCopyIncrementValue(modifier: BsModifierRaw): number | null {
  if (String(modifier.type) !== 'increment') return null;
  const flatBefore = asArray(modifier.conditions).some(
    (condition) => condition.type === 'before'
  );
  if (!flatBefore && !hasBeforeCondition(asArray(modifier.conditionGroups))) return null;
  return Number(modifier.value) || 0;
}


/**
 * Ценовая формула даташита: база из `costs` + тиры из `modifiers`.
 * `knownIds` нужен, чтобы отличить условия про модели отряда от внешних.
 * Тиры задаются модификаторами 'set' по количеству моделей (Boyz: 90 → 180
 * при размере больше 10). «+N за каждую дополнительную копию отряда в ростере»
 * (Bloodcrushers 95 + 40) — отдельный вид модификатора, к цене одного
 * экземпляра отряда не применяется.
 */
export function costFormula(
  node: BsSelectionNodeRaw,
  knownIds: Set<string>,
  db: {
    meta: { ptsCostTypeId: string | null };
  }
): BsCostFormula {
  const ptsId = db.meta.ptsCostTypeId;
  const modifiers: BsCostModifier[] = [];

  for (const modifier of asArray(node.modifiers)) {
    if (ptsId !== null && modifier.field !== ptsId) continue;

    // increment + before — ростерная цена за дополнительную копию отряда.
    const unitCopy = unitCopyIncrementValue(modifier);
    if (unitCopy !== null) {
      modifiers.push({
        type: 'increment-per-unit-copy',
        value: unitCopy,
        conditions: [],
        description: `+${unitCopy} за каждую дополнительную копию отряда в ростере`,
        uncertain: false,
      });
      continue;
    }

    const { expr, leaves } = mapExpr(modifier, knownIds);
    const value = Number(modifier.value) || 0;
    const type = String(modifier.type ?? 'set');
    const uncertain = leaves.length === 0 || hasExternal(expr.items);

    modifiers.push({
      type,
      value,
      conditions: leaves,
      expr: leaves.length > 0 ? expr : undefined,
      description:
        leaves.length === 0
          ? `${type} ${value} (без условий)`
          : `${type} ${value}, если ${describeExpr(expr)}`,
      uncertain,
    });
  }

  return { base: pointsCost(node, db), modifiers };
}