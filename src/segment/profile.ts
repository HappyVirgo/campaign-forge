import { z } from "zod";
import type { CustomerFeatures } from "./features.js";
import { quantile, RULE_TAGS, type RuleTag } from "./rules.js";

/** Human-readable summary of one cluster; also the segment input to campaign generation. */
export const SegmentProfileSchema = z.object({
  id: z.number().int().nonnegative(),
  name: z.string(),
  description: z.string(),
  size: z.number().int().nonnegative(),
  share: z.number().min(0).max(1),
  medianRecencyDays: z.number(),
  medianOrders: z.number(),
  medianSpend: z.number(),
  engagement: z.object({ email: z.number(), sms: z.number(), push: z.number() }),
  preferredChannel: z.enum(["email", "sms", "push"]),
  /** Share of members carrying each rule tag, only tags present in >= 20% of members. */
  topTags: z.array(z.object({ tag: z.enum(RULE_TAGS), share: z.number() })),
});
export type SegmentProfile = z.infer<typeof SegmentProfileSchema>;

const mean = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
const round = (x: number, dp = 2): number => Math.round(x * 10 ** dp) / 10 ** dp;
const pct = (x: number): string => `${Math.round(x * 100)}%`;

/** Builds one profile per cluster, comparing each to the whole population for naming. */
export function buildProfiles(
  features: readonly CustomerFeatures[],
  assignments: readonly number[],
  tags: readonly RuleTag[][],
): SegmentProfile[] {
  const k = Math.max(...assignments) + 1;
  const overallSpend = quantile(
    features.map((f) => f.monetary),
    0.5,
  );
  const profiles: SegmentProfile[] = [];

  for (let c = 0; c < k; c++) {
    const idx = assignments.flatMap((a, i) => (a === c ? [i] : []));
    if (idx.length === 0) continue;
    const members = idx.map((i) => features[i]!);
    const engagement = {
      email: round(mean(members.map((m) => m.emailRate)), 3),
      sms: round(mean(members.map((m) => m.smsRate)), 3),
      push: round(mean(members.map((m) => m.pushRate)), 3),
    };
    const preferredChannel = (Object.entries(engagement) as [SegmentProfile["preferredChannel"], number][]).reduce(
      (best, cur) => (cur[1] > best[1] ? cur : best),
    )[0];
    const medianRecencyDays = round(quantile(members.map((m) => m.recencyDays), 0.5), 1);
    const medianOrders = quantile(members.map((m) => m.frequency), 0.5);
    const medianSpend = round(quantile(members.map((m) => m.monetary), 0.5));
    const medianTenure = quantile(members.map((m) => m.tenureDays), 0.5);
    const topTags = RULE_TAGS.map((tag) => ({ tag, share: round(idx.filter((i) => tags[i]!.includes(tag)).length / idx.length) }))
      .filter((t) => t.share >= 0.2)
      .sort((a, b) => b.share - a.share);

    const value = medianSpend >= overallSpend * 1.5 ? "High-value" : medianSpend <= overallSpend * 0.6 ? "Low-spend" : "Mid-value";
    const activity = medianRecencyDays <= 30 ? "active" : medianRecencyDays <= 90 ? "cooling" : "lapsed";
    const life = medianTenure <= 90 ? "new" : "established";
    profiles.push({
      id: c,
      name: `${value} · ${activity} · ${preferredChannel}-first`,
      description:
        `${idx.length} ${life} customers (${pct(idx.length / features.length)}). Typically ${medianOrders} orders, ` +
        `$${medianSpend.toFixed(0)} lifetime spend, last order ${Math.round(medianRecencyDays)} days ago. ` +
        `Responds best to ${preferredChannel} (${pct(engagement[preferredChannel])} engagement).`,
      size: idx.length,
      share: round(idx.length / features.length, 4),
      medianRecencyDays,
      medianOrders,
      medianSpend,
      engagement,
      preferredChannel,
      topTags,
    });
  }
  return profiles.sort((a, b) => b.size - a.size);
}
