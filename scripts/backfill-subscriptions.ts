// backfill-subscriptions: cli wrapper around runSubscriptionsBackfill.
// useful for ops + testing without going through the agenda flow.
//
// usage:
//   npx tsx scripts/backfill-subscriptions.ts                            # defaults
//   npx tsx scripts/backfill-subscriptions.ts --since-days 90 --limit 200
//
// defaults: --since-days 365 --limit 1000
// reads DONNA_USER_ID from .env. requires gmail to already be connected
// (run scripts/connect-integration.ts first if not).

import "../src/donna/env.js";
import { runSubscriptionsBackfill } from "../src/donna/extractors/subscriptions/index.js";
import { closeDb } from "../src/donna/db.js";
import { readState } from "../src/donna/integrations/service.js";

interface CliArgs {
  sinceDays: number;
  limit: number;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const sinceDays = Number(get("--since-days") ?? 365);
  const limit = Number(get("--limit") ?? 1000);
  return { sinceDays, limit };
}

async function main(): Promise<void> {
  const userId = process.env.DONNA_USER_ID;
  if (!userId) throw new Error("DONNA_USER_ID not set");
  const { sinceDays, limit } = parseArgs();

  const state = await readState(userId, "gmail");
  if (!state || state.status !== "connected") {
    throw new Error(
      `gmail not connected for this user (status=${state?.status ?? "missing"}). run scripts/connect-integration.ts first.`,
    );
  }

  console.log(
    `[subs-backfill] user=${userId.slice(0, 8)} since=${sinceDays}d limit=${limit}`,
  );

  const result = await runSubscriptionsBackfill({
    userId,
    sinceDays,
    limit,
  });

  console.log(
    `\n[subs-backfill] done in ${(result.duration_ms / 1000).toFixed(1)}s.\n` +
      `  scanned:               ${result.scanned}\n` +
      `  classified yes:        ${result.classified_yes}\n` +
      `  classified no:         ${result.classified_no}\n` +
      `  charges inserted:      ${result.charges_inserted}\n` +
      `  charges deduped:       ${result.charges_deduped}\n` +
      `  subscriptions added:   ${result.subscriptions_added}\n` +
      `  subscriptions updated: ${result.subscriptions_updated}\n` +
      `  haiku batches:         ${result.haiku_calls}\n`,
  );
}

main()
  .catch((err) => {
    console.error("[subs-backfill] failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
