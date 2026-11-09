import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { createApp } from "./api/app.js";
import { BriefSchema } from "./campaign/types.js";
import { createWriter, generateCampaign } from "./campaign/writer.js";
import { parseCustomersCsv, toCsv } from "./data/customer.js";
import { generateCustomers, REFERENCE_DATE } from "./data/generator.js";
import { simulateExperiment } from "./experiment/run.js";
import { minSampleSize } from "./experiment/stats.js";
import { analysisMarkdown, campaignMarkdown, createWorkspace, segmentsMarkdown, workspaceReport } from "./report.js";
import { segmentCustomers } from "./segment/index.js";

const USAGE = `campaign-forge <command> [options]

  generate-data  --n 2000 --seed 42 --out data/customers.csv   write SYNTHETIC customers
  segment        <customers.csv> [--max-k 8] [--json]          k-means + rule segments
  campaign       <customers.csv> --brief brief.json [--segment N] [--json]
  simulate       --rates 0.05,0.06 --users 20000 [--strategy fixed|thompson] [--seed 1]
  sample-size    --baseline 0.10 --mde 0.02 [--alpha 0.05] [--power 0.8]
  report         <customers.csv> --brief brief.json             end-to-end markdown report
  serve          [--port 3000]                                  start the HTTP API`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    n: { type: "string", default: "2000" },
    seed: { type: "string", default: "42" },
    out: { type: "string" },
    "max-k": { type: "string", default: "8" },
    "reference-date": { type: "string", default: REFERENCE_DATE },
    json: { type: "boolean", default: false },
    brief: { type: "string" },
    segment: { type: "string" },
    rates: { type: "string", default: "0.05,0.06" },
    users: { type: "string", default: "20000" },
    strategy: { type: "string", default: "fixed" },
    baseline: { type: "string", default: "0.1" },
    mde: { type: "string", default: "0.02" },
    alpha: { type: "string", default: "0.05" },
    power: { type: "string", default: "0.8" },
    port: { type: "string", default: process.env.PORT ?? "3000" },
  },
});

const [command, file] = positionals;
const print = (x: unknown): void => console.log(typeof x === "string" ? x : JSON.stringify(x, null, 2));

function loadSegmentation(path: string | undefined) {
  if (!path) throw new Error("missing <customers.csv>");
  return segmentCustomers(parseCustomersCsv(readFileSync(path, "utf8")), {
    referenceDate: values["reference-date"],
    maxK: Number(values["max-k"]),
    seed: Number(values.seed),
  });
}

function loadBrief() {
  if (!values.brief) throw new Error("missing --brief <file.json>");
  return BriefSchema.parse(JSON.parse(readFileSync(values.brief, "utf8")));
}

async function main(): Promise<void> {
  switch (command) {
    case "generate-data": {
      const csv = toCsv(generateCustomers(Number(values.n), Number(values.seed)).customers);
      if (values.out) writeFileSync(values.out, csv);
      else process.stdout.write(csv);
      return;
    }
    case "segment": {
      const seg = loadSegmentation(file);
      const { assignments: _omit, ...summary } = seg;
      print(values.json ? summary : segmentsMarkdown(seg));
      return;
    }
    case "campaign": {
      const seg = loadSegmentation(file);
      const profile = values.segment ? seg.profiles.find((p) => p.id === Number(values.segment)) : seg.profiles[0];
      if (!profile) throw new Error(`segment ${values.segment} not found`);
      const result = await generateCampaign(createWriter(), loadBrief(), profile);
      print(values.json ? result : campaignMarkdown(result));
      return;
    }
    case "simulate": {
      const result = simulateExperiment({
        rates: values.rates.split(",").map(Number),
        users: Number(values.users),
        strategy: values.strategy as "fixed" | "thompson",
        seed: Number(values.seed),
      });
      print(values.json ? result : `${analysisMarkdown(result.analysis)}\n\nRegret: ${result.regret.toFixed(1)}, best-arm share: ${(result.bestArmShare * 100).toFixed(1)}%`);
      return;
    }
    case "sample-size":
      print({ perArm: minSampleSize({ baseline: Number(values.baseline), mde: Number(values.mde), alpha: Number(values.alpha), power: Number(values.power) }) });
      return;
    case "report": {
      const ws = createWorkspace();
      const seg = loadSegmentation(file);
      ws.segmentations.set("seg-1", seg);
      const brief = loadBrief();
      const campaign = await generateCampaign(createWriter(), brief, seg.profiles[0]!);
      ws.campaigns.set("cmp-1", campaign);
      const approved = campaign.variants.filter((v) => v.approved);
      // Synthetic true rates: each later variant converts slightly better, to illustrate the analysis.
      const rates = approved.map((_, i) => 0.04 + 0.006 * i);
      if (rates.length >= 2) {
        const variants = approved.map((v) => v.id);
        const sim = simulateExperiment({ rates, users: 30_000, seed: Number(values.seed), experimentId: "exp-1", variants });
        ws.experiments.set("exp-1", { id: "exp-1", name: "Simulated send (synthetic rates)", variants, weights: rates.map(() => 1), analysis: sim.analysis });
      }
      print(workspaceReport(ws));
      return;
    }
    case "serve": {
      const writer = createWriter();
      const port = Number(values.port);
      serve({ fetch: createApp({ writer }).fetch, port });
      console.log(`campaign-forge API on http://localhost:${port} (writer: ${writer.name})`);
      return;
    }
    default:
      console.log(USAGE);
      process.exitCode = command ? 1 : 0;
  }
}

main().catch((err: unknown) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
