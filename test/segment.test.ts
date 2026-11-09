import { describe, expect, it } from "vitest";
import { CsvError, parseCustomersCsv, toCsv } from "../src/data/customer.js";
import { generateCustomers, PERSONAS, REFERENCE_DATE } from "../src/data/generator.js";
import { computeFeatures, toMatrix } from "../src/segment/features.js";
import { segmentCustomers } from "../src/segment/index.js";
import { clusterPurity, kmeans, selectK, silhouetteScore } from "../src/segment/kmeans.js";
import { applyRules, quantile } from "../src/segment/rules.js";
import { Rng } from "../src/rng.js";

function blobs(centres: number[][], perBlob: number, sd: number, seed: number): number[][] {
  const rng = new Rng(seed);
  return centres.flatMap((c) => Array.from({ length: perBlob }, () => c.map((x) => rng.normal(x, sd))));
}

describe("kmeans", () => {
  it("recovers well-separated blobs", () => {
    const data = blobs([[0, 0], [10, 0], [0, 10]], 50, 0.5, 1);
    const fit = kmeans(data, 3, { seed: 2 });
    const groups = [0, 1, 2].map((b) => new Set(fit.assignments.slice(b * 50, b * 50 + 50)));
    expect(groups.every((g) => g.size === 1)).toBe(true);
    expect(new Set(groups.map((g) => [...g][0])).size).toBe(3);
  });

  it("is reproducible for a seed and validates k", () => {
    const data = blobs([[0, 0], [5, 5]], 30, 1, 4);
    expect(kmeans(data, 2, { seed: 9 })).toEqual(kmeans(data, 2, { seed: 9 }));
    expect(() => kmeans(data, 0)).toThrow(RangeError);
    expect(() => kmeans(data, 61)).toThrow(RangeError);
  });

  it("computes the silhouette score exactly on a small example", () => {
    // a=1 for every point; b=10.5 for the outer points and 9.5 for the inner ones.
    const s = silhouetteScore([[0], [1], [10], [11]], [0, 0, 1, 1]);
    expect(s).toBeCloseTo((1 - 1 / 10.5 + 1 - 1 / 9.5) / 2, 12);
    expect(silhouetteScore([[0], [1]], [0, 0])).toBe(0);
  });

  it("computes purity against true labels", () => {
    expect(clusterPurity([0, 0, 1, 1], ["a", "a", "b", "b"])).toBe(1);
    expect(clusterPurity([0, 0, 0, 0], ["a", "a", "a", "b"])).toBe(0.75);
  });

  it("selects k by silhouette", () => {
    const data = blobs([[0, 0], [8, 0], [0, 8], [8, 8]], 40, 0.7, 3);
    const sel = selectK(data, 2, 7, { seed: 1 });
    expect(sel.best.k).toBe(4);
    expect(sel.scores.map((s) => s.k)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(() => selectK(data, 1)).toThrow(RangeError);
  });
});

describe("customer data", () => {
  it("generates deterministic synthetic data that round-trips through CSV", () => {
    const { customers, labels } = generateCustomers(200, 5);
    expect(generateCustomers(200, 5).customers).toEqual(customers);
    expect(new Set(labels)).toEqual(new Set(PERSONAS));
    expect(customers[0]!.customer_id).toBe("SYN-000001");
    expect(parseCustomersCsv(toCsv(customers))).toEqual(customers);
  });

  it("reports the failing line for invalid rows", () => {
    const csv = toCsv(generateCustomers(3, 1).customers).replace(/\n(SYN-000002,[^,]*,[^,]*),\d+,/, "\n$1,-4,");
    expect(() => parseCustomersCsv(csv)).toThrow(/line 3/);
    expect(() => parseCustomersCsv("customer_id\nX")).toThrow(CsvError);
    expect(() => parseCustomersCsv("")).toThrow(/empty/);
  });

  it("accepts customers who never ordered", () => {
    const header = "customer_id,signup_date,last_order_date,order_count,total_spend,email_sent,email_opened,sms_sent,sms_clicked,push_sent,push_opened";
    const [c] = parseCustomersCsv(`${header}\nSYN-1,2026-09-01,,0,0,0,0,0,0,0,0\n`);
    const [f] = computeFeatures([c!], "2026-10-01");
    expect(f!.recencyDays).toBe(30);
    expect(f!.emailRate).toBeCloseTo(0.1, 10);
  });
});

describe("segmentation pipeline", () => {
  const { customers, labels } = generateCustomers(800, 42);

  it("standardises features to zero mean and unit variance", () => {
    const m = toMatrix(computeFeatures(customers, REFERENCE_DATE));
    for (let j = 0; j < 6; j++) {
      const col = m.map((r) => r[j]!);
      const mean = col.reduce((s, x) => s + x, 0) / col.length;
      expect(mean).toBeCloseTo(0, 9);
      expect(col.reduce((s, x) => s + (x - mean) ** 2, 0) / col.length).toBeCloseTo(1, 9);
    }
  });

  it("recovers the hidden personas with high purity and readable profiles", () => {
    const seg = segmentCustomers(customers, { referenceDate: REFERENCE_DATE });
    expect(seg.k).toBe(4);
    expect(seg.silhouette).toBeGreaterThan(0.4);
    const clusterOf = customers.map((c) => seg.assignments[c.customer_id]!);
    expect(clusterPurity(clusterOf, labels)).toBeGreaterThan(0.9);
    expect(seg.profiles.reduce((s, p) => s + p.size, 0)).toBe(800);
    expect(seg.profiles.some((p) => p.name.includes("lapsed"))).toBe(true);
    expect(seg.profiles[0]!.description).toMatch(/customers \(\d+%\)/);
  });

  it("applies rule-based tags", () => {
    const features = computeFeatures(customers, REFERENCE_DATE);
    const tags = applyRules(features);
    const vip = tags.filter((t) => t.includes("vip")).length / tags.length;
    expect(vip).toBeCloseTo(0.1, 1);
    tags.forEach((t, i) => {
      expect(t.includes("lapsed")).toBe(features[i]!.recencyDays > 120);
      if (t.includes("win_back")) expect(t).toContain("lapsed");
    });
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([], 0.5)).toBeNaN();
  });

  it("rejects datasets too small to cluster", () => {
    expect(() => segmentCustomers(customers.slice(0, 2), { referenceDate: REFERENCE_DATE })).toThrow(RangeError);
  });
});
