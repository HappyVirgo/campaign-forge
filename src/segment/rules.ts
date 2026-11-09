import type { CustomerFeatures } from "./features.js";

/** Rule-based tags; a customer can carry several. */
export const RULE_TAGS = ["vip", "lapsed", "new", "email_engaged", "sms_responsive", "push_responsive", "win_back"] as const;
export type RuleTag = (typeof RULE_TAGS)[number];

export interface RuleThresholds {
  /** Spend percentile (0-1) at or above which a customer is VIP. */
  vipPercentile: number;
  lapsedDays: number;
  newTenureDays: number;
  /** Minimum smoothed open/click rate to count as engaged on a channel. */
  engagedRate: number;
}

export const DEFAULT_THRESHOLDS: RuleThresholds = {
  vipPercentile: 0.9,
  lapsedDays: 120,
  newTenureDays: 60,
  engagedRate: 0.22,
};

/** Value at quantile q (0-1) of a sample, linear interpolation between order statistics. */
export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** Applies the rule set to every customer and returns their tags (index-aligned). */
export function applyRules(features: readonly CustomerFeatures[], t: RuleThresholds = DEFAULT_THRESHOLDS): RuleTag[][] {
  const vipCut = quantile(
    features.map((f) => f.monetary),
    t.vipPercentile,
  );
  const medianSpend = quantile(
    features.map((f) => f.monetary),
    0.5,
  );
  return features.map((f) => {
    const tags: RuleTag[] = [];
    if (f.monetary >= vipCut) tags.push("vip");
    if (f.recencyDays > t.lapsedDays) tags.push("lapsed");
    if (f.tenureDays <= t.newTenureDays) tags.push("new");
    if (f.emailRate >= t.engagedRate) tags.push("email_engaged");
    if (f.smsRate >= t.engagedRate) tags.push("sms_responsive");
    if (f.pushRate >= t.engagedRate) tags.push("push_responsive");
    if (f.recencyDays > t.lapsedDays && f.monetary >= medianSpend) tags.push("win_back");
    return tags;
  });
}
