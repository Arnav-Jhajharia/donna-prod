// subscription tools — the durable read/write surface for the feature.
// any future surface (whatsapp today, web dashboard later, voice agent, ...)
// consumes the same five tools.

import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../brain.js";
import { getSql } from "../db.js";
import { getTurnContext } from "../context.js";
import { audit } from "../integrations/service.js";
import { aggregate } from "../extractors/subscriptions/aggregate.js";
import type {
  Recurrence,
  SubscriptionStatus,
  SubscriptionView,
  DetectedCharge,
} from "../extractors/subscriptions/types.js";

const PTC_CALLER = "code_execution_20250825" as const;
const VALID_RECURRENCES: Recurrence[] = ["monthly", "yearly", "weekly", "quarterly", "unknown"];
const VALID_STATUSES: SubscriptionStatus[] = ["active", "cancelled", "paused", "uncertain"];

interface RawSubRow {
  id: string;
  user_id: string;
  merchant_canonical: string;
  merchant_raw: string[];
  category: string | null;
  amount_cents: number | null;
  currency: string | null;
  recurrence: string | null;
  status: string;
  user_confirmed: boolean;
  confidence: number;
  first_seen_at: string;
  last_charged_at: string | null;
  next_estimated_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

function rowToView(r: RawSubRow): SubscriptionView {
  return {
    id: r.id,
    user_id: r.user_id,
    merchant_canonical: r.merchant_canonical,
    merchant_raw: r.merchant_raw,
    category: r.category,
    amount_cents: r.amount_cents,
    currency: r.currency,
    recurrence: (r.recurrence as Recurrence | null) ?? null,
    status: r.status as SubscriptionStatus,
    user_confirmed: r.user_confirmed,
    confidence: r.confidence,
    first_seen_at: r.first_seen_at,
    last_charged_at: r.last_charged_at,
    next_estimated_at: r.next_estimated_at,
    notes: r.notes,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// monthly-equivalent cents for cross-recurrence totals.
function monthlyEquivalent(amount: number | null, recurrence: Recurrence | null): number {
  if (amount == null) return 0;
  switch (recurrence) {
    case "weekly":    return Math.round(amount * 4.345);
    case "quarterly": return Math.round(amount / 3);
    case "yearly":    return Math.round(amount / 12);
    case "monthly":
    case "unknown":
    default:          return amount;
  }
}

// ---------------------------------------------------------------------------
// subscriptions_list
// ---------------------------------------------------------------------------

export const subscriptionsListTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "subscriptions_list",
  description: `list the user's tracked subscriptions.

returns: { subscriptions: [{id, merchant_canonical, amount_cents, currency, recurrence, status, last_charged_at, next_estimated_at, confidence, user_confirmed, category}], count, total_monthly_equivalent_cents }.

call when user asks:
- "what am i paying for"
- "show me my subscriptions"
- "anything that auto-renews soon"

filter by status if you want only active ones (default returns all). limit caps results (default 50, max 200).`,
  input_schema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["active", "cancelled", "paused", "uncertain", "any"],
        description: "filter by status. defaults to 'any'.",
      },
      limit: {
        type: "number",
        description: "max rows (1-200). default 50.",
      },
    },
  },
  allowed_callers: [PTC_CALLER],
  input_examples: [
    { status: "active" },
    { status: "any", limit: 100 },
    {},
  ],
  modes: new Set<BrainMode>(["reactive", "proactive"]),
};

interface ListInput {
  status?: SubscriptionStatus | "any";
  limit?: number;
}

export async function subscriptionsListHandler(input: unknown): Promise<unknown> {
  const { status = "any", limit = 50 } = (input ?? {}) as ListInput;
  const cap = Math.max(1, Math.min(200, Math.floor(limit)));
  const ctx = getTurnContext();
  const sql = getSql();

  const rows = status === "any"
    ? await sql<RawSubRow[]>`
        select * from subscriptions
        where user_id = ${ctx.userId}
        order by amount_cents desc nulls last, merchant_canonical asc
        limit ${cap}
      `
    : await sql<RawSubRow[]>`
        select * from subscriptions
        where user_id = ${ctx.userId} and status = ${status}
        order by amount_cents desc nulls last, merchant_canonical asc
        limit ${cap}
      `;

  const subs = rows.map(rowToView);
  const total = subs.reduce(
    (acc, s) => acc + monthlyEquivalent(s.amount_cents, s.recurrence),
    0,
  );
  return {
    subscriptions: subs,
    count: subs.length,
    total_monthly_equivalent_cents: total,
  };
}

// ---------------------------------------------------------------------------
// subscriptions_summary
// ---------------------------------------------------------------------------

