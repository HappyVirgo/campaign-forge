import { Rng } from "../rng.js";

export type Matrix = readonly (readonly number[])[];

export interface KMeansResult {
  k: number;
  centroids: number[][];
  assignments: number[];
  /** Sum of squared distances to the assigned centroid. */
  inertia: number;
  iterations: number;
}

export interface KMeansOptions {
  seed?: number;
  /** Independent k-means++ restarts; the lowest-inertia run wins. */
  restarts?: number;
  maxIterations?: number;
}

/** Squared Euclidean distance. */
export function sqDist(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i]! - b[i]!) ** 2;
  return s;
}

function nearest(point: readonly number[], centroids: readonly number[][]): [index: number, dist: number] {
  let best = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let c = 0; c < centroids.length; c++) {
    const d = sqDist(point, centroids[c]!);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return [best, bestDist];
}

/** k-means++ seeding: each new centre is drawn with probability proportional to D(x)^2. */
function seedCentroids(data: Matrix, k: number, rng: Rng): number[][] {
  const centroids = [[...data[rng.int(data.length)]!]];
  while (centroids.length < k) {
    const weights = data.map((p) => nearest(p, centroids)[1]);
    centroids.push([...data[rng.weighted(weights)]!]);
  }
  return centroids;
}

function lloyd(data: Matrix, k: number, rng: Rng, maxIterations: number): KMeansResult {
  const dims = data[0]!.length;
  let centroids = seedCentroids(data, k, rng);
  const assignments = new Array<number>(data.length).fill(-1);
  let iterations = 0;

  for (; iterations < maxIterations; iterations++) {
    let changed = false;
    data.forEach((p, i) => {
      const [c] = nearest(p, centroids);
      if (assignments[i] !== c) {
        assignments[i] = c;
        changed = true;
      }
    });
    if (!changed) break;

    const sums = Array.from({ length: k }, () => new Array<number>(dims).fill(0));
    const counts = new Array<number>(k).fill(0);
    data.forEach((p, i) => {
      const c = assignments[i]!;
      counts[c]!++;
      for (let j = 0; j < dims; j++) sums[c]![j]! += p[j]!;
    });
    // An emptied cluster keeps its previous centre rather than collapsing to NaN.
    centroids = sums.map((s, c) => (counts[c]! > 0 ? s.map((v) => v / counts[c]!) : centroids[c]!));
  }

  const inertia = data.reduce((s, p, i) => s + sqDist(p, centroids[assignments[i]!]!), 0);
  return { k, centroids, assignments, inertia, iterations };
}

/** Runs k-means (Lloyd's algorithm, k-means++ init) with seeded restarts. */
export function kmeans(data: Matrix, k: number, options: KMeansOptions = {}): KMeansResult {
  if (k < 1 || k > data.length) throw new RangeError(`k must be in [1, ${data.length}], got ${k}`);
  const rng = new Rng(options.seed ?? 1);
  let best: KMeansResult | undefined;
  for (let r = 0; r < (options.restarts ?? 5); r++) {
    const run = lloyd(data, k, rng, options.maxIterations ?? 100);
    if (!best || run.inertia < best.inertia) best = run;
  }
  return best!;
}

/**
 * Mean silhouette coefficient over all points (exact, O(n^2)).
 * Points in singleton clusters score 0, following Rousseeuw (1987).
 */
export function silhouetteScore(data: Matrix, assignments: readonly number[]): number {
  const k = Math.max(...assignments) + 1;
  const sizes = new Array<number>(k).fill(0);
  for (const a of assignments) sizes[a]!++;
  if (sizes.filter((s) => s > 0).length < 2) return 0;

  let total = 0;
  const sums = new Array<number>(k);
  for (let i = 0; i < data.length; i++) {
    sums.fill(0);
    for (let j = 0; j < data.length; j++) if (i !== j) sums[assignments[j]!]! += Math.sqrt(sqDist(data[i]!, data[j]!));
    const own = assignments[i]!;
    if (sizes[own]! <= 1) continue;
    const a = sums[own]! / (sizes[own]! - 1);
    let b = Number.POSITIVE_INFINITY;
    for (let c = 0; c < k; c++) if (c !== own && sizes[c]! > 0) b = Math.min(b, sums[c]! / sizes[c]!);
    total += (b - a) / Math.max(a, b);
  }
  return total / data.length;
}

export interface KSelection {
  best: KMeansResult;
  silhouette: number;
  /** Silhouette score per candidate k, for reporting. */
  scores: { k: number; silhouette: number; inertia: number }[];
}

/** Fits k-means for every k in [minK, maxK] and keeps the k with the highest silhouette score. */
export function selectK(data: Matrix, minK = 2, maxK = 8, options: KMeansOptions = {}): KSelection {
  if (minK < 2) throw new RangeError("silhouette needs at least 2 clusters");
  let best: KSelection | undefined;
  const scores: KSelection["scores"] = [];
  for (let k = minK; k <= Math.min(maxK, data.length - 1); k++) {
    const fit = kmeans(data, k, options);
    const silhouette = silhouetteScore(data, fit.assignments);
    scores.push({ k, silhouette, inertia: fit.inertia });
    if (!best || silhouette > best.silhouette) best = { best: fit, silhouette, scores };
  }
  if (!best) throw new RangeError("not enough points to cluster");
  return best;
}

/** Cluster purity: share of points whose cluster's majority true label matches their own. */
export function clusterPurity(assignments: readonly number[], labels: readonly string[]): number {
  const byCluster = new Map<number, Map<string, number>>();
  assignments.forEach((cluster, i) => {
    const counts = byCluster.get(cluster) ?? new Map<string, number>();
    counts.set(labels[i]!, (counts.get(labels[i]!) ?? 0) + 1);
    byCluster.set(cluster, counts);
  });
  let majority = 0;
  for (const counts of byCluster.values()) majority += Math.max(...counts.values());
  return majority / assignments.length;
}
