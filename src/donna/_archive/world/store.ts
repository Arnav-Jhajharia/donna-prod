// dedup ledger + daily budget. utc date for now (todo v0.3: user-local).

import { getSql } from "../db.js";

const DEFAULT_DEDUP_TTL_HOURS = 24;

export async function isDedupHit(
  userId: string,
  dedupKey: string,
  ttlHours: number = DEFAULT_DEDUP_TTL_HOURS,
): Promise<boolean> {
  const sql = getSql();
  const rows = await sql<{ fired_at: Date }[]>`
    select fired_at
    from world_ledger
    where user_id = ${userId}
      and dedup_key = ${dedupKey}
      and fired_at >= now() - make_interval(hours => ${ttlHours})
    limit 1
  `;
  return rows.length > 0;
}

export async function markDedup(userId: string, dedupKey: string): Promise<void> {
  const sql = getSql();
  await sql`
    insert into world_ledger (user_id, dedup_key, fired_at)
    values (${userId}, ${dedupKey}, now())
    on conflict (user_id, dedup_key)
      do update set fired_at = excluded.fired_at
  `;
}

export async function getDailyCount(userId: string): Promise<number> {
  const sql = getSql();
  const rows = await sql<{ count: number }[]>`
    select count
    from world_daily_count
    where user_id = ${userId}
      and local_date = (now() at time zone 'utc')::date
    limit 1
  `;
  const first = rows[0];
  return first ? Number(first.count) : 0;
}

export async function bumpDailyCount(userId: string): Promise<void> {
  const sql = getSql();
  await sql`
    insert into world_daily_count (user_id, local_date, count)
    values (${userId}, (now() at time zone 'utc')::date, 1)
    on conflict (user_id, local_date)
      do update set count = world_daily_count.count + 1
  `;
}
