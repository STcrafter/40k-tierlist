/**
 * Расчёт очков и размеров отряда по ценовой формуле BSData.
 *
 * Формула: база (`costs.pts`) + модификаторы-тиры. Пример Boyz:
 *   base 90; modifier {set 180, если моделей > 10} → 10 моделей = 90, 20 = 180.
 * Пример Intercessor Squad: base 80; {set 150, если моделей группы ≥ 6}.
 * Ростерная цена 11-й редакции: `increment-per-unit-copy` — «+N за каждую
 * дополнительную копию отряда в армии» (Bloodcrushers 95 + 40); к цене одного
 * экземпляра отряда не применяется и в расчёт не включается.
 *
 * Условия, которые относятся к внешним выборам (например, «в ростере есть
 * Incursion»), помечены как uncertain: цена по такой формуле не считается —
 * лучше явный пропуск, чем неверная цифра.
 */

import type { BsCostCondition, BsCostExpr, BsDatasheet } from './types.ts';

/** Соответствует ли счётчик условию. */
function matches(condition: BsCostCondition, counts: Map<string, number>, total: number): boolean {
  if (condition.target === 'external') return false;
  const actual =
    condition.target === 'total-models'
      ? total
      : counts.get(condition.targetId ?? '') ?? 0;

  switch (condition.compare) {
    case '>=':
      return actual >= condition.value;
    case '<=':
      return actual <= condition.value;
    case '>':
      return actual > condition.value;
    case '<':
      return actual < condition.value;
    case '=':
      return actual === condition.value;
    case '!=':
      return actual !== condition.value;
    default:
      return false;
  }
}

/** Вычисление булева дерева условий по составу отряда. */
function evalExpr(node: BsCostExpr | BsCostCondition, counts: Map<string, number>, total: number): boolean {
  if ('op' in node) {
    if (node.items.length === 0) return true;
    if (node.op === 'or') return node.items.some((item) => evalExpr(item, counts, total));
    return node.items.every((item) => evalExpr(item, counts, total));
  }
  return matches(node, counts, total);
}

export interface PointsResult {
  points: number;
  /** Модификаторы, которые не удалось применить (внешние условия). */
  uncertain: string[];
}

/**
 * Очки за отряд указанного состава.
 * @param counts число моделей по каждому варианту (id варианта → количество)
 */
export function pointsFor(datasheet: BsDatasheet, counts: Map<string, number>): PointsResult {
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
  let points = datasheet.cost.base;
  const uncertain: string[] = [];

  for (const modifier of datasheet.cost.modifiers) {
    if (modifier.uncertain) {
      uncertain.push(modifier.description);
      continue;
    }
    const pass = modifier.expr
      ? evalExpr(modifier.expr, counts, total)
      : modifier.conditions.every((condition) => matches(condition, counts, total));
    if (!pass) continue;

    if (modifier.type === 'set') points = modifier.value;
    else if (modifier.type === 'increment') points += modifier.value;
    else if (modifier.type === 'decrement') points -= modifier.value;
    else if (modifier.type === 'multiply') points *= modifier.value;
    // 'increment-per-unit-copy' — ростерная цена за дополнительную копию
    // отряда; к цене одного экземпляра даташита не применяется (пропуск).
  }

  return { points, uncertain };
}

/** Очки за «базовый» размер отряда: минимумы состава по каждой группе. */
export function pointsForMinimumSize(datasheet: BsDatasheet): number {
  const counts = new Map<string, number>();
  for (const group of datasheet.modelGroups) {
    for (const variant of group.variants) {
      if (variant.min > 0) counts.set(variant.id, variant.min);
    }
  }
  if (counts.size === 0 && datasheet.variants.length > 0) {
    counts.set(datasheet.variants[0].id, 1);
  }
  return pointsFor(datasheet, counts).points;
}

export interface SizeRange {
  min: number;
  max: number | null;
}

/** Допустимый размер отряда по ограничениям групп (минимумы/максимумы моделей). */
export function sizeRangeOf(datasheet: BsDatasheet): SizeRange {
  let min = 0;
  let max: number | null = 0;

  for (const group of datasheet.modelGroups) {
    const groupMin = group.min > 0 ? group.min : group.variants.reduce((sum, v) => sum + v.min, 0);
    min += groupMin;
    if (max === null || group.max === null) {
      max = null;
    } else {
      max += group.max;
    }
  }

  return { min, max };
}

export interface SizeTier {
  models: number;
  points: number;
  /** Откуда взят размер: минимум состава или тир цены. */
  source: 'minimum' | 'tier';
}

/**
 * Вероятные «официальные» размеры отряда: минимальный размер плюс пороги
 * из ценовых тиров (для Boyz: 10 и 20 → 90 и 180 очков).
 */
export function sizeTiersOf(datasheet: BsDatasheet): SizeTier[] {
  const range = sizeRangeOf(datasheet);
  const sizes = new Set<number>([range.min]);
  if (range.max !== null) sizes.add(range.max);

  for (const modifier of datasheet.cost.modifiers) {
    if (modifier.uncertain) continue;
    for (const condition of modifier.conditions) {
      if (condition.target !== 'total-models') continue;
      // 'больше 10' → следующий возможный размер 11, но официальным тиром
      // обычно является максимум состава; добавляем оба варианта.
      if (condition.compare === '>') sizes.add(condition.value + 1);
      if (condition.compare === '>=') sizes.add(Math.max(condition.value, 1));
    }
  }

  const tiers: SizeTier[] = [];
  for (const models of [...sizes].sort((a, b) => a - b)) {
    if (models < range.min) continue;
    if (range.max !== null && models > range.max) continue;

    // Раскладываем модели по вариантам: сначала минимумы, затем остаток.
    const counts = new Map<string, number>();
    let remaining = models;
    const ordered = datasheet.modelGroups.flatMap((group) => group.variants);

    for (const variant of ordered) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, variant.min);
      if (take > 0) {
        counts.set(variant.id, take);
        remaining -= take;
      }
    }
    for (const variant of ordered) {
      if (remaining <= 0) break;
      const current = counts.get(variant.id) ?? 0;
      const capacity = variant.max === null ? remaining : variant.max - current;
      const take = Math.max(0, Math.min(remaining, capacity));
      if (take > 0) {
        counts.set(variant.id, current + take);
        remaining -= take;
      }
    }

    tiers.push({
      models,
      points: pointsFor(datasheet, counts).points,
      source: models === range.min ? 'minimum' : 'tier',
    });
  }

  return tiers;
}