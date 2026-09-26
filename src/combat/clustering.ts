/**
 * Кластеризация юнитов: k-means и выбор числа кластеров.
 *
 * Зачем: ручная типизация `archetypeOf` кривая — она относит и отряд
 * Intercessors, и Abaddon в одну корзину «infantry», а внутри «infantry»
 * реально живут и Battle Sisters (W1/Sv3+), и Acolyte Hybrids (W1/Sv5+), и
 * Bloodletters (W1/Sv7+). Медиана по такой смеси даёт усреднение, которого
 * нет ни у одного реального юнита, и все юниты начинают сравниваться с
 * несуществующей целью. Поэтому типы выводятся из ДАННЫХ, а не задаются руками.
 *
 * Реализация намеренно своя: в проекте нет ML-зависимостей, а добавлять
 * тяжёлую ради девяти числовых признаков незачем. k-means детерминирован
 * (k-means++ инициализация с фиксированным seed), поэтому сборка тирлиста
 * воспроизводима.
 *
 * Признаки — только числовые характеристики модели и её отряда:
 *   T, W, Sv, InSv, моделей в отряде, очков на модель.
 * Кейворды в признаки НЕ входят: они используются затем для НАИМЕНОВАНИЯ
 * кластера («доминирующий кейворд: VEHICLE»), но не влияют на разбиение —
 * иначе кластеризация лишь воспроизвела бы ту же ручную типизацию.
 */

import { mulberry32 } from './dice.ts';
import type { CombatUnit } from './types.ts';

/**
 * Признаки юнита для кластеризации: T, W, Sv, InSv, моделей в отряде,
 * очков на модель.
 *
 * Характеристики берутся как «наихудшие» (минимум) по всем моделям отряда:
 * эталон цели в модели — это N ОДИНАКОВЫХ моделей, и у Intercessor Squad
 * (5 бойцов + сержант + чемпион) усреднение завысило бы стойкость.
 *
 * Отсутствующий сейв кодируется как 6 («Sv-» в правилах = нет сейва), а
 * отсутствующий инвуль — тоже 6, чтобы значение не выпадало из шкалы.
 */
export function unitFeatureVector(unit: CombatUnit, points: number): number[] {
  const models = unit.models;
  if (models.length === 0) return [];
  const first = models[0];
  const saves = models.map((model) => model.save).filter((value): value is number => value !== null);
  const invulns = models.map((model) => model.invuln).filter((value): value is number => value !== null);
  return [
    first.toughness,
    first.wounds,
    saves.length > 0 ? Math.min(...saves) : 6,
    invulns.length > 0 ? Math.min(...invulns) : 6,
    models.length,
    points / models.length,
  ];
}

/** Числовой вектор признаков. */
export type Vector = readonly number[];

export interface ClusterResult {
  /** Номер кластера для каждой точки, по порядку входа. */
  labels: number[];
  /** Центроиды. */
  centroids: number[][];
  /** Сумма квадратов расстояний до своих центроидов. */
  inertia: number;
  /** Число итераций до сходимости. */
  iterations: number;
}

/** Среднее и σ по столбцу; σ = 0, если все значения одинаковы. */
export function columnStats(matrix: Vector[]): Array<{ mean: number; sd: number }> {
  if (matrix.length === 0) return [];
  const width = matrix[0].length;
  const out: Array<{ mean: number; sd: number }> = [];
  for (let j = 0; j < width; j += 1) {
    const column = matrix.map((row) => row[j]);
    const mean = column.reduce((a, b) => a + b, 0) / column.length;
    const variance = column.reduce((sum, value) => sum + (value - mean) ** 2, 0) / column.length;
    out.push({ mean, sd: Math.sqrt(variance) });
  }
  return out;
}

/**
 * Стандартизация по столбцам (z-score). Обязательна: T лежит в 1..14,
 * а очки на модель — в 5..400, и без нормировки «очки» перевешивали бы
 * остальные признаки на порядок, и кластеры получились бы по одной оси.
 */
