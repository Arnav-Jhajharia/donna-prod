import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../../brain.js";
import { getTurnContext } from "../../context.js";
import { getMealHistory } from "../../calories/summary.js";

const PTC_CALLER = "code_execution_20250825" as const;

interface GetMealHistoryInput {
  start: string;
  end: string;
}

export const getMealHistoryTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "get_meal_history",
  description: `list meals in a date range (inclusive). dates are YYYY-MM-DD in user tz.

use when the user asks "what did i have monday", "show me last week", or when computing a weekly recap.

returns: array of meal rows with totals + raw_input + confidence.`,
  input_schema: {
    type: "object",
    properties: {
      start: { type: "string" },
      end: { type: "string" },
    },
    required: ["start", "end"],
  },
  allowed_callers: [PTC_CALLER],
  modes: new Set<BrainMode>(["reactive", "proactive"]),
};

export async function getMealHistoryHandler(input: unknown): Promise<unknown> {
  const i = (input ?? {}) as GetMealHistoryInput;
  if (!i.start || !i.end) {
    throw new Error("get_meal_history: start + end required");
  }
  const ctx = getTurnContext();
  const meals = await getMealHistory({
    userId: ctx.userId,
    start: i.start,
    end: i.end,
  });
  return { meals };
}
