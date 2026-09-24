/**
 * Числовые парсеры характеристик Wahapedia.
 *
 * Реальные значения в датасете (проверено на выгрузке):
 * - атаки/урон: '3', '2D3', 'D6', 'D6+3', '2D6+6' (возможны пробелы по краям);
 * - BS/WS: '3+', 'N/A' (auto-hit, Torrent), '-';
 * - M: '6"', '-', '20+"';
 * - Sv/inv: '3+', '-'/'' (нет);
 * - AP: '', '0', '-1', '-3';
 * - range: '', 'Melee', 'N/A', '24';
 * - OC: '0'..'30', '-'.
 *
 * Никаких «угадываний по умолчанию»: нераспознанное возвращает null,
 * а решение о fallback принимает вызывающий код.
 */

export type DiceExpr =
  | { kind: 'flat'; value: number }
  | { kind: 'dice'; count: number; sides: number; modifier: number };

const EMPTY = new Set(['', '-', 'n/a', 'na', 'null']);

function isBlank(raw: string): boolean {
  return EMPTY.has(raw.trim().toLowerCase());
}

/** '2D6+3' | 'D6' | 'D3+1' | '3' → структура; нераспознанное → null. */
export function parseDice(raw: string): DiceExpr | null {
  if (isBlank(raw)) return null;
  const value = raw.trim().toUpperCase().replace(/\s+/g, '');

  const flat = value.match(/^(\d+)$/);
  if (flat) return { kind: 'flat', value: Number.parseInt(flat[1], 10) };

  const dice = value.match(/^(\d*)D(\d+)([+-]\d+)?$/);
  if (dice) {
    const count = dice[1] === '' ? 1 : Number.parseInt(dice[1], 10);
    const sides = Number.parseInt(dice[2], 10);
    const modifier = dice[3] ? Number.parseInt(dice[3], 10) : 0;
    return { kind: 'dice', count, sides, modifier };
  }

  return null;
}

/** Среднее значение броска (для ненаблюдаемых проверок и тестов). */
export function diceMean(expr: DiceExpr | null): number | null {
  if (!expr) return null;
  if (expr.kind === 'flat') return expr.value;
  return (expr.count * (expr.sides + 1)) / 2 + expr.modifier;
}

/** '3+' → 3; '' / '-' / 'N/A' → null. */
export function parseSave(raw: string): number | null {
  if (isBlank(raw)) return null;
  const match = raw.match(/(\d+)\s*\+/);
  if (match) return Number.parseInt(match[1], 10);
  if (/^\d+$/.test(raw.trim())) return Number.parseInt(raw.trim(), 10);
  return null;
}

/** BS/WS: '3+' → 3; 'N/A' (auto-hit) → null. */
export function parseSkill(raw: string): number | null {
  return parseSave(raw);
}

export function parseIntOrNull(raw: string): number | null {
  if (isBlank(raw)) return null;
  const match = raw.match(/-?\d+/);
  return match ? Number.parseInt(match[0], 10) : null;
}

/** AP: '' → 0, '-3' → -3, '+1' → 1. */
export function parseArmourPenetration(raw: string): number {
  if (isBlank(raw)) return 0;
  const match = raw.match(/[+-]?\d+/);
  return match ? Number.parseInt(match[0], 10) : 0;
}

export type WeaponRange = { kind: 'melee' } | { kind: 'ranged'; inches: number };

/** '' / '-' / 'N/A' → null; 'Melee' → melee; '24"' → ranged 24. */
export function parseRange(raw: string): WeaponRange | null {
  if (isBlank(raw)) return null;
  const value = raw.trim();
  if (/^melee$/i.test(value)) return { kind: 'melee' };
  const inches = value.match(/(\d+)/);
  return inches ? { kind: 'ranged', inches: Number.parseInt(inches[1], 10) } : null;
}

/** M: '6"' → 6; '-' (обездвижен) → null; сохраняем сырое значение. */
export function parseMovement(raw: string): number | null {
  if (isBlank(raw)) return null;
  const match = raw.match(/(\d+)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

/** 'true' → true, иначе false (в файлах только 'true'/'false'/''). */
export function parseFlag(raw: string): boolean {
  return raw.trim().toLowerCase() === 'true';
}

/** '1-5' → { from: 1, to: 5 }; '3' → { from: 3, to: 3 }. */
export function parseRangeBounds(raw: string): { from: number | null; to: number | null } {
  const match = raw.match(/(\d+)\s*-\s*(\d+)/);
  if (match) {
    return { from: Number.parseInt(match[1], 10), to: Number.parseInt(match[2], 10) };
  }
  const single = raw.match(/(\d+)/);
  if (single) {
    const value = Number.parseInt(single[1], 10);
    return { from: value, to: value };
  }
  return { from: null, to: null };
}
