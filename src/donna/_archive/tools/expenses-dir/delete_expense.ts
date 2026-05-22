import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../../brain.js";
import { getTurnContext } from "../../context.js";
import { softDeleteExpense } from "../../expenses/expenses.js";
import { recordExecutionEvent } from "../../observability/execution.js";

interface DeleteExpenseInput {
  expense_id: string;
}

export const deleteExpenseTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "delete_expense",
  description: `soft-delete an expense the user retracts. use when the user says "scratch that", "i didn't actually buy it", "wrong account".

if the user only wants to correct part of it, use update_expense instead.`,
  input_schema: {
    type: "object",
    properties: {
      expense_id: { type: "string" },
    },
    required: ["expense_id"],
  },
  modes: new Set<BrainMode>(["reactive"]),
};

export async function deleteExpenseHandler(input: unknown): Promise<unknown> {
  const i = (input ?? {}) as DeleteExpenseInput;
  if (!i.expense_id) throw new Error("delete_expense: expense_id required");
  const ctx = getTurnContext();
  await softDeleteExpense(i.expense_id, ctx.userId);
  if (ctx.runId) {
    await recordExecutionEvent(ctx.runId, "expense_deleted", "expenses", {
      expense_id: i.expense_id,
    });
  }
  return { expense_id: i.expense_id, deleted: true };
}
