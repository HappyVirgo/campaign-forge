import type { Customer } from "../data/customer.js";

/** Behavioural features per customer, in natural units. */
export interface CustomerFeatures {
  customerId: string;
  /** Days since last order (tenure if the customer never ordered). */
  recencyDays: number;
  /** Number of orders. */
  frequency: number;
  /** Lifetime spend in dollars. */
  monetary: number;
  tenureDays: number;
  emailRate: number;
  smsRate: number;
  pushRate: number;
}

export const FEATURE_NAMES = ["recency", "frequency", "monetary", "emailRate", "smsRate", "pushRate"] as const;

const DAY_MS = 86_400_000;

/** Laplace-smoothed engagement rate so a customer with zero sends is not 0% or 100%. */
function rate(engaged: number, sent: number): number {
  return (engaged + 1) / (sent + 10);
}

/** Computes recency, frequency, spend and per-channel engagement relative to `referenceDate`. */
export function computeFeatures(customers: readonly Customer[], referenceDate: string): CustomerFeatures[] {
  const ref = Date.parse(referenceDate);
  return customers.map((c) => {
    const tenureDays = Math.max(0, (ref - Date.parse(c.signup_date)) / DAY_MS);
    const recencyDays = c.last_order_date ? Math.max(0, (ref - Date.parse(c.last_order_date)) / DAY_MS) : tenureDays;
    return {
      customerId: c.customer_id,
      recencyDays,
      frequency: c.order_count,
      monetary: c.total_spend,
      tenureDays,
      emailRate: rate(c.email_opened, c.email_sent),
      smsRate: rate(c.sms_clicked, c.sms_sent),
      pushRate: rate(c.push_opened, c.push_sent),
    };
  });
}

/**
 * Turns features into a standardised matrix for clustering: skewed count/currency
 * features are log1p-transformed, then every column is z-scored.
 */
export function toMatrix(features: readonly CustomerFeatures[]): number[][] {
  const raw = features.map((f) => [
    Math.log1p(f.recencyDays),
    Math.log1p(f.frequency),
    Math.log1p(f.monetary),
    f.emailRate,
    f.smsRate,
    f.pushRate,
  ]);
  const dims = FEATURE_NAMES.length;
  const n = raw.length;
  for (let j = 0; j < dims; j++) {
    const mean = raw.reduce((s, r) => s + r[j]!, 0) / n;
    const sd = Math.sqrt(raw.reduce((s, r) => s + (r[j]! - mean) ** 2, 0) / n) || 1;
    for (const r of raw) r[j] = (r[j]! - mean) / sd;
  }
  return raw;
}
