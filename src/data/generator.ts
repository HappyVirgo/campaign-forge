import { Rng } from "../rng.js";
import type { Customer } from "./customer.js";

/** Snapshot date the synthetic data is generated relative to. */
export const REFERENCE_DATE = "2026-10-01";

/** Hidden ground-truth personas used to evaluate segmentation. */
export const PERSONAS = ["loyal_email", "lapsed", "sms_deal_seeker", "new_push"] as const;
export type Persona = (typeof PERSONAS)[number];

interface PersonaSpec {
  share: number;
  /** Mean days since last order. */
  recencyDays: number;
  /** Mean order count (Poisson). */
  orders: number;
  /** Mean order value in dollars (log-normal centre). */
  aov: number;
  /** Mean tenure in days. */
  tenureDays: number;
  /** Open/click rates for email, SMS, push. */
  rates: [number, number, number];
}

const SPECS: Record<Persona, PersonaSpec> = {
  loyal_email: { share: 0.25, recencyDays: 12, orders: 14, aov: 85, tenureDays: 900, rates: [0.45, 0.06, 0.08] },
  lapsed: { share: 0.3, recencyDays: 220, orders: 5, aov: 60, tenureDays: 700, rates: [0.08, 0.03, 0.03] },
  sms_deal_seeker: { share: 0.25, recencyDays: 35, orders: 8, aov: 28, tenureDays: 400, rates: [0.12, 0.32, 0.07] },
  new_push: { share: 0.2, recencyDays: 14, orders: 1.5, aov: 40, tenureDays: 45, rates: [0.15, 0.05, 0.38] },
};

export interface SyntheticDataset {
  customers: Customer[];
  /** Ground-truth persona per customer, index-aligned; never written to the CSV. */
  labels: Persona[];
}

const DAY_MS = 86_400_000;

function isoDaysBefore(reference: string, days: number): string {
  return new Date(Date.parse(reference) - Math.round(days) * DAY_MS).toISOString().slice(0, 10);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Generates SYNTHETIC customers drawn from four noisy personas.
 * IDs are obviously fake (`SYN-000001`); no real people are represented.
 */
export function generateCustomers(n: number, seed = 42): SyntheticDataset {
  const rng = new Rng(seed);
  const shares = PERSONAS.map((p) => SPECS[p].share);
  const customers: Customer[] = [];
  const labels: Persona[] = [];

  for (let i = 0; i < n; i++) {
    const persona = PERSONAS[rng.weighted(shares)]!;
    const s = SPECS[persona];
    const tenure = clamp(s.tenureDays * Math.exp(rng.normal(0, 0.35)), 5, 2500);
    const orders = Math.max(1, rng.poisson(s.orders));
    const recency = clamp(s.recencyDays * Math.exp(rng.normal(0, 0.45)), 0, tenure);
    const spend = orders * s.aov * Math.exp(rng.normal(0, 0.3));
    const sends = [rng.poisson(40), rng.poisson(20), rng.poisson(25)];
    const engaged = sends.map((sent, ch) => rng.binomial(sent, clamp(s.rates[ch]! + rng.normal(0, 0.04), 0, 1)));

    customers.push({
      customer_id: `SYN-${String(i + 1).padStart(6, "0")}`,
      signup_date: isoDaysBefore(REFERENCE_DATE, tenure),
      last_order_date: isoDaysBefore(REFERENCE_DATE, recency),
      order_count: orders,
      total_spend: Math.round(spend * 100) / 100,
      email_sent: sends[0]!,
      email_opened: engaged[0]!,
      sms_sent: sends[1]!,
      sms_clicked: engaged[1]!,
      push_sent: sends[2]!,
      push_opened: engaged[2]!,
    });
    labels.push(persona);
  }
  return { customers, labels };
}
