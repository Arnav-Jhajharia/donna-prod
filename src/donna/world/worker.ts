// proactive worker. drains donnaschedule, dispatches by cause_kind.
//
// world_tick     → runWorldTick (research → judge → maybe deliver via brain)
// scheduled      → runProactiveTurn with the row's cause (defer / scan / ...)
// scan_gmail     → runProactiveTurn (brain decides what to do)
// watch_fired    → runProactiveTurn (brain decides what to do)
//
// failures mark the row errored; success marks it fired. crashed claims are
// reaped via sweepStuckClaimed on each idle tick.

import { runProactiveTurn } from "../brain.js";
import {
  claimNextPending,
  markErrored,
  markFired,
  sweepStuckClaimed,
  type ScheduleRow,
} from "../proactive/schedule.js";
import { driveWorldTick } from "./runner.js";

const IDLE_POLL_MS = 5_000;
const CLAIM_BURST_LIMIT = 16;
const STUCK_CLAIM_THRESHOLD_MIN = 5;

export interface RunWorkerOpts {
  // when true, the loop exits after draining the current backlog. used by tests
  // and one-shot dev runs. default false (long-lived process).
  drain_only?: boolean;
  // soft stop signal. set to true and the loop exits at the next idle tick.
  signal?: AbortSignal;
}

export async function runProactiveWorker(opts: RunWorkerOpts = {}): Promise<void> {
  while (!opts.signal?.aborted) {
    const burstCount = await drainBurst();
    if (burstCount === 0) {
      if (opts.drain_only) return;
      await sweepStuckClaimed(STUCK_CLAIM_THRESHOLD_MIN);
      await sleep(IDLE_POLL_MS, opts.signal);
    }
  }
}

async function drainBurst(): Promise<number> {
  let processed = 0;
  for (let i = 0; i < CLAIM_BURST_LIMIT; i++) {
    const row = await claimNextPending();
    if (!row) break;
    await dispatchRow(row);
    processed++;
  }
  return processed;
}

async function dispatchRow(row: ScheduleRow): Promise<void> {
  try {
    if (row.cause_kind === "world_tick") {
      const trigger =
        typeof row.cause_payload?.trigger === "string"
          ? row.cause_payload.trigger
          : "cadence";
      await driveWorldTick({
        user_id: row.user_id,
        source: "proactive_worker",
        trigger,
      });
    } else {
      // generic proactive: hand the brain the cause as-is.
      await runProactiveTurn({
        userId: row.user_id,
        source: "proactive_worker",
        cause: {
          kind: row.cause_kind,
          payload: row.cause_payload ?? {},
          set_at: row.fire_at,
          schedule_id: row.id,
          instruction: row.instruction ?? "",
        },
      });
    }
    await markFired(row.id);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await markErrored(row.id, msg.slice(0, 500));
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
