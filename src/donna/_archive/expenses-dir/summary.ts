// daily / monthly aggregates + recurring-charge detection. all totals are
// recomputed on every read (data volume per user is small).
//
// recurring detection is a derived view: pick merchants that show up ≥3 times
// with similar amounts (within 15%) at monthly cadence, and report them as
// subscriptions. flips expenses.is_recurring on those rows as a side effect so
// future reads are cheaper.

import { getSql } from "../db.js";
import { getBudget } from "./goals.js";
import { markRecurring } from "./expenses.js";
import type {
  DailySpendSummary,
  ExpenseGoalRow,
  ExpenseRow,
  MonthlySpendSummary,
  Recurrence,
  RecurringCharge,
} from "./types.js";

function isoDate(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
}

function isoMonth(d: Date, tz: string): string {
  return isoDate(d, tz).slice(0, 7); // YYYY-MM
}

function bucketByCategory(rows: ExpenseRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const cat = r.category ?? "uncategorized";
    out[cat] = (out[cat] ?? 0) + Number(r.amount_cents);
  }
  return out;
}

export async function getDailySpendSummary(args: {
  userId: string;
  date?: string;
}): Promise<DailySpendSummary> {
  const sql = getSql();
  const goal = await getBudget(args.userId);
  const tz = goal?.timezone ?? "Asia/Singapore";
  const currency = goal?.currency ?? "USD";
  const date = args.date ?? isoDate(new Date(), tz);
  const month = date.slice(0, 7);

  const expenses = await sql<ExpenseRow[]>`
    select * from expenses
    where user_id = ${args.userId}
      and not is_deleted
      and date(occurred_at at time zone ${tz}) = ${date}::date
    order by occurred_at asc
  `;

  const total = expenses.reduce(
    (acc, e) => acc + Number(e.amount_cents),
    0,
  );

  let monthlyTotal: number | null = null;
  if (goal?.monthly_total_cents != null) {
    const rows = await sql<Array<{ sum: number | null }>>`
      select coalesce(sum(amount_cents), 0)::bigint as sum from expenses
      where user_id = ${args.userId}
        and not is_deleted
        and to_char(occurred_at at time zone ${tz}, 'YYYY-MM') = ${month}
    `;
    monthlyTotal = Number(rows[0]?.sum ?? 0);
  }

  const delta: DailySpendSummary["delta"] = goal
    ? {
        daily_cents:
          goal.daily_total_cents != null
            ? Number(goal.daily_total_cents) - total
            : null,
        monthly_remaining_cents:
          goal.monthly_total_cents != null && monthlyTotal != null
            ? Number(goal.monthly_total_cents) - monthlyTotal
            : null,
      }
    : null;

  return {
    date,
    currency,
    total_cents: total,
    by_category: bucketByCategory(expenses),
    goal,
    delta,
    expenses: expenses.map((e) => ({
      id: e.id,
      occurred_at: new Date(e.occurred_at).toISOString(),
      merchant: e.merchant,
      amount_cents: Number(e.amount_cents),
      category: e.category,
      confidence: e.confidence,
    })),
  };
}

export async function getMonthlySpendSummary(args: {
  userId: string;
  month?: string; // YYYY-MM
}): Promise<MonthlySpendSummary> {
  const sql = getSql();
  const goal = await getBudget(args.userId);
  const tz = goal?.timezone ?? "Asia/Singapore";
  const currency = goal?.currency ?? "USD";
  const month = args.month ?? isoMonth(new Date(), tz);

  const expenses = await sql<ExpenseRow[]>`
    select * from expenses
    where user_id = ${args.userId}
      and not is_deleted
      and to_char(occurred_at at time zone ${tz}, 'YYYY-MM') = ${month}
    order by occurred_at asc
  `;

  const total = expenses.reduce((acc, e) => acc + Number(e.amount_cents), 0);
  const byCategory = bucketByCategory(expenses);

  const byDay: Record<string, number> = {};
  for (const e of expenses) {
    const d = isoDate(new Date(e.occurred_at), tz);
    byDay[d] = (byDay[d] ?? 0) + Number(e.amount_cents);
  }

  const merchantTotals = new Map<string, { total: number; count: number }>();
  for (const e of expenses) {
    if (!e.merchant) continue;
    const prev = merchantTotals.get(e.merchant) ?? { total: 0, count: 0 };
    prev.total += Number(e.amount_cents);
    prev.count += 1;
    merchantTotals.set(e.merchant, prev);
  }
  const topMerchants = Array.from(merchantTotals.entries())
    .map(([merchant, v]) => ({
      merchant,
      total_cents: v.total,
      count: v.count,
    }))
    .sort((a, b) => b.total_cents - a.total_cents)
    .slice(0, 10);

  const delta: MonthlySpendSummary["delta"] = goal
    ? {
        monthly_cents:
          goal.monthly_total_cents != null
            ? Number(goal.monthly_total_cents) - total
            : null,
        per_category: goal.per_category_monthly_cents
          ? perCategoryDelta(byCategory, goal.per_category_monthly_cents)
          : null,
      }
    : null;

  return {
    month,
    currency,
    total_cents: total,
    by_category: byCategory,
    by_day: byDay,
    goal,
    delta,
    top_merchants: topMerchants,
  };
}

