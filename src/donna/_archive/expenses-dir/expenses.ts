// expenses + expense_items repository. all writes are transactional. when
// items are provided, the parent's amount_cents is recomputed from the sum.
// when items are absent (the common "spent 40 on uber" case), amount_cents is
// taken verbatim from the caller.

import { getSql } from "../db.js";
import type {
  Confidence,
  ExpenseItemInput,
  ExpenseItemRow,
  ExpenseRow,
  ExpenseSource,
  Parser,
  Recurrence,
} from "./types.js";

interface InsertExpenseArgs {
  userId: string;
  occurredAt: Date;
  merchant: string | null;
  amountCents: number | null; // if null, must provide items[]
  currency?: string;
  category: string | null;
  sourceKind: ExpenseSource;
  sourceMessageId: string | null;
  rawInput: string | null;
  visionDescription: string | null;
  confidence: Confidence | null;
  parser: Parser | null;
  recurrence?: Recurrence | null;
  isRecurring?: boolean;
  notes?: string | null;
  items?: ExpenseItemInput[];
}

function sumItems(items: ExpenseItemInput[]): number {
  return items.reduce((acc, it) => acc + (it.amount_cents ?? 0), 0);
}

function rowsForItems(expenseId: string, items: ExpenseItemInput[]) {
  return items.map((it, i) => ({
    expense_id: expenseId,
    position: i,
    name: it.name,
    quantity: it.quantity ?? null,
    unit: it.unit ?? null,
    amount_cents: it.amount_cents,
    category: it.category ?? null,
    notes: it.notes ?? null,
  }));
}

export async function insertExpense(args: InsertExpenseArgs): Promise<ExpenseRow> {
  const sql = getSql();
  const items = args.items ?? [];
  const amount =
    args.amountCents != null
      ? args.amountCents
      : items.length > 0
        ? sumItems(items)
        : null;
  if (amount == null) {
    throw new Error("insert_expense: amount_cents or items[] required");
  }
  return (await sql.begin(async (tx) => {
    const [expense] = await tx<ExpenseRow[]>`
      insert into expenses (
        user_id, occurred_at, merchant, amount_cents, currency, category,
        source_kind, source_message_id, raw_input, vision_description,
        confidence, parser, is_recurring, recurrence, notes
      ) values (
        ${args.userId}, ${args.occurredAt}, ${args.merchant}, ${amount},
        ${args.currency ?? "USD"}, ${args.category},
        ${args.sourceKind}, ${args.sourceMessageId}, ${args.rawInput}, ${args.visionDescription},
        ${args.confidence}, ${args.parser},
        ${args.isRecurring ?? false}, ${args.recurrence ?? null},
        ${args.notes ?? null}
      )
      returning *
    `;
    if (!expense) throw new Error("insert_expense: insert returned no row");
    if (items.length > 0) {
      const rows = rowsForItems(expense.id, items);
      await tx`insert into expense_items ${tx(rows)}`;
    }
    return expense;
  })) as ExpenseRow;
}

interface UpdateExpensePatch {
  occurredAt?: Date;
  merchant?: string | null;
  amountCents?: number;
  currency?: string;
  category?: string | null;
  rawInput?: string | null;
  confidence?: Confidence;
  parser?: Parser;
  recurrence?: Recurrence | null;
  isRecurring?: boolean;
  notes?: string | null;
  items?: ExpenseItemInput[];
}

export async function updateExpense(
  expenseId: string,
  userId: string,
  patch: UpdateExpensePatch,
): Promise<ExpenseRow> {
  const sql = getSql();
  return (await sql.begin(async (tx) => {
    const [existing] = await tx<ExpenseRow[]>`
      select * from expenses
       where id = ${expenseId} and user_id = ${userId} and not is_deleted
    `;
    if (!existing) throw new Error("update_expense: expense not found");

    const items = patch.items ?? null;
    if (items) {
      await tx`delete from expense_items where expense_id = ${expenseId}`;
      if (items.length > 0) {
        const rows = rowsForItems(expenseId, items);
        await tx`insert into expense_items ${tx(rows)}`;
      }
    }

    // if items were rewritten, the new amount is their sum. otherwise honor
    // the explicit amount or leave existing.
    const newAmount =
      items != null
        ? sumItems(items)
        : (patch.amountCents ?? Number(existing.amount_cents));

    const [updated] = await tx<ExpenseRow[]>`
      update expenses set
        occurred_at  = coalesce(${patch.occurredAt ?? null}, occurred_at),
        merchant     = coalesce(${patch.merchant ?? null}, merchant),
        currency     = coalesce(${patch.currency ?? null}, currency),
        category     = coalesce(${patch.category ?? null}, category),
        raw_input    = coalesce(${patch.rawInput ?? null}, raw_input),
        confidence   = coalesce(${patch.confidence ?? null}, confidence),
        parser       = coalesce(${patch.parser ?? null}, parser),
        recurrence   = coalesce(${patch.recurrence ?? null}, recurrence),
        is_recurring = coalesce(${patch.isRecurring ?? null}, is_recurring),
        notes        = coalesce(${patch.notes ?? null}, notes),
        amount_cents = ${newAmount},
        updated_at   = now()
      where id = ${expenseId}
      returning *
    `;
    return updated;
  })) as ExpenseRow;
}

export async function softDeleteExpense(
  expenseId: string,
  userId: string,
): Promise<void> {
  const sql = getSql();
  await sql`
    update expenses set is_deleted = true, updated_at = now()
     where id = ${expenseId} and user_id = ${userId}
  `;
}

export async function getMostRecentExpense(
  userId: string,
): Promise<ExpenseRow | null> {
  const sql = getSql();
  const rows = await sql<ExpenseRow[]>`
    select * from expenses
     where user_id = ${userId} and not is_deleted
     order by occurred_at desc
     limit 1
  `;
  return rows[0] ?? null;
}

export async function getExpenseItems(
  expenseId: string,
): Promise<ExpenseItemRow[]> {
  const sql = getSql();
  return await sql<ExpenseItemRow[]>`
    select * from expense_items where expense_id = ${expenseId} order by position asc
  `;
}

export async function markRecurring(
  userId: string,
  expenseIds: string[],
  recurrence: Recurrence,
): Promise<void> {
  if (expenseIds.length === 0) return;
  const sql = getSql();
  await sql`
    update expenses set is_recurring = true, recurrence = ${recurrence}, updated_at = now()
     where user_id = ${userId} and id in ${sql(expenseIds)}
  `;
}
