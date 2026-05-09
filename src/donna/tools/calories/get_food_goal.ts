import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../../brain.js";
import { getTurnContext } from "../../context.js";
import { getGoal } from "../../calories/goals.js";

const PTC_CALLER = "code_execution_20250825" as const;

export const getFoodGoalTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "get_food_goal",
  description: `read the user's daily food goal. returns null if none set.

call inside python alongside get_daily_summary so you can compute delta vs target before composing the burst.`,
  input_schema: { type: "object", properties: {} },
  allowed_callers: [PTC_CALLER],
  modes: new Set<BrainMode>(["reactive", "proactive"]),
};

export async function getFoodGoalHandler(): Promise<unknown> {
  const ctx = getTurnContext();
  const goal = await getGoal(ctx.userId);
  return { goal };
}
