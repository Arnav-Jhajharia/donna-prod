// subscriptions storage: CRUD over subscriptions, subscription_events, agendas.
// no inline classification or gmail logic — that lives in scan.ts. storage
// trusts the caller to pass a canonical vendor.

import { getSql } from "../db.js";
import type {
  Subscription,
  SubscriptionEvent,
  SubscriptionStatus,
  SubscriptionRecurrence,
  SubscriptionEventKind,
  SubscriptionSourceKind,
  Agenda,
  BackfillRow,
} from "./types.js";

// ─── subscriptions ────────────────────────────────────────────────────────

interface UpsertInput {
  userId: string;
  vendor_canonical: string;
  vendor_raw?: string | null;
  status?: SubscriptionStatus;
  recurrence?: SubscriptionRecurrence | null;
  amount_cents?: number | null;
  monthly_amount_cents?: number | null;
  currency?: string | null;
  category?: string | null;
  first_seen_at?: string | null;
  last_charge_at?: string | null;
  next_renewal_at?: string | null;
  source_kind: SubscriptionSourceKind;
  notes?: string | null;
}

// upsert a subscription row by (user_id, vendor_canonical). on conflict, take
// the NEW non-null values (don't clobber known data with nulls).
export async function upsertSubscription(args: UpsertInput): Promise<Subscription> {
  const sql = getSql();
  const rows = await sql<Subscription[]>`
    insert into subscriptions
      (user_id, vendor_canonical, vendor_raw, status, recurrence,
       amount_cents, monthly_amount_cents, currency, category,
       first_seen_at, last_charge_at, next_renewal_at,
       source_kind, notes, updated_at)
    values
      (${args.userId}, ${args.vendor_canonical}, ${args.vendor_raw ?? null},
       ${args.status ?? "unknown"}, ${args.recurrence ?? null},
       ${args.amount_cents ?? null}, ${args.monthly_amount_cents ?? null},
       ${args.currency ?? null}, ${args.category ?? null},
       ${args.first_seen_at ?? null}, ${args.last_charge_at ?? null},
       ${args.next_renewal_at ?? null},
       ${args.source_kind}, ${args.notes ?? null}, now())
    on conflict on constraint subscriptions_user_vendor_active_uniq
    do update set
      vendor_raw           = coalesce(excluded.vendor_raw, subscriptions.vendor_raw),
      status               = case
                               when excluded.status = 'unknown' then subscriptions.status
                               else excluded.status
                             end,
      recurrence           = coalesce(excluded.recurrence, subscriptions.recurrence),
      amount_cents         = coalesce(excluded.amount_cents, subscriptions.amount_cents),
      monthly_amount_cents = coalesce(excluded.monthly_amount_cents, subscriptions.monthly_amount_cents),
      currency             = coalesce(excluded.currency, subscriptions.currency),
      category             = coalesce(excluded.category, subscriptions.category),
      first_seen_at        = least(coalesce(excluded.first_seen_at, subscriptions.first_seen_at),
                                   coalesce(subscriptions.first_seen_at, excluded.first_seen_at)),
      last_charge_at       = greatest(coalesce(excluded.last_charge_at, subscriptions.last_charge_at),
                                      coalesce(subscriptions.last_charge_at, excluded.last_charge_at)),
      next_renewal_at      = coalesce(excluded.next_renewal_at, subscriptions.next_renewal_at),
      notes                = coalesce(excluded.notes, subscriptions.notes),
      updated_at           = now()
    returning *
  `;
  if (rows.length === 0) throw new Error("upsertSubscription: no row returned");
  return rows[0]!;
}

export async function listSubscriptions(
  userId: string,
  opts: { status?: SubscriptionStatus; limit?: number } = {},
): Promise<Subscription[]> {
  const sql = getSql();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  if (opts.status) {
    return [
      ...(await sql<Subscription[]>`
        select * from subscriptions
        where user_id = ${userId} and not is_deleted and status = ${opts.status}
        order by coalesce(monthly_amount_cents, 0) desc, vendor_canonical asc
        limit ${limit}
      `),
    ];
  }
  return [
    ...(await sql<Subscription[]>`
      select * from subscriptions
      where user_id = ${userId} and not is_deleted
      order by coalesce(monthly_amount_cents, 0) desc, vendor_canonical asc
      limit ${limit}
    `),
  ];
}

export async function getSubscriptionById(
  id: string,
  userId: string,
): Promise<Subscription | null> {
  const sql = getSql();
  const rows = await sql<Subscription[]>`
    select * from subscriptions
    where id = ${id} and user_id = ${userId} and not is_deleted
    limit 1
  `;
  return rows[0] ?? null;
}

export interface UpdateInput {
  status?: SubscriptionStatus;
  recurrence?: SubscriptionRecurrence;
  amount_cents?: number;
  monthly_amount_cents?: number;
  currency?: string;
  notes?: string;
  user_confirmed?: boolean;
  next_renewal_at?: string | null;
}

