// scripts/connect-gmail-local.ts
//
// minimal one-shot: connects gmail to composio under user_id=DONNA_USER_ID.
// avoids the broken db-upsert path in scripts/connect-integration.ts (which
// uses an older schema). this just does the composio oauth dance, prints
// the resulting connectedAccount id, and writes a tiny json file at
// scripts/.composio-mining.json so the mining script can pick it up.
//
// after this completes, the MCP URL created by scripts/setup-composio-mcp.ts
// becomes live (both bound to user_id=DONNA_USER_ID).
//
// run:  npx tsx scripts/connect-gmail-local.ts

import "dotenv/config";
import { Composio } from "@composio/core";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const PROVIDER = "gmail";

async function main() {
  const apiKey = process.env.COMPOSIO_API_KEY;
  const userId = process.env.DONNA_USER_ID;
  if (!apiKey) throw new Error("COMPOSIO_API_KEY not set");
  if (!userId) throw new Error("DONNA_USER_ID not set");

  const composio = new Composio({ apiKey });

  console.log(`[connect] requesting auth url for provider=${PROVIDER}, user_id=${userId}...`);
  // current SDK signature: authorize(userId, toolkit)
  const cr = await composio.toolkits.authorize(userId, PROVIDER);

  if (!cr.redirectUrl) {
    console.log("[connect] no redirect URL returned (api-key toolkit?).");
    console.log("[connect] raw:", JSON.stringify(cr.toJSON?.() ?? cr, null, 2));
  } else {
    console.log("");
    console.log("=".repeat(72));
    console.log("OPEN THIS URL IN A BROWSER TO COMPLETE OAUTH:");
    console.log("");
    console.log(cr.redirectUrl);
    console.log("");
    console.log("=".repeat(72));
  }

  console.log("");
  const timeoutMin = 15;
  console.log(`[connect] waiting up to ${timeoutMin} min for oauth to complete...`);
  const account = await cr.waitForConnection(timeoutMin * 60 * 1000);

  console.log("[connect] ✓ connected");
  console.log("  id:", account.id);
  console.log("  status:", account.status);

  // write a small artifact for the mining script to consume
  const out = {
    user_id: userId,
    connected_account_id: account.id,
    status: account.status,
    toolkit: PROVIDER,
    connected_at: new Date().toISOString(),
  };
  const outPath = join(process.cwd(), "scripts", ".composio-mining.json");
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`[connect] wrote ${outPath}`);
  console.log("");
  console.log("MCP URL bound to this user_id is now live:");
  console.log("  https://backend.composio.dev/v3/mcp/5f5f9e84-911b-4752-ad75-31b7f3ce9441?include_composio_helper_actions=true&user_id=" + userId);
}

main().catch((err) => {
  console.error("[connect] failed:", err);
  process.exit(1);
});
