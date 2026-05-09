import "../src/donna/env.js";
import { closeDb, getSql } from "../src/donna/db.js";

async function main() {
  const sql = getSql();

  const conn = await sql<Array<{ db: string; user: string; host: string }>>`
    select current_database() as db, current_user as "user", inet_server_addr()::text as host
  `;
  console.log("CONNECTED TO:", JSON.stringify(conn[0]));

  const schemas = await sql<Array<{ table_schema: string; table_name: string }>>`
    select table_schema, table_name from information_schema.tables
    where table_name in ('integrations', 'gmail_threads', 'gmail_people')
    order by table_schema, table_name
  `;
  console.log("\nTABLE LOCATIONS:");
  for (const s of schemas) console.log(`  ${s.table_schema}.${s.table_name}`);
  console.log();

  const cols = await sql<Array<{ column_name: string; data_type: string }>>`
    select column_name, data_type
    from information_schema.columns
    where table_name = 'integrations'
    order by ordinal_position
  `;
  console.log("INTEGRATIONS COLUMNS:");
  for (const c of cols) console.log(`  ${c.column_name.padEnd(28)} ${c.data_type}`);

  const counts = await sql<Array<{ count: string }>>`select count(*) from integrations`;
  console.log(`\nROW COUNT: ${counts[0]?.count}`);

  if (Number(counts[0]?.count ?? 0) > 0) {
    const sample = await sql`select * from integrations limit 5`;
    console.log("\nSAMPLE:");
    console.log(JSON.stringify(sample, null, 2));
  }

  const auditCols = await sql<Array<{ column_name: string; data_type: string }>>`
    select column_name, data_type from information_schema.columns
    where table_name = 'integration_audit' order by ordinal_position
  `;
  console.log("\nINTEGRATION_AUDIT COLUMNS:");
  for (const c of auditCols) console.log(`  ${c.column_name.padEnd(28)} ${c.data_type}`);
}

main()
  .catch((e) => console.error(e))
  .finally(() => closeDb());
