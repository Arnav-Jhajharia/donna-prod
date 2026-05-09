// runSubscriptionsBackfill — orchestrator entry. callable from:
//   - the agenda handler (in-process, fire-and-forget after user opts in)
//   - scripts/backfill-subscriptions.ts (cli for ops/testing)
//
// always wraps work in withTurnContext so executeForUser + audit have the
// userId they need.

import { withTurnContext } from "../../context.js";
import { audit } from "../../integrations/service.js";
import { fetchCandidatesGmail } from "./source_gmail.js";
import { classify } from "./classify.js";
import { aggregate } from "./aggregate.js";
import type { BackfillResult } from "./types.js";
import { randomUUID } from "node:crypto";

export interface BackfillArgs {
  userId: string;
  sinceDays?: number;
  limit?: number;
  source?: "gmail";   // future: union with bank | paypal | imessage
}

export async function runSubscriptionsBackfill(
  args: BackfillArgs,
): Promise<BackfillResult> {
  const sinceDays = args.sinceDays ?? 365;
  const limit = args.limit ?? 1000;
  const synthRunId = randomUUID();

  const startedAt = Date.now();

  return withTurnContext(
    { userId: args.userId, runId: synthRunId, source: "proactive_worker" },
    async () => {
      await audit({
        userId: args.userId,
        provider: "gmail",
        action: "subscriptions.scan_started",
        ok: true,
        meta: { since_days: sinceDays, limit, run_id: synthRunId },
      });

      // 1. fetch candidates from gmail (only source supported today)
      const candidates = await fetchCandidatesGmail({ sinceDays, limit });

      // 2. classify each → DetectedCharge[] (heuristic + haiku for ambiguous)
      const classified = await classify(candidates);

      // 3. aggregate: upsert subscriptions + charges, infer recurrence
      const written = await aggregate(args.userId, classified.charges);

      const durationMs = Date.now() - startedAt;
      const result: BackfillResult = {
        scanned: candidates.length,
        classified_yes: classified.decided_yes,
        classified_no: classified.decided_no,
        charges_inserted: written.charges_inserted,
        charges_deduped: written.charges_deduped,
        subscriptions_added: written.subscriptions_added,
        subscriptions_updated: written.subscriptions_updated,
        haiku_calls: classified.haiku_calls,
        duration_ms: durationMs,
      };

      await audit({
        userId: args.userId,
        provider: "gmail",
        action: "subscriptions.scan_completed",
        ok: true,
        durationMs,
        meta: { ...result, run_id: synthRunId },
      });

      return result;
    },
  );
}
