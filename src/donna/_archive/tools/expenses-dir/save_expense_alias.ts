import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../../brain.js";
import { getTurnContext } from "../../context.js";
import {
  getMostRecentExpense,
  getExpenseItems,
} from "../../expenses/expenses.js";
import { saveExpenseAlias } from "../../expenses/aliases.js";
import type { ExpenseAliasTemplate } from "../../expenses/types.js";

interface SaveExpenseAliasInput {
  alias: string;
  expense_id?: string;
}

export const saveExpenseAliasTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "save_expense_alias",
  description: `snapshot an expense as a named template the user can re-log via log_expense_from_alias.

call when the user says "save this as my usual coffee" / "remember this as 'gym dues'".

inputs:
- alias: short user-facing name ("usual coffee", "gym dues").
- expense_id: which expense to snapshot. if omitted, uses the user's most recent expense.

returns: { alias, template }.`,
  input_schema: {
    type: "object",
    properties: {
      alias: { type: "string" },
      expense_id: { type: "string" },
    },
    required: ["alias"],
  },
  modes: new Set<BrainMode>(["reactive"]),
};

export async function saveExpenseAliasHandler(
  input: unknown,
): Promise<unknown> {
  const i = (input ?? {}) as SaveExpenseAliasInput;
  if (!i.alias) throw new Error("save_expense_alias: alias required");
  const ctx = getTurnContext();

  let template: ExpenseAliasTemplate;
  if (i.expense_id) {
    // load items + parent for the specified expense — left as a small follow-up
    // when needed. for now we error out so callers know to omit and use the
    // most-recent flow.
    throw new Error(
      "save_expense_alias: explicit expense_id not yet supported; omit to use most recent",
    );
  } else {
    const recent = await getMostRecentExpense(ctx.userId);
    if (!recent) {
      throw new Error("save_expense_alias: no recent expense to snapshot");
    }
    const items = await getExpenseItems(recent.id);
    template = {
      merchant: recent.merchant ?? undefined,
      amount_cents: Number(recent.amount_cents),
      currency: recent.currency,
      category: recent.category ?? undefined,
      items: items.length
        ? items.map((it) => ({
            name: it.name,
            quantity: it.quantity ?? undefined,
            unit: it.unit ?? undefined,
            amount_cents: Number(it.amount_cents),
            category: it.category ?? undefined,
            notes: it.notes ?? undefined,
          }))
        : undefined,
      notes: recent.notes ?? undefined,
    };
  }

  const row = await saveExpenseAlias({
    userId: ctx.userId,
    alias: i.alias,
    template,
  });
  return { alias: row.alias, template: row.template };
}
