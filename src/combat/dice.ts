/**
 * Кубы и генератор случайных чисел.
 *
 * PRNG — mulberry32: детерминированный при заданном seed, поэтому серия
 * Монте-Карло воспроизводима (важно для тестов и сравнения конфигураций).
 */

import type { DiceSpec, Rng } from './types.ts';

/** Детерминированный PRNG с сидом. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Разбор характеристики кубов: '2D6+3', 'D3', 'D6+2', '3', 'D6'.
 * null/пусто/'-' → null. Нераспознанное ('x2', 'D') → null.
 */
export function parseDice(text: string | null): DiceSpec | null {
  if (text === null) return null;
  const raw = text.trim().replace(/\s+/g, '');
  if (raw === '' || raw === '-' || raw.toLowerCase() === 'n/a') return null;

  const dice = /^(\d*)D(\d+)([+-]\d+)?$/i.exec(raw);
  if (dice) {
    const count = dice[1] === '' ? 1 : Number(dice[1]);
    const sides = Number(dice[2]);
    const plus = dice[3] === undefined ? 0 : Number(dice[3]);
    if (!Number.isFinite(count) || !Number.isFinite(sides) || sides < 1) return null;
    return { count, sides, plus };
  }

  const fixed = /^-?\d+$/.exec(raw);
  if (fixed) return { count: Number(raw), sides: 1, plus: 0 };

  return null;
}

/** Бросок спецификации: сумма count кубов sides граней плюс plus. */
export function rollDice(spec: DiceSpec, rng: Rng): number {
  let total = spec.plus;
  for (let i = 0; i < spec.count; i += 1) {
    total += 1 + Math.floor(rng() * spec.sides);
  }
  return total;
}

/** Математическое ожидание спецификации. */
export function diceMean(spec: DiceSpec): number {
  return spec.count * ((1 + spec.sides) / 2) + spec.plus;
}

/** Бросок dN: целое от 1 до N. */
export function rollDie(sides: number, rng: Rng): number {
  return 1 + Math.floor(rng() * sides);
}
