import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../../brain.js";
import { getTurnContext } from "../../context.js";
import { getExpenseHistory } from "../../expenses/summary.js";

const PTC_CALLER = "code_execution_20250825" as const;

interface GetExpenseHistoryInput {
  start: string;
  end: string;
  category?: string;
}

export const getExpenseHistoryTool: Tool & {
  modes: ReadonlySet<BrainMode>;
} = {
  name: "get_expense_history",
  description: `expenses in an inclusive YYYY-MM-DD date range, optionally filtered by category.

returns: array of expense rows ({id, occurred_at, merchant, amount_cents, currency, category, confidence, parser, is_recurring, ...}).

use inside code_execution when you need to filter / aggregate further ("biggest expenses last month", "all food spend in march", "anything > $200 in q1").`,
  input_schema: {
    type: "object",
    properties: {
      start: { type: "string", description: "YYYY-MM-DD (inclusive)" },
      end: { type: "string", description: "YYYY-MM-DD (inclusive)" },
      category: {
        type: "string",
        description: "optional: free-form category to filter by",
      },
    },
    required: ["start", "end"],
  },
  allowed_callers: [PTC_CALLER],
  modes: new Set<BrainMode>(["reactive", "proactive"]),
};

export async function getExpenseHistoryHandler(
  input: unknown,
): Promise<unknown> {
  const i = (input ?? {}) as GetExpenseHistoryInput;
  if (!i.start || !i.end) {
    throw new Error("get_expense_history: start and end required");
  }
  const ctx = getTurnContext();
  return await getExpenseHistory({
    userId: ctx.userId,
    start: i.start,
    end: i.end,
    category: i.category,
  });
}
