/**
 * Reproducible benchmark/evaluation. Everything runs offline on bundled or generated SYNTHETIC data.
 * Usage: npm run bench   (writes bench/RESULTS.md)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { cpus, release, type } from "node:os";
import { performance } from "node:perf_hooks";
import { COMPLIANCE_RULES, checkCompliance, type IssueRule, validateVariant } from "../src/campaign/compliance.js";
import { TemplateCampaignWriter } from "../src/campaign/template-writer.js";
import { BriefSchema, CHANNELS, type Channel, GOALS, TONES, type Variant } from "../src/campaign/types.js";
import { generateCustomers, REFERENCE_DATE } from "../src/data/generator.js";
import { simulateExperiment } from "../src/experiment/run.js";
import { segmentCustomers } from "../src/segment/index.js";
import { clusterPurity } from "../src/segment/kmeans.js";

const out: string[] = [];
const log = (line = ""): void => {
  console.log(line);
  out.push(line);
};
const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
const sd = (xs: number[]): number => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));
const f = (x: number, dp = 3): string => x.toFixed(dp);

log("# campaign-forge benchmark results");
log();
log(`- Date: ${new Date().toISOString().slice(0, 10)}`);
log(`- Machine: ${cpus()[0]?.model.trim()} (${cpus().length} logical cores), ${type()} ${release()}, Node ${process.version}`);
log("- Command: `npm run bench`");
log("- Data: SYNTHETIC customers from `generateCustomers` (4 hidden personas), the hand-labelled set in `bench/compliance-set.json`, simulated experiments.");
log("- Copy generation uses the offline `TemplateCampaignWriter`; no LLM numbers are reported here.");
log();

// 1. Segmentation quality ------------------------------------------------------------------------
log("## 1. Segmentation quality (k-means, k chosen by silhouette over 2..8)");
log();
log("| data seed | customers | chosen k | silhouette | purity vs hidden personas | time (s) |");
log("|---|---|---|---|---|---|");
const seg = { sil: [] as number[], pur: [] as number[], k: [] as number[] };
let kScores: { k: number; silhouette: number }[] = [];
for (const seed of [42, 1, 2, 3, 4]) {
  const { customers, labels } = generateCustomers(2000, seed);
  const t0 = performance.now();
  const s = segmentCustomers(customers, { referenceDate: REFERENCE_DATE, seed: 1 });
  const secs = (performance.now() - t0) / 1000;
  const purity = clusterPurity(
    customers.map((c) => s.assignments[c.customer_id]!),
    labels,
  );
  if (seed === 42) kScores = s.kScores;
  seg.sil.push(s.silhouette);
  seg.pur.push(purity);
  seg.k.push(s.k);
  log(`| ${seed} | 2000 | ${s.k} | ${f(s.silhouette)} | ${f(purity)} | ${f(secs, 2)} |`);
}
log(`| **mean** | | | **${f(mean(seg.sil))}** | **${f(mean(seg.pur))}** | |`);
log();
log(`Silhouette by k (seed 42): ${kScores.map((s) => `k=${s.k}: ${f(s.silhouette)}`).join(", ")}`);
log();

// 2. Compliance precision / recall -------------------------------------------------------------
interface Labelled extends Variant {
  id: string;
  channel: Channel;
  violations: IssueRule[];
}
const set = JSON.parse(readFileSync(new URL("./compliance-set.json", import.meta.url), "utf8")) as { messages: Labelled[] };
const counts = Object.fromEntries(COMPLIANCE_RULES.map((r) => [r, { tp: 0, fp: 0, fn: 0 }]));
const msgLevel = { tp: 0, fp: 0, fn: 0, tn: 0 };
const errors: string[] = [];
for (const m of set.messages) {
  const predicted = new Set(checkCompliance(m, m.channel).map((i) => i.rule));
  const truth = new Set(m.violations);
  for (const rule of COMPLIANCE_RULES) {
    const p = predicted.has(rule);
    const t = truth.has(rule);
    if (p && t) counts[rule]!.tp++;
    if (p && !t) counts[rule]!.fp++;
    if (!p && t) counts[rule]!.fn++;
    if (p !== t) errors.push(`${m.id} (${rule}: ${p ? "false positive" : "missed"})`);
  }
  const p = predicted.size > 0;
  const t = truth.size > 0;
  msgLevel[p && t ? "tp" : p ? "fp" : t ? "fn" : "tn"]++;
}
const pr = (c: { tp: number; fp: number; fn: number }): string => {
  const precision = c.tp / (c.tp + c.fp);
  const recall = c.tp / (c.tp + c.fn);
  return `${f(precision)} | ${f(recall)} | ${f((2 * precision * recall) / (precision + recall))}`;
};
log(`## 2. Compliance checker on ${set.messages.length} hand-labelled messages`);
log();
log("| rule | labelled violations | TP | FP | FN | precision | recall | F1 |");
log("|---|---|---|---|---|---|---|---|");
for (const rule of COMPLIANCE_RULES) {
  const c = counts[rule]!;
  log(`| ${rule} | ${c.tp + c.fn} | ${c.tp} | ${c.fp} | ${c.fn} | ${pr(c)} |`);
}
const micro = Object.values(counts).reduce((a, c) => ({ tp: a.tp + c.tp, fp: a.fp + c.fp, fn: a.fn + c.fn }), { tp: 0, fp: 0, fn: 0 });
log(`| **all rules (micro)** | ${micro.tp + micro.fn} | ${micro.tp} | ${micro.fp} | ${micro.fn} | ${pr(micro)} |`);
log(`| **message-level (any violation)** | ${msgLevel.tp + msgLevel.fn} | ${msgLevel.tp} | ${msgLevel.fp} | ${msgLevel.fn} | ${pr(msgLevel)} |`);
log();
log(`Disagreements with the labels: ${errors.join("; ")}.`);
log();

// 3. Bandit vs fixed split ---------------------------------------------------------------------
const rates = [0.04, 0.045, 0.05, 0.06];
const users = 20_000;
const seeds = Array.from({ length: 50 }, (_, i) => i + 1);
log(`## 3. Thompson sampling vs fixed even split (${rates.length} arms, true rates ${rates.join(", ")}, ${users} users, ${seeds.length} seeds)`);
log();
log("| strategy | mean regret (conversions lost) | sd | best-arm traffic share | runs where best arm is the significant winner |");
log("|---|---|---|---|---|");
for (const strategy of ["fixed", "thompson"] as const) {
  const runs = seeds.map((seed) => simulateExperiment({ rates, users, strategy, seed, experimentId: `bench-${seed}` }));
  const regrets = runs.map((r) => r.regret);
  const wins = runs.filter((r) => r.analysis.winner === "D").length;
  log(`| ${strategy} | ${f(mean(regrets), 1)} | ${f(sd(regrets), 1)} | ${f(mean(runs.map((r) => r.bestArmShare)))} | ${wins}/${runs.length} |`);
}
log();
log("Regret is expected regret, sum over users of (best rate - chosen arm's rate). The last column uses the Bonferroni-corrected z-test vs control (A) at alpha = 0.05; Thompson starves weak arms (including the control) of traffic, so its final z-test has less power even though it routes most users to the best arm: lower regret is bought with weaker inference.");
log();

// 4. Variant validation throughput ---------------------------------------------------------------
const writer = new TemplateCampaignWriter();
const profile = {
  id: 0, name: "bench", description: "bench", size: 1, share: 1, medianRecencyDays: 200, medianOrders: 5, medianSpend: 300,
  engagement: { email: 0.2, sms: 0.1, push: 0.1 }, preferredChannel: "email" as const, topTags: [],
};
const pool: [Variant, Channel][] = set.messages.map((m) => [m, m.channel]);
for (const channel of CHANNELS)
  for (const goal of GOALS)
    for (const tone of TONES) {
      const brief = BriefSchema.parse({ brand: "Northwind", product: "Winter Roast", goal, tone, channel, offer: "free shipping" });
      for (const v of await writer.write(brief, profile)) pool.push([v, channel]);
    }
const N = 200_000;
const rates_: number[] = [];
let flagged = 0;
for (let run = 0; run < 6; run++) {
  flagged = 0;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    const [v, ch] = pool[i % pool.length]!;
    if (validateVariant(v, ch).length > 0) flagged++;
  }
  if (run > 0) rates_.push(N / ((performance.now() - t0) / 1000)); // run 0 is JIT warm-up
}
rates_.sort((a, b) => a - b);
log("## 4. Variant validation throughput");
log();
log(`Full \`validateVariant\` (channel limits + banned words + compliance) over a pool of ${pool.length} variants, cycled to ${N.toLocaleString("en-US")} validations, single thread, 5 timed runs after one warm-up run.`);
log();
log("| median variants/s | min | max |");
log("|---|---|---|");
log(`| ${Math.round(rates_[2]!).toLocaleString("en-US")} | ${Math.round(rates_[0]!).toLocaleString("en-US")} | ${Math.round(rates_[4]!).toLocaleString("en-US")} |`);
log();
log(`(${flagged.toLocaleString("en-US")} of the ${N.toLocaleString("en-US")} validations in the last run reported at least one issue.)`);

writeFileSync(new URL("./RESULTS.md", import.meta.url), `${out.join("\n")}\n`);
