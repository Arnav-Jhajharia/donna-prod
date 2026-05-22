// schedule world ticks via donnaschedule. self-driving cadence: each tick
// books the next one, the worker drains, the cycle repeats.

import { insertSchedule } from "../proactive/schedule.js";

const DEFAULT_INTERVAL_MINUTES = 4 * 60; // 4 hours
const MIN_INTERVAL_MINUTES = 15;
const MAX_INTERVAL_MINUTES = 24 * 60;

export interface ScheduleWorldTickArgs {
  user_id: string;
  // when to fire. defaults to now + interval_minutes.
  fire_at?: string;
  // override the default cadence. ignored if fire_at is set.
  interval_minutes?: number;
  // freeform tag e.g. "morning" | "drain" | "follow_up" — passed into ctx.trigger.
  trigger?: string;
  // who scheduled this fire.
  created_by?: "user" | "donna_reactive" | "donna_proactive" | "system";
}

export async function scheduleWorldTick(args: ScheduleWorldTickArgs): Promise<string> {
  const fireAt = args.fire_at ?? computeFireAt(args.interval_minutes);
  return insertSchedule({
    user_id: args.user_id,
    fire_at: fireAt,
    cause_kind: "world_tick",
    cause_payload: { trigger: args.trigger ?? "cadence" },
    instruction: undefined,
    created_by: args.created_by ?? "system",
  });
}

export function defaultIntervalMinutes(): number {
  const raw = process.env.WORLD_TICK_INTERVAL_MINUTES;
  if (!raw) return DEFAULT_INTERVAL_MINUTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_INTERVAL_MINUTES;
  return Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.floor(n)));
}

function computeFireAt(intervalMinutes?: number): string {
  const minutes = intervalMinutes && intervalMinutes > 0 ? intervalMinutes : defaultIntervalMinutes();
  const fire = new Date(Date.now() + minutes * 60_000);
  return fire.toISOString();
}
