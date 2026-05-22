// scripts/probe-gmail.ts
//
// one-shot probe: confirms gmail is reachable via composio for this user.
// reads the integrations row, makes one cheap composio call (GET_PROFILE),
// prints the user identifier we should pass to the bulk-mining script.
//
// run:  npx tsx scripts/probe-gmail.ts

import "dotenv/config";
import postgres from "postgres";
import { Composio } from "@composio/core";

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  const apiKey = process.env.COMPOSIO_API_KEY;
  const userId = process.env.DONNA_USER_ID;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  if (!apiKey) throw new Error("COMPOSIO_API_KEY not set");
  if (!userId) throw new Error("DONNA_USER_ID not set");

  const sql = postgres(dbUrl, { ssl: "require" });
  let composioUserId: string | null = null;
  try {
    const rows = await sql<
      Array<{ status: string; composio_account_id: string | null }>
    >`
      select status, composio_account_id
      from integrations
      where user_id = ${userId} and provider = 'gmail'
      limit 1
    `;
    if (rows.length === 0) {
      console.log("[probe] no gmail integration row for user", userId);
      console.log(
        "[probe] will try DONNA_USER_ID directly as composio user_id",
      );
      composioUserId = userId;
    } else {
      const row = rows[0];
      console.log("[probe] integration row:", row);
      composioUserId = row.composio_account_id ?? userId;
    }
  } finally {
    await sql.end();
  }

  const composio = new Composio({ apiKey });

  console.log(`[probe] calling GMAIL_GET_PROFILE as user=${composioUserId}...`);
  const resp = (await composio.tools.execute("GMAIL_GET_PROFILE", {
    userId: composioUserId!,
    arguments: {},
  })) as { successful?: boolean; data?: unknown; error?: string | null };

  console.log("[probe] success:", resp.successful);
  console.log("[probe] data:", JSON.stringify(resp.data, null, 2));
  if (resp.error) console.log("[probe] error:", resp.error);

  if (resp.successful) {
    console.log("");
    console.log("=".repeat(72));
    console.log(`✓ gmail reachable. composio_user_id = "${composioUserId}"`);
    console.log("use this id in the mining script.");
    console.log("=".repeat(72));
  }
}

main().catch((err) => {
  console.error("[probe] failed:", err);
  process.exit(1);
});
