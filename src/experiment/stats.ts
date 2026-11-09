/**
 * Standard normal CDF via Marsaglia's (2004) Taylor series around 0. Absolute error is near
 * machine precision; values are clamped to 0/1 beyond |z| > 8.
 */
export function normalCdf(z: number): number {
  if (z < -8) return 0;
  if (z > 8) return 1;
  let sum = z;
  let term = z;
  for (let i = 3; sum + term !== sum; i += 2) {
    term *= (z * z) / i;
    sum += term;
  }
  // 0.9189... = ln(sqrt(2*pi))
  return 0.5 + sum * Math.exp(-0.5 * z * z - 0.9189385332046727);
}

/** Inverse standard normal CDF (Acklam's rational approximation plus one Halley refinement step). */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError(`p must be in (0, 1), got ${p}`);
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  let x: number;
  if (p < low || p > 1 - low) {
    const q = Math.sqrt(-2 * Math.log(p < low ? p : 1 - p));
    x =
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
    if (p > 1 - low) x = -x;
  } else {
    const q = p - 0.5;
    const r = q * q;
    x =
      ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
      (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  }
  const e = normalCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

export interface ArmCounts {
  users: number;
  conversions: number;
}

export interface Interval {
  low: number;
  high: number;
}

/** Wilson score interval for a single proportion. */
export function wilsonInterval(conversions: number, users: number, confidence = 0.95): Interval {
  if (users === 0) return { low: 0, high: 1 };
  const z = normalQuantile(1 - (1 - confidence) / 2);
  const p = conversions / users;
  const denom = 1 + (z * z) / users;
  const centre = (p + (z * z) / (2 * users)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / users + (z * z) / (4 * users * users))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

export interface ZTestResult {
  rateA: number;
  rateB: number;
  /** rateB - rateA. */
  diff: number;
  /** Relative lift of B over A (diff / rateA); NaN when rateA is 0. */
  lift: number;
  z: number;
  /** Two-sided p-value under the pooled null. */
  pValue: number;
  /** Unpooled (Wald) interval for the difference. */
  diffInterval: Interval;
}

/**
 * Two-sided two-proportion z-test of B against A. The test statistic uses the pooled
 * standard error; the confidence interval for the difference uses the unpooled one.
 */
export function twoProportionZTest(a: ArmCounts, b: ArmCounts, confidence = 0.95): ZTestResult {
  if (a.users === 0 || b.users === 0) throw new RangeError("both arms need at least one user");
  const rateA = a.conversions / a.users;
  const rateB = b.conversions / b.users;
  const diff = rateB - rateA;
  const pooled = (a.conversions + b.conversions) / (a.users + b.users);
  const sePooled = Math.sqrt(pooled * (1 - pooled) * (1 / a.users + 1 / b.users));
  const z = sePooled === 0 ? 0 : diff / sePooled;
  const seDiff = Math.sqrt((rateA * (1 - rateA)) / a.users + (rateB * (1 - rateB)) / b.users);
  const zc = normalQuantile(1 - (1 - confidence) / 2);
  return {
    rateA,
    rateB,
    diff,
    lift: rateA === 0 ? Number.NaN : diff / rateA,
    z,
    pValue: 2 * (1 - normalCdf(Math.abs(z))),
    diffInterval: { low: diff - zc * seDiff, high: diff + zc * seDiff },
  };
}

export interface SampleSizeInput {
  /** Baseline conversion rate of the control. */
  baseline: number;
  /** Minimum detectable effect as an absolute difference in rate (e.g. 0.01 = 1 point). */
  mde: number;
  alpha?: number;
  power?: number;
}

/**
 * Users needed per arm for a two-sided two-proportion z-test (normal approximation,
 * no continuity correction, pooled variance under H0 and unpooled under H1).
 */
export function minSampleSize({ baseline, mde, alpha = 0.05, power = 0.8 }: SampleSizeInput): number {
  const p1 = baseline;
  const p2 = baseline + mde;
  if (!(p1 > 0 && p1 < 1 && p2 > 0 && p2 < 1) || mde === 0) throw new RangeError("baseline and baseline+mde must be in (0, 1), mde != 0");
  const za = normalQuantile(1 - alpha / 2);
  const zb = normalQuantile(power);
  const pBar = (p1 + p2) / 2;
  const n = (za * Math.sqrt(2 * pBar * (1 - pBar)) + zb * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2 / mde ** 2;
  return Math.ceil(n);
}
