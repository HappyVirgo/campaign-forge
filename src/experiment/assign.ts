import { createHash } from "node:crypto";

/** Maps (experiment, user) to a stable point in [0, 1) using the top 52 bits of SHA-256. */
export function hashToUnit(experimentId: string, userId: string): number {
  const digest = createHash("sha256").update(`${experimentId}\u0000${userId}`).digest();
  const hi = digest.readUInt32BE(0);
  const lo = digest.readUInt32BE(4) >>> 12;
  return (hi * 2 ** 20 + lo) / 2 ** 52;
}

/**
 * Deterministically assigns a user to one of the variants. The same user always lands in the
 * same variant for a given experiment; different experiments hash independently.
 * `weights` default to an even split and need not sum to 1.
 */
export function assignVariant(experimentId: string, userId: string, variants: readonly string[], weights?: readonly number[]): string {
  if (variants.length === 0) throw new RangeError("need at least one variant");
  const w = weights ?? variants.map(() => 1);
  if (w.length !== variants.length || w.some((x) => !(x >= 0)) || w.every((x) => x === 0)) {
    throw new RangeError("weights must be non-negative, one per variant, not all zero");
  }
  const total = w.reduce((s, x) => s + x, 0);
  let point = hashToUnit(experimentId, userId) * total;
  for (let i = 0; i < variants.length; i++) {
    point -= w[i]!;
    if (point < 0) return variants[i]!;
  }
  return variants[variants.length - 1]!;
}
