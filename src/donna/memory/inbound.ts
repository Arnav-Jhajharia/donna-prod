// durable dedup for inbound platform messages. atomic claim via insert ...
// on conflict — two concurrent retries race the unique constraint, exactly
// one wins. this is the durable layer behind the in-memory 5-min ttl cache
// in ingress/whatsapp.ts.

import { getSql } from "../db.js";

export type InboundSource = "whatsapp" | "web" | "api";

interface ClaimArgs {
  waMessageId: string;
  phone: string;
  body: unknown; // raw platform message envelope, stored as jsonb
  source?: InboundSource;
}

/**
 * Try to claim a wa_message_id as ours. returns true if this call wrote the
 * row (first delivery), false if the row already exists (duplicate retry).
 *
 * fail-open: if the db is unreachable, returns true. dropping a real inbound
 * is worse than processing one twice — the in-memory cache already absorbs
 * tight retry bursts, so the at-most-once-with-occasional-double window is
 * narrow.
 */
export async function claimInbound({
  waMessageId,
  phone,
  body,
  source = "whatsapp",
}: ClaimArgs): Promise<boolean> {
  const sql = getSql();
  try {
    const rows = await sql<{ id: string }[]>`
      insert into inbound_messages (wa_message_id, phone, source, body)
      values (${waMessageId}, ${phone}, ${source}, ${sql.json(body as Parameters<typeof sql.json>[0])})
      on conflict (wa_message_id) do nothing
      returning id
    `;
    return rows.length > 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[inbound] db claim failed, processing anyway: ${msg}`);
    return true;
  }
}
