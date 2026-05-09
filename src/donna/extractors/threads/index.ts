// public entry for the threads extractor.
//
// runThreadsBackfill: source → classify → aggregate over a bounded window.
// callable from the cli (scripts/backfill-threads.ts) and from in-conversation
// flows when we want to fully refresh.
//
// onPushEventClassifyOne: hot path for the gmail_event push lane. fetches
// just the affected thread, classifies, aggregates, returns the resulting
// row + decision so the proactive turn can decide whether to interrupt.

import { audit } from "../../integrations/service.js";
import { withTurnContext } from "../../context.js";
import {
  fetchThreadCandidatesGmail,
  fetchSingleThread,
} from "./source_gmail.js";
import { classifyThreads, classifyHeuristic } from "./classify.js";
import { aggregateThreads } from "./aggregate.js";
import type { ThreadsBackfillResult, ClassifiedThread, ThreadCandidate } from "./types.js";

// ──────────────────────────────────────────────────────────────────────────
// backfill
// ──────────────────────────────────────────────────────────────────────────

export async function runThreadsBackfill(args: {
  userId: string;
  userEmail: string;
  sinceDays?: number;     // default 30
  limit?: number;         // default 200 threads
}): Promise<ThreadsBackfillResult> {
  const sinceDays = args.sinceDays ?? 30;
  const limit = args.limit ?? 200;
  const startedAt = Date.now();

  return withTurnContext(
    { userId: args.userId, runId: null, source: "proactive_worker" },
    async () => {
      await audit({
        userId: args.userId,
        provider: "gmail",
        action: "threads.backfill_started",
        ok: true,
        meta: { since_days: sinceDays, limit },
      });

      let candidates: ThreadCandidate[] = [];
      try {
        candidates = await fetchThreadCandidatesGmail({
          userEmail: args.userEmail,
          sinceDays,
          limit,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[threads/backfill] fetch failed: ${msg}`);
        await audit({
          userId: args.userId,
          provider: "gmail",
          action: "threads.backfill_failed",
          ok: false,
          meta: { error: msg, phase: "fetch" },
        });
        throw err;
      }

      const { classifications, haiku_calls } = await classifyThreads(candidates);
      const agg = await aggregateThreads(args.userId, classifications);

      const result: ThreadsBackfillResult = {
        threads_seen: candidates.length,
        threads_inserted: agg.threads_inserted,
        threads_updated: agg.threads_updated,
        people_inserted: agg.people_inserted,
        people_updated: agg.people_updated,
        haiku_calls,
        duration_ms: Date.now() - startedAt,
      };

      await audit({
        userId: args.userId,
        provider: "gmail",
        action: "threads.backfill_completed",
        ok: true,
        durationMs: result.duration_ms,
        meta: result as unknown as Record<string, unknown>,
      });

      return result;
    },
  );
}

// ──────────────────────────────────────────────────────────────────────────
// hot path — push event classifier (one thread)
// ──────────────────────────────────────────────────────────────────────────

export interface PushClassifyResult {
  candidate: ThreadCandidate;
  classified: ClassifiedThread;
  is_worth_interrupting: boolean;        // pre-LLM heuristic decision for the brain
  reason: string;
}

const INTERRUPT_THRESHOLD = 0.55;

export async function classifyPushedThread(args: {
  userId: string;
  userEmail: string;
  gmailThreadId: string;
}): Promise<PushClassifyResult | null> {
  return withTurnContext(
    { userId: args.userId, runId: null, source: "proactive_worker" },
    async () => {
      const candidate = await fetchSingleThread(args.gmailThreadId, args.userEmail);
      if (!candidate) return null;

      // try heuristic first; only call haiku if heuristic returned null.
      let classified: ClassifiedThread;
      const h = classifyHeuristic(candidate);
      if (h.classified) {
        classified = h.classified;
      } else {
        const { classifications } = await classifyThreads([candidate]);
        classified = classifications[0]!.classified;
      }

      // aggregate so the row + people reflect the new state regardless of
      // whether we end up sending a burst.
      await aggregateThreads(args.userId, [{ candidate, classified }]);

      const isWorth =
        classified.state === "awaiting_user" &&
        classified.ball_in_court === "user" &&
        classified.importance_score >= INTERRUPT_THRESHOLD;

      return {
        candidate,
        classified,
        is_worth_interrupting: isWorth,
        reason: isWorth
          ? "ball_on_user_high_importance"
          : `state=${classified.state} importance=${classified.importance_score.toFixed(2)}`,
      };
    },
  );
}
