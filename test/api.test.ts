import { describe, expect, it } from "vitest";
import { createApp } from "../src/api/app.js";
import { TemplateCampaignWriter } from "../src/campaign/template-writer.js";
import { toCsv } from "../src/data/customer.js";
import { generateCustomers } from "../src/data/generator.js";

const post = (_path: string, body: unknown) =>
  ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) satisfies RequestInit;

describe("HTTP API", () => {
  it("runs the full flow: segment, campaign, experiment, report", async () => {
    const app = createApp({ writer: new TemplateCampaignWriter() });

    const segRes = await app.request("/segments", post("/segments", { synthetic: { n: 300, seed: 1 }, maxK: 5 }));
    expect(segRes.status).toBe(201);
    const seg = (await segRes.json()) as { id: string; k: number; profiles: { id: number }[]; assignments?: unknown };
    expect(seg.profiles).toHaveLength(seg.k);
    expect(seg.assignments).toBeUndefined();

    const cmpRes = await app.request(
      "/campaigns",
      post("/campaigns", {
        segmentationId: seg.id,
        segmentId: seg.profiles[0]!.id,
        brief: { brand: "Northwind", product: "Winter Roast", goal: "retention", tone: "premium", channel: "sms", variantCount: 2 },
      }),
    );
    expect(cmpRes.status).toBe(201);
    const cmp = (await cmpRes.json()) as { variants: { id: string; approved: boolean }[] };
    expect(cmp.variants.map((v) => v.approved)).toEqual([true, true]);

    const exp = (await (await app.request("/experiments", post("/experiments", { name: "sms test", variants: ["A", "B"] }))).json()) as {
      id: string;
    };
    const a1 = await (await app.request(`/experiments/${exp.id}/assign/user-1`)).json();
    const a2 = await (await app.request(`/experiments/${exp.id}/assign/user-1`)).json();
    expect(a1).toEqual(a2);

    const analysis = (await (
      await app.request(
        `/experiments/${exp.id}/results`,
        post("", { arms: [{ variant: "A", users: 1000, conversions: 200 }, { variant: "B", users: 1000, conversions: 250 }] }),
      )
    ).json()) as { winner: string };
    expect(analysis.winner).toBe("B");

    const report = await (await app.request("/report")).text();
    expect(report).toContain("## Segmentation seg-1");
    expect(report).toContain("Winner: **B**");
  });

  it("accepts a CSV upload and a profile directly", async () => {
    const app = createApp({ writer: new TemplateCampaignWriter() });
    const res = await app.request("/segments", post("", { csv: toCsv(generateCustomers(120, 3).customers), maxK: 4 }));
    expect(res.status).toBe(201);
    const { profiles } = (await res.json()) as { profiles: unknown[] };
    const cmp = await app.request(
      "/campaigns",
      post("", { profile: profiles[0], brief: { brand: "B", product: "P", goal: "awareness", tone: "playful", channel: "push" } }),
    );
    expect(cmp.status).toBe(201);
  });

  it("simulates experiments and computes sample sizes", async () => {
    const app = createApp({ writer: new TemplateCampaignWriter() });
    const sim = (await (await app.request("/simulations", post("", { rates: [0.05, 0.08], users: 5000, strategy: "thompson" }))).json()) as {
      strategy: string;
      regret: number;
    };
    expect(sim.strategy).toBe("thompson");
    expect(sim.regret).toBeGreaterThan(0);
    expect(await (await app.request("/sample-size?baseline=0.1&mde=0.02")).json()).toMatchObject({ perArm: 3841 });
  });

  it("returns 400 for invalid input and 404 for unknown ids", async () => {
    const app = createApp({ writer: new TemplateCampaignWriter() });
    expect((await app.request("/segments", post("", {}))).status).toBe(400);
    expect((await app.request("/segments", post("", { csv: "bad" }))).status).toBe(400);
    expect((await app.request("/segments/nope")).status).toBe(404);
    expect((await app.request("/experiments/nope/assign/u")).status).toBe(404);
    expect((await app.request("/sample-size?baseline=2&mde=0.1")).status).toBe(400);
    const badBrief = { profile: {}, brief: { brand: "B", product: "P", goal: "x", tone: "friendly", channel: "fax" } };
    expect((await app.request("/campaigns", post("", badBrief))).status).toBe(400);
  });
});
