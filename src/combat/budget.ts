/**
 * Единый лимит стоимости для аналитических расчётов.
 *
 * Дорогие отряды нельзя сравнивать с обычными юнитами напрямую: они нарушают
 * min-max-нормализацию и перцентили (один Knight/Titan слегка меняет шкалу всего
 * набора). При этом адаптер BSData продолжает разбирать такие даташиты — лимит
 * применяется только к расчётным выборкам и тирлисту.
 */
export const CALCULATION_POINTS_LIMIT = 2000;

/** Попадает ли отряд в расчётную выборку. */
export function withinCalculationBudget(points: number): boolean {
  return Number.isFinite(points) && points > 0 && points <= CALCULATION_POINTS_LIMIT;
}
