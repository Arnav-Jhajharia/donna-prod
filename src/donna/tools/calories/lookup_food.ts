import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../../brain.js";
import { getTurnContext } from "../../context.js";
import { instantSearch } from "../../integrations/nutritionix.js";
import { recordExecutionEvent } from "../../observability/execution.js";

const PTC_CALLER = "code_execution_20250825" as const;

interface LookupFoodInput {
  query: string;
  limit?: number;
}

export const lookupFoodTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "lookup_food",
  description: `instant search for foods when parse_food_text was ambiguous. returns common (generic) and branded matches.

use when the user says "log a venti latte" but you're not sure which one — call lookup_food first, pick the right nix_item_id, then use it inside parse_food_text or compose the item directly for log_meal.

returns: { common: [...], branded: [...] }.`,
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "number" },
    },
    required: ["query"],
  },
  allowed_callers: [PTC_CALLER],
  modes: new Set<BrainMode>(["reactive"]),
};

export async function lookupFoodHandler(input: unknown): Promise<unknown> {
  const i = (input ?? {}) as LookupFoodInput;
  if (!i.query) throw new Error("lookup_food: query required");
  const ctx = getTurnContext();
  const result = await instantSearch(i.query, i.limit ?? 5);
  if (ctx.runId) {
    await recordExecutionEvent(ctx.runId, "nutritionix_lookup", "calories", {
      query: i.query.slice(0, 80),
      common: result.common.length,
      branded: result.branded.length,
    });
  }
  return result;
}
