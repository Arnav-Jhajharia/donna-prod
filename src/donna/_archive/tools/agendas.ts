// agendas_advance: transitions a multi-turn flow agenda. generic on `kind` —
// the model knows which steps are valid per kind from the prompt's
// <agenda_handling> section.
//
// special wiring for kind="subscriptions_onboarding":
//   next_step="scanning" → fire off a detached gmail backfill that will
//   advance the agenda again to "ask_confirm" via a proactive trigger when
//   the scan completes. the model does NOT call subscriptions_record itself
//   during the scan — the runtime owns it.

import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../brain.js";
import { getTurnContext, withTurnContext } from "../context.js";
import {
  advanceAgenda,
  getAgenda,
  createBackfill,
  updateBackfill,
} from "../subscriptions/storage.js";
import { scanGmailForSubscriptions } from "../subscriptions/scan.js";

interface AdvanceInput {
  id: string;
  next_step?: string;
  status?: "completed" | "abandoned" | "blocked";
  payload_patch?: Record<string, unknown>;
}

export const agendasAdvanceTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "agendas_advance",
  description: `advance the named multi-turn agenda. use this once per turn when the user's reply moves the flow forward or the agenda is complete.

inputs:
- id: required. the agenda id from <active_agendas>.
- next_step: optional. the new current_step value. consult <agenda_handling> for the valid steps per kind.
- status: optional. 'completed' | 'abandoned' | 'blocked'. when set, the agenda will not surface in <active_agendas> on future turns.
- payload_patch: optional. shallow-merged onto the agenda payload.

returns the updated agenda row, or null if not found.

side effects:
- kind="subscriptions_onboarding", next_step="scanning" → kicks off a detached gmail backfill (180-day lookback by default). when the backfill finishes the runtime will advance the agenda again to "ask_confirm" and fire a proactive trigger.`,
  input_schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      next_step: { type: "string" },
      status: { type: "string", enum: ["completed", "abandoned", "blocked"] },
      payload_patch: { type: "object" },
    },
    required: ["id"],
  },
  modes: new Set<BrainMode>(["reactive", "proactive"]),
};

export async function agendasAdvanceHandler(input: unknown): Promise<unknown> {
  const i = (input ?? {}) as AdvanceInput;
  if (!i.id || typeof i.id !== "string") {
    throw new Error("agendas_advance: id required");
  }
  const ctx = getTurnContext();

  const before = await getAgenda(i.id, ctx.userId);
  if (!before) throw new Error(`agendas_advance: agenda ${i.id} not found`);

  const updated = await advanceAgenda({
    id: i.id,
    user_id: ctx.userId,
    next_step: i.next_step,
    status: i.status,
    payload_patch: i.payload_patch,
  });

  // wire: subscriptions_onboarding → scanning kicks off a backfill.
  // we fire it via a detached promise so the agendas_advance call returns
  // quickly. the backfill will run inside its own withTurnContext so
  // anything it calls that needs a turn (audit, etc.) keeps working.
  if (
    before.kind === "subscriptions_onboarding" &&
    i.next_step === "scanning"
  ) {
    const lookback =
      typeof (i.payload_patch?.lookback_days) === "number"
        ? (i.payload_patch.lookback_days as number)
        : 180;
    const backfill = await createBackfill({
      user_id: ctx.userId,
      agenda_id: i.id,
      lookback_days: lookback,
    });
    // detached. errors land on the backfill row, not the user turn.
    const detachedCtx = { ...ctx };
    void withTurnContext(detachedCtx, async () => {
      try {
        await scanGmailForSubscriptions({
          userId: ctx.userId,
          lookbackDays: lookback,
          backfillId: backfill.id,
        });
        // advance the agenda — let the model know via the next proactive
        // trigger. for v1 we just update the row; a follow-up runtime hook
        // will fire runProactiveTurn so the model surfaces results.
        await advanceAgenda({
          id: i.id,
          user_id: ctx.userId,
          next_step: "ask_confirm",
          payload_patch: { backfill_id: backfill.id },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await updateBackfill(backfill.id, {
          status: "error",
          last_error: msg,
          finished_at: new Date().toISOString(),
        });
      }
    });
  }

  return updated;
}
