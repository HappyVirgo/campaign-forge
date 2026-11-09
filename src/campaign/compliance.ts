import { CHANNEL_LIMITS, type Channel, renderSms, type Variant } from "./types.js";

export const ISSUE_RULES = [
  "headline_missing",
  "headline_forbidden",
  "headline_length",
  "body_length",
  "cta_length",
  "sms_length",
  "banned_word",
  "missing_unsubscribe",
  "missing_opt_out",
  "unverifiable_claim",
  "free_without_disclaimer",
] as const;
export type IssueRule = (typeof ISSUE_RULES)[number];

/** Rules that are legal/regulatory rather than formatting or brand voice. */
export const COMPLIANCE_RULES: readonly IssueRule[] = [
  "missing_unsubscribe",
  "missing_opt_out",
  "unverifiable_claim",
  "free_without_disclaimer",
];

export interface Issue {
  rule: IssueRule;
  message: string;
}

export interface BrandVoice {
  /** Words or phrases the brand never uses (case-insensitive, whole-word). */
  bannedWords: readonly string[];
}

export const DEFAULT_BRAND_VOICE: BrandVoice = {
  bannedWords: ["cheap", "click here", "act now", "hurry", "urgent", "buy now"],
};

/** Claims a marketer cannot substantiate on demand. */
const UNVERIFIABLE_CLAIMS: readonly RegExp[] = [
  /\bguarantee[sd]?\b/i,
  /\b100\s?%/i,
  /\brisk[- ]free\b/i,
  /\bno risk\b/i,
  /\bmiracle\b/i,
  /\bcures?\b/i,
  /\bclinically proven\b/i,
  /\b(best|#1|number one)\b[^.!?]{0,30}\b(in the world|on the planet|ever)\b/i,
  /\blowest prices? (ever|anywhere|guaranteed)\b/i,
  /\binstant results?\b/i,
  /\bnever (fails?|disappoints?)\b/i,
];

const UNSUBSCRIBE = /\bunsubscribe\b|\bopt[- ]out\b|\bmanage (your )?(email )?preferences\b/i;
const SMS_OPT_OUT = /\b(reply|text) stop\b|\bstop to (opt out|unsubscribe|end|cancel|quit)\b/i;
/** "free" as an offer; hyphenated compounds such as "gluten-free" are not offers. */
const FREE_OFFER = /(?<![-\w])free\b(?!-)/i;
const DISCLAIMER =
  /\b(terms|conditions|restrictions|exclusions) apply\b|\bt&cs? apply\b|\bsee (site|terms|details)\b|\bterms at\b|\bwhile supplies last\b/i;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** All delivered text of a variant, used for content rules. */
function fullText(v: Variant): string {
  return [v.headline ?? "", v.body, v.cta].join("\n");
}

/** Checks channel length/shape constraints. */
export function checkChannel(v: Variant, channel: Channel): Issue[] {
  const limits = CHANNEL_LIMITS[channel];
  const issues: Issue[] = [];
  if (limits.headline === null && v.headline) {
    issues.push({ rule: "headline_forbidden", message: `${channel} messages have no headline` });
  }
  if (limits.headline !== null && !v.headline?.trim()) {
    issues.push({ rule: "headline_missing", message: `${channel} messages need a headline/subject` });
  }
  if (limits.headline !== null && v.headline && v.headline.length > limits.headline) {
    issues.push({ rule: "headline_length", message: `headline is ${v.headline.length} chars (max ${limits.headline})` });
  }
  if (v.body.length > limits.body) issues.push({ rule: "body_length", message: `body is ${v.body.length} chars (max ${limits.body})` });
  if (v.cta.length > limits.cta) issues.push({ rule: "cta_length", message: `CTA is ${v.cta.length} chars (max ${limits.cta})` });
  if (limits.total !== undefined && renderSms(v).length > limits.total) {
    issues.push({ rule: "sms_length", message: `SMS is ${renderSms(v).length} chars (max ${limits.total})` });
  }
  return issues;
}

const compiledVoices = new WeakMap<BrandVoice, [word: string, pattern: RegExp][]>();

/** Whole-word, case-insensitive patterns for a voice, compiled once per BrandVoice object. */
function voicePatterns(voice: BrandVoice): [string, RegExp][] {
  let patterns = compiledVoices.get(voice);
  if (!patterns) {
    patterns = voice.bannedWords.map((w) => [w, new RegExp(`(?<![\\w-])${escapeRegExp(w)}(?![\\w-])`, "i")]);
    compiledVoices.set(voice, patterns);
  }
  return patterns;
}

/** Flags banned brand-voice words anywhere in the copy. */
export function checkBrandVoice(v: Variant, voice: BrandVoice = DEFAULT_BRAND_VOICE): Issue[] {
  const text = fullText(v);
  return voicePatterns(voice)
    .filter(([, pattern]) => pattern.test(text))
    .map(([w]) => ({ rule: "banned_word" as const, message: `uses banned word "${w}"` }));
}

/** Regulatory checks: opt-out lines, unverifiable claims, and disclaimers on "free" offers. */
export function checkCompliance(v: Variant, channel: Channel): Issue[] {
  const text = fullText(v);
  const issues: Issue[] = [];
  if (channel === "email" && !UNSUBSCRIBE.test(v.body)) {
    issues.push({ rule: "missing_unsubscribe", message: "email body needs an unsubscribe line" });
  }
  if (channel === "sms" && !SMS_OPT_OUT.test(renderSms(v))) {
    issues.push({ rule: "missing_opt_out", message: 'SMS needs an opt-out such as "Reply STOP to opt out"' });
  }
  for (const pattern of UNVERIFIABLE_CLAIMS) {
    const match = pattern.exec(text);
    if (match) issues.push({ rule: "unverifiable_claim", message: `unverifiable claim: "${match[0]}"` });
  }
  if (FREE_OFFER.test(text) && !DISCLAIMER.test(text)) {
    issues.push({ rule: "free_without_disclaimer", message: 'uses "free" without a disclaimer such as "Terms apply."' });
  }
  return issues;
}

/** Runs every check. An empty array means the variant can ship. */
export function validateVariant(v: Variant, channel: Channel, voice: BrandVoice = DEFAULT_BRAND_VOICE): Issue[] {
  return [...checkChannel(v, channel), ...checkBrandVoice(v, voice), ...checkCompliance(v, channel)];
}

/**
 * Adds the mechanical compliance lines a writer may forget (unsubscribe footer, SMS opt-out,
 * "Terms apply." after a free offer). Content problems such as claims are left for validation to reject.
 */
export function enforceRequiredLines(v: Variant, channel: Channel, url: string): Variant {
  let { body } = v;
  if (FREE_OFFER.test(fullText(v)) && !DISCLAIMER.test(fullText(v))) body = `${body} Terms apply.`;
  if (channel === "email" && !UNSUBSCRIBE.test(body)) body = `${body}\n\nUnsubscribe: ${url}/unsubscribe`;
  if (channel === "sms" && !SMS_OPT_OUT.test(renderSms({ ...v, body }))) body = `${body} Reply STOP to opt out.`;
  return { ...v, body };
}
