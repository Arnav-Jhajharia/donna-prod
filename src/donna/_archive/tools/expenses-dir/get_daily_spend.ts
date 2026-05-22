import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../../brain.js";
import { getTurnContext } from "../../context.js";
import { getDailySpendSummary } from "../../expenses/summary.js";

const PTC_CALLER = "code_execution_20250825" as const;

interface GetDailySpendInput {
  date?: string;
}

export const getDailySpendTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "get_daily_spend",
  description: `aggregate today's (or any date's) expenses + delta vs budget. dates are YYYY-MM-DD in the user's tz.

returns: {date, currency, total_cents, by_category: {category: cents}, goal, delta: {daily_cents, monthly_remaining_cents} | null, expenses: [{id, occurred_at, merchant, amount_cents, category, confidence}]}.

mark async — fan out alongside get_budget / get_monthly_summary in python.`,
  input_schema: {
    type: "object",
    properties: {
      date: {
        type: "string",
        description: "YYYY-MM-DD; default today user tz.",
      },
    },
  },
  allowed_callers: [PTC_CALLER],
  modes: new Set<BrainMode>(["reactive", "proactive"]),
};

export async function getDailySpendHandler(input: unknown): Promise<unknown> {
  const i = (input ?? {}) as GetDailySpendInput;
  const ctx = getTurnContext();
  return await getDailySpendSummary({ userId: ctx.userId, date: i.date });
}
