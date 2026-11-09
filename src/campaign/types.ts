import { z } from "zod";

export const CHANNELS = ["email", "sms", "push", "social"] as const;
export type Channel = (typeof CHANNELS)[number];

export const GOALS = ["awareness", "conversion", "retention", "reactivation"] as const;
export const TONES = ["friendly", "premium", "playful", "professional"] as const;

/** What the marketer asks for. */
export const BriefSchema = z.object({
  brand: z.string().min(1).max(40),
  product: z.string().min(1).max(80),
  goal: z.enum(GOALS),
  tone: z.enum(TONES),
  channel: z.enum(CHANNELS),
  /** Optional offer, e.g. "15% off" or "free shipping". */
  offer: z.string().max(60).optional(),
  /** Landing page shown in SMS/CTA copy. */
  url: z.url().default("https://example.com"),
  variantCount: z.number().int().min(1).max(5).default(3),
});
export type Brief = z.infer<typeof BriefSchema>;

/** One piece of generated copy. `headline` is the email subject / push title / social headline; null for SMS. */
export const VariantSchema = z.object({
  headline: z.string().nullable(),
  body: z.string().min(1),
  cta: z.string().min(1),
});
export type Variant = z.infer<typeof VariantSchema>;

/** Character limits per channel. `total` applies to the rendered message (body + CTA). */
export interface ChannelLimits {
  headline: number | null;
  body: number;
  cta: number;
  total?: number;
}

export const CHANNEL_LIMITS: Record<Channel, ChannelLimits> = {
  email: { headline: 60, body: 2000, cta: 25 },
  sms: { headline: null, body: 160, cta: 40, total: 160 },
  push: { headline: 50, body: 150, cta: 20 },
  social: { headline: 80, body: 280, cta: 25 },
};

/** Text that is actually delivered for an SMS: body then CTA on one line. */
export function renderSms(v: Variant): string {
  return `${v.body} ${v.cta}`;
}
