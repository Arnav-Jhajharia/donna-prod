// expense_goals repo. one row per user; upserted on every set_budget call.

import { getSql } from "../db.js";
import type { ExpenseGoalRow } from "./types.js";

export interface UpsertBudgetArgs {
  userId: string;
  monthlyTotalCents?: number;
  dailyTotalCents?: number;
  perCategoryMonthlyCents?: Record<string, number>;
  currency?: string;
  notes?: string;
  proactiveNudges?: boolean;
  timezone?: string;
}

export async function upsertBudget(
  args: UpsertBudgetArgs,
): Promise<ExpenseGoalRow> {
  const sql = getSql();
  const perCategory = args.perCategoryMonthlyCents ?? null;
  const [row] = await sql<ExpenseGoalRow[]>`
    insert into expense_goals (
      user_id, monthly_total_cents, daily_total_cents,
      per_category_monthly_cents, currency, notes,
      proactive_nudges, timezone
    ) values (
      ${args.userId},
      ${args.monthlyTotalCents ?? null},
      ${args.dailyTotalCents ?? null},
      ${perCategory ? sql.json(perCategory as unknown as Parameters<typeof sql.json>[0]) : null},
      ${args.currency ?? "USD"},
      ${args.notes ?? null},
      ${args.proactiveNudges ?? true},
      ${args.timezone ?? "Asia/Singapore"}
    )
    on conflict (user_id) do update set
      monthly_total_cents        = coalesce(${args.monthlyTotalCents ?? null}, expense_goals.monthly_total_cents),
      daily_total_cents          = coalesce(${args.dailyTotalCents ?? null}, expense_goals.daily_total_cents),
      per_category_monthly_cents = coalesce(${perCategory ? sql.json(perCategory as unknown as Parameters<typeof sql.json>[0]) : null}, expense_goals.per_category_monthly_cents),
      currency                   = coalesce(${args.currency ?? null}, expense_goals.currency),
      notes                      = coalesce(${args.notes ?? null}, expense_goals.notes),
      proactive_nudges           = coalesce(${args.proactiveNudges ?? null}, expense_goals.proactive_nudges),
      timezone                   = coalesce(${args.timezone ?? null}, expense_goals.timezone),
      updated_at                 = now()
    returning *
  `;
  if (!row) throw new Error("upsert_budget: insert returned no row");
  return row;
}

export async function getBudget(userId: string): Promise<ExpenseGoalRow | null> {
  const sql = getSql();
  const rows = await sql<ExpenseGoalRow[]>`
    select * from expense_goals where user_id = ${userId}
  `;
  return rows[0] ?? null;
}
