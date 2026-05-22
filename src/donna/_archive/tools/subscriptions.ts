// tool wrappers for the subscriptions tracker. one slice of a future
// expense-tracker feature; not the whole thing.
//
// five tools (matching tools/index.ts imports + the <subscriptions> prompt
// section):
//   subscriptions_list      — typed list (ptc-callable for in-python fanout)
//   subscriptions_summary   — totals + by-category + top active (direct)
//   subscriptions_record    — record one the user told you about (direct)
//   subscriptions_update    — edit / status-change / user_confirmed (direct)
//   subscriptions_merge     — collapse dupe vendor rows (direct)

import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../brain.js";
import { getTurnContext } from "../context.js";
import {
  listSubscriptions,
  subscriptionsSummary,
  upsertSubscription,
  updateSubscription,
  mergeSubscriptions,
  getSubscriptionById,
} from "../subscriptions/storage.js";
import type {
  SubscriptionRecurrence,
  SubscriptionStatus,
} from "../subscriptions/types.js";

const PTC_CALLER = "code_execution_20250825" as const;

// ─── subscriptions_list ────────────────────────────────────────────────────

interface ListInput {
  status?: SubscriptionStatus;
  limit?: number;
}

export const subscriptionsListTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "subscriptions_list",
  description: `list the user's tracked subscriptions.

returns array of: {id, vendor_canonical, status, recurrence, amount_cents, monthly_amount_cents, currency, category, last_charge_at, next_renewal_at, user_confirmed, notes}.

amounts are in CENTS in the wire format. render them as dollars/euros/etc when speaking to the user (1999 → $19.99).

call this inside code_execution when you want to filter, sort, or aggregate ("over $10/mo", "added since march", "everything ai-related"). use subscriptions_summary for the headline totals.

defaults: no status filter, limit=100. cap is 500.`,
  input_schema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["active", "paused", "failed", "cancelled", "trial", "unknown"],
        description: "filter to one status. omit for all.",
      },
      limit: { type: "number", description: "max rows (1-500). default 100." },
    },
  },
  allowed_callers: [PTC_CALLER],
  modes: new Set<BrainMode>(["reactive", "proactive"]),
};

export async function subscriptionsListHandler(input: unknown): Promise<unknown> {
  const i = (input ?? {}) as ListInput;
  const ctx = getTurnContext();
  return listSubscriptions(ctx.userId, { status: i.status, limit: i.limit });
}

// ─── subscriptions_summary ─────────────────────────────────────────────────

export const subscriptionsSummaryTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "subscriptions_summary",
  description: `aggregated view of recurring charges. one round-trip, summary-shaped.

returns:
  {
    total_monthly_cents: int,
    active_count, failed_count, paused_count, cancelled_count: int,
    by_category: [{category, status, count, monthly_total_cents}],
    top_active: [{id, vendor_canonical, monthly_amount_cents, currency, category}]
  }

call directly (not in code_execution) for "where does my money go", "how much in subs", "anything new lately". then summarize in natural language for send_burst.`,
  input_schema: { type: "object", properties: {} },
  modes: new Set<BrainMode>(["reactive", "proactive"]),
};

export async function subscriptionsSummaryHandler(): Promise<unknown> {
  const ctx = getTurnContext();
  return subscriptionsSummary(ctx.userId);
}

// ─── subscriptions_record ──────────────────────────────────────────────────

interface RecordInput {
  merchant: string;
  amount_cents?: number;
  currency?: string;
  recurrence?: SubscriptionRecurrence;
  category?: string;
  notes?: string;
}

export const subscriptionsRecordTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "subscriptions_record",
  description: `record a subscription the user just told you about.

inputs:
- merchant: required. canonical vendor name as the user said it (we'll dedupe later).
- amount_cents: integer cents (19.99 → 1999). omit if unknown — store it as null.
- currency: 3-letter code (USD, INR, SGD, EUR, GBP). default USD.
- recurrence: monthly | yearly | weekly | quarterly | custom | one_off. default monthly.
- category: optional free-text (ai_saas, infra, telecom, ...). leave unset to let the canonicalizer decide.
- notes: free-form.

returns the upserted row. on conflict with an existing (user, merchant), merges instead of duplicating.`,
  input_schema: {
    type: "object",
    properties: {
      merchant: { type: "string" },
      amount_cents: { type: "number" },
      currency: { type: "string" },
      recurrence: {
        type: "string",
        enum: ["monthly", "yearly", "weekly", "quarterly", "custom", "one_off"],
      },
      category: { type: "string" },
      notes: { type: "string" },
    },
    required: ["merchant"],
  },
  modes: new Set<BrainMode>(["reactive"]),
};

