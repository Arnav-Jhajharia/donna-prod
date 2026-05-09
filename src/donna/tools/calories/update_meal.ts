import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../../brain.js";
import { getTurnContext } from "../../context.js";
import { updateMeal } from "../../calories/meals.js";
import { recordExecutionEvent } from "../../observability/execution.js";
import type {
  Confidence,
  MealItemInput,
  MealType,
  Parser,
} from "../../calories/types.js";

interface UpdateMealInput {
  meal_id: string;
  items?: MealItemInput[];
  occurred_at?: string;
  meal_type?: MealType;
  raw_input?: string;
  confidence?: Confidence;
  parser?: Parser;
  notes?: string;
}

export const updateMealTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "update_meal",
  description: `edit a previously logged meal. replace items wholesale (all old items deleted, new items inserted), or change occurred_at / meal_type / notes.

call this when the user corrects themselves: "actually one egg, not two", "that was at 1pm not noon".

if items is provided you MUST recompute via parse_food_text first — don't pass numbers you didn't get from nutritionix or estimate explicitly.

returns: { meal_id, totals }.`,
  input_schema: {
    type: "object",
    properties: {
      meal_id: { type: "string" },
      items: { type: "array" },
      occurred_at: { type: "string" },
      meal_type: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack"] },
      raw_input: { type: "string" },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      parser: { type: "string", enum: ["nutritionix", "llm", "mixed"] },
      notes: { type: "string" },
    },
    required: ["meal_id"],
  },
  modes: new Set<BrainMode>(["reactive"]),
};

export async function updateMealHandler(input: unknown): Promise<unknown> {
  const i = (input ?? {}) as UpdateMealInput;
  if (!i.meal_id) throw new Error("update_meal: meal_id required");
  const ctx = getTurnContext();
  const meal = await updateMeal(i.meal_id, ctx.userId, {
    items: i.items,
    occurredAt: i.occurred_at ? new Date(i.occurred_at) : undefined,
    mealType: i.meal_type,
    rawInput: i.raw_input,
    confidence: i.confidence,
    parser: i.parser,
    notes: i.notes,
  });
  if (ctx.runId) {
    await recordExecutionEvent(ctx.runId, "meal_edited", "calories", {
      meal_id: meal.id,
      kcal: Number(meal.total_kcal),
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
