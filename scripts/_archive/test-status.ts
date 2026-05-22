// scripts/test-status.ts
//
// pre-flight diagnostic before the e2e test. tells us:
//   1. does DATABASE_URL connect
//   2. is DONNA_USER_ID a valid uuid
//   3. which expected tables exist
//   4. which expected columns exist on integrations (schema-drift check)
//   5. is there a user row for DONNA_USER_ID
//   6. is there an integrations row for gmail
//   7. is there an active subscriptions_onboarding agenda
//
// each row prints ✓ or ✗. nothing is changed.
//
// run: npx tsx scripts/test-status.ts

import "dotenv/config";
import postgres from "postgres";
import { readFileSync, existsSync } from "node:fs";

const REQUIRED_TABLES = [
  "users",
  "integrations",
  "chat_messages",
  "execution_runs",
  "subscriptions",
  "subscription_events",
  "agendas",
  "subscriptions_backfills",
];

const REQUIRED_INTEGRATIONS_COLUMNS = [
  "user_id",
  "provider",
  "status",
  "mode",
  "exclusions",
  "config",
  "composio_account_id",
  "last_sync_at",
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function row(ok: boolean, label: string, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"}  ${label}${detail ? "  —  " + detail : ""}`);
  return ok;
}

async function main() {
  console.log("─".repeat(72));
  console.log("  pre-flight diagnostic");
  console.log("─".repeat(72));

  const dbUrl = process.env.DATABASE_URL;
  const donnaUserId = process.env.DONNA_USER_ID;
  const composioApiKey = process.env.COMPOSIO_API_KEY;

  let allGreen = true;

  allGreen = row(!!dbUrl, "DATABASE_URL set") && allGreen;
  allGreen = row(!!donnaUserId, "DONNA_USER_ID set", donnaUserId ?? "(missing)") && allGreen;
  allGreen = row(!!composioApiKey, "COMPOSIO_API_KEY set") && allGreen;
  if (!dbUrl || !donnaUserId) return;

  const isUuid = UUID_RE.test(donnaUserId);
  allGreen = row(isUuid, "DONNA_USER_ID looks like a uuid", isUuid ? "" : "users.id is uuid type — non-uuid will fail FK") && allGreen;

  const sql = postgres(dbUrl, { ssl: "require", connect_timeout: 8 });
  try {
    await sql`select 1`;
    row(true, "DB connects");

    // tables
    const tables = (await sql<Array<{ tablename: string }>>`
      select tablename from pg_tables where schemaname = 'public'
    `).map((t) => t.tablename);
    console.log("");
    console.log("  TABLES");
    for (const t of REQUIRED_TABLES) {
      const ok = tables.includes(t);
      row(ok, `public.${t}`, ok ? "" : "missing — apply migrations");
      if (!ok) allGreen = false;
    }

    // integrations columns
    if (tables.includes("integrations")) {
      const cols = (await sql<Array<{ column_name: string }>>`
        select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'integrations'
      `).map((c) => c.column_name);
      console.log("");
      console.log("  INTEGRATIONS COLUMNS");
      for (const c of REQUIRED_INTEGRATIONS_COLUMNS) {
        const ok = cols.includes(c);
        row(ok, `integrations.${c}`, ok ? "" : "missing — schema drift");
        if (!ok) allGreen = false;
      }
    }

    // user row
    if (isUuid && tables.includes("users")) {
      const u = await sql<Array<{ id: string; phone: string | null }>>`
        select id, phone from users where id = ${donnaUserId} limit 1
      `;
      console.log("");
      console.log("  SEED ROWS");
      const ok = u.length > 0;
      row(ok, `users row for DONNA_USER_ID`, ok ? `phone=${u[0]?.phone ?? "(none)"}` : "missing — run seed");
      if (!ok) allGreen = false;
    }

    // integrations row for gmail
    if (isUuid && tables.includes("integrations")) {
      const cols = (await sql<Array<{ column_name: string }>>`
        select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'integrations'
      `).map((c) => c.column_name);
      if (cols.includes("composio_account_id")) {
        const r = await sql<Array<{ status: string; composio_account_id: string | null }>>`
          select status, composio_account_id from integrations
          where user_id = ${donnaUserId} and provider = 'gmail' limit 1
        `;
        const ok = r.length > 0 && r[0]!.status === "connected" && !!r[0]!.composio_account_id;
        row(
          ok,
          "integrations row for gmail (status=connected)",
          ok ? `composio_account_id=${r[0]!.composio_account_id}` : (r.length === 0 ? "missing — run seed" : `status=${r[0]!.status}`),
        );
        if (!ok) allGreen = false;
      }
    }

    // active subs onboarding agenda
    if (isUuid && tables.includes("agendas")) {
      const a = await sql<Array<{ id: string; current_step: string }>>`
        select id, current_step from agendas
        where user_id = ${donnaUserId}
          and kind = 'subscriptions_onboarding'
          and status = 'active'
        order by created_at desc limit 1
      `;
      const ok = a.length > 0;
      row(ok, "active subscriptions_onboarding agenda", ok ? `id=${a[0]!.id} step=${a[0]!.current_step}` : "missing — run seed");
      if (!ok) allGreen = false;
    }

    // mining state file
    console.log("");
    console.log("  ARTIFACTS");
    const stateExists = existsSync("scripts/.composio-mining.json");
    row(stateExists, "scripts/.composio-mining.json present");
    if (stateExists) {
      const state = JSON.parse(readFileSync("scripts/.composio-mining.json", "utf8"));
      row(true, "  → connected_account_id", state.connected_account_id);
      row(true, "  → user_id (composio entity)", state.user_id);
    }
  } catch (e) {
    console.log("");
    row(false, "DB error", (e as Error).message);
    allGreen = false;
  } finally {
    await sql.end();
  }

  console.log("");
  console.log("─".repeat(72));
  console.log(allGreen ? "  ALL GREEN — ready to run e2e test" : "  blockers above — see ✗ rows");
  console.log("─".repeat(72));
}

main().catch((err) => {
  console.error("[test-status]", err);
  process.exit(1);
});