export function standardize(matrix: Vector[]): { rows: number[][]; stats: Array<{ mean: number; sd: number }> } {
  const stats = columnStats(matrix);
  const rows = matrix.map((row) =>
    row.map((value, j) => {
      const { mean, sd } = stats[j] ?? { mean: 0, sd: 1 };
      return sd === 0 ? 0 : (value - mean) / sd;
    })
  );
  return { rows, stats };
}


export function distanceSquared(a: Vector, b: Vector): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return sum;
}

export function meanVector(rows: Vector[]): number[] {
  if (rows.length === 0) return [];
  const width = rows[0].length;
  const out = new Array<number>(width).fill(0);
  for (const row of rows) {
    for (let i = 0; i < width; i += 1) out[i] += row[i];
  }
  return out.map((value) => value / rows.length);
}

/**
 * k-means с инициализацией k-means++ и фиксированным seed.
 * `points` должны быть уже нормированы (см. standardize).
 */
export function kMeans(
  points: Vector[],
  k: number,
  seed = 0x40_4b,
  maxIterations = 100,
  tolerance = 1e-6
): ClusterResult {
  if (points.length === 0) return { labels: [], centroids: [], inertia: 0, iterations: 0 };
  if (k <= 1) {
    return { labels: points.map(() => 0), centroids: [meanVector(points)], inertia: 0, iterations: 0 };
  }
  if (k >= points.length) {
    return { labels: points.map((_, i) => i), centroids: points.map((row) => [...row]), inertia: 0, iterations: 0 };
  }

  const rng = mulberry32(seed >>> 0);
  // k-means++: первый центр случайный, остальные — с весом D² от ближайшего.
  const centroids: number[][] = [[...points[Math.floor(rng() * points.length)]]];
  const closest = points.map((point) => distanceSquared(point, centroids[0]));
  while (centroids.length < k) {
    const total = closest.reduce((a, b) => a + b, 0);
    if (total === 0) {
      centroids.push([...points[Math.floor(rng() * points.length)]]);
    } else {
      let target = rng() * total;
      let index = 0;
      for (let i = 0; i < closest.length; i += 1) {
        target -= closest[i];
        if (target <= 0) {
          index = i;
          break;
        }
      }
      centroids.push([...points[index]]);
    }
    const last = centroids[centroids.length - 1];
    for (let i = 0; i < points.length; i += 1) {
      closest[i] = Math.min(closest[i], distanceSquared(points[i], last));
    }
  }

  const labels = points.map(() => 0);
  let iterations = 0;
  let inertia = 0;
  for (; iterations < maxIterations; iterations += 1) {
    let moved = false;
    inertia = 0;
    for (let i = 0; i < points.length; i += 1) {
      let best = 0;
      let bestDistance = distanceSquared(points[i], centroids[0]);
      for (let c = 1; c < centroids.length; c += 1) {
        const value = distanceSquared(points[i], centroids[c]);
        if (value < bestDistance) {
          bestDistance = value;
          best = c;
        }
      }
      if (labels[i] !== best) moved = true;
      labels[i] = best;
      inertia += bestDistance;
    }
    // Пустой кластер оставляем на месте: иначе он «украдёт» чужой центр.
    for (let c = 0; c < centroids.length; c += 1) {
      const members = points.filter((_, i) => labels[i] === c);
      if (members.length > 0) centroids[c] = meanVector(members);
    }
    if (!moved) break;
    if (inertia <= tolerance) break;
  }

  return { labels, centroids, inertia, iterations };
}

/**
 * Silhouette score: насколько точка ближе к своему кластеру, чем к чужому.
 * Стандартный критерий выбора K.
 *
 * Считается за O(n²k), поэтому для тысяч юнитов его стоит запускать на
 * выборке, а не на всём наборе.
 */
