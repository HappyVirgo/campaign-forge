import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { SegmentProfile } from "../segment/profile.js";
import { DEFAULT_BRAND_VOICE, type BrandVoice } from "./compliance.js";
import { type Brief, CHANNEL_LIMITS, type Variant, VariantSchema } from "./types.js";
import type { CampaignWriter } from "./writer.js";

export const CLAUDE_MODEL = "claude-opus-5-5";

/** Shape the model must return; re-validated with zod after the API's schema enforcement. */
export const ModelOutputSchema = z.object({ variants: z.array(VariantSchema).min(1) });

/** JSON schema sent as `output_config.format`; mirrors {@link ModelOutputSchema}. */
export const OUTPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["variants"],
  properties: {
    variants: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["headline", "body", "cta"],
        properties: {
          headline: { type: ["string", "null"] },
          body: { type: "string" },
          cta: { type: "string" },
        },
      },
    },
  },
} as const;

/** Raised when the model refuses, truncates, or returns output that fails validation. */
export class CampaignWriterError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CampaignWriterError";
  }
}

/** Minimal slice of the SDK client used here, so tests can inject a fake. */
export interface MessagesClient {
  messages: {
    create(
      body: Anthropic.MessageCreateParamsNonStreaming,
      options?: { headers?: Record<string, string> },
    ): Promise<Anthropic.Message>;
  };
}

export interface ClaudeWriterOptions {
  client?: MessagesClient;
  effort?: "low" | "medium" | "high";
  voice?: BrandVoice;
}

/** Builds the system prompt with the channel limits and compliance rules spelled out. */
export function systemPrompt(brief: Brief, voice: BrandVoice): string {
  const l = CHANNEL_LIMITS[brief.channel];
  const limits =
    brief.channel === "sms"
      ? `headline must be null; body + " " + cta must be at most ${l.total} characters in total`
      : `headline at most ${l.headline} chars, body at most ${l.body} chars, cta at most ${l.cta} chars`;
  return `You are a senior lifecycle-marketing copywriter. Write distinct campaign variants for one channel.
Channel: ${brief.channel}. Limits: ${limits}.
Rules:
- Never use these words or phrases: ${voice.bannedWords.join(", ")}.
- Make no unverifiable claims (no "guaranteed", "100%", "risk-free", "best in the world", "clinically proven", "miracle").
- If the copy says "free", include "Terms apply." in the body.
- Email bodies must end with an unsubscribe line. SMS must include "Reply STOP to opt out."
- Match the requested tone and speak to the audience segment described. Do not invent prices or statistics.`;
}

/** Writer backed by Claude with JSON-schema structured output, validated with zod. */
export class ClaudeCampaignWriter implements CampaignWriter {
  readonly name = "claude";
  private readonly client: MessagesClient;
  private readonly effort: NonNullable<ClaudeWriterOptions["effort"]>;
  private readonly voice: BrandVoice;

  constructor(options: ClaudeWriterOptions = {}) {
    this.client = options.client ?? new Anthropic();
    this.effort = options.effort ?? "medium";
    this.voice = options.voice ?? DEFAULT_BRAND_VOICE;
  }

  /** Requests `brief.variantCount` variants and returns them after schema validation. */
  async write(brief: Brief, segment: SegmentProfile): Promise<Variant[]> {
    const user = `Brief:\n${JSON.stringify(brief, null, 2)}\n\nAudience segment:\n${JSON.stringify(segment, null, 2)}\n\nWrite exactly ${brief.variantCount} variants.`;
    const body = {
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      system: systemPrompt(brief, this.voice),
      messages: [{ role: "user", content: user }],
      output_config: { effort: this.effort, format: { type: "json_schema", schema: OUTPUT_JSON_SCHEMA } },
      // Server-side refusal fallback; not yet in the SDK's request types.
      fallbacks: "default",
    } as Anthropic.MessageCreateParamsNonStreaming;

    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create(body, {
        headers: { "anthropic-beta": "server-side-fallback-2026-07-01" },
      });
    } catch (err) {
      throw new CampaignWriterError(describeApiError(err), { cause: err });
    }
    return parseResponse(response).slice(0, brief.variantCount);
  }
}

/** Maps SDK errors (most specific first) to an actionable message. */
export function describeApiError(err: unknown): string {
  if (err instanceof Anthropic.RateLimitError) return "Claude API rate limit hit (429); retry later.";
  if (err instanceof Anthropic.AuthenticationError) return "Claude API rejected the API key (401). Check ANTHROPIC_API_KEY.";
  if (err instanceof Anthropic.APIConnectionError) return `Could not reach the Claude API: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `Claude API error ${String(err.status)}: ${err.message}`;
  return `Unexpected error calling Claude: ${err instanceof Error ? err.message : String(err)}`;
}

/** Checks the stop reason, extracts the JSON text and validates it with zod. */
export function parseResponse(response: Anthropic.Message): Variant[] {
  if (response.stop_reason === "refusal") {
    const category = response.stop_details?.category ?? "unspecified";
    throw new CampaignWriterError(`Claude declined to write this campaign (refusal, category: ${category}).`);
  }
  if (response.stop_reason === "max_tokens") throw new CampaignWriterError("Claude's response was truncated at max_tokens.");
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new CampaignWriterError("Claude returned non-JSON output.", { cause: err });
  }
  const parsed = ModelOutputSchema.safeParse(json);
  if (!parsed.success) throw new CampaignWriterError(`Claude output failed validation: ${parsed.error.message}`);
  return parsed.data.variants;
}
