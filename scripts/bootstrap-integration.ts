// one-shot script to seed the integrations row for the current dev user.
// reads DONNA_USER_ID + COMPOSIO_USER_ID from .env, writes/updates the
// (donna_user, "gmail") row in the integrations table.
//
// usage: npx tsx scripts/bootstrap-integration.ts [--provider gmail]

import "../src/donna/env.js";
import { upsertState, readState } from "../src/donna/integrations/service.js";
import { closeDb } from "../src/donna/db.js";

async function main(): Promise<void> {
  const userId = process.env.DONNA_USER_ID;
  const composioAccountId = process.env.COMPOSIO_USER_ID;
  const provider = process.argv.includes("--provider")
    ? process.argv[process.argv.indexOf("--provider") + 1]
    : "gmail";

  if (!userId) throw new Error("DONNA_USER_ID not set");
  if (!composioAccountId) throw new Error("COMPOSIO_USER_ID not set");
  if (!provider) throw new Error("--provider value missing");

  await upsertState({
    userId,
    provider,
    status: "connected",
    mode: "smart_index",
    composio_account_id: composioAccountId,
  });

  const after = await readState(userId, provider);
  console.log("integration upserted:", JSON.stringify(after, null, 2));
}

main()
  .catch((err) => {
    console.error("bootstrap failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
