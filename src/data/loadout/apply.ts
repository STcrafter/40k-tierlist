/**
 * Применение выбора игрока к базовой комплектации.
 *
 * Терминология (важно для понимания чисел):
 *  - `perModel` в базовой комплектации — сколько стволов на одну модель;
 *  - `count` — сколько стволов во всём отряде; после применения опций
 *    `perModel` пересчитывается как count / число моделей носителя, то есть
 *    становится средним (например, 2 из 5 моделей поменяли оружие → 0.4 на модель);
 *  - `LoadoutSelection.count` — сколько раз применяется вариант: для опций по
 *    моделям это число моделей, для weapon-scope опций ('Each of this model's…',
 *    '2 of this model's…') — число замен.
 */

import { matchByName } from '../normalize/match.ts';
import { splitModelCounts } from '../parse/composition.ts';
import type { LoadoutEntry, LoadoutOption, LoadoutSelection } from '../types/loadout.ts';
import type { ModelGroup, Unit } from '../types/unit.ts';

export interface AppliedLoadout {
  size: number;
  /** Сколько моделей каждой группы при данном размере отряда. */
  groupCounts: number[];
  entries: LoadoutEntry[];
  /** Опции, недоступные при данном размере/составе. */
  unavailableOptionIds: string[];
  issues: string[];
}

function groupIndexOf(unit: Unit, modelGroupId: string | null): number {
  if (!modelGroupId) return -1;
  return unit.modelGroups.findIndex((group) => group.id === modelGroupId);
}

/** Группа моделей, к которой относится опция (null — опция на отряд целиком). */
export function resolveOptionScopeGroup(unit: Unit, option: LoadoutOption): ModelGroup | null {
  if (option.scope.kind === 'unit') return null;

  if (option.modelName) {
    const match = matchByName(option.modelName, unit.modelGroups, (group) => group.labelName, 0.8);
    if (match) return match.item;
  }

  return unit.modelGroups.length === 1 ? unit.modelGroups[0] : null;
}

function modelsInScope(unit: Unit, option: LoadoutOption, size: number, groupCounts: number[]): number {
  const group = resolveOptionScopeGroup(unit, option);
  if (!group) return size;
  const index = groupIndexOf(unit, group.id);
  return index >= 0 ? (groupCounts[index] ?? 0) : size;
}

/** Сколько стволов указанной группы есть у отряда в рамках области действия опции. */
function baseWeaponInstances(
  unit: Unit,
  option: LoadoutOption,
  groupId: string | null,
  groupCounts: number[]
): number {
  if (groupId === null) return 0;
  const scopeGroup = resolveOptionScopeGroup(unit, option);
  let total = 0;

  for (const entry of unit.baseLoadout) {
    if (entry.groupId !== groupId) continue;
    if (scopeGroup && entry.modelGroupId !== scopeGroup.id) continue;
    const index = groupIndexOf(unit, entry.modelGroupId);
    const models = index >= 0 ? (groupCounts[index] ?? 0) : 0;
    total += entry.perModel * models;
  }

  return total;
}

/** Опция доступна при данном размере отряда ('If this unit contains N models', 'For every N models'). */
export function isOptionAvailable(option: LoadoutOption, size: number): boolean {
  if (option.minUnitModels !== null && size < option.minUnitModels) return false;
  if (option.perModels !== null && Math.floor(size / option.perModels) < 1) return false;
  return true;
}

/** Максимальное число применений варианта при данном размере отряда. */
export function resolveOptionCapacity(
  unit: Unit,
  option: LoadoutOption,
  size: number,
  groupCounts: number[]
): number {
  if (option.scope.kind === 'unit') return option.capacity === null ? 1 : option.capacity;

  const models = modelsInScope(unit, option, size, groupCounts);
  if (option.perModels !== null) return Math.floor(size / option.perModels);

  if (option.family === 'n-of-weapon') {
    const perAction = option.capacity === null ? 1 : option.capacity;
    const instances = baseWeaponInstances(unit, option, option.base[0]?.groupId ?? null, groupCounts);
    return Math.max(0, Math.min(Math.floor(instances / perAction), Math.max(models, 1)));
  }

  if (option.family === 'each-of-weapon') {
    return baseWeaponInstances(unit, option, option.base[0]?.groupId ?? null, groupCounts);
  }

  const limit = option.capacity === null ? models : Math.min(option.capacity, models);
  return Math.max(0, limit);
}

/** Лимит на повторы одного и того же варианта (строки ограничений с '*' ). */
export function effectiveDuplicateLimit(option: LoadoutOption, size: number): number | null {
  if (option.duplicateLimitAtSize && size >= option.duplicateLimitAtSize.models) {
    return option.duplicateLimitAtSize.limit;
  }
  return option.duplicateLimit;
}