export const subscriptionsSummaryTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "subscriptions_summary",
  description: `aggregated view of the user's subscriptions. answers "where does my money go" in one call.

returns: {
  count_active, count_uncertain, count_cancelled,
  total_monthly_equivalent_cents, currency_breakdown: {USD: cents, SGD: cents, ...},
  top_5_by_cost: [{merchant_canonical, amount_cents, currency, recurrence}],
  recently_added_30d: [{merchant_canonical, amount_cents, currency, first_seen_at}]
}

call this for "what am i paying monthly", "how much do my subs cost", "anything new lately".`,
  input_schema: { type: "object", properties: {} },
  modes: new Set<BrainMode>(["reactive", "proactive"]),
};

export async function subscriptionsSummaryHandler(_input: unknown): Promise<unknown> {
  const ctx = getTurnContext();
  const sql = getSql();
  const rows = await sql<RawSubRow[]>`
    select * from subscriptions
    where user_id = ${ctx.userId}
    order by amount_cents desc nulls last
  `;
  const subs = rows.map(rowToView);

  const active = subs.filter((s) => s.status === "active");
  const uncertain = subs.filter((s) => s.status === "uncertain");
  const cancelled = subs.filter((s) => s.status === "cancelled");

  const totalMonthly = active.reduce(
    (acc, s) => acc + monthlyEquivalent(s.amount_cents, s.recurrence),
    0,
  );

  const currency_breakdown: Record<string, number> = {};
  for (const s of active) {
    const c = s.currency ?? "USD";
    currency_breakdown[c] = (currency_breakdown[c] ?? 0) + monthlyEquivalent(s.amount_cents, s.recurrence);
  }

  const top_5_by_cost = active
    .filter((s) => s.amount_cents != null)
    .sort((a, b) => monthlyEquivalent(b.amount_cents, b.recurrence) - monthlyEquivalent(a.amount_cents, a.recurrence))
    .slice(0, 5)
    .map((s) => ({
      merchant_canonical: s.merchant_canonical,
      amount_cents: s.amount_cents,
      currency: s.currency,
      recurrence: s.recurrence,
    }));

  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const recently_added_30d = subs
    .filter((s) => s.first_seen_at >= cutoff)
    .map((s) => ({
      merchant_canonical: s.merchant_canonical,
      amount_cents: s.amount_cents,
      currency: s.currency,
      first_seen_at: s.first_seen_at,
    }));

  return {
    count_active: active.length,
    count_uncertain: uncertain.length,
    count_cancelled: cancelled.length,
    total_monthly_equivalent_cents: totalMonthly,
    currency_breakdown,
    top_5_by_cost,
    recently_added_30d,
  };
}

// ---------------------------------------------------------------------------
// subscriptions_record (user-volunteered)
// ---------------------------------------------------------------------------

export const subscriptionsRecordTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "subscriptions_record",
  description: `record a subscription the user told you about (not detected from gmail).

call when the user says things like:
- "i pay $20/mo for openai"
- "$5 a month for grok api"
- "i just signed up for cursor pro at $20"

amount is the price ONE charge, in the smallest currency unit (cents). $19.99 → 1999.
recurrence default 'monthly' if user says "/mo" or "monthly" or omits; else read from user words.

returns: { subscription: {id, merchant_canonical, amount_cents, currency, recurrence, status, ...}, action: "added"|"updated" }`,
  input_schema: {
    type: "object",
    properties: {
      merchant: { type: "string", description: "name as the user said it" },
      amount_cents: { type: "number", description: "price per charge, smallest currency unit" },
      currency: { type: "string", description: "iso 4217. default 'USD' if user gave a $ amount." },
      recurrence: { type: "string", enum: ["monthly", "yearly", "weekly", "quarterly", "unknown"] },
      charged_at: { type: "string", description: "iso 8601. defaults to now." },
      notes: { type: "string", description: "free-form note (e.g. 'free trial ends jun 1')" },
    },
    required: ["merchant", "amount_cents", "currency"],
  },
  modes: new Set<BrainMode>(["reactive"]),
};

interface RecordInput {
  merchant?: string;
  amount_cents?: number;
  currency?: string;
  recurrence?: Recurrence;
  charged_at?: string;
  notes?: string;
}

