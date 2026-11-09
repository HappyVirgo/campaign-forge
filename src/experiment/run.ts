import { z } from "zod";
import { Rng } from "../rng.js";
import { assignVariant } from "./assign.js";
import { ThompsonSampler } from "./bandit.js";
import { type Interval, twoProportionZTest, wilsonInterval, type ZTestResult } from "./stats.js";

export const ArmResultSchema = z.object({
  variant: z.string().min(1),
  users: z.number().int().nonnegative(),
  conversions: z.number().int().nonnegative(),
});
export type ArmResult = z.infer<typeof ArmResultSchema>;

export interface ArmSummary extends ArmResult {
  rate: number;
  interval: Interval;
}

export interface Comparison extends ZTestResult {
  variant: string;
  /** Bonferroni-adjusted p-value across all comparisons against the control. */
  adjustedP: number;
  significant: boolean;
}

export interface Analysis {
  control: string;
  arms: ArmSummary[];
  comparisons: Comparison[];
  /** Variant with the highest observed rate among significant winners, else the control. */
  winner: string;
}

/** Compares every arm against the first (control) arm with Bonferroni correction. */
export function analyzeExperiment(arms: readonly ArmResult[], confidence = 0.95): Analysis {
  if (arms.length < 2) throw new RangeError("need a control and at least one variant");
  const [control, ...rest] = arms as [ArmResult, ...ArmResult[]];
  const alpha = 1 - confidence;
  const comparisons = rest.map((arm) => {
    if (control.users === 0 || arm.users === 0) {
      // An arm with no traffic cannot be tested; report it as inconclusive.
      const nan = Number.NaN;
      const empty = { rateA: nan, rateB: nan, diff: nan, lift: nan, z: nan, pValue: 1, diffInterval: { low: nan, high: nan } };
      return { variant: arm.variant, ...empty, adjustedP: 1, significant: false };
    }
    const test = twoProportionZTest(control, arm, confidence);
    const adjustedP = Math.min(1, test.pValue * rest.length);
    return { variant: arm.variant, ...test, adjustedP, significant: adjustedP < alpha };
  });
  const winners = comparisons.filter((c) => c.significant && c.diff > 0).sort((a, b) => b.rateB - a.rateB);
  return {
    control: control.variant,
    arms: arms.map((a) => ({
      ...a,
      rate: a.users === 0 ? 0 : a.conversions / a.users,
      interval: wilsonInterval(a.conversions, a.users, confidence),
    })),
    comparisons,
    winner: winners[0]?.variant ?? control.variant,
  };
}

export const SimulationSchema = z.object({
  /** True conversion rate per variant; the first is the control. */
  rates: z.array(z.number().min(0).max(1)).min(2).max(10),
  users: z.number().int().min(10).max(1_000_000),
  strategy: z.enum(["fixed", "thompson"]).default("fixed"),
  seed: z.number().int().default(1),
  experimentId: z.string().default("sim"),
  /** Variant names, one per rate; defaults to A, B, C, ... */
  variants: z.array(z.string().min(1)).optional(),
}).refine((s) => !s.variants || s.variants.length === s.rates.length, { message: "one variant name per rate" });
export type SimulationInput = z.input<typeof SimulationSchema>;

export interface SimulationResult {
  strategy: "fixed" | "thompson";
  analysis: Analysis;
  /** Expected cumulative regret: sum over users of (best rate - chosen arm's rate). */
  regret: number;
  /** Fraction of traffic that went to the truly best arm. */
  bestArmShare: number;
}

/**
 * Simulates an experiment on synthetic users. "fixed" uses deterministic hash-based even
 * assignment; "thompson" allocates each user with a Thompson-sampling bandit.
 */
export function simulateExperiment(input: SimulationInput): SimulationResult {
  const { rates, users, strategy, seed, experimentId, variants } = SimulationSchema.parse(input);
  const rng = new Rng(seed);
  const names = variants ?? rates.map((_, i) => String.fromCharCode(65 + i));
  const counts = rates.map(() => ({ users: 0, conversions: 0 }));
  const bandit = strategy === "thompson" ? new ThompsonSampler(rates.length, seed + 1) : undefined;
  const best = Math.max(...rates);
  let regret = 0;

  for (let u = 0; u < users; u++) {
    const arm = bandit ? bandit.choose() : names.indexOf(assignVariant(experimentId, `user-${u}`, names));
    const converted = rng.bernoulli(rates[arm]!);
    bandit?.update(arm, converted);
    counts[arm]!.users++;
    if (converted) counts[arm]!.conversions++;
    regret += best - rates[arm]!;
  }

  const bestArms = rates.flatMap((r, i) => (r === best ? [i] : []));
  return {
    strategy,
    analysis: analyzeExperiment(counts.map((c, i) => ({ variant: names[i]!, ...c }))),
    regret,
    bestArmShare: bestArms.reduce((s, i) => s + counts[i]!.users, 0) / users,
  };
}
