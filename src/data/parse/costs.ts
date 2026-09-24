/**
 * Разбор Datasheets_models_cost → таблица стоимости.
 *
 * Структура файла (проверено на выгрузке):
 *   YOUR UNIT COSTS            ← заголовок тира (цены за базовое количество копий)
 *   10 models|90               ← размер отряда и очки
 *   20 models|180
 *   YOUR 1ST TO 3RD UNITS COST ← второе ценообразование для тех же размеров
 *   YOUR 4TH + UNIT COSTS
 *   WARGEAR OPTIONS            ← блок доплат за конкретное оружие
 *   per Paired Krumpas|5
 *
 * Тиры НЕ схлопываются: 'YOUR 1ST TO 3RD UNITS COST' и 'YOUR 4TH + UNIT COSTS'
 * это разные цены за один и тот же размер отряда. Базовой считается первая строка
 * каждого размера в первом тире.
 */

import type { ModelCostRow } from '../raw/types.ts';
import { cleanText } from '../normalize/text.ts';
import { parseIntOrNull } from '../normalize/numbers.ts';
import type { UnitCostTable, UnitCostTier, UnitSize, WargearCost } from '../types/unit.ts';

const DEFAULT_TIER_LABEL = 'YOUR UNIT COSTS';

export interface ParsedCostTable {
  table: UnitCostTable;
  sizes: UnitSize[];
  anomalies: Array<{ line: number; description: string; cost: string }>;
}

export function parseCostTable(rows: ModelCostRow[]): ParsedCostTable {
  const tiers: UnitCostTier[] = [];
  const wargearCosts: WargearCost[] = [];
  const anomalies: ParsedCostTable['anomalies'] = [];

  let current: UnitCostTier | null = null;
  let inWargearBlock = false;

  const ensureTier = (): UnitCostTier => {
    if (current) return current;
    current = { label: DEFAULT_TIER_LABEL, sizes: [] };
    tiers.push(current);
    return current;
  };

  for (const row of rows) {
    const line = parseIntOrNull(row.line) ?? 0;
    const description = cleanText(row.description);
    if (description === '') continue;

    if (/^wargear options$/i.test(description)) {
      inWargearBlock = true;
      current = null;
      continue;
    }

    if (/^your\b/i.test(description)) {
      inWargearBlock = false;
      current = { label: description.toUpperCase(), sizes: [] };
      tiers.push(current);
      continue;
    }

    const points = parseIntOrNull(row.cost);

    if (inWargearBlock || /^per\b/i.test(description)) {
      if (points === null) {
        anomalies.push({ line, description, cost: row.cost });
        continue;
      }
      wargearCosts.push({
        label: description,
        weaponName: description.replace(/^per\s+/i, '').trim(),
        points,
      });
      continue;
    }

    if (points === null) {
      anomalies.push({ line, description, cost: row.cost });
      continue;
    }

    const models = parseIntOrNull(description);
    if (models === null) {
      anomalies.push({ line, description, cost: row.cost });
      continue;
    }

    ensureTier().sizes.push({ label: description, models, points });
  }

  const nonEmptyTiers = tiers.filter((tier) => tier.sizes.length > 0);
  const sizes = nonEmptyTiers[0]?.sizes ?? [];

  return {
    table: { tiers: nonEmptyTiers, wargearCosts },
    sizes: [...sizes].sort((a, b) => a.models - b.models),
    anomalies,
  };
}

/** Очки за размер отряда: базовая цена (первый тир), иначе null. */
export function pointsForSize(table: UnitCostTable, models: number): number | null {
  const base = table.tiers[0];
  if (!base) return null;
  const exact = base.sizes.find((size) => size.models === models);
  return exact ? exact.points : null;
}

/**
 * Выбирает «базовый» размер отряда: минимальный размер, который не меньше суммы
 * минимумов состава; если такого нет — самый маленький доступный размер.
 */
export function selectBaseSize(sizes: UnitSize[], compositionMin: number): UnitSize | null {
  if (sizes.length === 0) return null;
  const suitable = sizes.find((size) => size.models >= compositionMin);
  return suitable ?? sizes[0];
}