export async function subscriptionsRecordHandler(input: unknown): Promise<unknown> {
  const { merchant, amount_cents, currency, recurrence, charged_at, notes } =
    (input ?? {}) as RecordInput;
  if (!merchant || typeof merchant !== "string") {
    throw new Error("subscriptions_record: merchant required");
  }
  if (typeof amount_cents !== "number" || amount_cents <= 0) {
    throw new Error("subscriptions_record: amount_cents must be a positive number");
  }
  if (!currency || typeof currency !== "string") {
    throw new Error("subscriptions_record: currency required (iso 4217 like 'USD')");
  }
  const rec: Recurrence = recurrence && VALID_RECURRENCES.includes(recurrence) ? recurrence : "monthly";
  const ctx = getTurnContext();

  const charge: DetectedCharge = {
    merchant_raw: merchant,
    amount_cents: Math.round(amount_cents),
    currency: currency.toUpperCase(),
    charged_at: charged_at ?? new Date().toISOString(),
    evidence_quote: `user-volunteered: ${merchant} ${currency} ${(amount_cents / 100).toFixed(2)} ${rec}${notes ? ` (${notes})` : ""}`,
    recurrence_hint: rec,
    category_hint: null,
    confidence: 1.0,
    source_channel: "user_volunteered",
    source_ref: null,
  };

  const before = await getSql()<{ id: string }[]>`
    select id from subscriptions
    where user_id = ${ctx.userId} and lower(merchant_canonical) = ${merchant.toLowerCase()}
    limit 1
  `;
  const existed = before.length > 0;

  await aggregate(ctx.userId, [charge]);

  // mark the row user_confirmed=true and set notes if given
  const sql = getSql();
  const updated = await sql<RawSubRow[]>`
    update subscriptions set
      user_confirmed = true,
      notes = coalesce(${notes ?? null}, notes),
      updated_at = now()
    where user_id = ${ctx.userId}
      and lower(merchant_canonical) = ${merchant.toLowerCase()}
      and status != 'cancelled'
    returning *
  `;

  await audit({
    userId: ctx.userId,
    provider: "subscriptions",
    action: "subscriptions.record",
    ok: true,
    meta: { merchant, amount_cents, currency, recurrence: rec, action: existed ? "updated" : "added" },
  });

  return {
    subscription: updated[0] ? rowToView(updated[0]) : null,
    action: existed ? "updated" : "added",
  };
}

// ---------------------------------------------------------------------------
// subscriptions_update
// ---------------------------------------------------------------------------

export const subscriptionsUpdateTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "subscriptions_update",
  description: `update a tracked subscription. corrections, status flips, user-confirms.

call when user says:
- "i cancelled netflix" → status="cancelled"
- "actually it's $19.99 not $14.99" → amount_cents=1999
- "yes that's right" → user_confirmed=true (during onboarding confirmation)
- "amazon prime is yearly not monthly" → recurrence="yearly"
- "free trial ends jun 1" → notes

returns the updated subscription row.`,
  input_schema: {
    type: "object",
    properties: {
      id: { type: "string", description: "subscription id (uuid)" },
      status: { type: "string", enum: ["active", "cancelled", "paused", "uncertain"] },
      amount_cents: { type: "number", description: "new price per charge" },
      recurrence: { type: "string", enum: ["monthly", "yearly", "weekly", "quarterly", "unknown"] },
      notes: { type: "string" },
      user_confirmed: { type: "boolean" },
    },
    required: ["id"],
  },
  modes: new Set<BrainMode>(["reactive"]),
};

interface UpdateInput {
  id?: string;
  status?: SubscriptionStatus;
  amount_cents?: number;
  recurrence?: Recurrence;
  notes?: string;
  user_confirmed?: boolean;
}

export async function subscriptionsUpdateHandler(input: unknown): Promise<unknown> {
  const { id, status, amount_cents, recurrence, notes, user_confirmed } =
    (input ?? {}) as UpdateInput;
  if (!id || typeof id !== "string") throw new Error("subscriptions_update: id required");
  if (status && !VALID_STATUSES.includes(status)) {
    throw new Error(`subscriptions_update: status must be one of ${VALID_STATUSES.join(" | ")}`);
  }
  if (recurrence && !VALID_RECURRENCES.includes(recurrence)) {
    throw new Error(`subscriptions_update: recurrence must be one of ${VALID_RECURRENCES.join(" | ")}`);
  }
  const ctx = getTurnContext();
  const sql = getSql();

  const updated = await sql<RawSubRow[]>`
    update subscriptions set
      status = coalesce(${status ?? null}, status),
      amount_cents = coalesce(${amount_cents ?? null}, amount_cents),
      recurrence = coalesce(${recurrence ?? null}, recurrence),
      notes = coalesce(${notes ?? null}, notes),
      user_confirmed = coalesce(${user_confirmed ?? null}, user_confirmed),
      updated_at = now()
    where id = ${id} and user_id = ${ctx.userId}
    returning *
  `;
  if (updated.length === 0) {
    throw new Error(`subscriptions_update: no row found for id=${id}`);
  }

  await audit({
    userId: ctx.userId,
    provider: "subscriptions",
    action: "subscriptions.update",
    itemRef: id,
    ok: true,
    meta: { status, amount_cents, recurrence, user_confirmed },
  });

  return { subscription: rowToView(updated[0]!) };
}

