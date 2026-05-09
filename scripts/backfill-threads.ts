// backfill-threads: cli wrapper around runThreadsBackfill.
// useful for ops + first-time setup without going through the agenda flow.
//
// usage:
//   npx tsx scripts/backfill-threads.ts                          # defaults
//   npx tsx scripts/backfill-threads.ts --since-days 60 --limit 300
//
// defaults: --since-days 30 --limit 200
// reads DONNA_USER_ID from .env. requires gmail to already be connected
// (run scripts/connect-integration.ts first if not).

import "../src/donna/env.js";
import { runThreadsBackfill } from "../src/donna/extractors/threads/index.js";
import { closeDb } from "../src/donna/db.js";
import { readState } from "../src/donna/integrations/service.js";
import { resolveGmailUserEmail } from "../src/donna/integrations/composio.js";

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
  const sinceDays = Number(get("--since-days") ?? 30);
  const limit = Number(get("--limit") ?? 200);
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

  const userEmail = await resolveGmailUserEmail(userId);
  if (!userEmail) {
    throw new Error(
      "could not resolve user's gmail email — composio profile fetch failed. is gmail connected?",
    );
  }

  console.log(
    `[threads-backfill] user=${userId.slice(0, 8)} email=${userEmail} since=${sinceDays}d limit=${limit}`,
  );

  const result = await runThreadsBackfill({
    userId,
    userEmail,
    sinceDays,
    limit,
  });

  console.log(
    `\n[threads-backfill] done in ${(result.duration_ms / 1000).toFixed(1)}s.\n` +
      `  threads seen:        ${result.threads_seen}\n` +
      `  threads inserted:    ${result.threads_inserted}\n` +
      `  threads updated:     ${result.threads_updated}\n` +
      `  people inserted:     ${result.people_inserted}\n` +
      `  people updated:      ${result.people_updated}\n` +
      `  haiku batches:       ${result.haiku_calls}\n`,
  );
}

main()
  .catch((err) => {
    console.error("[threads-backfill] failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
