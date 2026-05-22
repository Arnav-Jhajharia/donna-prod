import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../../brain.js";
import { getTurnContext } from "../../context.js";
import { getDailySummary } from "../../calories/summary.js";

const PTC_CALLER = "code_execution_20250825" as const;

interface GetDailySummaryInput {
  date?: string;
}

export const getDailySummaryTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "get_daily_summary",
  description: `aggregate today's (or any date's) meals + delta vs goal. dates are YYYY-MM-DD in the user's tz.

returns: {date, totals: {kcal, protein_g, carbs_g, fat_g, fiber_g, sodium_mg}, goal, delta: {kcal, protein_g, carbs_g, fat_g} | null, meals: [{id, occurred_at, meal_type, summary, kcal, confidence}]}.

mark this async — fan out alongside get_food_goal() and parse_food_text() in python.`,
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

export async function getDailySummaryHandler(input: unknown): Promise<unknown> {
  const i = (input ?? {}) as GetDailySummaryInput;
  const ctx = getTurnContext();
  return await getDailySummary({ userId: ctx.userId, date: i.date });
}
