// src/workers/analysis.worker.ts

import { Unit } from '../data/types/unit';
import { CombatPhase } from '../core/combat';
import { runMonteCarlo } from '../core/monte-carlo';
import { summarize, SimSummary } from '../core/types';
import { META_TARGETS } from '../core/meta/targets';
import { META_THREATS, unitAsTarget } from '../core/meta/threats';
import { computeMetricsFromSims, RawMetrics } from '../core/scoring/metrics';

export interface UnitAnalysis {
  unitId: string;
  matrices: Record<CombatPhase, Record<string, SimSummary>>;
  metrics: RawMetrics;
}

interface Job {
  jobId: number;
  unit: Unit;
  iterations: number;
}

self.onmessage = (e: MessageEvent<Job>) => {
  const { jobId, unit, iterations } = e.data;

  const matrices = {} as Record<CombatPhase, Record<string, SimSummary>>;
  const shootMeans = new Map<string, number>();
  const meleeMeans = new Map<string, number>();

  const phases: CombatPhase[] = ['Shooting', 'Melee', 'All'];
  for (const phase of phases) {
    matrices[phase] = {};
    for (const t of META_TARGETS) {
      const res = runMonteCarlo(unit, t, iterations, {}, phase);
      matrices[phase][t.id] = summarize(res);
      if (phase === 'Shooting') shootMeans.set(t.id, res.mean);
      if (phase === 'Melee') meleeMeans.set(t.id, res.mean);
    }
  }

  const asTarget = unitAsTarget(unit);
  const threatMeans = new Map<string, number>();
  for (const th of META_THREATS) {
    threatMeans.set(th.id, runMonteCarlo(th.attacker, asTarget, iterations).mean);
  }

  const metrics = computeMetricsFromSims(unit, shootMeans, meleeMeans, threatMeans);

  (self as unknown as Worker).postMessage({
    jobId,
    analysis: { unitId: unit.id, matrices, metrics } satisfies UnitAnalysis,
  });
};