export function silhouetteScore(points: Vector[], labels: number[], k: number): number | null {
  const n = points.length;
  if (n < 3 || k < 2 || k >= n) return null;

  const sizes = new Map<number, number>();
  for (const label of labels) sizes.set(label, (sizes.get(label) ?? 0) + 1);

  let total = 0;
  let counted = 0;
  for (let i = 0; i < n; i += 1) {
    const ownLabel = labels[i];
    const ownSize = sizes.get(ownLabel) ?? 0;
    if (ownSize <= 1) continue; // силуэт одиночки не определён
    let ownSum = 0;
    for (let j = 0; j < n; j += 1) if (labels[j] === ownLabel) ownSum += distanceSquared(points[i], points[j]);
    const a = Math.sqrt(ownSum / (ownSize - 1));

    let b = Infinity;
    for (const [label, size] of sizes) {
      if (label === ownLabel || size === 0) continue;
      let sum = 0;
      for (let j = 0; j < n; j += 1) if (labels[j] === label) sum += distanceSquared(points[i], points[j]);
      b = Math.min(b, Math.sqrt(sum / size));
    }
    if (!Number.isFinite(b)) continue;
    const denominator = Math.max(a, b);
    total += denominator === 0 ? 0 : (b - a) / denominator;
    counted += 1;
  }
  return counted === 0 ? null : total / counted;
}

export interface NaturalBreaks {
  /** Номер группы (0 — самая низкая) для каждого значения, по порядку входа. */
  labels: number[];
  /** Границы между группами, по возрастанию (среднее между соседними значениями). */
  boundaries: number[];
  /** Сумма квадратов отклонений внутри групп: меньше — разбиение лучше. */
  sse: number;
  /** Размер каждой группы, по возрастанию значений. */
  sizes: number[];
}

/**
 * Натуральные разрывы (Fisher–Jenks) для одномерного набора.
 *
 * Зачем это вместо перцентилей: перцентили режут набор РАВНЫМИ ДОЛЯМИ, поэтому
 * граница тира попадает в середину плотной группы. Два юнита, отличающиеся на
 * 0.1 балла, оказываются по разные стороны такой границы — и получают разные
 * тиры, хотя разницы в игре у них нет. Натуральные разрывы вместо этого
 * минимизируют отклонения внутри групп, а значит ставят границы туда, где
 * между юнитами реальный ПРОВАЛ в оценке.
 *
 * Тот же критерий, что у k-means (сумма квадратов внутри кластеров), но
 * для одного измерения задача решается точно динамическим программированием,
 * а не локальным поиском Lloyd: 1-D k-means зависит от seed и может попасть в
 * неоптимальное разбиение, а здесь результат единственный и воспроизводимый.
 *
 * Каждая группа непустая (минимум одно значение), иначе тир был бы пустым.
 */
