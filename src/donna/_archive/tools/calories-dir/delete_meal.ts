import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../../brain.js";
import { getTurnContext } from "../../context.js";
import { softDeleteMeal } from "../../calories/meals.js";
import { recordExecutionEvent } from "../../observability/execution.js";

interface DeleteMealInput {
  meal_id: string;
}

export const deleteMealTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "delete_meal",
  description: `soft-delete a meal. row stays in the table with is_deleted=true; daily summaries skip it.

call this when the user retracts: "i didn't actually eat that", "delete the snack i logged".

returns: { meal_id, deleted: true }.`,
  input_schema: {
    type: "object",
    properties: { meal_id: { type: "string" } },
    required: ["meal_id"],
  },
  modes: new Set<BrainMode>(["reactive"]),
};

export async function deleteMealHandler(input: unknown): Promise<unknown> {
  const i = (input ?? {}) as DeleteMealInput;
  if (!i.meal_id) throw new Error("delete_meal: meal_id required");
  const ctx = getTurnContext();
  await softDeleteMeal(i.meal_id, ctx.userId);
  if (ctx.runId) {
    await recordExecutionEvent(ctx.runId, "meal_deleted", "calories", {
      meal_id: i.meal_id,
    });
  }
  return { meal_id: i.meal_id, deleted: true };
}
