import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../../brain.js";
import { getTurnContext } from "../../context.js";
import { naturalNutrients } from "../../integrations/nutritionix.js";
import { recordExecutionEvent } from "../../observability/execution.js";

const PTC_CALLER = "code_execution_20250825" as const;

interface ParseFoodTextInput {
  text: string;
}

export const parseFoodTextTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "parse_food_text",
  description: `parse a free-form food description into canonical macros via nutritionix natural language. handles "two eggs and toast", "starbucks venti latte", "1 cup of basmati rice with curry".

returns: { source: "nutritionix"|"cache", items: [{name, quantity, unit, serving_grams, kcal, protein_g, carbs_g, fat_g, fiber_g, sodium_mg, nix_id?}] }.

confidence rules for log_meal: if items.length matches what you described and every item has nf data, confidence="high". if some items are missing or estimated, "medium". if items is empty, fall back to your own estimate and pass confidence="low" with parser="llm".

mark this async — call from inside python via asyncio.gather alongside get_food_goal() and get_daily_summary().`,
  input_schema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "the food description in plain english.",
      },
    },
    required: ["text"],
  },
  allowed_callers: [PTC_CALLER],
  modes: new Set<BrainMode>(["reactive"]),
};

export async function parseFoodTextHandler(input: unknown): Promise<unknown> {
  const i = (input ?? {}) as ParseFoodTextInput;
  if (!i.text) throw new Error("parse_food_text: text required");
  const ctx = getTurnContext();
  const result = await naturalNutrients(i.text);
  const items = result.foods.map((f) => ({
    name: f.food_name,
    quantity: f.serving_qty,
    unit: f.serving_unit,
    serving_grams: f.serving_weight_grams ?? undefined,
    kcal: f.nf_calories,
    protein_g: f.nf_protein,
    carbs_g: f.nf_total_carbohydrate,
    fat_g: f.nf_total_fat,
    fiber_g: f.nf_dietary_fiber ?? 0,
    sodium_mg: f.nf_sodium ?? 0,
    nix_id: f.nix_item_id ?? undefined,
  }));
  if (ctx.runId) {
    const label =
      result.source === "cache"
        ? "nutritionix_cached"
        : items.length > 0
          ? "nutritionix_hit"
          : "nutritionix_miss";
    await recordExecutionEvent(ctx.runId, label, "calories", {
      query: i.text.slice(0, 80),
      items: items.length,
    });
  }
  return { source: result.source, items };
}