function perCategoryDelta(
  spent: Record<string, number>,
  caps: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [cat, cap] of Object.entries(caps)) {
    out[cat] = cap - (spent[cat] ?? 0);
  }
  return out;
}

export async function getExpenseHistory(args: {
  userId: string;
  start: string;
  end: string;
  category?: string;
}): Promise<ExpenseRow[]> {
  const sql = getSql();
  const goal = await getBudget(args.userId);
  const tz = goal?.timezone ?? "Asia/Singapore";
  if (args.category) {
    return await sql<ExpenseRow[]>`
      select * from expenses
      where user_id = ${args.userId}
        and not is_deleted
        and category = ${args.category}
        and date(occurred_at at time zone ${tz}) between ${args.start}::date and ${args.end}::date
      order by occurred_at asc
    `;
  }
  return await sql<ExpenseRow[]>`
    select * from expenses
    where user_id = ${args.userId}
      and not is_deleted
      and date(occurred_at at time zone ${tz}) between ${args.start}::date and ${args.end}::date
    order by occurred_at asc
  `;
}

// ─── recurring detection ────────────────────────────────────────────────────
//
// signals for "this is a subscription":
//   - same merchant has ≥3 charges
//   - charge intervals cluster around a recurrence period (weekly / monthly /
//     yearly) with low variance
//   - amounts are within ±15% across charges (covers price bumps, tax wobble)
//
// we don't have a perfect classifier here. this is intentionally simple — when
// a real bank/gmail integration lands, we'll refine. for now it works on
// manual + photo-logged data once the user has a few weeks of history.

const MIN_OCCURRENCES = 3;
const AMOUNT_TOLERANCE = 0.15;

interface MerchantHistory {
  merchant: string;
  charges: Array<{ id: string; occurred_at: Date; amount_cents: number; category: string | null }>;
}

function recurrenceFromDays(days: number): Recurrence | null {
  if (days >= 5 && days <= 9) return "weekly";
  if (days >= 25 && days <= 35) return "monthly";
  if (days >= 85 && days <= 100) return "quarterly";
  if (days >= 350 && days <= 380) return "yearly";
  return null;
}

function detectRecurrence(
  charges: MerchantHistory["charges"],
): { recurrence: Recurrence; amount_cents: number } | null {
  if (charges.length < MIN_OCCURRENCES) return null;

  // amount stability check
  const amounts = charges.map((c) => c.amount_cents);
  const sortedAmounts = amounts.slice().sort((a, b) => a - b);
  const median = sortedAmounts[Math.floor(sortedAmounts.length / 2)];
  if (median == null || median === 0) return null;
  for (const a of amounts) {
    if (Math.abs(a - median) / median > AMOUNT_TOLERANCE) return null;
  }

  // interval stability check
  const sorted = charges.slice().sort(
    (a, b) => a.occurred_at.getTime() - b.occurred_at.getTime(),
  );
  const intervals: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const prev = sorted[i - 1];
    if (!cur || !prev) continue;
    const ms = cur.occurred_at.getTime() - prev.occurred_at.getTime();
    intervals.push(ms / (1000 * 60 * 60 * 24));
  }
  if (intervals.length === 0) return null;
  const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const recurrence = recurrenceFromDays(avg);
  if (!recurrence) return null;
  return { recurrence, amount_cents: median };
}

export async function detectRecurringCharges(
  userId: string,
): Promise<RecurringCharge[]> {
  const sql = getSql();
  // pull last 18 months of merchant'd expenses
  const rows = await sql<ExpenseRow[]>`
    select * from expenses
    where user_id = ${userId}
      and not is_deleted
      and merchant is not null
      and occurred_at >= now() - interval '18 months'
    order by occurred_at asc
  `;

  const byMerchant = new Map<string, MerchantHistory>();
  for (const r of rows) {
    if (!r.merchant) continue;
    const key = r.merchant.toLowerCase().trim();
    const prev = byMerchant.get(key) ?? { merchant: r.merchant, charges: [] };
    prev.charges.push({
      id: r.id,
      occurred_at: new Date(r.occurred_at),
      amount_cents: Number(r.amount_cents),
      category: r.category,
    });
    byMerchant.set(key, prev);
  }

  const result: RecurringCharge[] = [];

  for (const hist of byMerchant.values()) {
    const detected = detectRecurrence(hist.charges);
    if (!detected) continue;
    const last = hist.charges
      .slice()
      .sort((a, b) => b.occurred_at.getTime() - a.occurred_at.getTime())[0];
    if (!last) continue;
    result.push({
      merchant: hist.merchant,
      recurrence: detected.recurrence,
      estimated_amount_cents: detected.amount_cents,
      last_charged_at: last.occurred_at.toISOString(),
      occurrences: hist.charges.length,
      category: last.category,
    });
    // side-effect: flip is_recurring on this merchant's rows. recurrence is
    // uniform per merchant so we update its charges in one batch.
    await markRecurring(
      userId,
      hist.charges.map((c) => c.id),
      detected.recurrence,
    );
  }

  return result.sort(
    (a, b) => b.estimated_amount_cents - a.estimated_amount_cents,
  );
}

export type { ExpenseGoalRow } from "./types.js";
