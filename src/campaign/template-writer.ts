import type { SegmentProfile } from "../segment/profile.js";
import type { Brief, Variant } from "./types.js";
import { CHANNEL_LIMITS, renderSms } from "./types.js";
import type { CampaignWriter } from "./writer.js";

type Goal = Brief["goal"];
type Tone = Brief["tone"];

const HOOKS: Record<Goal, readonly string[]> = {
  awareness: ["Meet {product}.", "Say hello to {product}.", "Introducing {product}."],
  conversion: ["Your {product} is waiting.", "Ready for {product}?", "Make {product} yours."],
  retention: ["More to love in {product}.", "Get more from {product}.", "Your next pick: {product}."],
  reactivation: ["We saved you some {product}.", "It's been a while. Meet {product}.", "Come back to {product}."],
};

const OPENERS: Record<Tone, readonly string[]> = {
  friendly: ["Hi there!", "Hey friend,", "Good news!"],
  premium: ["Crafted for you.", "An exclusive invitation.", "Considered, refined, yours."],
  playful: ["Psst!", "Guess what?", "Plot twist:"],
  professional: ["Hello,", "An update for you:", "Quick note:"],
};

const CTAS: Record<Goal, readonly string[]> = {
  awareness: ["Learn more", "Take a look", "Discover it"],
  conversion: ["Shop now", "Get yours", "Claim offer"],
  retention: ["See what's new", "Explore picks", "Keep going"],
  reactivation: ["Come back", "See what's new", "Welcome back"],
};

function pick<T>(xs: readonly T[], i: number): T {
  return xs[i % xs.length]!;
}

/** One sentence tailored to the segment's behaviour. */
function segmentLine(segment: SegmentProfile): string {
  const tags = new Set(segment.topTags.map((t) => t.tag));
  if (tags.has("vip")) return "As one of our most valued customers, you get first access.";
  if (segment.medianRecencyDays > 90) return "We've added a lot since your last visit.";
  if (segment.medianOrders <= 2) return "Here's a great next step after your first order.";
  return "Picked for shoppers like you.";
}

function fill(template: string, brief: Brief): string {
  return template.replaceAll("{product}", brief.product);
}

/**
 * Offline, deterministic writer: fills goal/tone templates with the brief and segment cues and
 * always includes the required compliance lines. Used automatically when no API key is set.
 */
export class TemplateCampaignWriter implements CampaignWriter {
  readonly name = "template";

  /** Produces `brief.variantCount` variants; never calls the network. */
  async write(brief: Brief, segment: SegmentProfile): Promise<Variant[]> {
    return Array.from({ length: brief.variantCount }, (_, i) => this.variant(brief, segment, i));
  }

  private variant(brief: Brief, segment: SegmentProfile, i: number): Variant {
    const hook = fill(pick(HOOKS[brief.goal], i), brief);
    const opener = pick(OPENERS[brief.tone], i);
    const offer = brief.offer ? ` Enjoy ${brief.offer}.` : "";
    const terms = brief.offer && /\bfree\b/i.test(brief.offer) ? " Terms apply." : "";
    const cta = pick(CTAS[brief.goal], i + Math.floor(i / 3));

    switch (brief.channel) {
      case "email":
        return {
          headline: truncate(hook, CHANNEL_LIMITS.email.headline!),
          body:
            `${opener} ${hook} ${segmentLine(segment)}${offer}${terms}\n\n${cta}: ${brief.url}\n\n` +
            `The ${brief.brand} team\nUnsubscribe: ${brief.url}/unsubscribe`,
          cta,
        };
      case "sms": {
        const tail = `${terms} Reply STOP to opt out.`;
        const smsCta = `${cta}: ${brief.url}`;
        const long = { headline: null, body: `${brief.brand}: ${hook}${offer}${tail}`, cta: smsCta };
        if (renderSms(long).length <= CHANNEL_LIMITS.sms.total!) return long;
        return { headline: null, body: `${brief.brand}:${offer || ` ${hook}`}${tail}`, cta: smsCta };
      }
      case "push":
        return {
          headline: truncate(hook, CHANNEL_LIMITS.push.headline!),
          body: truncate(`${opener}${offer || ` ${segmentLine(segment)}`}${terms}`, CHANNEL_LIMITS.push.body),
          cta,
        };
      case "social":
        return {
          headline: truncate(`${hook} | ${brief.brand}`, CHANNEL_LIMITS.social.headline!),
          body: truncate(`${opener} ${hook}${offer}${terms} ${brief.url}`, CHANNEL_LIMITS.social.body),
          cta,
        };
    }
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}
