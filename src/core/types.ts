// src/core/types.ts

import { Unit, WeaponAbility } from '../data/types/unit';

/**
 * Профиль цели для анализа (мета-цели или конкретные юниты)
 */
export interface TargetProfile {
  id: string;
  name: string;
  toughness: number;
  save: number;                    // Обычный сейв (2-6)
  invulnerableSave: number | null; // Инвульн (если есть)
  wounds: number;                  // Ран на модель
  models: number;                  // Количество моделей
  feelNoPain: number | null;       // 5+ = 5, null = нет
  damageReduction: number;         // 0, 1, 2...
  minusToHit: number;              // Модификатор на попадание (например, -1 за Stealth)
  hasCover: boolean;               // В укрытии?
  keywords: string[];              // Для Anti-X правил
  metaWeight: number;              // Вес в мете (0-1) для взвешенного DPE
}

/**
 * Модификаторы, применяемые к атакующему (от ауры, стратагемы и т.д.)
 */
export interface AttackModifiers {
  plusToHit?: number;       // +1 to hit
  plusToWound?: number;     // +1 to wound
  plusDamage?: number;      // +1 damage
  rerollHit?: boolean;      // Перебивание промахов
  rerollWound?: boolean;    // Перебивание неранений
  rerollDamage?: boolean;   // Перебивание 1 урона
}

/**
 * Результат симуляции урона
 */
export interface SimulationResult {
  mean: number;             // Средний урон
  median: number;           // Медиана (50-й перцентиль)
  stdDev: number;           // Стандартное отклонение
  min: number;
  max: number;
  percentiles: {
    p10: number;            // Пессимистичный исход
    p25: number;
    p50: number;
    p75: number;
    p90: number;            // Оптимистичный исход
  };
  distribution: number[];   // Массив всех исходов (для гистограммы)

  // Специфичные метрики
  probabilityOfKill: number;       // Шанс убить цель полностью (0-1)
  expectedWoundsInflicted: number; // Ожидаемое количество снятых ран
  expectedModelsKilled: number;    // Ожидаемое количество убитых моделей
}

/**
 * Один прогон симуляции (детализация)
 */
export interface CombatRoll {
  totalAttacks: number;
  hits: number;
  wounds: number;
  failedSaves: number;
  totalDamage: number;
  modelsKilled: number;
}

/** SimulationResult без массива distribution (для передачи из Worker) */
export interface SimSummary {
  mean: number;
  median: number;
  stdDev: number;
  min: number;
  max: number;
  percentiles: { p10: number; p25: number; p50: number; p75: number; p90: number };
  probabilityOfKill: number;
  expectedWoundsInflicted: number;
  expectedModelsKilled: number;
}

export function summarize(r: SimulationResult): SimSummary {
  const { distribution, ...rest } = r;
  return rest;
}