export async function subscriptionsRecordHandler(input: unknown): Promise<unknown> {
  const i = (input ?? {}) as RecordInput;
  if (!i.merchant || typeof i.merchant !== "string") {
    throw new Error("subscriptions_record: merchant required");
  }
  const ctx = getTurnContext();
  const recurrence = i.recurrence ?? "monthly";
  const amount = typeof i.amount_cents === "number" ? Math.round(i.amount_cents) : null;
  // normalize monthly amount: yearly /12, weekly *4.345, etc. nullable.
  let monthly: number | null = null;
  if (amount !== null) {
    monthly = amount;
    if (recurrence === "yearly")    monthly = Math.round(amount / 12);
    if (recurrence === "weekly")    monthly = Math.round(amount * 4.345);
    if (recurrence === "quarterly") monthly = Math.round(amount / 3);
  }
  return upsertSubscription({
    userId: ctx.userId,
    vendor_canonical: i.merchant.trim(),
    vendor_raw: null,
    status: "active",
    recurrence,
    amount_cents: amount,
    monthly_amount_cents: monthly,
    currency: i.currency ?? "USD",
    category: i.category ?? null,
    source_kind: "manual",
    notes: i.notes ?? null,
  });
}

// ─── subscriptions_update ──────────────────────────────────────────────────

interface UpdateInput {
  id: string;
  status?: SubscriptionStatus;
  amount_cents?: number;
  monthly_amount_cents?: number;
  currency?: string;
  recurrence?: SubscriptionRecurrence;
  notes?: string;
  user_confirmed?: boolean;
  next_renewal_at?: string | null;
}

export const subscriptionsUpdateTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "subscriptions_update",
  description: `edit a tracked subscription.

inputs (all optional except id):
- id: required.
- status: active | paused | failed | cancelled | trial | unknown.
- amount_cents: corrected amount in cents.
- monthly_amount_cents: corrected normalized monthly amount.
- currency: 3-letter code.
- recurrence: monthly | yearly | weekly | quarterly | custom | one_off.
- notes: free-form.
- user_confirmed: true when the user has confirmed a previously-detected row.
- next_renewal_at: iso timestamp of the next charge. pass null to clear.

returns the updated row, or null if not found / not yours.`,
  input_schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      status: {
        type: "string",
        enum: ["active", "paused", "failed", "cancelled", "trial", "unknown"],
      },
      amount_cents: { type: "number" },
      monthly_amount_cents: { type: "number" },
      currency: { type: "string" },
      recurrence: {
        type: "string",
        enum: ["monthly", "yearly", "weekly", "quarterly", "custom", "one_off"],
      },
      notes: { type: "string" },
      user_confirmed: { type: "boolean" },
      next_renewal_at: { type: ["string", "null"] },
    },
    required: ["id"],
  },
  modes: new Set<BrainMode>(["reactive"]),
};

export async function subscriptionsUpdateHandler(input: unknown): Promise<unknown> {
  const i = (input ?? {}) as UpdateInput;
  if (!i.id || typeof i.id !== "string") throw new Error("subscriptions_update: id required");
  const ctx = getTurnContext();
  return updateSubscription(i.id, ctx.userId, {
    status: i.status,
    amount_cents: i.amount_cents,
    monthly_amount_cents: i.monthly_amount_cents,
    currency: i.currency,
    recurrence: i.recurrence,
    notes: i.notes,
    user_confirmed: i.user_confirmed,
    next_renewal_at: i.next_renewal_at,
  });
}

// ─── subscriptions_merge ───────────────────────────────────────────────────

interface MergeInput {
  primary_id: string;
  dupe_ids: string[];
}

export const subscriptionsMergeTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "subscriptions_merge",
  description: `collapse duplicate rows for the same vendor. moves all events from each dupe under primary, soft-deletes the dupes, recomputes first_seen / last_charge on primary.

inputs:
- primary_id: the id you want to keep.
- dupe_ids: ids to fold in.

returns: { merged: int, primary: <row> }.`,
  input_schema: {
    type: "object",
    properties: {
      primary_id: { type: "string" },
      dupe_ids: { type: "array", items: { type: "string" } },
    },
    required: ["primary_id", "dupe_ids"],
  },
  modes: new Set<BrainMode>(["reactive"]),
};

export async function subscriptionsMergeHandler(input: unknown): Promise<unknown> {
  const i = (input ?? {}) as MergeInput;
  if (!i.primary_id) throw new Error("subscriptions_merge: primary_id required");
  if (!Array.isArray(i.dupe_ids)) throw new Error("subscriptions_merge: dupe_ids required");
  const ctx = getTurnContext();
  // confirm primary exists & belongs to user before merging
  const primary = await getSubscriptionById(i.primary_id, ctx.userId);
  if (!primary) throw new Error("subscriptions_merge: primary not found");
  return mergeSubscriptions(i.primary_id, i.dupe_ids, ctx.userId);
}
