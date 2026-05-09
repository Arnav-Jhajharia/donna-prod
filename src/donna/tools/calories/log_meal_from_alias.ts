import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../../brain.js";
import { getTurnContext } from "../../context.js";
import { getAlias } from "../../calories/aliases.js";
import { insertMeal } from "../../calories/meals.js";
import { recordExecutionEvent } from "../../observability/execution.js";
import type { MealType } from "../../calories/types.js";

interface LogMealFromAliasInput {
  alias: string;
  occurred_at?: string;
  meal_type?: MealType;
}

export const logMealFromAliasTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "log_meal_from_alias",
  description: `fast-path log a meal by alias. snapshots the alias template into a fresh meal row.

call this when the user says "log my usual breakfast", "same as yesterday's salad", "log office lunch".

returns: { meal_id, totals }.`,
  input_schema: {
    type: "object",
    properties: {
      alias: { type: "string" },
      occurred_at: { type: "string" },
      meal_type: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack"] },
    },
    required: ["alias"],
  },
  modes: new Set<BrainMode>(["reactive"]),
};

export async function logMealFromAliasHandler(
  input: unknown,
): Promise<unknown> {
  const i = (input ?? {}) as LogMealFromAliasInput;
  if (!i.alias) throw new Error("log_meal_from_alias: alias required");
  const ctx = getTurnContext();
  const aliasRow = await getAlias(ctx.userId, i.alias.toLowerCase().trim());
  if (!aliasRow) throw new Error(`alias "${i.alias}" not found`);

  const meal = await insertMeal({
    userId: ctx.userId,
    occurredAt: i.occurred_at ? new Date(i.occurred_at) : new Date(),
    mealType: i.meal_type ?? null,
    sourceKind: "alias",
    sourceMessageId: null,
    rawInput: `alias:${aliasRow.alias}`,
    visionDescription: null,
    confidence: "high",
    parser: "nutritionix",
    items: aliasRow.template,
  });
  if (ctx.runId) {
    await recordExecutionEvent(ctx.runId, "meal_logged", "calories.alias", {
      meal_id: meal.id,
      alias: aliasRow.alias,
    });
  }
  return {
    meal_id: meal.id,
    totals: {
      kcal: Number(meal.total_kcal),
      protein_g: Number(meal.total_protein_g),
      carbs_g: Number(meal.total_carbs_g),
      fat_g: Number(meal.total_fat_g),
    },
  };
}
