import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../../brain.js";
import { getTurnContext } from "../../context.js";
import { updateExpense } from "../../expenses/expenses.js";
import type {
  Confidence,
  ExpenseItemInput,
  Parser,
  Recurrence,
} from "../../expenses/types.js";
import { recordExecutionEvent } from "../../observability/execution.js";

interface UpdateExpenseInput {
  expense_id: string;
  merchant?: string | null;
  amount_cents?: number;
  currency?: string;
  category?: string | null;
  items?: ExpenseItemInput[];
  occurred_at?: string;
  raw_input?: string;
  confidence?: Confidence;
  parser?: Parser;
  recurrence?: Recurrence | null;
  is_recurring?: boolean;
  notes?: string;
}

export const updateExpenseTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "update_expense",
  description: `edit a logged expense in place. when items[] is provided, the line items are replaced wholesale and amount_cents is recomputed from their sum.

use for corrections ("actually it was $50 not $40", "wrong category", "i forgot the tip"). soft-delete via delete_expense if the whole thing was wrong.

returns: { expense_id, amount_cents, merchant, category }.`,
  input_schema: {
    type: "object",
    properties: {
      expense_id: { type: "string" },
      merchant: { type: ["string", "null"] },
      amount_cents: { type: "number" },
      currency: { type: "string" },
      category: { type: ["string", "null"] },
      items: { type: "array" },
      occurred_at: { type: "string" },
      raw_input: { type: "string" },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      parser: {
        type: "string",
        enum: ["llm", "user", "gmail", "plaid", "mixed"],
      },
      recurrence: {
        type: ["string", "null"],
        enum: ["weekly", "monthly", "quarterly", "yearly", null],
      },
      is_recurring: { type: "boolean" },
      notes: { type: "string" },
    },
    required: ["expense_id"],
  },
  modes: new Set<BrainMode>(["reactive"]),
};

export async function updateExpenseHandler(input: unknown): Promise<unknown> {
  const i = (input ?? {}) as UpdateExpenseInput;
  if (!i.expense_id) throw new Error("update_expense: expense_id required");
  const ctx = getTurnContext();
  const updated = await updateExpense(i.expense_id, ctx.userId, {
    occurredAt: i.occurred_at ? new Date(i.occurred_at) : undefined,
    merchant: i.merchant,
    amountCents: i.amount_cents,
    currency: i.currency,
    category: i.category,
    rawInput: i.raw_input,
    confidence: i.confidence,
    parser: i.parser,
    recurrence: i.recurrence,
    isRecurring: i.is_recurring,
    notes: i.notes ?? null,
    items: i.items,
  });
  if (ctx.runId) {
    await recordExecutionEvent(ctx.runId, "expense_updated", "expenses", {
      expense_id: updated.id,
    });
  }
  return {
    expense_id: updated.id,
    amount_cents: Number(updated.amount_cents),
    merchant: updated.merchant,
    category: updated.category,
  };
}
