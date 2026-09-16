// src/core/scoring/metrics.ts

import { Unit } from '../../data/types/unit';
import { META_TARGETS } from '../meta/targets';
import { META_THREATS, unitAsTarget } from '../meta/threats';
import { runMonteCarlo } from '../monte-carlo';

export interface RawMetrics {
  dpeShoot: number;
  dpeMelee: number;
  spe: number;
  ope: number;
}

/**
 * Чистая формула метрик из готовых средних значений.
 * Используется и синхронной версией, и Web Worker'ом.
 */
export function computeMetricsFromSims(
  unit: Unit,
  shootMeans: Map<string, number>,
  meleeMeans: Map<string, number>,
  threatMeans: Map<string, number>
): RawMetrics {
  let shoot = 0;
  let melee = 0;
  for (const t of META_TARGETS) {
    shoot += (shootMeans.get(t.id) ?? 0) * t.metaWeight;
    melee += (meleeMeans.get(t.id) ?? 0) * t.metaWeight;
  }

  const pts = Math.max(unit.points, 1);
  const dpeShoot = (shoot / pts) * 100;
  const dpeMelee = (melee / pts) * 100;

  let ttk = 0;
  for (const th of META_THREATS) {
    const dmg = Math.max(threatMeans.get(th.id) ?? 0, 0.05);
    ttk += Math.min(unit.woundsTotal / dmg, 20) * th.weight;
  }

  const mobility =
    1 +
    Math.max(0, unit.movement - 6) * 0.05 +
    (unit.hasFly ? 0.15 : 0) +
    (unit.hasInfiltrate || unit.hasScout ? 0.2 : 0) +
    (unit.hasDeepStrike ? 0.1 : 0);
  const ope = unit.objectiveControlTotal * mobility;

  return { dpeShoot, dpeMelee, spe: ttk, ope };
}

/** Синхронная версия (для тестов и моков) */
export function computeMetrics(unit: Unit, iterations = 2000): RawMetrics {
  const shootMeans = new Map<string, number>();
  const meleeMeans = new Map<string, number>();

  for (const t of META_TARGETS) {
    shootMeans.set(t.id, runMonteCarlo(unit, t, iterations, {}, 'Shooting').mean);
    meleeMeans.set(t.id, runMonteCarlo(unit, t, iterations, {}, 'Melee').mean);
  }

  const asTarget = unitAsTarget(unit);
  const threatMeans = new Map<string, number>();
  for (const th of META_THREATS) {
    threatMeans.set(th.id, runMonteCarlo(th.attacker, asTarget, iterations).mean);
  }

  return computeMetricsFromSims(unit, shootMeans, meleeMeans, threatMeans);
}