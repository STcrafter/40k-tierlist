// src/core/monte-carlo.ts

import { Unit } from '../data/types/unit';
import { TargetProfile, AttackModifiers, SimulationResult } from './types';
import { simulateFullAttack, CombatPhase } from './combat';

export function runMonteCarlo(
  unit: Unit,
  target: TargetProfile,
  iterations: number = 10000,
  modifiers: AttackModifiers = {},
  phase: CombatPhase = 'All'
): SimulationResult {
  const damages: number[] = [];
  let totalKill = 0;
  let totalWounds = 0;
  let totalModelsKilled = 0;

  for (let i = 0; i < iterations; i++) {
    const roll = simulateFullAttack(unit, target, modifiers, phase);
    damages.push(roll.totalDamage);
    totalWounds += roll.totalDamage;
    totalModelsKilled += roll.modelsKilled;
    if (roll.modelsKilled >= target.models) totalKill++;
  }

  const sorted = [...damages].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = damages.reduce((s, x) => s + x, 0) / n;
  const variance = damages.reduce((s, x) => s + (x - mean) ** 2, 0) / n;

  return {
    mean,
    median: sorted[Math.floor(n / 2)],
    stdDev: Math.sqrt(variance),
    min: sorted[0],
    max: sorted[n - 1],
    percentiles: {
      p10: sorted[Math.floor(n * 0.1)],
      p25: sorted[Math.floor(n * 0.25)],
      p50: sorted[Math.floor(n * 0.5)],
      p75: sorted[Math.floor(n * 0.75)],
      p90: sorted[Math.floor(n * 0.9)],
    },
    distribution: damages,
    probabilityOfKill: totalKill / iterations,
    expectedWoundsInflicted: totalWounds / iterations,
    expectedModelsKilled: totalModelsKilled / iterations,
  };
}