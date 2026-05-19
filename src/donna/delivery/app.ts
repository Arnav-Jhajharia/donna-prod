// app channel — the seam every future surface plugs into. when the router
// can't (or shouldn't) push to whatsapp/imessage, the burst is written to
// outbound_messages and any client polling /app/inbox drains it: native
// app, dynamic island live activity, browser tab.
//
// the contract:
//   - enqueue never throws on a healthy database. callers can treat it as
//     "delivery guaranteed eventually" — the row is durable.
//   - status flow: pending → delivered (client ack'd receipt) → read
//     (client signaled the user actually saw it). failed when the client
//     pulled and rejected the row.
//   - one burst string per row. preserves ordering via created_at.
//
// nothing here knows about apns/fcm. push wake-ups are a separate concern:
// /app/inbox polling works without any of them. when push tokens land, the
// trigger fires *after* enqueue (a notify step), not in place of it.

import { getSql } from "../db.js";

export interface EnqueueArgs {
  userId: string;
  body: string;
  runId?: string | null;
  payload?: Record<string, unknown>;
}

export interface EnqueueResult {
  id: string;
}

export class AppChannel {
  async enqueue(args: EnqueueArgs): Promise<EnqueueResult> {
    const sql = getSql();
    const payload = args.payload ?? {};
    const rows = await sql<Array<{ id: string }>>`
      insert into outbound_messages
        (user_id, channel, body, payload, run_id)
      values
        (${args.userId}, 'app', ${args.body},
         ${sql.json(payload as unknown as Parameters<typeof sql.json>[0])},
         ${args.runId ?? null})
      returning id
    `;
    const id = rows[0]?.id;
    if (!id) throw new Error("AppChannel.enqueue: no row returned");
    return { id };
  }
}

export interface InboxRow {
  id: string;
  body: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

/**
 * Drain pending bursts for a user. Caller (HTTP handler at /app/inbox)
 * marks them delivered after a successful client ack. Rows stay pending
 * until ack — at-least-once delivery, never lost.
 */
export async function listPendingForUser(
  userId: string,
  limit: number = 50,
): Promise<InboxRow[]> {
  const sql = getSql();
  const rows = await sql<Array<{
    id: string;
    body: string;
    payload: Record<string, unknown>;
    created_at: string;
  }>>`
    select id, body, payload, created_at
    from outbound_messages
    where user_id = ${userId}
      and channel = 'app'
      and status = 'pending'
    order by created_at
    limit ${limit}
  `;
  return rows.map((r) => ({
    id: r.id,
    body: r.body,
    payload: r.payload,
    createdAt: r.created_at,
  }));
}

export async function markDelivered(id: string): Promise<void> {
  const sql = getSql();
  await sql`
    update outbound_messages
      set status = 'delivered', delivered_at = now()
    where id = ${id} and status = 'pending'
  `;
}

export async function markRead(id: string): Promise<void> {
  const sql = getSql();
  await sql`
    update outbound_messages
      set status = 'read', read_at = now()
    where id = ${id} and status in ('pending', 'delivered')
  `;
}

export async function markFailed(id: string, errorMessage: string): Promise<void> {
  const sql = getSql();
  await sql`
    update outbound_messages
      set status = 'failed', failed_at = now(), error_message = ${errorMessage}
    where id = ${id} and status = 'pending'
  `;
}
