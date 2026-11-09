import { Hono } from "hono";
import { z } from "zod";
import { BriefSchema } from "../campaign/types.js";
import { type CampaignWriter, generateCampaign } from "../campaign/writer.js";
import { CsvError, parseCustomersCsv } from "../data/customer.js";
import { generateCustomers, REFERENCE_DATE } from "../data/generator.js";
import { assignVariant } from "../experiment/assign.js";
import { ArmResultSchema, analyzeExperiment, SimulationSchema, simulateExperiment } from "../experiment/run.js";
import { minSampleSize } from "../experiment/stats.js";
import { createWorkspace, type Workspace, workspaceReport } from "../report.js";
import { segmentCustomers } from "../segment/index.js";
import { SegmentProfileSchema } from "../segment/profile.js";

const SegmentRequest = z
  .object({
    csv: z.string().optional(),
    synthetic: z.object({ n: z.number().int().min(10).max(5000), seed: z.number().int().default(42) }).optional(),
    referenceDate: z.iso.date().default(REFERENCE_DATE),
    maxK: z.number().int().min(2).max(10).default(8),
  })
  .refine((r) => (r.csv === undefined) !== (r.synthetic === undefined), { message: "provide exactly one of csv or synthetic" });

const CampaignRequest = z.union([
  z.object({ brief: BriefSchema, segmentationId: z.string(), segmentId: z.number().int() }),
  z.object({ brief: BriefSchema, profile: SegmentProfileSchema }),
]);

const ExperimentRequest = z
  .object({
    name: z.string().min(1),
    variants: z.array(z.string().min(1)).min(2).max(10),
    weights: z.array(z.number().nonnegative()).optional(),
  })
  .refine((e) => !e.weights || e.weights.length === e.variants.length, { message: "one weight per variant" });

const SampleSizeQuery = z.object({
  baseline: z.coerce.number(),
  mde: z.coerce.number(),
  alpha: z.coerce.number().default(0.05),
  power: z.coerce.number().default(0.8),
});

class NotFound extends Error {}

export interface AppOptions {
  writer: CampaignWriter;
  workspace?: Workspace;
}

/** Builds the HTTP API. State lives in an in-memory {@link Workspace}. */
export function createApp({ writer, workspace = createWorkspace() }: AppOptions): Hono {
  const app = new Hono();
  let seq = 0;
  const nextId = (prefix: string): string => `${prefix}-${++seq}`;

  app.onError((err, c) => {
    if (err instanceof z.ZodError) return c.json({ error: "invalid request", issues: err.issues }, 400);
    if (err instanceof NotFound) return c.json({ error: err.message }, 404);
    if (err instanceof RangeError || err instanceof SyntaxError || err instanceof CsvError) return c.json({ error: err.message }, 400);
    return c.json({ error: err.message }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true, writer: writer.name }));

  app.post("/segments", async (c) => {
    const req = SegmentRequest.parse(await c.req.json());
    const customers = req.csv !== undefined ? parseCustomersCsv(req.csv) : generateCustomers(req.synthetic!.n, req.synthetic!.seed).customers;
    const seg = segmentCustomers(customers, { referenceDate: req.referenceDate, maxK: req.maxK });
    const id = nextId("seg");
    workspace.segmentations.set(id, seg);
    const { assignments: _omit, ...summary } = seg;
    return c.json({ id, customers: customers.length, ...summary }, 201);
  });

  app.get("/segments/:id", (c) => {
    const seg = workspace.segmentations.get(c.req.param("id"));
    if (!seg) throw new NotFound("segmentation not found");
    return c.json(seg);
  });

  app.post("/campaigns", async (c) => {
    const req = CampaignRequest.parse(await c.req.json());
    let profile = "profile" in req ? req.profile : undefined;
    if ("segmentationId" in req) {
      profile = workspace.segmentations.get(req.segmentationId)?.profiles.find((p) => p.id === req.segmentId);
      if (!profile) throw new NotFound("segment not found");
    }
    const result = await generateCampaign(writer, req.brief, profile!);
    const id = nextId("cmp");
    workspace.campaigns.set(id, result);
    return c.json({ id, ...result }, 201);
  });

  app.post("/experiments", async (c) => {
    const req = ExperimentRequest.parse(await c.req.json());
    const experiment = { id: nextId("exp"), name: req.name, variants: req.variants, weights: req.weights ?? req.variants.map(() => 1) };
    workspace.experiments.set(experiment.id, experiment);
    return c.json(experiment, 201);
  });

  app.get("/experiments/:id/assign/:userId", (c) => {
    const exp = workspace.experiments.get(c.req.param("id"));
    if (!exp) throw new NotFound("experiment not found");
    return c.json({ userId: c.req.param("userId"), variant: assignVariant(exp.id, c.req.param("userId"), exp.variants, exp.weights) });
  });

  app.post("/experiments/:id/results", async (c) => {
    const exp = workspace.experiments.get(c.req.param("id"));
    if (!exp) throw new NotFound("experiment not found");
    const arms = z.object({ arms: z.array(ArmResultSchema).min(2) }).parse(await c.req.json()).arms;
    exp.analysis = analyzeExperiment(arms);
    return c.json(exp.analysis);
  });

  app.post("/simulations", async (c) => c.json(simulateExperiment(SimulationSchema.parse(await c.req.json()))));

  app.get("/sample-size", (c) => {
    const q = SampleSizeQuery.parse(c.req.query());
    return c.json({ ...q, perArm: minSampleSize(q) });
  });

  app.get("/report", (c) => c.text(workspaceReport(workspace), 200, { "content-type": "text/markdown; charset=utf-8" }));

  return app;
}
