import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { ClaudeCampaignWriter, CLAUDE_MODEL, describeApiError, type MessagesClient } from "../src/campaign/claude-writer.js";
import { checkBrandVoice, checkChannel, checkCompliance, enforceRequiredLines, validateVariant } from "../src/campaign/compliance.js";
import { TemplateCampaignWriter } from "../src/campaign/template-writer.js";
import { BriefSchema, CHANNELS, GOALS, renderSms, TONES, type Variant } from "../src/campaign/types.js";
import { createWriter, generateCampaign } from "../src/campaign/writer.js";
import type { SegmentProfile } from "../src/segment/profile.js";

const PROFILE: SegmentProfile = {
  id: 0,
  name: "Mid-value · lapsed · email-first",
  description: "test segment",
  size: 100,
  share: 0.25,
  medianRecencyDays: 200,
  medianOrders: 5,
  medianSpend: 300,
  engagement: { email: 0.1, sms: 0.05, push: 0.04 },
  preferredChannel: "email",
  topTags: [{ tag: "lapsed", share: 1 }],
};

const brief = (over: object = {}) =>
  BriefSchema.parse({ brand: "Northwind", product: "Winter Roast", goal: "conversion", tone: "friendly", channel: "email", ...over });

const rules = (issues: { rule: string }[]) => issues.map((i) => i.rule);

describe("channel constraints", () => {
  it("enforces subject and SMS length limits", () => {
    const long: Variant = { headline: "x".repeat(61), body: "Hi. Unsubscribe here", cta: "Go" };
    expect(rules(checkChannel(long, "email"))).toEqual(["headline_length"]);
    const sms: Variant = { headline: null, body: "y".repeat(150), cta: "Shop: https://x.co" };
    expect(renderSms(sms).length).toBe(169);
    expect(rules(checkChannel(sms, "sms"))).toEqual(["sms_length"]);
    expect(rules(checkChannel({ ...sms, headline: "Hi", body: "short" }, "sms"))).toEqual(["headline_forbidden"]);
    expect(rules(checkChannel({ headline: " ", body: "b", cta: "c" }, "push"))).toEqual(["headline_missing"]);
  });
});

describe("brand voice and compliance", () => {
  it("flags banned words as whole words only", () => {
    expect(rules(checkBrandVoice({ headline: "Act now!", body: "So cheap", cta: "Go" }))).toEqual(["banned_word", "banned_word"]);
    expect(checkBrandVoice({ headline: "Cheapskate tips", body: "ok", cta: "Go" })).toEqual([]);
  });

  it("requires an unsubscribe line in email and STOP in SMS", () => {
    expect(rules(checkCompliance({ headline: "Hi", body: "Hello", cta: "Go" }, "email"))).toEqual(["missing_unsubscribe"]);
    expect(rules(checkCompliance({ headline: null, body: "Hello", cta: "Go" }, "sms"))).toEqual(["missing_opt_out"]);
    expect(checkCompliance({ headline: null, body: "Hello. Reply STOP to opt out.", cta: "Go" }, "sms")).toEqual([]);
  });

  it("flags unverifiable claims and undisclosed free offers", () => {
    const v: Variant = { headline: "Guaranteed results", body: "Free gift! Manage preferences", cta: "Go" };
    expect(rules(checkCompliance(v, "email"))).toEqual(["unverifiable_claim", "free_without_disclaimer"]);
    expect(checkCompliance({ ...v, headline: "New", body: "Free gift, terms apply. Unsubscribe" }, "email")).toEqual([]);
    expect(checkCompliance({ headline: "Gluten-free bakes", body: "Unsubscribe", cta: "Go" }, "email")).toEqual([]);
  });

  it("adds required lines mechanically but leaves claims for rejection", () => {
    const fixed = enforceRequiredLines({ headline: "Hi", body: "Free mug inside.", cta: "Go" }, "email", "https://x.co");
    expect(fixed.body).toBe("Free mug inside. Terms apply.\n\nUnsubscribe: https://x.co/unsubscribe");
    expect(validateVariant(fixed, "email")).toEqual([]);
    const sms = enforceRequiredLines({ headline: null, body: "100% guaranteed!", cta: "Go" }, "sms", "https://x.co");
    expect(sms.body).toContain("Reply STOP");
    expect(rules(validateVariant(sms, "sms"))).toEqual(["unverifiable_claim", "unverifiable_claim"]);
  });
});

