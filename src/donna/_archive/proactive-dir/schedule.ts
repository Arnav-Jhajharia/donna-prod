import { getSql } from "../db.js";
import type { ProactiveCauseKind } from "./cause.js";

export type ScheduleStatus = "pending" | "claimed" | "fired" | "errored" | "cancelled";

export interface ScheduleRow {
  id: string;
  user_id: string;
  fire_at: string;
  cause_kind: ProactiveCauseKind;
  cause_payload: Record<string, unknown>;
  instruction: string | null;
  status: ScheduleStatus;
  created_at: string;
  claimed_at: string | null;
  fired_at: string | null;
  errored_at: string | null;
  error_message: string | null;
  created_by: string;
}

export interface InsertScheduleArgs {
  user_id: string;
  fire_at: string;
  cause_kind: ProactiveCauseKind;
  cause_payload?: Record<string, unknown>;
  instruction?: string;
  created_by: "user" | "donna_reactive" | "donna_proactive" | "system";
}

export async function insertSchedule(args: InsertScheduleArgs): Promise<string> {
  const sql = getSql();
  const rows = await sql<Array<{ id: string }>>`
    insert into donnaschedule
      (user_id, fire_at, cause_kind, cause_payload, instruction, created_by)
    values
      (${args.user_id}, ${args.fire_at}, ${args.cause_kind},
       ${sql.json((args.cause_payload ?? {}) as unknown as Parameters<typeof sql.json>[0])},
       ${args.instruction ?? null}, ${args.created_by})
    returning id
  `;
  const id = rows[0]?.id;
  if (!id) throw new Error("insertSchedule: no row returned");
  return id;
}

export async function claimNextPending(): Promise<ScheduleRow | null> {
  const sql = getSql();
  const rows = await sql<ScheduleRow[]>`
    update donnaschedule
    set status = 'claimed', claimed_at = now()
    where id = (
      select id from donnaschedule
      where status = 'pending' and fire_at <= now()
      order by fire_at
      limit 1
      for update skip locked
    )
    returning *
  `;
  return rows[0] ?? null;
}

export async function sweepStuckClaimed(thresholdMinutes: number = 5): Promise<number> {
  const sql = getSql();
  const result = await sql`
    update donnaschedule
    set status = 'pending', claimed_at = null
    where status = 'claimed'
      and claimed_at < now() - (${thresholdMinutes} || ' minutes')::interval
  `;
  return result.count ?? 0;
}

export async function markFired(id: string): Promise<void> {
  const sql = getSql();
  await sql`
    update donnaschedule
    set status = 'fired', fired_at = now()
    where id = ${id}
  `;
}

export async function markErrored(id: string, errorMessage: string): Promise<void> {
  const sql = getSql();
  await sql`
    update donnaschedule
    set status = 'errored', errored_at = now(), error_message = ${errorMessage}
    where id = ${id}
  `;
}

export async function markCancelled(id: string, reason: string): Promise<void> {
  const sql = getSql();
  await sql`
    update donnaschedule
    set status = 'cancelled', error_message = ${reason}
    where id = ${id}
  `;
}
