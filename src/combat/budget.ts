/**
 * Единый лимит стоимости для аналитических расчётов.
 *
 * Дорогие отряды нельзя сравнивать с обычными юнитами напрямую: они нарушают
 * min-max-нормализацию и перцентили (один Knight/Titan слегка меняет шкалу всего
 * набора). При этом адаптер BSData продолжает разбирать такие даташиты — лимит
 * применяется только к расчётным выборкам и тирлисту.
 */
export const CALCULATION_POINTS_LIMIT = 2000;

/** Попадает ли отряд в расчётную выборку по стоимости. */
export function withinCalculationBudget(points: number): boolean {
  return Number.isFinite(points) && points > 0 && points <= CALCULATION_POINTS_LIMIT;
}

/** Legends — отдельный корпус правил, его не смешиваем с актуальными юнитами. */
export function isLegendsName(name: string): boolean {
  return /\[\s*legends\s*\]/i.test(name);
}

/** Комплексная проверка попадания даташита в расчётную выборку. */
export function isEligibleForCalculations(name: string, points: number): boolean {
  return !isLegendsName(name) && withinCalculationBudget(points);
}
