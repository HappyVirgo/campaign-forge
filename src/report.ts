import type { CampaignResult } from "./campaign/writer.js";
import type { Analysis } from "./experiment/run.js";
import type { Segmentation } from "./segment/index.js";

/** In-memory workspace shared by the API and the CLI `demo` command. */
export interface Workspace {
  segmentations: Map<string, Segmentation>;
  campaigns: Map<string, CampaignResult>;
  experiments: Map<string, Experiment>;
}

export interface Experiment {
  id: string;
  name: string;
  variants: string[];
  weights: number[];
  analysis?: Analysis;
}

/** Creates an empty workspace. */
export function createWorkspace(): Workspace {
  return { segmentations: new Map(), campaigns: new Map(), experiments: new Map() };
}

const pct = (x: number, dp = 1): string => (Number.isFinite(x) ? `${(x * 100).toFixed(dp)}%` : "n/a");

/** Markdown table of segment profiles. */
export function segmentsMarkdown(s: Segmentation): string {
  const rows = s.profiles.map(
    (p) =>
      `| ${p.id} | ${p.name} | ${p.size} (${pct(p.share, 0)}) | ${Math.round(p.medianRecencyDays)} | ${p.medianOrders} | $${p.medianSpend.toFixed(0)} | ${p.topTags.map((t) => t.tag).join(", ") || "-"} |`,
  );
  return [
    `k = ${s.k} (silhouette ${s.silhouette.toFixed(3)})`,
    "",
    "| id | segment | size | median recency (d) | median orders | median spend | common tags |",
    "|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

/** Markdown summary of generated variants and their validation status. */
export function campaignMarkdown(c: CampaignResult): string {
  const lines = [`Writer: \`${c.writer}\`, channel: ${c.brief.channel}, segment ${c.segmentId}`, ""];
  for (const v of c.variants) {
    lines.push(`- **${v.id}** ${v.approved ? "approved" : `rejected (${v.issues.map((i) => i.rule).join(", ")})`}`);
    if (v.headline) lines.push(`  - headline: ${v.headline}`);
    lines.push(`  - body: ${v.body.replaceAll("\n", " ")}`, `  - CTA: ${v.cta}`);
  }
  return lines.join("\n");
}

/** Markdown table of an experiment analysis. */
export function analysisMarkdown(a: Analysis): string {
  const cmp = new Map(a.comparisons.map((c) => [c.variant, c]));
  const rows = a.arms.map((arm) => {
    const c = cmp.get(arm.variant);
    const vs = c ? `${pct(c.lift)} | ${c.pValue.toPrecision(3)} | ${c.adjustedP.toPrecision(3)}` : "control | - | -";
    return `| ${arm.variant} | ${arm.users} | ${arm.conversions} | ${pct(arm.rate, 2)} [${pct(arm.interval.low, 2)}, ${pct(arm.interval.high, 2)}] | ${vs} |`;
  });
  return [
    "| variant | users | conversions | rate [95% CI] | lift vs control | p | p (Bonferroni) |",
    "|---|---|---|---|---|---|---|",
    ...rows,
    "",
    `Winner: **${a.winner}**`,
  ].join("\n");
}

/** Full workspace report. */
export function workspaceReport(ws: Workspace): string {
  const out = ["# campaign-forge report", ""];
  for (const [id, s] of ws.segmentations) out.push(`## Segmentation ${id}`, "", segmentsMarkdown(s), "");
  for (const [id, c] of ws.campaigns) out.push(`## Campaign ${id}`, "", campaignMarkdown(c), "");
  for (const e of ws.experiments.values()) {
    out.push(`## Experiment ${e.id}: ${e.name}`, "", e.analysis ? analysisMarkdown(e.analysis) : "_No results yet._", "");
  }
  return out.join("\n");
}
