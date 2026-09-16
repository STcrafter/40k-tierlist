// src/core/dice.ts

export function rollD6(): number {
  return Math.floor(Math.random() * 6) + 1;
}

export function rollD3(): number {
  return Math.ceil(rollD6() / 2);
}

export function resolveDice(value: number | 'D6' | 'D3'): number {
  if (value === 'D6') return rollD6();
  if (value === 'D3') return rollD3();
  return value;
}

export function woundTarget(strength: number, toughness: number): number {
  if (strength >= toughness * 2) return 2;
  if (strength > toughness) return 3;
  if (strength === toughness) return 4;
  if (strength * 2 <= toughness) return 6;
  return 5;
}

/**
 * Проверка hit/wound броска.
 * Правила 10th ed: натуральная 1 всегда провал, натуральная 6 всегда успех.
 * Модификатор применяется ОДИН раз и ограничен ±1.
 */
export function isSuccess(roll: number, target: number, modifier: number = 0): boolean {
  if (roll === 1) return false;
  if (roll === 6) return true;
  const clamped = Math.max(-1, Math.min(1, modifier));
  return roll + clamped >= target;
}

/**
 * Проверка save броска.
 * Натуральная 1 всегда провал, натуральная 6 всегда успех
 * (поэтому сейв 7+ всё же спасает на шестёрке).
 */
export function saveSucceeds(roll: number, target: number): boolean {
  if (roll === 1) return false;
  if (roll === 6) return true;
  return roll >= target;
}

export function chooseSave(
  save: number | null,
  invuln: number | null,
  ap: number
): number | null {
  const effectiveSave = save !== null ? Math.min(7, save + Math.abs(ap)) : null;

  if (effectiveSave === null && invuln === null) return null;
  if (effectiveSave === null) return invuln;
  if (invuln === null) return effectiveSave;

  return Math.min(effectiveSave, invuln);
}