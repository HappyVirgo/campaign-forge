import { z } from "zod";

/** One row of the customer CSV. All bundled data is SYNTHETIC. */
export const CustomerSchema = z
  .object({
    customer_id: z.string().min(1),
    signup_date: z.iso.date(),
    last_order_date: z.iso.date().nullable(),
    order_count: z.coerce.number().int().nonnegative(),
    total_spend: z.coerce.number().nonnegative(),
    email_sent: z.coerce.number().int().nonnegative(),
    email_opened: z.coerce.number().int().nonnegative(),
    sms_sent: z.coerce.number().int().nonnegative(),
    sms_clicked: z.coerce.number().int().nonnegative(),
    push_sent: z.coerce.number().int().nonnegative(),
    push_opened: z.coerce.number().int().nonnegative(),
  })
  .refine((c) => c.email_opened <= c.email_sent && c.sms_clicked <= c.sms_sent && c.push_opened <= c.push_sent, {
    message: "engagement counts cannot exceed sends",
  });

export type Customer = z.infer<typeof CustomerSchema>;

export const CSV_COLUMNS = [
  "customer_id",
  "signup_date",
  "last_order_date",
  "order_count",
  "total_spend",
  "email_sent",
  "email_opened",
  "sms_sent",
  "sms_clicked",
  "push_sent",
  "push_opened",
] as const satisfies readonly (keyof Customer)[];

/** Raised when a CSV cannot be parsed into customers; carries the 1-based line number. */
export class CsvError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`line ${line}: ${message}`);
    this.name = "CsvError";
  }
}

/** Parses a customer CSV (header row required, no quoted commas) and validates every row. */
export function parseCustomersCsv(text: string): Customer[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const header = lines[0]?.split(",").map((h) => h.trim());
  if (!header) throw new CsvError("empty file", 1);
  const missing = CSV_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) throw new CsvError(`missing columns: ${missing.join(", ")}`, 1);

  return lines.slice(1).map((line, i) => {
    const cells = line.split(",");
    if (cells.length !== header.length) throw new CsvError(`expected ${header.length} cells, got ${cells.length}`, i + 2);
    const raw: Record<string, string | null> = {};
    header.forEach((h, j) => {
      const v = cells[j]!.trim();
      raw[h] = v === "" ? null : v;
    });
    const parsed = CustomerSchema.safeParse(raw);
    if (!parsed.success) throw new CsvError(parsed.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join("; "), i + 2);
    return parsed.data;
  });
}

/** Serialises customers to CSV with the canonical column order. */
export function toCsv(customers: readonly Customer[]): string {
  const rows = customers.map((c) => CSV_COLUMNS.map((col) => c[col] ?? "").join(","));
  return `${[CSV_COLUMNS.join(","), ...rows].join("\n")}\n`;
}
