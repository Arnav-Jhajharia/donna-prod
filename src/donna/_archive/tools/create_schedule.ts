import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../brain.js";
import { getSql } from "../db.js";
import { getTurnContext } from "../context.js";
import type { ProactiveCauseKind } from "../proactive/cause.js";

export interface CreateScheduleInput {
  fire_at: string;
  instruction: string;
  cause_kind?: ProactiveCauseKind;
  cause_payload?: Record<string, unknown>;
}

export interface CreateScheduleResult {
  schedule_id: string;
  fire_at: string;
}

export const createScheduleTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "create_schedule",
  description: `schedule yourself to wake up at a future time with a cause.

use when:
- the user explicitly asks for a reminder ("remind me at 6pm to call mom").
- you want to set up a recurring proactive surface (e.g., daily 8am gmail scan — but defer is preferred for one-shot re-arms).

fire_at must be an iso timestamp in the future. instruction is what next-you needs to know to act. cause_kind defaults to "scheduled".

returns {schedule_id, fire_at}.`,
  input_schema: {
    type: "object",
    properties: {
      fire_at: { type: "string", description: "iso 8601 in the future." },
      instruction: { type: "string", minLength: 1, description: "what next-you should remember." },
      cause_kind: {
        type: "string",
        enum: ["scheduled", "scan_gmail", "watch_fired"],
        description: "default: scheduled.",
      },
      cause_payload: { type: "object", description: "optional extra structured data." },
    },
    required: ["fire_at", "instruction"],
  },
  modes: new Set<BrainMode>(["reactive", "proactive"]),
};

export async function createScheduleHandler(input: unknown): Promise<CreateScheduleResult> {
  const obj = (input ?? {}) as Partial<CreateScheduleInput>;
  if (typeof obj.fire_at !== "string") {
    throw new Error("create_schedule: fire_at required");
  }
  const fireAtMs = Date.parse(obj.fire_at);
  if (!Number.isFinite(fireAtMs) || fireAtMs <= Date.now()) {
    throw new Error("create_schedule: fire_at must be a parseable iso timestamp in the future");
  }
  if (typeof obj.instruction !== "string" || obj.instruction.length === 0) {
    throw new Error("create_schedule: instruction required");
  }
  const ctx = getTurnContext();
  if (!ctx.userId) {
    throw new Error("create_schedule: turn context missing userId");
  }
  const causeKind: ProactiveCauseKind = obj.cause_kind ?? "scheduled";
  const causePayload = obj.cause_payload ?? {};

  const sql = getSql();
  const rows = await sql<Array<{ id: string; fire_at: string }>>`
    insert into donnaschedule
      (user_id, fire_at, cause_kind, cause_payload, instruction, created_by)
    values
      (${ctx.userId}, ${obj.fire_at}, ${causeKind},
       ${sql.json(causePayload as unknown as Parameters<typeof sql.json>[0])},
       ${obj.instruction}, 'donna_reactive')
    returning id, fire_at::text as fire_at
  `;
  const row = rows[0];
  if (!row) throw new Error("create_schedule: insert returned no rows");
  return { schedule_id: row.id, fire_at: row.fire_at };
}
