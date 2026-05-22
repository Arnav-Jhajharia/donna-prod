// watches service: create / list / close / schedule-next-fire.
//
// every watch is backed by exactly one agent_thread (kind='watch'). creating a
// watch creates the thread, the watches row, and the FIRST donnaschedule row
// at the computed first fire_at.

import { getSql } from "../db.js";
import { createThread } from "../agents/thread.js";
import type { TriggerSpec, WatchRow, WatchStatus } from "../agents/types.js";
import { insertSchedule } from "../proactive/schedule.js";
import { nextFireAt, parseTriggerSpec, isRecurring } from "./trigger-spec.js";

export interface CreateWatchArgs {
  userId: string;
  name: string;
  description: string;
  trigger: TriggerSpec;
  initialContext?: Record<string, unknown>;
  createdBy?: "user" | "donna_reactive" | "donna_proactive" | "system";
}

export interface CreateWatchResult {
  watch_id: string;
  thread_id: string;
  next_fire_at: string | null;
}

export async function createWatch(args: CreateWatchArgs): Promise<CreateWatchResult> {
  // validate trigger_spec up-front — throws on bad input.
  const trigger = parseTriggerSpec(args.trigger);
  const firstFire = nextFireAt(trigger);
  if (!firstFire) {
    throw new Error(
      `createWatch: trigger has no future fire time (one_shot in the past or invalid cron)`,
    );
  }

  const sql = getSql();

  // 1. create the agent thread.
  const thread = await createThread({
    userId: args.userId,
    kind: "watch",
    name: args.name,
    metadata: { description: args.description },
  });

  // 2. create the watches row.
  const watchRows = await sql<Array<{ id: string }>>`
    insert into watches
      (user_id, thread_id, name, description, trigger_spec, initial_context)
    values
      (${args.userId}, ${thread.id}, ${args.name}, ${args.description},
       ${sql.json(trigger as unknown as Parameters<typeof sql.json>[0])},
       ${sql.json((args.initialContext ?? {}) as Parameters<typeof sql.json>[0])})
    returning id
  `;
  const watchId = watchRows[0]?.id;
  if (!watchId) throw new Error("createWatch: insert returned no row");

  // 3. schedule the first fire.
  await insertSchedule({
    user_id: args.userId,
    fire_at: firstFire,
    cause_kind: "watch_fired",
    cause_payload: { watch_id: watchId, thread_id: thread.id },
    instruction: args.description,
    created_by: args.createdBy ?? "donna_reactive",
  });

  return {
    watch_id: watchId,
    thread_id: thread.id,
    next_fire_at: firstFire,
  };
}

export async function getWatchById(watchId: string): Promise<WatchRow | null> {
  const sql = getSql();
  const rows = await sql<WatchRow[]>`
    select id, user_id, thread_id, name, description, trigger_spec, initial_context,
           status, created_at, updated_at
    from watches
    where id = ${watchId}
    limit 1
  `;
  return rows[0] ?? null;
}

export async function listWatchesForUser(
  userId: string,
  opts: { status?: WatchStatus } = {},
): Promise<WatchRow[]> {
  const sql = getSql();
  const status = opts.status;
  const rows = status
    ? await sql<WatchRow[]>`
        select id, user_id, thread_id, name, description, trigger_spec, initial_context,
               status, created_at, updated_at
        from watches
        where user_id = ${userId} and status = ${status}
        order by created_at desc
      `
    : await sql<WatchRow[]>`
        select id, user_id, thread_id, name, description, trigger_spec, initial_context,
               status, created_at, updated_at
        from watches
        where user_id = ${userId}
        order by created_at desc
      `;
  return [...rows];
}

export async function closeWatch(watchId: string): Promise<void> {
  const sql = getSql();
  // close the watch + the thread atomically.
  await sql.begin(async (tx) => {
    const rows = await tx<Array<{ thread_id: string }>>`
      update watches
      set status = 'closed', updated_at = now()
      where id = ${watchId}
      returning thread_id
    `;
    const threadId = rows[0]?.thread_id;
    if (threadId) {
      await tx`
        update agent_threads
        set status = 'done', updated_at = now()
        where id = ${threadId}
      `;
      // cancel any pending donnaschedule rows for this watch — they would
      // wake a closed thread otherwise.
      await tx`
        update donnaschedule
        set status = 'cancelled', error_message = 'watch closed'
        where cause_kind = 'watch_fired'
          and status = 'pending'
          and cause_payload->>'watch_id' = ${watchId}
      `;
    }
  });
}

// schedule the next firing of a recurring watch after a successful fire.
// no-op for one_shot triggers. returns the next fire_at or null.
export async function scheduleNextFire(watchId: string, from: Date = new Date()): Promise<string | null> {
  const watch = await getWatchById(watchId);
  if (!watch) return null;
  if (watch.status !== "active") return null;
  const spec = watch.trigger_spec as TriggerSpec;
  if (!isRecurring(spec)) return null;
  const next = nextFireAt(spec, from);
  if (!next) return null;
  await insertSchedule({
    user_id: watch.user_id,
    fire_at: next,
    cause_kind: "watch_fired",
    cause_payload: { watch_id: watch.id, thread_id: watch.thread_id },
    instruction: watch.description,
    created_by: "donna_proactive",
  });
  return next;
}
