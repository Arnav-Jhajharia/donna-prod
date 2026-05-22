// manual world-engine tick. dev/debug entry. context is built from supermemory
// + recent chat — no env-var blurb needed. by default this also books the next
// cadence fire; pass WORLD_TICK_NO_RESCHEDULE=1 to skip.
//
// usage:
//   DONNA_USER_ID=<uuid> EXA_API_KEY=... \
//     [SUPERMEMORY_API_KEY=...] \
//     npm run world:tick

import "dotenv/config";
import { closeDb } from "../src/donna/db.js";
import { driveWorldTick } from "../src/donna/world/runner.js";

async function main(): Promise<void> {
  const userId = process.env.DONNA_USER_ID;
  if (!userId) {
    throw new Error("DONNA_USER_ID not set");
  }
  const reschedule = process.env.WORLD_TICK_NO_RESCHEDULE !== "1";
  const result = await driveWorldTick({
    user_id: userId,
    source: "cli",
    trigger: "manual",
    reschedule,
  });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  await closeDb();
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`world-tick failed: ${msg}\n`);
  process.exit(1);
});