export async function updateSubscription(
  id: string,
  userId: string,
  patch: UpdateInput,
): Promise<Subscription | null> {
  const sql = getSql();
  const rows = await sql<Subscription[]>`
    update subscriptions
    set status               = coalesce(${patch.status ?? null}, status),
        recurrence           = coalesce(${patch.recurrence ?? null}, recurrence),
        amount_cents         = coalesce(${patch.amount_cents ?? null}, amount_cents),
        monthly_amount_cents = coalesce(${patch.monthly_amount_cents ?? null}, monthly_amount_cents),
        currency             = coalesce(${patch.currency ?? null}, currency),
        notes                = coalesce(${patch.notes ?? null}, notes),
        user_confirmed       = coalesce(${patch.user_confirmed ?? null}, user_confirmed),
        next_renewal_at      = case
                                 when ${patch.next_renewal_at === null ? 1 : 0}::int = 1
                                   then null
                                 else coalesce(${patch.next_renewal_at ?? null}::timestamptz, next_renewal_at)
                               end,
        updated_at           = now()
    where id = ${id} and user_id = ${userId} and not is_deleted
    returning *
  `;
  return rows[0] ?? null;
}

// soft-delete dupes onto a primary id. moves all subscription_events from
// each dupe under primary, then marks dupes is_deleted=true.
export async function mergeSubscriptions(
  primaryId: string,
  dupeIds: string[],
  userId: string,
): Promise<{ merged: number; primary: Subscription | null }> {
  if (dupeIds.length === 0) return { merged: 0, primary: await getSubscriptionById(primaryId, userId) };
  const sql = getSql();
  let mergedCount = 0;
  await sql.begin(async (tx) => {
    await tx`
      update subscription_events
      set subscription_id = ${primaryId}
      where subscription_id = any(${dupeIds}) and user_id = ${userId}
    `;
    const updated = await tx<{ id: string }[]>`
      update subscriptions
      set is_deleted = true, updated_at = now()
      where id = any(${dupeIds}) and user_id = ${userId}
      returning id
    `;
    mergedCount = updated.length;
    // re-aggregate primary's last_charge_at + first_seen_at + max amount
    await tx`
      update subscriptions s
      set first_seen_at = (select min(occurred_at) from subscription_events e where e.subscription_id = s.id),
          last_charge_at = (select max(occurred_at) from subscription_events e where e.subscription_id = s.id),
          updated_at = now()
      where id = ${primaryId} and user_id = ${userId}
    `;
  });
  return { merged: mergedCount, primary: await getSubscriptionById(primaryId, userId) };
}

export interface SummaryRow {
  category: string | null;
  status: SubscriptionStatus;
  count: number;
  monthly_total_cents: number;
}

export async function subscriptionsSummary(userId: string): Promise<{
  total_monthly_cents: number;
  active_count: number;
  failed_count: number;
  paused_count: number;
  cancelled_count: number;
  by_category: SummaryRow[];
  top_active: Array<Pick<Subscription, "id" | "vendor_canonical" | "monthly_amount_cents" | "currency" | "category">>;
}> {
  const sql = getSql();
  const total = (
    await sql<Array<{ total: number; n: number }>>`
      select coalesce(sum(monthly_amount_cents), 0)::int as total, count(*)::int as n
      from subscriptions
      where user_id = ${userId} and not is_deleted and status = 'active'
    `
  )[0]!;
  const counts = await sql<Array<{ status: SubscriptionStatus; n: number }>>`
    select status, count(*)::int as n
    from subscriptions
    where user_id = ${userId} and not is_deleted
    group by status
  `;
  const byCat = await sql<SummaryRow[]>`
    select category, status, count(*)::int as count,
           coalesce(sum(monthly_amount_cents), 0)::int as monthly_total_cents
    from subscriptions
    where user_id = ${userId} and not is_deleted
    group by category, status
    order by monthly_total_cents desc
  `;
  const topActive = await sql<
    Array<Pick<Subscription, "id" | "vendor_canonical" | "monthly_amount_cents" | "currency" | "category">>
  >`
    select id, vendor_canonical, monthly_amount_cents, currency, category
    from subscriptions
    where user_id = ${userId} and not is_deleted and status = 'active'
    order by coalesce(monthly_amount_cents, 0) desc
    limit 10
  `;
  const lookup = (s: SubscriptionStatus) => counts.find((c) => c.status === s)?.n ?? 0;
  return {
    total_monthly_cents: total.total,
    active_count: lookup("active"),
    failed_count: lookup("failed"),
    paused_count: lookup("paused"),
    cancelled_count: lookup("cancelled"),
    by_category: [...byCat],
    top_active: [...topActive],
  };
}

// ─── subscription_events ──────────────────────────────────────────────────

