import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../../brain.js";
import { getTurnContext } from "../../context.js";
import { insertMeal } from "../../calories/meals.js";
import type {
  Confidence,
  MealItemInput,
  MealSource,
  MealType,
  Parser,
} from "../../calories/types.js";
import { recordExecutionEvent } from "../../observability/execution.js";

interface LogMealInput {
  items: MealItemInput[];
  occurred_at?: string;
  meal_type?: MealType;
  source_kind: MealSource;
  source_message_id?: string;
  raw_input?: string;
  vision_description?: string;
  confidence: Confidence;
  parser: Parser;
  notes?: string;
}

export const logMealTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "log_meal",
  description: `persist a meal the user just told you about. one row in meals + N rows in meal_items, in one transaction. all macros come from parse_food_text or your own estimate.

call this AFTER parse_food_text has returned items, or AFTER you've estimated items yourself when nutritionix had nothing.

inputs:
- items: array of {name, quantity?, unit?, serving_grams?, kcal, protein_g, carbs_g, fat_g, fiber_g?, sodium_mg?, nix_id?}
- occurred_at: iso timestamp the meal happened. default now.
- meal_type: breakfast | lunch | dinner | snack. infer from time if obvious.
- source_kind: text | photo | voice | alias | edit. how the user logged it.
- source_message_id: the inbound platform message id, when known.
- raw_input: the user's words / transcription / typed message.
- vision_description: your description of the photo, if there was one.
- confidence: high (all items matched in nutritionix), medium (some matched), low (none).
- parser: nutritionix | mixed | llm.

returns: { meal_id, totals: {kcal, protein_g, carbs_g, fat_g} }.

after logging, call get_daily_summary() so you can tell the user where they are vs goal.`,
  input_schema: {
    type: "object",
    properties: {
      items: { type: "array" },
      occurred_at: { type: "string" },
      meal_type: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack"] },
      source_kind: { type: "string", enum: ["text", "photo", "voice", "alias", "edit"] },
      source_message_id: { type: "string" },
      raw_input: { type: "string" },
      vision_description: { type: "string" },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      parser: { type: "string", enum: ["nutritionix", "llm", "mixed"] },
      notes: { type: "string" },
    },
    required: ["items", "source_kind", "confidence", "parser"],
  },
  modes: new Set<BrainMode>(["reactive"]),
};

export async function logMealHandler(input: unknown): Promise<unknown> {
  const i = (input ?? {}) as LogMealInput;
  if (!Array.isArray(i.items) || i.items.length === 0) {
    throw new Error("log_meal: items required");
  }
  const ctx = getTurnContext();
  const occurredAt = i.occurred_at ? new Date(i.occurred_at) : new Date();
  const meal = await insertMeal({
    userId: ctx.userId,
    occurredAt,
    mealType: i.meal_type ?? null,
    sourceKind: i.source_kind,
    sourceMessageId: i.source_message_id ?? null,
    rawInput: i.raw_input ?? null,
    visionDescription: i.vision_description ?? null,
    confidence: i.confidence,
    parser: i.parser,
    notes: i.notes ?? null,
    items: i.items,
  });
  if (ctx.runId) {
    await recordExecutionEvent(ctx.runId, "meal_logged", "calories", {
      meal_id: meal.id,
      kcal: Number(meal.total_kcal),
      item_count: i.items.length,
      source_kind: i.source_kind,
      confidence: i.confidence,
    });
    if (i.vision_description) {
      await recordExecutionEvent(ctx.runId, "vision_described", "calories", {
        meal_id: meal.id,
        description_length: i.vision_description.length,
      });
    }
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
