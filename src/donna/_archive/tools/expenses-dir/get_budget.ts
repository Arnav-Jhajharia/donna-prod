import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../../brain.js";
import { getTurnContext } from "../../context.js";
import { getBudget } from "../../expenses/goals.js";

const PTC_CALLER = "code_execution_20250825" as const;

export const getBudgetTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "get_budget",
  description: `current budget row or null. fields: monthly_total_cents, daily_total_cents, per_category_monthly_cents (jsonb), currency, proactive_nudges, timezone.

mark async — fan out alongside get_daily_spend / get_monthly_summary.`,
  input_schema: { type: "object", properties: {} },
  allowed_callers: [PTC_CALLER],
  modes: new Set<BrainMode>(["reactive", "proactive"]),
};

export async function getBudgetHandler(_input: unknown): Promise<unknown> {
  const ctx = getTurnContext();
  return await getBudget(ctx.userId);
}
