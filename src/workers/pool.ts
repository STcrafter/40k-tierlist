// src/workers/pool.ts

import { Unit } from '../data/types/unit';
import { UnitAnalysis } from './analysis.worker';

/**
 * Запускает анализ юнитов на пуле Web Worker'ов.
 * Каждый worker берёт следующий юнит из очереди, пока очередь не пуста.
 */
export function analyzeUnits(
  units: Unit[],
  iterations: number,
  onProgress: (done: number, total: number) => void
): Promise<UnitAnalysis[]> {
  return new Promise((resolve, reject) => {
    if (units.length === 0) {
      resolve([]);
      return;
    }

    const poolSize = Math.min(navigator.hardwareConcurrency || 4, 8, units.length);
    const results: UnitAnalysis[] = new Array(units.length);
    let nextIndex = 0;
    let done = 0;

    const dispatch = (worker: Worker) => {
      if (nextIndex < units.length) {
        worker.postMessage({ jobId: nextIndex, unit: units[nextIndex], iterations });
        nextIndex++;
      } else {
        worker.terminate();
      }
    };

    for (let i = 0; i < poolSize; i++) {
      const worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), {
        type: 'module',
      });

      worker.onmessage = (e: MessageEvent<{ jobId: number; analysis: UnitAnalysis }>) => {
        results[e.data.jobId] = e.data.analysis;
        done++;
        onProgress(done, units.length);

        if (done === units.length) {
          resolve(results);
        } else {
          dispatch(worker);
        }
      };

      worker.onerror = (err) => {
        console.error('Worker error:', err);
        reject(err);
      };

      dispatch(worker);
    }
  });
}