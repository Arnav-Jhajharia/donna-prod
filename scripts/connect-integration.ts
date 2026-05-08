// connect-integration: oauth dance for a provider, then write the resolved
// connected-account id into our integrations table. one-time per (user, provider).
//
// usage:
//   npx tsx scripts/connect-integration.ts --provider gmail
//   npx tsx scripts/connect-integration.ts --provider gmail --mode full
//
// flow:
//   1. read DONNA_USER_ID from .env
//   2. call composio.toolkits.authorize("gmail", {alias: <donna_user_id>})
//   3. print the redirect URL — user opens, completes OAuth in browser
//   4. waitForConnection() blocks until composio reports the account is linked
//   5. write integrations row with the resulting connected_account.id

import "dotenv/config";
import { Composio } from "@composio/core";
import {
  upsertState,
  readState,
  type IntegrationMode,
} from "../src/donna/integrations/service.js";
import { closeDb } from "../src/donna/db.js";
import { runProactiveTurn } from "../src/donna/brain.js";
import { deliverBurstToUser } from "../src/donna/delivery/proactive.js";

interface CliArgs {
  provider: string;
  mode: IntegrationMode;
  callbackUrl?: string;
  timeoutMs: number;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const provider = get("--provider");
  if (!provider) throw new Error("--provider required (e.g. --provider gmail)");
  const mode = (get("--mode") ?? "smart_index") as IntegrationMode;
  if (!["search_only", "smart_index", "full"].includes(mode)) {
    throw new Error(`--mode must be search_only | smart_index | full (got ${mode})`);
  }
  const callbackUrl = get("--callback-url");
  const timeoutMs = Number(get("--timeout-ms") ?? 5 * 60 * 1000);
  return { provider, mode, callbackUrl, timeoutMs };
}

async function main(): Promise<void> {
  const userId = process.env.DONNA_USER_ID;
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!userId) throw new Error("DONNA_USER_ID not set");
  if (!apiKey) throw new Error("COMPOSIO_API_KEY not set");

  const { provider, mode, callbackUrl, timeoutMs } = parseArgs();

  const existing = await readState(userId, provider);
  if (existing && existing.status === "connected" && existing.composio_account_id) {
    console.log(
      `already connected: provider=${provider}, account=${existing.composio_account_id}, mode=${existing.mode}`,
    );
    console.log("re-running will create a fresh oauth grant. ctrl-c to abort. continuing in 3s...");
    await new Promise((r) => setTimeout(r, 3000));
  }

  const composio = new Composio({ apiKey });

  console.log(`requesting auth url for provider=${provider}, alias=${userId}...`);
  const cr = await composio.toolkits.authorize(provider, {
    callbackUrl,
    alias: userId,
  });

  if (!cr.redirectUrl) {
    // some toolkits (api-key based) don't need a redirect
    console.log("no redirect URL — toolkit may not require oauth.");
    console.log("connection state:", cr.toJSON());
  } else {
    console.log("\n---- open this URL in a browser to complete oauth ----");
    console.log(cr.redirectUrl);
    console.log("------------------------------------------------------\n");
  }

  console.log(`waiting up to ${Math.round(timeoutMs / 1000)}s for connection...`);
  const account = await cr.waitForConnection(timeoutMs);
  console.log("composio reports connection:", {
    id: account.id,
    status: account.status,
  });

  await upsertState({
    userId,
    provider,
    status: "connected",
    mode,
    composio_account_id: account.id,
  });

  const after = await readState(userId, provider);
  console.log("\nintegration row:");
  console.log(JSON.stringify(after, null, 2));

  // fire a proactive turn so donna acknowledges the connection in her voice.
  // print to stdout AND deliver to whatsapp if the user has a phone on file.
  // delivered bursts are persisted to chat_messages with mode='proactive' so
  // the next reactive turn sees the same conversation the user just received.
  console.log("\nasking donna to acknowledge...\n");
  try {
    const result = await runProactiveTurn({
      userId,
      source: "whatsapp",
      trigger: `${provider} just finished oauth and is now connected (mode=${mode}). this is the user's first integration of this provider — or a reconnect.`,
    });

    if (result.sends.length === 0) {
      console.log("(donna had nothing to say)");
    } else {
      for (const send of result.sends) {
        console.log(`donna: ${send}`);
      }
    }

    const delivery = await deliverBurstToUser(userId, result.sends);
    if (delivery.channel === "whatsapp") {
      console.log(
        `\n→ delivered ${delivery.delivered}/${result.sends.length} burst(s) via whatsapp.`,
      );
    } else {
      console.log("\n(no phone on file — bursts printed only.)");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`(proactive ack failed: ${msg})`);
    console.log(`done. ${provider} is connected for user ${userId}.`);
  }
}

main()
  .catch((err) => {
    console.error("connect failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
