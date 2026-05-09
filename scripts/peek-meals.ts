import "../src/donna/env.js";
import { getSql, closeDb } from "../src/donna/db.js";

async function main() {
  const sql = getSql();
  const tables = await sql`
    select table_schema, table_name
    from information_schema.tables
    where table_name in ('users','meals','meal_items','food_goals','meal_aliases','food_cache','execution_runs','execution_events','chat_messages')
    order by table_name
  `;
  console.log("== tables visible to runtime DATABASE_URL ==");
  console.log(tables);
  await closeDb();
}
main().catch((e) => { console.error(e); process.exit(1); });
