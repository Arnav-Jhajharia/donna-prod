// meal_aliases repo. saves a snapshot of items as a named template the user
// can re-log via log_meal_from_alias.

import { getSql } from "../db.js";
import type { MealAliasRow, MealItemInput } from "./types.js";

export async function saveAlias(args: {
  userId: string;
  alias: string;
  template: MealItemInput[];
}): Promise<MealAliasRow> {
  const sql = getSql();
  const [row] = await sql<MealAliasRow[]>`
    insert into meal_aliases (user_id, alias, template)
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
  if (!row) throw new Error("save_alias: insert returned no row");
  return row;
}

export async function listAliases(userId: string): Promise<MealAliasRow[]> {
  const sql = getSql();
  return await sql<MealAliasRow[]>`
    select * from meal_aliases where user_id = ${userId} order by alias asc
  `;
}

export async function getAlias(
  userId: string,
  alias: string,
): Promise<MealAliasRow | null> {
  const sql = getSql();
  const rows = await sql<MealAliasRow[]>`
    select * from meal_aliases where user_id = ${userId} and alias = ${alias}
  `;
  return rows[0] ?? null;
}
