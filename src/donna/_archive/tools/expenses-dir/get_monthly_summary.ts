import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../../brain.js";
import { getTurnContext } from "../../context.js";
import { getMonthlySpendSummary } from "../../expenses/summary.js";

const PTC_CALLER = "code_execution_20250825" as const;

interface GetMonthlySummaryInput {
  month?: string; // YYYY-MM
}

export const getMonthlySummaryTool: Tool & {
  modes: ReadonlySet<BrainMode>;
} = {
  name: "get_monthly_summary",
  description: `month-to-date totals + per-category breakdown + per-day pattern + top merchants + delta vs budget. months are YYYY-MM in the user's tz.

use for "how much did i spend this month", "where did my money go", "what's my biggest category".

returns: {month, currency, total_cents, by_category: {cat: cents}, by_day: {YYYY-MM-DD: cents}, goal, delta: {monthly_cents, per_category: {cat: remaining}} | null, top_merchants: [{merchant, total_cents, count}]}.

mark async — fan out alongside get_budget / get_recurring_charges.`,
  input_schema: {
    type: "object",
    properties: {
      month: {
        type: "string",
        description: "YYYY-MM; default current month user tz.",
      },
    },
  },
  allowed_callers: [PTC_CALLER],
  modes: new Set<BrainMode>(["reactive", "proactive"]),
};

export async function getMonthlySummaryHandler(
  input: unknown,
): Promise<unknown> {
  const i = (input ?? {}) as GetMonthlySummaryInput;
  const ctx = getTurnContext();
  return await getMonthlySpendSummary({ userId: ctx.userId, month: i.month });
}
