import type { Customer } from "../data/customer.js";
import { computeFeatures, toMatrix } from "./features.js";
import { selectK } from "./kmeans.js";
import { buildProfiles, type SegmentProfile } from "./profile.js";
import { applyRules, type RuleTag, RULE_TAGS } from "./rules.js";

export interface SegmentationOptions {
  referenceDate: string;
  minK?: number;
  maxK?: number;
  seed?: number;
}

export interface Segmentation {
  k: number;
  silhouette: number;
  kScores: { k: number; silhouette: number; inertia: number }[];
  profiles: SegmentProfile[];
  /** Cluster id per customer, keyed by customer_id. */
  assignments: Record<string, number>;
  /** Number of customers carrying each rule tag. */
  ruleCounts: Record<RuleTag, number>;
}

/** Full pipeline: features -> standardise -> k-means with silhouette-chosen k -> rules -> profiles. */
export function segmentCustomers(customers: readonly Customer[], options: SegmentationOptions): Segmentation {
  if (customers.length < 3) throw new RangeError("need at least 3 customers to segment");
  const features = computeFeatures(customers, options.referenceDate);
  const matrix = toMatrix(features);
  const selection = selectK(matrix, options.minK ?? 2, options.maxK ?? 8, { seed: options.seed ?? 1 });
  const tags = applyRules(features);
  const ruleCounts = Object.fromEntries(RULE_TAGS.map((t) => [t, tags.filter((ts) => ts.includes(t)).length])) as Record<
    RuleTag,
    number
  >;
  return {
    k: selection.best.k,
    silhouette: selection.silhouette,
    kScores: selection.scores,
    profiles: buildProfiles(features, selection.best.assignments, tags),
    assignments: Object.fromEntries(features.map((f, i) => [f.customerId, selection.best.assignments[i]!])),
    ruleCounts,
  };
}
