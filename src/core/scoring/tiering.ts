// src/core/scoring/tiering.ts

import { Unit } from '../../data/types/unit';
import { RawMetrics } from './metrics';

export enum Tier { S = 'S', A = 'A', B = 'B', C = 'C', D = 'D' }

/**
 * Калибровочные константы.
 * Подобраны предварительно, будут тюниться на реальных данных фракций.
 */
export const SCORE_CONFIG = {
  dpeMax: 8,    // взвешенный урон/100 очков = 8 → 100 баллов
  speMax: 8,    // 8 залпов до смерти → 100 баллов
  opeMax: 15,   // OC×mobility = 15 → 100 баллов
  weights: { dpe: 0.45, spe: 0.35, ope: 0.20 },
  tierThresholds: { S: 75, A: 60, B: 45, C: 30 },
};

export interface TierEntry {
  unit: Unit;
  metrics: RawMetrics;
  axis: { dpe: number; spe: number; ope: number }; // 0-100
  composite: number;  // 0-100
  tier: Tier;
  strengths: string[];
  weaknesses: string[];
}

const clamp100 = (v: number) => Math.max(0, Math.min(100, v));

export function buildTierList(
  input: Array<{ unit: Unit; metrics: RawMetrics }>
): TierEntry[] {
  const entries: TierEntry[] = input.map(({ unit, metrics }) => {
    // Юнит судим по его ЛУЧШЕЙ фазе (стрикер в melee не наказывается за слабую стрельбу)
    const bestDpe = Math.max(metrics.dpeShoot, metrics.dpeMelee);

    const dpe = clamp100((bestDpe / SCORE_CONFIG.dpeMax) * 100);
    const spe = clamp100((metrics.spe / SCORE_CONFIG.speMax) * 100);
    const ope = clamp100((metrics.ope / SCORE_CONFIG.opeMax) * 100);

    const composite =
      dpe * SCORE_CONFIG.weights.dpe +
      spe * SCORE_CONFIG.weights.spe +
      ope * SCORE_CONFIG.weights.ope;

    const tier =
      composite >= SCORE_CONFIG.tierThresholds.S ? Tier.S :
      composite >= SCORE_CONFIG.tierThresholds.A ? Tier.A :
      composite >= SCORE_CONFIG.tierThresholds.B ? Tier.B :
      composite >= SCORE_CONFIG.tierThresholds.C ? Tier.C :
      Tier.D;

    // === Генерация объяснений ===
    const strengths: string[] = [];
    const weaknesses: string[] = [];

    if (dpe >= 60) strengths.push('высокий урон');
    if (dpe <= 25) weaknesses.push('низкий урон');
    if (spe >= 60) strengths.push('отличная живучесть');
    if (spe <= 25) weaknesses.push('хрупкий');
    if (ope >= 60) strengths.push('сильный контроль точек');
    if (ope <= 25) weaknesses.push('слаб на точках');

    if (metrics.dpeMelee > metrics.dpeShoot * 1.5) strengths.push('специалист ближнего боя');
    else if (metrics.dpeShoot > metrics.dpeMelee * 1.5) strengths.push('специалист стрельбы');

    return { unit, metrics, axis: { dpe, spe, ope }, composite, tier, strengths, weaknesses };
  });

  entries.sort((a, b) => b.composite - a.composite);
  return entries;
}