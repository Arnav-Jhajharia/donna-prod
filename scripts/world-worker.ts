// long-lived proactive worker. drains donnaschedule, dispatches each row by
// cause_kind. world_tick rows trigger the world engine; everything else goes
// to the brain via runProactiveTurn.
//
// usage:
//   npm run world:worker
//
// stops on SIGINT/SIGTERM. on shutdown, in-flight rows are left as 'claimed'
// and the next worker reclaims them via sweepStuckClaimed.

import "../src/donna/env.js";
import { closeDb } from "../src/donna/db.js";
import { runProactiveWorker } from "../src/donna/world/worker.js";

async function main(): Promise<void> {
  const ctrl = new AbortController();
  const stop = (sig: string) => {
    process.stderr.write(`world-worker: ${sig} received, draining…\n`);
    ctrl.abort();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.stderr.write("world-worker: started\n");
  await runProactiveWorker({ signal: ctrl.signal });
  await closeDb();
  process.stderr.write("world-worker: stopped\n");
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`world-worker failed: ${msg}\n`);
  process.exit(1);
});
