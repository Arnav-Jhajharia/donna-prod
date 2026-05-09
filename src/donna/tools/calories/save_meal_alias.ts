import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../../brain.js";
import { getTurnContext } from "../../context.js";
import { saveAlias } from "../../calories/aliases.js";
import { getMealItems, getMostRecentMeal } from "../../calories/meals.js";
import type { MealItemInput } from "../../calories/types.js";

interface SaveMealAliasInput {
  alias: string;
  meal_id?: string;
  template?: MealItemInput[];
}

export const saveMealAliasTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "save_meal_alias",
  description: `save a meal as a named template the user can re-log later.

call this when the user says "save this as my usual breakfast" or "remember this lunch as 'office salad'".

inputs:
- alias: short user-facing name. lowercased before save.
- meal_id (optional): meal to snapshot. omit to use the most recent meal.
- template (optional): explicit item list. when set, db isn't read.

returns: { alias, items: [...] }.`,
  input_schema: {
    type: "object",
    properties: {
      alias: { type: "string" },
      meal_id: { type: "string" },
      template: { type: "array" },
    },
    required: ["alias"],
  },
  modes: new Set<BrainMode>(["reactive"]),
};

export async function saveMealAliasHandler(input: unknown): Promise<unknown> {
  const i = (input ?? {}) as SaveMealAliasInput;
  if (!i.alias) throw new Error("save_meal_alias: alias required");
  const ctx = getTurnContext();

  let template: MealItemInput[];
  if (i.template && i.template.length > 0) {
    template = i.template;
  } else {
    const mealId =
      i.meal_id ?? (await getMostRecentMeal(ctx.userId))?.id ?? null;
    if (!mealId) throw new Error("save_meal_alias: no meal to snapshot");
    const items = await getMealItems(mealId);
    template = items.map((it) => ({
      name: it.name,
      quantity: it.quantity ?? undefined,
      unit: it.unit ?? undefined,
      serving_grams: it.serving_grams ?? undefined,
      kcal: Number(it.kcal),
      protein_g: Number(it.protein_g),
      carbs_g: Number(it.carbs_g),
      fat_g: Number(it.fat_g),
      fiber_g: Number(it.fiber_g),
      sodium_mg: Number(it.sodium_mg),
      nix_id: it.nix_id ?? undefined,
    }));
  }

  const row = await saveAlias({
    userId: ctx.userId,
    alias: i.alias.toLowerCase().trim(),
    template,
  });
  return { alias: row.alias, items: row.template };
}