describe("TemplateCampaignWriter", () => {
  it("produces approved variants for every channel, goal and tone", async () => {
    const writer = new TemplateCampaignWriter();
    for (const channel of CHANNELS)
      for (const goal of GOALS)
        for (const tone of TONES) {
          const result = await generateCampaign(writer, brief({ channel, goal, tone, offer: "free shipping", variantCount: 3 }), PROFILE);
          for (const v of result.variants) expect(v.issues, `${channel}/${goal}/${tone}`).toEqual([]);
        }
  });

  it("falls back to the short SMS form when the long one would exceed 160 chars", async () => {
    const b = brief({ channel: "sms", product: "P".repeat(70), offer: "free shipping on everything this weekend", variantCount: 1 });
    const [v] = await new TemplateCampaignWriter().write(b, PROFILE);
    expect(renderSms(v!).length).toBeLessThanOrEqual(160);
    expect(v!.body).toContain("Terms apply.");
  });
});

function message(text: string, stop: Anthropic.Message["stop_reason"] = "end_turn"): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: CLAUDE_MODEL,
    content: [{ type: "text", text, citations: null }],
    stop_reason: stop,
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  } as unknown as Anthropic.Message;
}

function fakeClient(impl: () => Promise<Anthropic.Message>) {
  const create = vi.fn(impl);
  return { client: { messages: { create } } as MessagesClient, create };
}

describe("ClaudeCampaignWriter", () => {
  const payload = { variants: [{ headline: "Your roast awaits", body: "Fresh beans. Guaranteed joy!", cta: "Shop" }] };

  it("sends model, effort, JSON-schema format and fallback options without sampling params", async () => {
    const { client, create } = fakeClient(async () => message(JSON.stringify(payload)));
    await new ClaudeCampaignWriter({ client }).write(brief({ variantCount: 1 }), PROFILE);
    const [body, options] = create.mock.calls[0]! as unknown as [Record<string, unknown>, unknown];
    expect(body).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema" } },
    });
    for (const banned of ["temperature", "top_p", "top_k", "thinking"]) expect(body).not.toHaveProperty(banned);
    expect(String(body.system)).toContain("at most 60 chars");
    expect(options).toEqual({ headers: { "anthropic-beta": "server-side-fallback-2026-07-01" } });
  });

  it("validates output and the pipeline still rejects non-compliant copy", async () => {
    const { client } = fakeClient(async () => message(JSON.stringify(payload)));
    const result = await generateCampaign(new ClaudeCampaignWriter({ client }), brief({ variantCount: 1 }), PROFILE);
    expect(result.writer).toBe("claude");
    expect(result.variants[0]!.body).toContain("Unsubscribe");
    expect(result.variants[0]!.approved).toBe(false);
    expect(rules(result.variants[0]!.issues)).toEqual(["unverifiable_claim"]);
  });

  it("treats refusal, truncation, non-JSON and schema-invalid output as errors", async () => {
    const refusal = { ...message(""), stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null } };
    const cases: [Anthropic.Message, RegExp][] = [
      [refusal as unknown as Anthropic.Message, /declined.*cyber/],
      [message("{", "max_tokens"), /truncated/],
      [message("not json"), /non-JSON/],
      [message('{"variants": []}'), /failed validation/],
    ];
    for (const [response, pattern] of cases) {
      const { client } = fakeClient(async () => response);
      await expect(new ClaudeCampaignWriter({ client }).write(brief(), PROFILE)).rejects.toThrow(pattern);
    }
  });

  it("wraps SDK errors with an actionable message", async () => {
    const { client } = fakeClient(async () => {
      throw new Error("socket hang up");
    });
    await expect(new ClaudeCampaignWriter({ client }).write(brief(), PROFILE)).rejects.toThrow(/Unexpected error.*socket/);
    expect(describeApiError("x")).toMatch(/Unexpected/);
  });

  it("is selected only when ANTHROPIC_API_KEY is set", () => {
    expect(createWriter({}).name).toBe("template");
    expect(createWriter({ ANTHROPIC_API_KEY: "test-key-not-real" }).name).toBe("claude");
  });
});