export async function recordEvent(args: {
  subscription_id: string;
  user_id: string;
  event_kind: SubscriptionEventKind;
  occurred_at: string;
  amount_cents?: number | null;
  currency?: string | null;
  source_kind: "gmail" | "manual";
  source_ref?: string | null;
  raw_subject?: string | null;
  raw_snippet?: string | null;
}): Promise<SubscriptionEvent | null> {
  const sql = getSql();
  // ON CONFLICT for the dedupe-by-message-id index. if source_ref is null,
  // there's no dedupe constraint and we just insert.
  const rows = await sql<SubscriptionEvent[]>`
    insert into subscription_events
      (subscription_id, user_id, event_kind, amount_cents, currency,
       occurred_at, source_kind, source_ref, raw_subject, raw_snippet)
    values
      (${args.subscription_id}, ${args.user_id}, ${args.event_kind},
       ${args.amount_cents ?? null}, ${args.currency ?? null},
       ${args.occurred_at}, ${args.source_kind}, ${args.source_ref ?? null},
       ${args.raw_subject ?? null}, ${args.raw_snippet ?? null})
    on conflict on constraint subscription_events_source_uniq do nothing
    returning *
  `;
  return rows[0] ?? null;
}

// ─── agendas ──────────────────────────────────────────────────────────────

export async function createAgenda(args: {
  user_id: string;
  kind: string;
  current_step: string;
  payload?: Record<string, unknown>;
}): Promise<Agenda> {
  const sql = getSql();
  const rows = await sql<Agenda[]>`
    insert into agendas (user_id, kind, current_step, payload)
    values (${args.user_id}, ${args.kind}, ${args.current_step},
            ${sql.json((args.payload ?? {}) as Parameters<typeof sql.json>[0])})
    returning *
  `;
  if (rows.length === 0) throw new Error("createAgenda: no row returned");
  return rows[0]!;
}

export async function getAgenda(id: string, userId: string): Promise<Agenda | null> {
  const sql = getSql();
  const rows = await sql<Agenda[]>`
    select * from agendas where id = ${id} and user_id = ${userId} limit 1
  `;
  return rows[0] ?? null;
}

export async function listActiveAgendas(userId: string): Promise<Agenda[]> {
  const sql = getSql();
  return [
    ...(await sql<Agenda[]>`
      select * from agendas
      where user_id = ${userId} and status = 'active'
      order by updated_at desc
    `),
  ];
}

export async function advanceAgenda(args: {
  id: string;
  user_id: string;
  next_step?: string;
  status?: "completed" | "abandoned" | "blocked";
  payload_patch?: Record<string, unknown>;
}): Promise<Agenda | null> {
  const sql = getSql();
  const rows = await sql<Agenda[]>`
    update agendas
    set current_step = coalesce(${args.next_step ?? null}, current_step),
        status       = coalesce(${args.status ?? null}, status),
        payload      = case
                         when ${args.payload_patch ? 1 : 0}::int = 1
                           then payload || ${sql.json((args.payload_patch ?? {}) as Parameters<typeof sql.json>[0])}::jsonb
                         else payload
                       end,
        updated_at   = now()
    where id = ${args.id} and user_id = ${args.user_id}
    returning *
  `;
  return rows[0] ?? null;
}

// ─── backfills ────────────────────────────────────────────────────────────

export async function createBackfill(args: {
  user_id: string;
  agenda_id?: string | null;
  lookback_days?: number;
}): Promise<BackfillRow> {
  const sql = getSql();
  const rows = await sql<BackfillRow[]>`
    insert into subscriptions_backfills (user_id, agenda_id, lookback_days)
    values (${args.user_id}, ${args.agenda_id ?? null}, ${args.lookback_days ?? 180})
    returning *
  `;
  if (rows.length === 0) throw new Error("createBackfill: no row returned");
  return rows[0]!;
}

export async function updateBackfill(
  id: string,
  patch: Partial<Omit<BackfillRow, "id" | "user_id" | "created_at">>,
): Promise<BackfillRow | null> {
  const sql = getSql();
  const rows = await sql<BackfillRow[]>`
    update subscriptions_backfills
    set status                       = coalesce(${patch.status ?? null}, status),
        lookback_days                = coalesce(${patch.lookback_days ?? null}, lookback_days),
        detected_count               = coalesce(${patch.detected_count ?? null}, detected_count),
        scanned_count                = coalesce(${patch.scanned_count ?? null}, scanned_count),
        total_monthly_amount_cents   = coalesce(${patch.total_monthly_amount_cents ?? null}, total_monthly_amount_cents),
        last_error                   = coalesce(${patch.last_error ?? null}, last_error),
        started_at                   = coalesce(${patch.started_at ?? null}, started_at),
        finished_at                  = coalesce(${patch.finished_at ?? null}, finished_at)
    where id = ${id}
    returning *
  `;
  return rows[0] ?? null;
}
