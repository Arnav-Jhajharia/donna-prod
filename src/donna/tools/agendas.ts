// agendas_advance — minimal multi-turn state primitive. donna calls this to
// advance, complete, or abandon an active agenda row. the composer surfaces
// active agendas in every reactive prompt so donna knows what step she's on.
//
// today there's one agenda kind: 'subscriptions_onboarding'. same shape
// supports any future "donna is in the middle of a multi-question setup" flow.

import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../brain.js";
import { getSql } from "../db.js";
import { getTurnContext } from "../context.js";
import { audit } from "../integrations/service.js";

export const agendasAdvanceTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "agendas_advance",
  description: `advance, complete, or abandon a multi-turn agenda. donna calls this once per turn when she's mid-flow on an onboarding or setup conversation.

input:
- id: agenda row id (uuid). REQUIRED.
- next_step: the new step name. set when staying in 'active' status. for subscriptions_onboarding the steps are 'ask_install' → 'ask_sources' → 'scanning' → 'ask_confirm' → 'done'.
- payload: optional jsonb merged into the row's payload (e.g. carrying scan results into ask_confirm).
- status: 'completed' (when done) or 'abandoned' (user said no thanks). omit to stay 'active'.

returns the updated row so donna can reason against it next turn.`,
  input_schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      next_step: { type: "string" },
      payload: { type: "object", additionalProperties: true },
      status: { type: "string", enum: ["active", "completed", "abandoned"] },
    },
    required: ["id"],
  },
  modes: new Set<BrainMode>(["reactive"]),
};

interface AgendaUpdateInput {
  id?: string;
  next_step?: string;
  payload?: Record<string, unknown>;
  status?: "active" | "completed" | "abandoned";
}

interface AgendaRow {
  id: string;
  user_id: string;
  kind: string;
  step: string;
  payload: Record<string, unknown>;
  status: string;
  created_at: string;
  updated_at: string;
}

export async function agendasAdvanceHandler(input: unknown): Promise<unknown> {
  const { id, next_step, payload, status } = (input ?? {}) as AgendaUpdateInput;
  if (!id || typeof id !== "string") throw new Error("agendas_advance: id required");
  const ctx = getTurnContext();
  const sql = getSql();

  // verify ownership and read current state for payload merge
  const existing = await sql<AgendaRow[]>`
    select * from agendas_select_safe(${ctx.userId}, ${id})
  `.catch(async () => {
    // function-based fetch failed (function may not exist) — fall back to direct select
    return await sql<AgendaRow[]>`
      select * from donna_state_agendas
      where id = ${id} and user_id = ${ctx.userId}
      limit 1
    `;
  });
  if (existing.length === 0) {
    throw new Error(`agendas_advance: agenda ${id} not found for this user`);
  }
  const current = existing[0]!;

  // merge payload (shallow)
  const mergedPayload = payload
    ? { ...(current.payload ?? {}), ...payload }
    : (current.payload ?? {});

  const newStep = next_step ?? current.step;
  const newStatus = status ?? current.status;

  const updated = await sql<AgendaRow[]>`
    update donna_state_agendas set
      step = ${newStep},
      payload = ${sql.json(mergedPayload as Parameters<typeof sql.json>[0])},
      status = ${newStatus},
      updated_at = now()
    where id = ${id} and user_id = ${ctx.userId}
    returning *
  `;

  await audit({
    userId: ctx.userId,
    provider: "agendas",
    action: "agendas.advance",
    itemRef: id,
    ok: true,
    meta: { from_step: current.step, to_step: newStep, status: newStatus, kind: current.kind },
  });

  return { agenda: updated[0] ?? null };
}