function scaledBaseEntries(unit: Unit, groupCounts: number[], size: number): LoadoutEntry[] {
  return unit.baseLoadout.map((entry) => {
    const index = groupIndexOf(unit, entry.modelGroupId);
    const models = index >= 0 ? (groupCounts[index] ?? 0) : size;
    return { ...entry, count: entry.perModel * models };
  });
}

function removeWeaponInstances(
  entries: LoadoutEntry[],
  groupId: string | null,
  name: string,
  amount: number,
  modelGroupId: string | null
): number {
  let remaining = amount;

  for (const entry of entries) {
    if (remaining <= 0) break;
    if (entry.groupId !== groupId && entry.name !== name) continue;
    if (modelGroupId && entry.modelGroupId !== modelGroupId) continue;

    const taken = Math.min(entry.count, remaining);
    entry.count -= taken;
    remaining -= taken;
  }

  return amount - remaining;
}

/**
 * Сводит записи по (группа модели, оружие): количество суммируется,
 * `perModel` пересчитывается как среднее по моделям носителя.
 */
function mergeEntries(
  entries: LoadoutEntry[],
  unit: Unit,
  groupCounts: number[],
  size: number
): LoadoutEntry[] {
  const byKey = new Map<string, LoadoutEntry>();

  for (const entry of entries) {
    if (entry.count <= 0) continue;
    const key = `${entry.modelGroupId ?? ''}|${entry.groupId ?? entry.name}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count += entry.count;
      continue;
    }
    byKey.set(key, { ...entry });
  }

  return [...byKey.values()].map((entry) => {
    const index = groupIndexOf(unit, entry.modelGroupId);
    const models = index >= 0 ? (groupCounts[index] ?? 0) : size;
    return { ...entry, perModel: models > 0 ? entry.count / models : entry.count };
  });
}

/**
 * Применяет набор выборов к базовой комплектации и возвращает снаряжение
 * конкретного размера отряда. Некорректные выборы не бросают исключение:
 * они попадают в issues/unavailableOptionIds (важно для UI и для отчёта).
 */
export function applyLoadout(
  unit: Unit,
  size: number,
  selections: LoadoutSelection[] = []
): AppliedLoadout {
  const groupCounts = splitModelCounts(unit.modelGroups, size);
  const entries = scaledBaseEntries(unit, groupCounts, size);
  const issues: string[] = [];
  const unavailableOptionIds: string[] = [];

  for (const selection of selections) {
    const option = unit.loadoutOptions.find((candidate) => candidate.id === selection.optionId);
    if (!option) {
      issues.push(`опция не найдена: ${selection.optionId}`);
      continue;
    }
    if (!isOptionAvailable(option, size)) {
      unavailableOptionIds.push(option.id);
      continue;
    }

    const choice = option.choices[selection.choiceIndex];
    if (!choice) {
      issues.push(`вариант ${selection.choiceIndex} отсутствует в опции ${option.id}`);
      continue;
    }

    const capacity = resolveOptionCapacity(unit, option, size, groupCounts);
    if (capacity <= 0) {
      unavailableOptionIds.push(option.id);
      issues.push(`нулевая вместимость для опции ${option.id}`);
      continue;
    }

    const duplicateLimit = effectiveDuplicateLimit(option, size);
    const maxCount = duplicateLimit === null ? capacity : Math.min(capacity, duplicateLimit);
    const count = Math.max(1, Math.min(selection.count, maxCount));

    const scopeGroup = resolveOptionScopeGroup(unit, option);
    const modelGroupId = scopeGroup ? scopeGroup.id : null;

    if (option.action === 'replace') {
      const perAction = option.family === 'n-of-weapon' ? (option.capacity ?? 1) : 1;
      for (const baseRef of option.base) {
        const removed = removeWeaponInstances(
          entries,
          baseRef.groupId,
          baseRef.name,
          baseRef.count * perAction * count,
          modelGroupId
        );
        if (removed === 0) {
          issues.push(`не найдено оружие для замены: ${baseRef.name} (${option.id})`);
        }
      }
    }

    for (const weapon of choice.weapons) {
      entries.push({
        groupId: weapon.groupId,
        name: weapon.name,
        perModel: weapon.count * count,
        count: weapon.count * count,
        modelGroupId,
        source: 'option',
        optionId: option.id,
      });
    }
  }

  return {
    size,
    groupCounts,
    entries: mergeEntries(entries, unit, groupCounts, size),
    unavailableOptionIds,
    issues,
  };
}