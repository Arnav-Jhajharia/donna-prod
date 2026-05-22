import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../../brain.js";
import { getTurnContext } from "../../context.js";
import { listAliases } from "../../calories/aliases.js";

const PTC_CALLER = "code_execution_20250825" as const;

export const listMealAliasesTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "list_meal_aliases",
  description: `list all saved meal aliases for the user.

use when the user asks "what did i save" or before logging by alias to confirm the name.

returns: { aliases: [{alias, items_summary}] } — items_summary is the first item name + count.`,
  input_schema: { type: "object", properties: {} },
  allowed_callers: [PTC_CALLER],
  modes: new Set<BrainMode>(["reactive"]),
};

export async function listMealAliasesHandler(): Promise<unknown> {
  const ctx = getTurnContext();
  const rows = await listAliases(ctx.userId);
  return {
    aliases: rows.map((r) => {
      const first = r.template[0];
      return {
        alias: r.alias,
        items_summary:
          r.template.length === 0 || !first
            ? "(empty)"
            : `${first.name}${r.template.length > 1 ? ` +${r.template.length - 1}` : ""}`,
      };
    }),
  };
}
