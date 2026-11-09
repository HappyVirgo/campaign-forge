import { describe, expect, it } from "vitest";
import {
  minSampleSize,
  normalCdf,
  normalQuantile,
  twoProportionZTest,
  wilsonInterval,
} from "../src/experiment/stats.js";
import { Rng } from "../src/rng.js";

// Reference values computed with Python's statistics.NormalDist (an independent implementation)
// and, for Wilson, the worked example on Wikipedia's "Binomial proportion confidence interval".
describe("normal distribution", () => {
  it("matches reference CDF values", () => {
    expect(normalCdf(1.96)).toBeCloseTo(0.9750021048517796, 12);
    expect(normalCdf(-1)).toBeCloseTo(0.15865525393145713, 12);
    expect(normalCdf(0)).toBe(0.5);
  });

  it("matches reference quantiles", () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.9599639845400536, 10);
    expect(normalQuantile(0.995)).toBeCloseTo(2.5758293035489, 10);
    expect(normalQuantile(0.8)).toBeCloseTo(0.8416212335729144, 10);
    expect(normalQuantile(0.001)).toBeCloseTo(-3.090232306167813, 10);
  });

  it("rejects probabilities outside (0, 1)", () => {
    expect(() => normalQuantile(0)).toThrow(RangeError);
    expect(() => normalQuantile(1)).toThrow(RangeError);
  });
});

describe("twoProportionZTest", () => {
  it("matches a hand-computed reference (20% vs 25%, n=1000 each)", () => {
    const r = twoProportionZTest({ users: 1000, conversions: 200 }, { users: 1000, conversions: 250 });
    expect(r.z).toBeCloseTo(2.677397763008329, 6);
    expect(r.pValue).toBeCloseTo(0.007419649261025674, 6);
    expect(r.diffInterval.low).toBeCloseTo(0.013463621687539847, 6);
    expect(r.diffInterval.high).toBeCloseTo(0.08653637831246014, 6);
    expect(r.lift).toBeCloseTo(0.25, 10);
  });

  it("matches a second reference (4.8% vs 5.6%, n=10000 each)", () => {
    const r = twoProportionZTest({ users: 10000, conversions: 480 }, { users: 10000, conversions: 560 });
    expect(r.z).toBeCloseTo(2.5478223832249745, 6);
    expect(r.pValue).toBeCloseTo(0.010839764531605178, 6);
  });

  it("is antisymmetric and handles identical zero-variance arms", () => {
    const a = { users: 500, conversions: 40 };
    const b = { users: 400, conversions: 50 };
    expect(twoProportionZTest(a, b).z).toBeCloseTo(-twoProportionZTest(b, a).z, 12);
    const zero = twoProportionZTest({ users: 10, conversions: 0 }, { users: 10, conversions: 0 });
    expect(zero.z).toBe(0);
    expect(zero.pValue).toBeCloseTo(1, 9);
    expect(() => twoProportionZTest({ users: 0, conversions: 0 }, b)).toThrow(RangeError);
  });

  it("keeps the type I error near alpha under the null (simulation)", () => {
    const rng = new Rng(7);
    let rejections = 0;
    const trials = 4000;
    for (let t = 0; t < trials; t++) {
      const a = { users: 2000, conversions: rng.binomial(2000, 0.1) };
      const b = { users: 2000, conversions: rng.binomial(2000, 0.1) };
      if (twoProportionZTest(a, b).pValue < 0.05) rejections++;
    }
    expect(rejections / trials).toBeGreaterThan(0.04);
    expect(rejections / trials).toBeLessThan(0.06);
  });
});

describe("wilsonInterval", () => {
  it("matches the textbook example 81/263", () => {
    const ci = wilsonInterval(81, 263);
    expect(ci.low).toBeCloseTo(0.2552885198782743, 6);
    expect(ci.high).toBeCloseTo(0.3662095769828001, 6);
  });

  it("stays inside [0, 1] at the boundaries", () => {
    const ci = wilsonInterval(0, 50);
    expect(ci.low).toBe(0);
    expect(ci.high).toBeCloseTo(0.07134759913335868, 6);
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 });
  });
});

describe("minSampleSize", () => {
  it("matches reference values", () => {
    expect(minSampleSize({ baseline: 0.1, mde: 0.02 })).toBe(3841);
    expect(minSampleSize({ baseline: 0.05, mde: 0.01 })).toBe(8158);
    expect(minSampleSize({ baseline: 0.2, mde: 0.05, alpha: 0.01, power: 0.9 })).toBe(2074);
  });

  it("achieves the requested power in simulation", () => {
    const n = minSampleSize({ baseline: 0.1, mde: 0.03 });
    const rng = new Rng(11);
    let detected = 0;
    const trials = 2000;
    for (let t = 0; t < trials; t++) {
      const a = { users: n, conversions: rng.binomial(n, 0.1) };
      const b = { users: n, conversions: rng.binomial(n, 0.13) };
      if (twoProportionZTest(a, b).pValue < 0.05) detected++;
    }
    expect(detected / trials).toBeGreaterThan(0.77);
    expect(detected / trials).toBeLessThan(0.83);
  });

  it("rejects impossible inputs", () => {
    expect(() => minSampleSize({ baseline: 0.99, mde: 0.02 })).toThrow(RangeError);
    expect(() => minSampleSize({ baseline: 0.1, mde: 0 })).toThrow(RangeError);
  });
});
