// parse + validate trigger_spec jsonb. compute the next fire_at.
//
// v1 supports:
// - { kind: "cron",     schedule: string,   timezone?: string }
// - { kind: "one_shot", fire_at:  string (iso) }

import { CronExpressionParser } from "cron-parser";
import type { TriggerSpec } from "../agents/types.js";

export class TriggerSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TriggerSpecError";
  }
}

export function parseTriggerSpec(raw: unknown): TriggerSpec {
  if (!raw || typeof raw !== "object") {
    throw new TriggerSpecError("trigger_spec must be an object");
  }
  const obj = raw as Record<string, unknown>;
  const kind = obj.kind;
  if (kind === "cron") {
    if (typeof obj.schedule !== "string" || obj.schedule.trim().length === 0) {
      throw new TriggerSpecError("cron trigger: schedule must be a non-empty string");
    }
    // validate by parsing once now; throws TriggerSpecError on bad cron.
    try {
      CronExpressionParser.parse(obj.schedule, {
        tz: typeof obj.timezone === "string" ? obj.timezone : undefined,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new TriggerSpecError(`cron trigger: invalid schedule "${obj.schedule}": ${msg}`);
    }
    return {
      kind: "cron",
      schedule: obj.schedule,
      timezone: typeof obj.timezone === "string" ? obj.timezone : undefined,
    };
  }
  if (kind === "one_shot") {
    if (typeof obj.fire_at !== "string") {
      throw new TriggerSpecError("one_shot trigger: fire_at must be an ISO timestamp string");
    }
    const d = new Date(obj.fire_at);
    if (Number.isNaN(d.getTime())) {
      throw new TriggerSpecError(`one_shot trigger: fire_at "${obj.fire_at}" is not a valid date`);
    }
    return { kind: "one_shot", fire_at: d.toISOString() };
  }
  throw new TriggerSpecError(`trigger_spec.kind must be "cron" or "one_shot" (got "${String(kind)}")`);
}

// returns the next fire timestamp (iso), or null if the trigger should not
// fire again (one_shot after fire_at, or invalid expression).
export function nextFireAt(
  spec: TriggerSpec,
  from: Date = new Date(),
): string | null {
  if (spec.kind === "one_shot") {
    const fireAt = new Date(spec.fire_at);
    if (Number.isNaN(fireAt.getTime())) return null;
    // one_shot only fires if the time hasn't passed.
    return fireAt.getTime() > from.getTime() ? fireAt.toISOString() : null;
  }
  // cron — compute next fire strictly after `from`.
  try {
    const interval = CronExpressionParser.parse(spec.schedule, {
      currentDate: from,
      tz: spec.timezone,
    });
    return interval.next().toDate().toISOString();
  } catch {
    return null;
  }
}

// whether this trigger should be re-scheduled after firing (cron = yes,
// one_shot = no).
export function isRecurring(spec: TriggerSpec): boolean {
  return spec.kind === "cron";
}
