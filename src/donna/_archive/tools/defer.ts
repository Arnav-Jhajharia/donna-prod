import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../brain.js";
import type { ProactiveCauseKind } from "../proactive/cause.js";

export interface DeferInput {
  fire_at: string;
  cause: {
    kind: ProactiveCauseKind;
    instruction: string;
    payload?: Record<string, unknown>;
  };
}

export interface DeferResult {
  fire_at: string;
  cause: DeferInput["cause"];
}

export const deferTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "defer",
  description: `re-arm yourself to think about this again later. terminator.

call when:
- the cause is real but now is not the moment.
- you want to check back after the user finishes work, after sleep, after an event.
- a watch condition has not yet tripped but is still worth re-checking.

fire_at must be an iso timestamp strictly in the future. cause is what next-you should see when you wake. include kind, instruction, and any payload that helps next-you.

defer does not message the user. it only schedules another wake-up.`,
  input_schema: {
    type: "object",
    properties: {
      fire_at: {
        type: "string",
        description: "iso 8601 timestamp in the future (e.g. 2026-05-08T22:00:00Z).",
      },
      cause: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["scheduled", "scan_gmail", "watch_fired"] },
          instruction: { type: "string", minLength: 1 },
          payload: { type: "object" },
        },
        required: ["kind", "instruction"],
      },
    },
    required: ["fire_at", "cause"],
  },
  modes: new Set<BrainMode>(["proactive"]),
};

export async function deferHandler(input: unknown): Promise<string> {
  const obj = (input ?? {}) as Partial<DeferInput>;
  if (typeof obj.fire_at !== "string") {
    throw new Error("defer: fire_at required");
  }
  const fireAtMs = Date.parse(obj.fire_at);
  if (!Number.isFinite(fireAtMs)) {
    throw new Error(`defer: fire_at unparseable: ${obj.fire_at}`);
  }
  if (fireAtMs <= Date.now()) {
    throw new Error("defer: fire_at must be in the future");
  }
  if (!obj.cause || typeof obj.cause !== "object") {
    throw new Error("defer: cause required");
  }
  const validKinds: ProactiveCauseKind[] = ["scheduled", "scan_gmail", "watch_fired"];
  if (!obj.cause.kind || !validKinds.includes(obj.cause.kind)) {
    throw new Error(`defer: cause.kind invalid`);
  }
  if (typeof obj.cause.instruction !== "string" || obj.cause.instruction.length === 0) {
    throw new Error("defer: cause.instruction required");
  }
  return `deferred until ${obj.fire_at}`;
}
