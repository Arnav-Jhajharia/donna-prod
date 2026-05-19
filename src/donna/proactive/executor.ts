import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { runTurn as defaultRunTurn, type RunTurnResult } from "../brain.js";
import { loadRecentMessages, saveMessages } from "../memory/chat.js";
import { deliverBurst } from "../delivery/router.js";
import { arbitrate } from "./arbiter.js";
import {
  claimNextPending,
  insertSchedule,
  markCancelled,
  markErrored,
  markFired,
  sweepStuckClaimed,
  type ScheduleRow,
} from "./schedule.js";
import type { ProactiveCause } from "./cause.js";
import { getSql } from "../db.js";

import type { TurnSource } from "../context.js";

export type RunTurnFn = (args: {
  mode: "proactive";
  messages: MessageParam[];
  cause: ProactiveCause;
  userId: string;
  source: TurnSource;
}) => Promise<RunTurnResult>;

// deliver one burst body to a user. the default implementation routes
// through the omnipresence router (whatsapp → imessage → app fallback);
// tests inject their own via opts.deliverFn.
export type DeliverFn = (userId: string, body: string) => Promise<void>;

export interface RunScheduleTickOnceOptions {
  runTurnFn?: RunTurnFn;
  deliverFn?: DeliverFn;
  recentMessageLimit?: number;
  nowOverride?: Date;
}

let _ticking = false;

async function defaultDeliver(userId: string, body: string): Promise<void> {
  // proactive worker has no source hint — the router will pick based on the
  // user's last_active_channel / preferred_channel and fall through to the
  // app outbox if nothing else lands.
  const result = await deliverBurst(userId, [body], {
    sourceHint: "proactive_worker",
    persistHistory: false,
  });
  if (result.delivered === 0) {
    throw new Error(`proactive delivery failed for user_id=${userId}`);
  }
}

function rowToCause(row: ScheduleRow): ProactiveCause {
  return {
    kind: row.cause_kind,
    payload: row.cause_payload ?? {},
    set_at: row.created_at,
    schedule_id: row.id,
    instruction: row.instruction ?? "",
  };
}

async function fetchLastAssistantTimestamp(userId: string): Promise<Date | undefined> {
  const sql = getSql();
  const rows = await sql<Array<{ created_at: string }>>`
    select created_at from chat_messages
    where user_id = ${userId} and role = 'assistant'
    order by seq desc
    limit 1
  `;
  const ts = rows[0]?.created_at;
  return ts ? new Date(ts) : undefined;
}

export async function runScheduleTickOnce(opts: RunScheduleTickOnceOptions = {}): Promise<void> {
  if (_ticking) return;
  _ticking = true;
  try {
    await sweepStuckClaimed(5);
    const row = await claimNextPending();
    if (!row) return;

    const runTurnFn = opts.runTurnFn ?? (defaultRunTurn as unknown as RunTurnFn);
    const deliverFn = opts.deliverFn ?? defaultDeliver;
    const limit = opts.recentMessageLimit ?? 50;
    const now = opts.nowOverride ?? new Date();

    try {
      const lastAssistantAt = await fetchLastAssistantTimestamp(row.user_id);
      const decision = arbitrate({
        user_id: row.user_id,
        cause: rowToCause(row),
        recent_messages: [],
        last_assistant_at: lastAssistantAt,
        now,
        user_tz: process.env.DONNA_DEFAULT_TZ ?? "UTC",
      });

      if (!decision.allow) {
        await markCancelled(row.id, decision.reason);
        if (decision.reschedule_at) {
          await insertSchedule({
            user_id: row.user_id,
            fire_at: decision.reschedule_at,
            cause_kind: row.cause_kind,
            cause_payload: row.cause_payload,
            instruction: row.instruction ?? undefined,
            created_by: "system",
          });
        }
        return;
      }

      const messages = await loadRecentMessages(row.user_id, limit);
      const cause = rowToCause(row);

      const result = await runTurnFn({
        mode: "proactive",
        messages,
        cause,
        userId: row.user_id,
        source: "proactive_worker",
      });

      if (result.newMessages.length > 0) {
        await saveMessages(row.user_id, result.newMessages, "proactive");
      }

      if (result.terminator === "send_burst") {
        for (const body of result.sends) {
          await deliverFn(row.user_id, body);
        }
      } else if (result.terminator === "defer" && result.nextSchedule) {
        await insertSchedule({
          user_id: row.user_id,
          fire_at: result.nextSchedule.fire_at,
          cause_kind: result.nextSchedule.cause.kind,
          cause_payload: result.nextSchedule.cause.payload ?? {},
          instruction: result.nextSchedule.cause.instruction,
          created_by: "donna_proactive",
        });
      }

      await markFired(row.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await markErrored(row.id, msg);
    }
  } finally {
    _ticking = false;
  }
}

export function startScheduleTicker(intervalMs: number = 30_000): NodeJS.Timeout {
  return setInterval(() => {
    void runScheduleTickOnce().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[proactive] tick failed: ${msg}`);
    });
  }, intervalMs);
}
