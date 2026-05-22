import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../../brain.js";
import { getTurnContext } from "../../context.js";
import { getExpenseAlias } from "../../expenses/aliases.js";
import { insertExpense } from "../../expenses/expenses.js";

interface LogExpenseFromAliasInput {
  alias: string;
  occurred_at?: string;
  amount_cents_override?: number;
}

export const logExpenseFromAliasTool: Tool & {
  modes: ReadonlySet<BrainMode>;
} = {
  name: "log_expense_from_alias",
  description: `fast-path: log an expense from a saved alias ("my usual coffee", "gym dues").

inputs:
- alias: the saved alias name.
- occurred_at: iso timestamp. default now.
- amount_cents_override: replace the template's amount for this one entry (e.g. coffee usually 5 but today it was 7).

returns: { expense_id, amount_cents, merchant }.`,
  input_schema: {
    type: "object",
    properties: {
      alias: { type: "string" },
      occurred_at: { type: "string" },
      amount_cents_override: { type: "number" },
    },
    required: ["alias"],
  },
  modes: new Set<BrainMode>(["reactive"]),
};

export async function logExpenseFromAliasHandler(
  input: unknown,
): Promise<unknown> {
  const i = (input ?? {}) as LogExpenseFromAliasInput;
  if (!i.alias) throw new Error("log_expense_from_alias: alias required");
  const ctx = getTurnContext();
  const row = await getExpenseAlias(ctx.userId, i.alias);
  if (!row) throw new Error(`log_expense_from_alias: alias not found: ${i.alias}`);
  const t = row.template;
  const expense = await insertExpense({
    userId: ctx.userId,
    occurredAt: i.occurred_at ? new Date(i.occurred_at) : new Date(),
    merchant: t.merchant ?? null,
    amountCents: i.amount_cents_override ?? t.amount_cents,
    currency: t.currency ?? "USD",
    category: t.category ?? null,
    sourceKind: "alias",
    sourceMessageId: null,
    rawInput: i.alias,
    visionDescription: null,
    confidence: "high",
    parser: "user",
    notes: t.notes ?? null,
    items: t.items ?? [],
  });
  return {
    expense_id: expense.id,
    amount_cents: Number(expense.amount_cents),
    merchant: expense.merchant,
  };
}
