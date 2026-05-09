// food_cache repo. de-dupes nutritionix natural-language calls across users
// for common queries ("two eggs and toast"). 24h ttl.

import { getSql } from "../db.js";

const TTL_HOURS = 24;

function normalize(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

export async function getCached(query: string): Promise<unknown | null> {
  const sql = getSql();
  const key = normalize(query);
  const rows = await sql<{ raw_response: unknown }[]>`
    update food_cache
       set hit_count = hit_count + 1
     where query_normalized = ${key}
       and ttl_until > now()
     returning raw_response
  `;
  return rows[0]?.raw_response ?? null;
}

export async function putCached(
  query: string,
  response: unknown,
): Promise<void> {
  const sql = getSql();
  const key = normalize(query);
  await sql`
    insert into food_cache (query_normalized, source, raw_response, ttl_until)
    values (
      ${key},
      'nutritionix',
      ${sql.json(response as Parameters<typeof sql.json>[0])},
      now() + interval '${sql.unsafe(String(TTL_HOURS))} hours'
    )
    on conflict (query_normalized) do update
      set raw_response = excluded.raw_response,
          ttl_until    = excluded.ttl_until,
          hit_count    = 0
  `;
}
