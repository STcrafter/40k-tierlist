/**
 * Перечисление допустимых конфигураций снаряжения.
 *
 * Что такое «формула набора снаряжения» в этой реализации:
 *   1) декларативные правила (LoadoutOption) — что можно заменить/добавить,
 *      сколько моделей это может взять и при каких размерах отряда;
 *   2) applyLoadout — применить конкретный выбор (детерминированно);
 *   3) iterateLoadouts/enumerateLoadouts — перечислить ВСЕ допустимые наборы;
 *   4) optimizeLoadout — выбрать лучший по внешней метрике (расчёт урона
 *      остаётся вне парсера, чтобы разделять данные и математику).
 *
 * Комбинаторика ограничена: взаимоисключающие списки ('one of the following')
 * дают по одному варианту на позицию, независимые/дублируемые — распределения
 * с суммарным количеством не больше вместимости, плюс лимит конфигураций.
 */

import {
  applyLoadout,
  effectiveDuplicateLimit,
  isOptionAvailable,
  resolveOptionCapacity,
} from './apply.ts';
import { splitModelCounts } from '../parse/composition.ts';
import type {
  LoadoutConfiguration,
  LoadoutEntry,
  LoadoutOption,
  LoadoutSelection,
} from '../types/loadout.ts';
import type { Unit } from '../types/unit.ts';

export interface OptionSpace {
  optionId: string;
  /** Варианты: каждый — набор выборов (для независимых опций их может быть несколько). */
  alternatives: LoadoutSelection[][];
}

export interface EnumerateOptions {
  /** Максимум конфигураций (защита от комбинаторного взрыва). По умолчанию 256. */
  limit?: number;
}

/** Пространство выборов одной опции при данном размере отряда. */
export function optionSelectionSpace(
  unit: Unit,
  option: LoadoutOption,
  size: number,
  groupCounts: number[]
): OptionSpace {
  if (!isOptionAvailable(option, size)) return { optionId: option.id, alternatives: [] };

  const capacity = resolveOptionCapacity(unit, option, size, groupCounts);
  if (capacity <= 0) return { optionId: option.id, alternatives: [] };

  if (option.exclusive) {
    // 'one of the following' — либо один вариант целиком, либо ничего.
    return {
      optionId: option.id,
      alternatives: option.choices.map((_, choiceIndex) => [
        { optionId: option.id, choiceIndex, count: capacity },
      ]),
    };
  }

  const duplicateLimit = effectiveDuplicateLimit(option, size);
  const perChoiceMax = duplicateLimit === null ? capacity : Math.min(capacity, duplicateLimit);
  const alternatives: LoadoutSelection[][] = [];
  const current: LoadoutSelection[] = [];

  const walk = (start: number, remaining: number): void => {
    if (current.length > 0) alternatives.push([...current]);
    for (let choiceIndex = start; choiceIndex < option.choices.length; choiceIndex += 1) {
      const max = Math.min(perChoiceMax, remaining);
      for (let count = 1; count <= max; count += 1) {
        current.push({ optionId: option.id, choiceIndex, count });
        walk(choiceIndex + 1, remaining - count);
        current.pop();
      }
    }
  };

  walk(0, capacity);
  return { optionId: option.id, alternatives };
}

/** Стабильный ключ конфигурации для дедупликации одинаковых наборов. */
export function configurationKey(entries: LoadoutEntry[]): string {
  return entries
    .map((entry) => `${entry.modelGroupId ?? ''}|${entry.groupId ?? entry.name}|${entry.count}`)
    .sort()
    .join(';');
}

/** Базовая конфигурация: ничего не меняем. */
export function defaultConfiguration(unit: Unit, size: number): LoadoutConfiguration {
  const applied = applyLoadout(unit, size, []);
  return {
    size,
    selections: [],
    entries: applied.entries,
    unavailableOptionIds: applied.unavailableOptionIds,
  };
}

/** Ленивый перебор всех допустимых конфигураций. */
export function* iterateLoadouts(
  unit: Unit,
  size: number,
  options: EnumerateOptions = {}
): Generator<LoadoutConfiguration> {
  const limit = options.limit ?? 256;
  const groupCounts = splitModelCounts(unit.modelGroups, size);
  const spaces = unit.loadoutOptions
    .map((option) => optionSelectionSpace(unit, option, size, groupCounts))
    .filter((space) => space.alternatives.length > 0);

  const seen = new Set<string>();
  const selected: LoadoutSelection[] = [];
  let produced = 0;

  function* walk(index: number): Generator<LoadoutConfiguration> {
    if (produced >= limit) return;

    if (index >= spaces.length) {
      const applied = applyLoadout(unit, size, selected);
      const key = configurationKey(applied.entries);
      if (seen.has(key)) return;
      seen.add(key);
      produced += 1;
      yield {
        size,
        selections: [...selected],
        entries: applied.entries,
        unavailableOptionIds: applied.unavailableOptionIds,
      };
      return;
    }

    // Вариант «опция не используется» идёт первым — так дефолтная конфигурация
    // всегда оказывается в начале перечисления.
    yield* walk(index + 1);

    for (const alternative of spaces[index].alternatives) {
      selected.push(...alternative);
      yield* walk(index + 1);
      selected.length -= alternative.length;
    }
  }

  yield* walk(0);
}

export function enumerateLoadouts(
  unit: Unit,
  size: number,
  options: EnumerateOptions = {}
): LoadoutConfiguration[] {
  return [...iterateLoadouts(unit, size, options)];
}

/**
 * Жадный подбор наилучшей конфигурации по внешней метрике (например, среднему
 * урону из core/combat.ts). Парсер не знает про математику — метрика приходит
 * снаружи, поэтому модуль остаётся «про данные».
 */
export function optimizeLoadout(
  unit: Unit,
  size: number,
  score: (entries: LoadoutEntry[]) => number,
  options: { passes?: number } = {}
): LoadoutConfiguration {
  const passes = options.passes ?? 2;
  const groupCounts = splitModelCounts(unit.modelGroups, size);

  let best = defaultConfiguration(unit, size);
  let bestScore = score(best.entries);

  for (let pass = 0; pass < passes; pass += 1) {
    let improved = false;

    for (const option of unit.loadoutOptions) {
      const space = optionSelectionSpace(unit, option, size, groupCounts);
      if (space.alternatives.length === 0) continue;

      const others = best.selections.filter((selection) => selection.optionId !== option.id);

      for (const alternative of space.alternatives) {
        const candidateSelections = [...others, ...alternative];
        const applied = applyLoadout(unit, size, candidateSelections);
        const candidateScore = score(applied.entries);

        if (candidateScore > bestScore) {
          bestScore = candidateScore;
          best = {
            size,
            selections: candidateSelections,
            entries: applied.entries,
            unavailableOptionIds: applied.unavailableOptionIds,
          };
          improved = true;
        }
      }
    }

    if (!improved) break;
  }

  return best;
}