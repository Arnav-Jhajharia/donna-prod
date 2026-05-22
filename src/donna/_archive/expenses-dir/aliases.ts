// expense_aliases repo. saves a snapshot template the user can re-log via
// log_expense_from_alias.

import { getSql } from "../db.js";
import type { ExpenseAliasRow, ExpenseAliasTemplate } from "./types.js";

export async function saveExpenseAlias(args: {
  userId: string;
  alias: string;
  template: ExpenseAliasTemplate;
}): Promise<ExpenseAliasRow> {
  const sql = getSql();
  const [row] = await sql<ExpenseAliasRow[]>`
    insert into expense_aliases (user_id, alias, template)
    values (
      ${args.userId},
      ${args.alias},
      ${sql.json(args.template as unknown as Parameters<typeof sql.json>[0])}
    )
    on conflict (user_id, alias) do update set
      template = excluded.template,
      updated_at = now()
    returning *
  `;
  if (!row) throw new Error("save_expense_alias: insert returned no row");
  return row;
}

export async function listExpenseAliases(
  userId: string,
): Promise<ExpenseAliasRow[]> {
  const sql = getSql();
  return await sql<ExpenseAliasRow[]>`
    select * from expense_aliases where user_id = ${userId} order by alias asc
  `;
}

export async function getExpenseAlias(
  userId: string,
  alias: string,
): Promise<ExpenseAliasRow | null> {
  const sql = getSql();
  const rows = await sql<ExpenseAliasRow[]>`
    select * from expense_aliases where user_id = ${userId} and alias = ${alias}
  `;
  return rows[0] ?? null;
}