// ---------------------------------------------------------------------------
// subscriptions_merge
// ---------------------------------------------------------------------------

export const subscriptionsMergeTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "subscriptions_merge",
  description: `merge duplicate subscription rows into one. moves all charges from each dupe into the primary, marks the dupes as cancelled with a merge note.

call when you spot duplicates during the onboarding confirmation pass (e.g. "Netflix" and "Netflix US LLC" are the same), or when the user points one out.

primary_id wins; dupe_ids[] all get cancelled with notes='merged into <primary_id>'. returns the surviving primary row.`,
  input_schema: {
    type: "object",
    properties: {
      primary_id: { type: "string", description: "the row that survives" },
      dupe_ids: {
        type: "array",
        items: { type: "string" },
        description: "rows to merge into primary",
        minItems: 1,
      },
    },
    required: ["primary_id", "dupe_ids"],
  },
  modes: new Set<BrainMode>(["reactive"]),
};

interface MergeInput {
  primary_id?: string;
  dupe_ids?: string[];
}

export async function subscriptionsMergeHandler(input: unknown): Promise<unknown> {
  const { primary_id, dupe_ids } = (input ?? {}) as MergeInput;
  if (!primary_id || typeof primary_id !== "string") {
    throw new Error("subscriptions_merge: primary_id required");
  }
  if (!Array.isArray(dupe_ids) || dupe_ids.length === 0) {
    throw new Error("subscriptions_merge: dupe_ids[] required (≥1)");
  }
  const ctx = getTurnContext();
  const sql = getSql();

  // verify all rows belong to this user
  const allIds = [primary_id, ...dupe_ids];
  const owned = await sql<{ id: string }[]>`
    select id from subscriptions
    where user_id = ${ctx.userId} and id in ${sql(allIds)}
  `;
  const ownedSet = new Set(owned.map((r) => r.id));
  for (const id of allIds) {
    if (!ownedSet.has(id)) {
      throw new Error(`subscriptions_merge: id ${id} not found for this user`);
    }
  }

  // move charges → primary
  await sql`
    update subscription_charges
    set subscription_id = ${primary_id}
    where user_id = ${ctx.userId} and subscription_id in ${sql(dupe_ids)}
  `;

  // collect raw merchant variants from all dupes to merge into primary's array
  const dupeRows = await sql<{ merchant_raw: string[] }[]>`
    select merchant_raw from subscriptions
    where user_id = ${ctx.userId} and id in ${sql(dupe_ids)}
  `;
  const extraRaws = dupeRows.flatMap((r) => r.merchant_raw);
  if (extraRaws.length > 0) {
    await sql`
      update subscriptions
      set merchant_raw = (
        select array(select distinct unnest(merchant_raw || ${extraRaws}))
      ),
      updated_at = now()
      where id = ${primary_id} and user_id = ${ctx.userId}
    `;
  }

  // mark dupes cancelled
  await sql`
    update subscriptions set
      status = 'cancelled',
      notes = coalesce(notes || ' | ', '') || 'merged into ' || ${primary_id},
      updated_at = now()
    where user_id = ${ctx.userId} and id in ${sql(dupe_ids)}
  `;

  // recompute primary's rollup from charges
  const charges = await sql<{ charged_at: string; amount_cents: number }[]>`
    select charged_at, amount_cents
    from subscription_charges
    where subscription_id = ${primary_id}
    order by charged_at asc
  `;
  if (charges.length > 0) {
    const last = charges[charges.length - 1]!;
    await sql`
      update subscriptions set
        last_charged_at = ${last.charged_at},
        amount_cents = ${last.amount_cents},
        updated_at = now()
      where id = ${primary_id}
    `;
  }

  const primaryRow = await sql<RawSubRow[]>`
    select * from subscriptions where id = ${primary_id} limit 1
  `;

  await audit({
    userId: ctx.userId,
    provider: "subscriptions",
    action: "subscriptions.merge",
    itemRef: primary_id,
    ok: true,
    meta: { dupe_ids, dupe_count: dupe_ids.length },
  });

  return {
    primary: primaryRow[0] ? rowToView(primaryRow[0]) : null,
    merged_count: dupe_ids.length,
  };
}
