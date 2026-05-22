import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../../brain.js";
import { getTurnContext } from "../../context.js";
import { listExpenseAliases } from "../../expenses/aliases.js";

const PTC_CALLER = "code_execution_20250825" as const;

export const listExpenseAliasesTool: Tool & {
  modes: ReadonlySet<BrainMode>;
} = {
  name: "list_expense_aliases",
  description: `saved aliases with their templates. use to look up what "usual coffee" / "gym dues" resolve to before logging.

returns: array of {id, alias, template: {merchant?, amount_cents, currency?, category?, items?[], notes?}}.`,
  input_schema: { type: "object", properties: {} },
  allowed_callers: [PTC_CALLER],
  modes: new Set<BrainMode>(["reactive", "proactive"]),
};

export async function listExpenseAliasesHandler(
  _input: unknown,
): Promise<unknown> {
  const ctx = getTurnContext();
  return await listExpenseAliases(ctx.userId);
}
