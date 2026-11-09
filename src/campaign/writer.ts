import type { SegmentProfile } from "../segment/profile.js";
import { ClaudeCampaignWriter } from "./claude-writer.js";
import { type BrandVoice, DEFAULT_BRAND_VOICE, enforceRequiredLines, type Issue, validateVariant } from "./compliance.js";
import { TemplateCampaignWriter } from "./template-writer.js";
import type { Brief, Variant } from "./types.js";

/** Provider interface for copy generation. */
export interface CampaignWriter {
  readonly name: string;
  write(brief: Brief, segment: SegmentProfile): Promise<Variant[]>;
}

/** Claude when `ANTHROPIC_API_KEY` is set, otherwise the offline template writer. */
export function createWriter(env: NodeJS.ProcessEnv = process.env): CampaignWriter {
  return env.ANTHROPIC_API_KEY ? new ClaudeCampaignWriter() : new TemplateCampaignWriter();
}

export interface CheckedVariant extends Variant {
  id: string;
  issues: Issue[];
  approved: boolean;
}

export interface CampaignResult {
  writer: string;
  brief: Brief;
  segmentId: number;
  variants: CheckedVariant[];
}

/**
 * Generates variants, adds mechanically-required lines (unsubscribe, opt-out, disclaimer),
 * then validates each one. Variants with any remaining issue are returned with `approved: false`.
 */
export async function generateCampaign(
  writer: CampaignWriter,
  brief: Brief,
  segment: SegmentProfile,
  voice: BrandVoice = DEFAULT_BRAND_VOICE,
): Promise<CampaignResult> {
  const raw = await writer.write(brief, segment);
  const variants = raw.map((v, i) => {
    const fixed = enforceRequiredLines(v, brief.channel, brief.url);
    const issues = validateVariant(fixed, brief.channel, voice);
    return { id: String.fromCharCode(65 + i), ...fixed, issues, approved: issues.length === 0 };
  });
  return { writer: writer.name, brief, segmentId: segment.id, variants };
}
