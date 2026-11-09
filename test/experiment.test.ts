import { describe, expect, it } from "vitest";
import { assignVariant, hashToUnit } from "../src/experiment/assign.js";
import { ThompsonSampler } from "../src/experiment/bandit.js";
import { analyzeExperiment, simulateExperiment } from "../src/experiment/run.js";
import { Rng } from "../src/rng.js";

describe("assignVariant", () => {
  it("is deterministic per (experiment, user) and independent across experiments", () => {
    const variants = ["A", "B", "C"];
    expect(assignVariant("exp-1", "user-42", variants)).toBe(assignVariant("exp-1", "user-42", variants));
    const users = Array.from({ length: 500 }, (_, i) => `u${i}`);
    const same = users.filter((u) => assignVariant("exp-1", u, variants) === assignVariant("exp-2", u, variants)).length;
    expect(same / users.length).toBeGreaterThan(0.25);
    expect(same / users.length).toBeLessThan(0.42);
  });

  it("splits traffic according to weights", () => {
    const counts = { A: 0, B: 0 };
    for (let i = 0; i < 20000; i++) counts[assignVariant("w", `u${i}`, ["A", "B"], [9, 1]) as "A" | "B"]++;
    expect(counts.A / 20000).toBeCloseTo(0.9, 2);
  });

  it("produces uniform hash values", () => {
    const xs = Array.from({ length: 10000 }, (_, i) => hashToUnit("e", String(i)));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    expect(xs.reduce((s, x) => s + x, 0) / xs.length).toBeCloseTo(0.5, 1);
  });

  it("validates weights", () => {
    expect(() => assignVariant("e", "u", [])).toThrow(RangeError);
    expect(() => assignVariant("e", "u", ["A", "B"], [1])).toThrow(RangeError);
    expect(() => assignVariant("e", "u", ["A", "B"], [0, 0])).toThrow(RangeError);
    expect(assignVariant("e", "u", ["A", "B"], [0, 1])).toBe("B");
  });
});

describe("ThompsonSampler", () => {
  it("draws Beta samples with the right mean", () => {
    const rng = new Rng(3);
    const draws = Array.from({ length: 20000 }, () => rng.beta(3, 7));
    expect(draws.reduce((s, x) => s + x, 0) / draws.length).toBeCloseTo(0.3, 2);
  });

  it("concentrates traffic on the best arm", () => {
    const rates = [0.02, 0.05, 0.1];
    const bandit = new ThompsonSampler(3, 5);
    const rng = new Rng(9);
    const pulls = [0, 0, 0];
    for (let t = 0; t < 5000; t++) {
      const arm = bandit.choose();
      pulls[arm]!++;
      bandit.update(arm, rng.bernoulli(rates[arm]!));
    }
    expect(pulls[2]! / 5000).toBeGreaterThan(0.8);
    expect(bandit.probabilityBest(2000)[2]).toBeGreaterThan(0.9);
  });
});

describe("experiments", () => {
  it("applies Bonferroni correction and picks a significant winner", () => {
    const a = analyzeExperiment([
      { variant: "A", users: 1000, conversions: 200 },
      { variant: "B", users: 1000, conversions: 250 },
      { variant: "C", users: 1000, conversions: 205 },
    ]);
    expect(a.comparisons[0]!.adjustedP).toBeCloseTo(2 * 0.007419649261025674, 6);
    expect(a.winner).toBe("B");
    expect(a.arms[0]!.interval.low).toBeLessThan(0.2);
  });

  it("keeps the control as winner when nothing is significant, and handles empty arms", () => {
    const a = analyzeExperiment([
      { variant: "A", users: 100, conversions: 10 },
      { variant: "B", users: 0, conversions: 0 },
    ]);
    expect(a.winner).toBe("A");
    expect(a.comparisons[0]!.significant).toBe(false);
    expect(() => analyzeExperiment([{ variant: "A", users: 1, conversions: 0 }])).toThrow(RangeError);
  });

  it("simulates reproducibly and the bandit has lower regret than a fixed split", () => {
    const base = { rates: [0.04, 0.05, 0.07], users: 20000, seed: 3 };
    const fixed = simulateExperiment({ ...base, strategy: "fixed" });
    expect(simulateExperiment({ ...base, strategy: "fixed" })).toEqual(fixed);
    const ts = simulateExperiment({ ...base, strategy: "thompson" });
    expect(ts.regret).toBeLessThan(fixed.regret / 2);
    expect(fixed.bestArmShare).toBeCloseTo(1 / 3, 1);
    expect(fixed.analysis.winner).toBe("C");
  });
});
