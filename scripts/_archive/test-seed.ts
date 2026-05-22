// scripts/test-seed.ts
//
// idempotent seed for the e2e test. ensures:
//   1. a row in `users` for DONNA_USER_ID (uuid)
//   2. an `integrations` row mapping that user → composio_account_id from
//      scripts/.composio-mining.json, status='connected', mode='smart_index'
//   3. an active `agendas` row { kind: subscriptions_onboarding, step: 'ask_install' }
//
// safe to re-run.
//
// run: npx tsx scripts/test-seed.ts

import "dotenv/config";
import postgres from "postgres";
import { readFileSync, existsSync } from "node:fs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  const userId = process.env.DONNA_USER_ID;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  if (!userId) throw new Error("DONNA_USER_ID not set");
  if (!UUID_RE.test(userId)) {
    throw new Error(
      `DONNA_USER_ID must be a uuid (got "${userId}"). generate one with:\n  node -e "console.log(crypto.randomUUID())"\nand set it in .env.`,
    );
  }

  const stateFile = "scripts/.composio-mining.json";
  if (!existsSync(stateFile)) {
    throw new Error(`${stateFile} missing — run scripts/connect-gmail-local.ts first`);
  }
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  const composioAccountId = state.connected_account_id;
  if (!composioAccountId) throw new Error(`${stateFile} missing connected_account_id`);

  const sql = postgres(dbUrl, { ssl: "require" });

  try {
    console.log(`[seed] DONNA_USER_ID=${userId}`);
    console.log(`[seed] composio_account_id=${composioAccountId}`);

    // 1. users
    const phone = `dev-${userId.slice(0, 8)}`;
    const userRows = await sql<Array<{ id: string }>>`
      insert into users (id, phone, profile_name)
      values (${userId}, ${phone}, 'dev')
      on conflict (id) do update set updated_at = now()
      returning id
    `;
    console.log(`[seed] users  ✓  id=${userRows[0]?.id}`);

    // 2. integrations  — handle either schema (mode/exclusions/config may not exist)
    const cols = (
      await sql<Array<{ column_name: string }>>`
        select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'integrations'
      `
    ).map((c) => c.column_name);

    if (!cols.includes("composio_account_id")) {
      throw new Error(
        "integrations table is on old schema (missing composio_account_id). apply this repo's migrations first.",
      );
    }

    const intRows = await sql<Array<{ user_id: string; provider: string; status: string }>>`
      insert into integrations
        (user_id, provider, status, mode, exclusions, config,
         composio_account_id, last_sync_at, connected_at)
      values
        (${userId}, 'gmail', 'connected', 'smart_index',
         ${sql.json({} as Record<string, never>)}::jsonb,
         ${sql.json({} as Record<string, never>)}::jsonb,
         ${composioAccountId}, now(), now())
      on conflict (user_id, provider) do update set
        status = 'connected',
        composio_account_id = excluded.composio_account_id,
        updated_at = now()
      returning user_id, provider, status
    `;
    console.log(`[seed] integrations  ✓  ${intRows[0]?.provider} status=${intRows[0]?.status}`);

    // 3. agenda
    const existing = await sql<Array<{ id: string }>>`
      select id from agendas
      where user_id = ${userId}
        and kind = 'subscriptions_onboarding'
        and status = 'active'
      limit 1
    `;
    let agendaId: string;
    if (existing.length > 0) {
      agendaId = existing[0]!.id;
      console.log(`[seed] agenda  ✓  reusing active id=${agendaId}`);
    } else {
      const created = await sql<Array<{ id: string }>>`
        insert into agendas (user_id, kind, current_step, payload)
        values (${userId}, 'subscriptions_onboarding', 'ask_install',
                ${sql.json({} as Record<string, never>)}::jsonb)
        returning id
      `;
      agendaId = created[0]!.id;
      console.log(`[seed] agenda  ✓  created id=${agendaId} step=ask_install`);
    }

    console.log("");
    console.log("=".repeat(72));
    console.log("seed complete. start the cli:");
    console.log("  npm run dev");
    console.log("");
    console.log("then say something like:");
    console.log(`  "track my subscriptions"`);
    console.log("  (donna sees the active agenda and starts the flow)");
    console.log("=".repeat(72));
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("[seed]", err instanceof Error ? err.message : err);
  process.exit(1);
});
