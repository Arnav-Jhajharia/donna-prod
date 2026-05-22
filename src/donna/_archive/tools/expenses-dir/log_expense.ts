import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../../brain.js";
import { getTurnContext } from "../../context.js";
import { insertExpense } from "../../expenses/expenses.js";
import type {
  Confidence,
  ExpenseItemInput,
  ExpenseSource,
  Parser,
} from "../../expenses/types.js";
import { recordExecutionEvent } from "../../observability/execution.js";

interface LogExpenseInput {
  merchant?: string;
  amount_cents?: number;
  currency?: string;
  category?: string;
  items?: ExpenseItemInput[];
  occurred_at?: string;
  source_kind: ExpenseSource;
  source_message_id?: string;
  raw_input?: string;
  vision_description?: string;
  confidence?: Confidence;
  parser?: Parser;
  notes?: string;
}

export const logExpenseTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "log_expense",
  description: `persist an expense the user just told you about. one row in expenses (+ optional rows in expense_items if it's a multi-line receipt), in one transaction.

call this after you've parsed the user's text/photo/voice and have at least amount_cents (for single-line cases) or items[] (for receipts).

inputs:
- merchant: free-form name ("Uber", "Whole Foods", "Netflix"). null for cash etc.
- amount_cents: total in minor units (USD $40 → 4000). required unless items[] is provided.
- currency: ISO code ("USD", "EUR", ...). default USD.
- category: free-form. prefer the canonical buckets — see <expense_logging>.
- items: optional line items for receipts. each {name, amount_cents, quantity?, unit?, category?, notes?}. when provided, amount_cents is computed from their sum.
- occurred_at: iso timestamp. default now.
- source_kind: text | photo | voice | alias | edit | gmail | plaid.
- source_message_id: the inbound platform message id, when known.
- raw_input: the user's words / transcription / typed message.
- vision_description: your description of the receipt photo, if there was one.
- confidence: high (amount + merchant clearly stated) | medium (estimated) | low (ambiguous).
- parser: llm (you parsed it) | user (user typed structured) | gmail | plaid | mixed.

returns: { expense_id, amount_cents, currency, merchant, category }.

after logging, call get_daily_spend() and/or get_monthly_summary() so you can tell the user where they are vs budget.`,
  input_schema: {
    type: "object",
    properties: {
      merchant: { type: "string" },
      amount_cents: { type: "number" },
      currency: { type: "string" },
      category: { type: "string" },
      items: { type: "array" },
      occurred_at: { type: "string" },
      source_kind: {
        type: "string",
        enum: ["text", "photo", "voice", "alias", "edit", "gmail", "plaid"],
      },
      source_message_id: { type: "string" },
      raw_input: { type: "string" },
      vision_description: { type: "string" },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      parser: {
        type: "string",
        enum: ["llm", "user", "gmail", "plaid", "mixed"],
      },
      notes: { type: "string" },
    },
    required: ["source_kind"],
  },
  modes: new Set<BrainMode>(["reactive"]),
};

export async function logExpenseHandler(input: unknown): Promise<unknown> {
  const i = (input ?? {}) as LogExpenseInput;
  if (i.amount_cents == null && (!i.items || i.items.length === 0)) {
    throw new Error("log_expense: amount_cents or items[] required");
  }
  const ctx = getTurnContext();
  const occurredAt = i.occurred_at ? new Date(i.occurred_at) : new Date();
  const expense = await insertExpense({
    userId: ctx.userId,
    occurredAt,
    merchant: i.merchant ?? null,
    amountCents: i.amount_cents ?? null,
    currency: i.currency ?? "USD",
    category: i.category ?? null,
    sourceKind: i.source_kind,
    sourceMessageId: i.source_message_id ?? null,
    rawInput: i.raw_input ?? null,
    visionDescription: i.vision_description ?? null,
    confidence: i.confidence ?? null,
    parser: i.parser ?? "llm",
    notes: i.notes ?? null,
    items: i.items ?? [],
  });
  if (ctx.runId) {
    await recordExecutionEvent(ctx.runId, "expense_logged", "expenses", {
      expense_id: expense.id,
      amount_cents: Number(expense.amount_cents),
      merchant: expense.merchant,
      category: expense.category,
      source_kind: i.source_kind,
      confidence: i.confidence,
    });
    if (i.vision_description) {
      await recordExecutionEvent(ctx.runId, "vision_described", "expenses", {
        expense_id: expense.id,
        description_length: i.vision_description.length,
      });
    }
  }
  return {
    expense_id: expense.id,
    amount_cents: Number(expense.amount_cents),
    currency: expense.currency,
    merchant: expense.merchant,
    category: expense.category,
  };
}
