// world tick orchestrator. pure glue: gates → execute → judge → deliver.
// every decision lives in a sibling module.

import { runProactiveTurn } from "../brain.js";
import { randomUUID } from "node:crypto";
import { exaSearch } from "./exa.js";
import { judgeResult } from "./judge.js";
import { createMoves } from "./query_creation.js";
import {
  bumpDailyCount,
  getDailyCount,
  isDedupHit,
  markDedup,
} from "./store.js";
import type {
  DroppedMove,
  ProactiveMove,
  ProactiveResult,
  WorldContext,
  WorldTickResult,
} from "./types.js";

const PER_TURN_DEFAULT = 1;
const PER_DAY_DEFAULT = 3;

function envCap(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export interface RunWorldTickArgs {
  context: WorldContext;
  source: "cli" | "whatsapp" | "imessage";
  perTurn?: number;
  perDay?: number;
}

export async function runWorldTick(args: RunWorldTickArgs): Promise<WorldTickResult> {
  const startedAt = Date.now();
  const perTurn = args.perTurn ?? envCap("WORLD_PER_TURN", PER_TURN_DEFAULT);
  const perDay = args.perDay ?? envCap("WORLD_PER_DAY", PER_DAY_DEFAULT);
  const ctx = args.context;

  const movesRaw = await createMoves(ctx);
  const dailyUsed = await getDailyCount(ctx.user_id);
  const remainingDay = Math.max(0, perDay - dailyUsed);

  const accepted: ProactiveMove[] = [];
  const dropped: DroppedMove[] = [];

  for (const move of movesRaw) {
    if (accepted.length >= perTurn) {
      dropped.push({ move, reason: "per-turn budget exhausted" });
      continue;
    }
    if (accepted.length >= remainingDay) {
      dropped.push({ move, reason: "per-day budget exhausted" });
      continue;
    }
    if (await isDedupHit(ctx.user_id, move.dedup_key)) {
      dropped.push({ move, reason: "dedup: recently fired" });
      continue;
    }
    accepted.push(move);
  }

  const results: ProactiveResult[] = [];
  for (const move of accepted) {
    results.push(await executeMove(move));
  }

  const verdicts: WorldTickResult["verdicts"] = [];
  let delivered = 0;
  for (const result of results) {
    const verdict = await judgeResult(ctx, result);
    verdicts.push({ result, verdict });
    if (verdict.decision !== "send") continue;

    // route delivery through runProactiveTurn so voice stays in send_burst.
    // judge.draft becomes the instruction; brain composes the user-facing burst.
    await runProactiveTurn({
      userId: ctx.user_id,
      source: args.source,
      cause: {
        kind: "scheduled",
        payload: { world_tick: ctx.trigger } as Record<string, unknown>,
        set_at: new Date().toISOString(),
        schedule_id: randomUUID(),
        instruction: verdict.draft,
      },
    });
    await bumpDailyCount(ctx.user_id);
    await markDedup(ctx.user_id, result.move.dedup_key);
    delivered++;
  }

  return {
    user_id: ctx.user_id,
    trigger: ctx.trigger,
    moves_emitted: movesRaw,
    moves_dropped: dropped,
    results,
    verdicts,
    delivered,
    elapsed_ms: Date.now() - startedAt,
  };
}

async function executeMove(move: ProactiveMove): Promise<ProactiveResult> {
  const t0 = Date.now();
  try {
    const hits = await exaSearch({ query: move.query, numResults: 5 });
    if (hits.length === 0) {
      return { move, status: "no_hits", results: [], elapsed_ms: Date.now() - t0 };
    }
    return {
      move,
      status: "ok",
      results: hits.map((h) => ({
        title: h.title,
        url: h.url,
        snippet: h.text ?? "",
        published: h.publishedDate,
        author: h.author,
      })),
      elapsed_ms: Date.now() - t0,
    };
  } catch (err: unknown) {
    return {
      move,
      status: "degraded",
      results: [],
      elapsed_ms: Date.now() - t0,
      skipped_reason: err instanceof Error ? err.message : "unknown error",
    };
  }
}