export function naturalBreaks(values: number[], requestedGroups: number): NaturalBreaks {
  const n = values.length;
  const groups = Math.max(1, Math.min(requestedGroups, n));
  if (n === 0) return { labels: [], boundaries: [], sse: 0, sizes: [] };
  if (groups === 1) {
    return { labels: values.map(() => 0), boundaries: [], sse: 0, sizes: [n] };
  }

  const sorted = [...values].sort((a, b) => a - b);
  // Префиксные суммы: отрезок [lo, hi) за O(1).
  const prefix = new Float64Array(n + 1);
  const prefixSq = new Float64Array(n + 1);
  for (let i = 0; i < n; i += 1) {
    prefix[i + 1] = prefix[i] + sorted[i];
    prefixSq[i + 1] = prefixSq[i] + sorted[i] * sorted[i];
  }
  const sseOf = (lo: number, hi: number): number => {
    const count = hi - lo;
    if (count <= 1) return 0;
    const sum = prefix[hi] - prefix[lo];
    const sumSq = prefixSq[hi] - prefixSq[lo];
    // Теоретически неотрицательно, но при округлении может уйти в минус.
    return Math.max(0, sumSq - (sum * sum) / count);
  };

  // best[g][i] — минимальная сумма квадратов для первых i значений в g группах.
  const best: Float64Array[] = [];
  const back: Int32Array[] = [];
  for (let g = 0; g <= groups; g += 1) {
    best.push(new Float64Array(n + 1).fill(Number.POSITIVE_INFINITY));
    back.push(new Int32Array(n + 1));
  }
  best[0][0] = 0;
  for (let g = 1; g <= groups; g += 1) {
    for (let i = g; i <= n; i += 1) {
      // j — конец предыдущей группы; группа g непуста, значит j ≤ i - 1.
      for (let j = g - 1; j < i; j += 1) {
        if (best[g - 1][j] === Number.POSITIVE_INFINITY) continue;
        const candidate = best[g - 1][j] + sseOf(j, i);
        if (candidate < best[g][i]) {
          best[g][i] = candidate;
          back[g][i] = j;
        }
      }
    }
  }

  // Восстановление границ с конца.
  const cuts: number[] = [];
  let i = n;
  for (let g = groups; g >= 1; g -= 1) {
    const j = back[g][i];
    if (g > 1) cuts.push(j);
    i = j;
  }
  cuts.reverse();

  /**
   * Сдвигаем границу вправо до конца серии одинаковых значений.
   *
   * Иначе два юнита с РОВНО одинаковым Total оказались бы по разные стороны
   * границы и получили разные тиры. Динамика не запрещает разрезать серию
   * одинаковых чисел (вклад в SSE нулевой), но для тирлиста это абсурд.
   * Более того, соседние сдвиги могут столкнуться, поэтому границы двигаются
   * строго последовательно и не пересекаются.
   */
  const adjusted: number[] = [];
  let previous = 0;
  for (const cut of cuts) {
    let moved = Math.max(cut, previous);
    while (moved < n && sorted[moved] === sorted[moved - 1]) moved += 1;
    adjusted.push(moved);
    previous = moved;
  }

  const labels = values.map((value) => {
    let group = 0;
    for (const cut of adjusted) if (value >= sorted[cut]) group += 1;
    return group;
  });
  const sizes = new Array<number>(groups).fill(0);
  for (const label of labels) sizes[label] += 1;
  // Граница — середина провала между последним элементом нижней группы и
  // первым элементом верхней, а не сами значения: тогда значения, отличающиеся
  // на 0.1, не могут случайно попасть на разные стороны.
  const boundaries = adjusted.map((cut) => {
    const below = sorted[cut - 1];
    const above = sorted[cut];
    return below + (above - below) / 2;
  });
  return { labels, boundaries, sse: best[groups][n], sizes };
}

export interface KChoice {
  k: number;
  silhouette: number;
  inertia: number;
  labels: number[];
  centroids: number[][];
}

/**
 * Перебор K и расчёт силуэта на каждом.
 * `sampleSize` ограничивает набор для силуэта: он квадратичный, а сравнение
 * кластеров нужно на ОДНОЙ И ТОЙ ЖЕ выборке, иначе значения несопоставимы.
 */
export function chooseK(
  matrix: Vector[],
  candidates: number[],
  seed = 0x40_4b,
  sampleSize = 400
): KChoice[] {
  const { rows } = standardize(matrix);
  const step = Math.max(1, Math.floor(rows.length / sampleSize));
  const sample = rows.filter((_, i) => i % step === 0);
  return candidates.map((k) => {
    const result = kMeans(rows, k, seed);
    return {
      k,
      silhouette: silhouetteScore(sample, result.labels.filter((_, i) => i % step === 0), k) ?? -1,
      inertia: result.inertia,
      labels: result.labels,
      centroids: result.centroids,
    };
  });
}

/** Лучший K по силуэту; при равенстве берётся меньший. */
export function bestK(choices: KChoice[]): KChoice {
  return choices.reduce((best, current) =>
    current.silhouette > best.silhouette ? current : best
  );
}


