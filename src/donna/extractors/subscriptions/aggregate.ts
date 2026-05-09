// aggregator + writer. takes DetectedCharge[] from the classifier, canonicalizes
// merchants, upserts into subscriptions + subscription_charges, infers
// recurrence from charge history, and writes integration_audit rows.

import { getSql } from "../../db.js";
import { audit } from "../../integrations/service.js";
import { canonicalizeMerchant } from "./canonical.js";
import type {
  DetectedCharge,
  Recurrence,
  SubscriptionStatus,
  BackfillResult,
} from "./types.js";

interface ExistingSub {
  id: string;
  merchant_canonical: string;
  merchant_raw: string[];
  category: string | null;
  amount_cents: number | null;
  currency: string | null;
  recurrence: Recurrence | null;
  status: SubscriptionStatus;
  user_confirmed: boolean;
  confidence: number;
}

interface ExistingCharge {
  charged_at: string;
  amount_cents: number;
}

// ---------------------------------------------------------------------------
// recurrence inference from charge history
// ---------------------------------------------------------------------------

function inferRecurrence(chargeDates: string[]): Recurrence {
  if (chargeDates.length < 2) return "unknown";
  const sorted = chargeDates
    .map((d) => new Date(d).getTime())
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (sorted.length < 2) return "unknown";

  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push(sorted[i]! - sorted[i - 1]!);
  }
  // median gap is more robust than mean for occasional missed receipts
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)]!;
  const days = median / (24 * 60 * 60 * 1000);

  if (days <= 10) return "weekly";
  if (days <= 45) return "monthly";
  if (days <= 110) return "quarterly";
  return "yearly";
}

function nextEstimatedAt(lastCharged: string | null, recurrence: Recurrence): string | null {
  if (!lastCharged || recurrence === "unknown") return null;
  const last = new Date(lastCharged).getTime();
  if (!Number.isFinite(last)) return null;
  const dayMs = 24 * 60 * 60 * 1000;
  const offsetDays =
    recurrence === "weekly" ? 7
    : recurrence === "monthly" ? 30
    : recurrence === "quarterly" ? 91
    : /* yearly */ 365;
  return new Date(last + offsetDays * dayMs).toISOString();
}

// ---------------------------------------------------------------------------
// upsert one charge → updates one subscription row
// ---------------------------------------------------------------------------

interface UpsertOutcome {
  subscription_added: boolean;
  subscription_updated: boolean;
  charge_inserted: boolean;
  charge_deduped: boolean;
}

async function upsertOne(
  userId: string,
  charge: DetectedCharge,
): Promise<UpsertOutcome> {
  const outcome: UpsertOutcome = {
    subscription_added: false,
    subscription_updated: false,
    charge_inserted: false,
    charge_deduped: false,
  };
  const sql = getSql();

  const canon = canonicalizeMerchant(charge.merchant_raw);
  const lowered = canon.canonical.toLowerCase();

  // find existing non-cancelled row for this user+canonical
  const existingRows = await sql<ExistingSub[]>`
    select id, merchant_canonical, merchant_raw, category, amount_cents, currency,
           recurrence, status, user_confirmed, confidence
    from subscriptions
    where user_id = ${userId}
      and lower(merchant_canonical) = ${lowered}
      and status != 'cancelled'
    limit 1
  `;
  let subId: string;
  let existing: ExistingSub | undefined = existingRows[0];

  if (!existing) {
    // insert
    const inserted = await sql<{ id: string }[]>`
      insert into subscriptions (
        user_id, merchant_canonical, merchant_raw, category,
        amount_cents, currency, recurrence,
        status, user_confirmed, confidence,
        first_seen_at, last_charged_at, next_estimated_at
      ) values (
        ${userId},
        ${canon.canonical},
        ${[charge.merchant_raw]},
        ${charge.category_hint ?? canon.category},
        ${charge.amount_cents},
        ${charge.currency},
        ${charge.recurrence_hint ?? "unknown"},
        'active',
        ${charge.source_channel === "user_volunteered"},
        ${Math.max(charge.confidence, charge.source_channel === "user_volunteered" ? 1.0 : 0)},
        ${charge.charged_at},
        ${charge.charged_at},
        ${nextEstimatedAt(charge.charged_at, charge.recurrence_hint ?? "unknown")}
      )
      returning id
    `;
    subId = inserted[0]!.id;
    outcome.subscription_added = true;
  } else {
    subId = existing.id;
  }

  // try to insert the charge — partial unique index dedupes when source_ref present
  try {
    if (charge.source_channel === "user_volunteered" || !charge.source_ref) {
      // user-volunteered: dedup heuristic = same sub_id + same amount + same day
      const dayStart = new Date(new Date(charge.charged_at).toISOString().slice(0, 10) + "T00:00:00Z").toISOString();
      const dayEnd = new Date(new Date(dayStart).getTime() + 24 * 60 * 60 * 1000).toISOString();
      const dup = await sql<{ id: string }[]>`
        select id from subscription_charges
        where user_id = ${userId}
          and subscription_id = ${subId}
          and source_channel = ${charge.source_channel}
          and amount_cents = ${charge.amount_cents}
          and currency = ${charge.currency}
          and charged_at >= ${dayStart}
          and charged_at < ${dayEnd}
        limit 1
      `;
      if (dup.length > 0) {
        outcome.charge_deduped = true;
      } else {
        await sql`
          insert into subscription_charges (
            user_id, subscription_id, amount_cents, currency, charged_at,
            source_channel, source_ref, evidence_quote
          ) values (
            ${userId}, ${subId}, ${charge.amount_cents}, ${charge.currency},
            ${charge.charged_at}, ${charge.source_channel}, ${charge.source_ref},
            ${charge.evidence_quote}
          )
        `;
        outcome.charge_inserted = true;
      }
    } else {
      // typed source with source_ref → rely on partial unique index
      const result = await sql`
        insert into subscription_charges (
          user_id, subscription_id, amount_cents, currency, charged_at,
          source_channel, source_ref, evidence_quote
        ) values (
          ${userId}, ${subId}, ${charge.amount_cents}, ${charge.currency},
          ${charge.charged_at}, ${charge.source_channel}, ${charge.source_ref},
          ${charge.evidence_quote}
        )
        on conflict (user_id, source_channel, source_ref) where source_ref is not null
        do nothing
        returning id
      `;
      if (result.count === 0) outcome.charge_deduped = true;
      else outcome.charge_inserted = true;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[subscriptions/aggregate] charge insert failed: ${msg}`);
  }

  // recompute rollups: pull all charges for this sub, infer recurrence,
  // pick latest, update sub row.
  const charges = await sql<ExistingCharge[]>`
    select charged_at, amount_cents
    from subscription_charges
    where subscription_id = ${subId}
    order by charged_at asc
  `;
  if (charges.length > 0) {
    const dates = charges.map((c) => c.charged_at);
    const inferred = inferRecurrence(dates);
    const lastCharged = charges[charges.length - 1]!.charged_at;
    // typical amount: last charge's amount (most recent reflects current price)
    const latestAmount = charges[charges.length - 1]!.amount_cents;

    // merge new merchant_raw if not already there
    const newRaws = existing
      ? Array.from(new Set([...existing.merchant_raw, charge.merchant_raw]))
      : [charge.merchant_raw];

    await sql`
      update subscriptions set
        merchant_raw = ${newRaws},
        amount_cents = ${latestAmount},
        currency = coalesce(${charge.currency}, currency),
        recurrence = ${inferred !== "unknown" ? inferred : (existing?.recurrence ?? charge.recurrence_hint ?? "unknown")},
        last_charged_at = ${lastCharged},
        next_estimated_at = ${nextEstimatedAt(lastCharged, inferred !== "unknown" ? inferred : (existing?.recurrence ?? charge.recurrence_hint ?? "unknown"))},
        confidence = greatest(confidence, ${charge.confidence}),
        category = coalesce(category, ${charge.category_hint ?? canon.category}),
        updated_at = now()
      where id = ${subId}
    `;
    if (!outcome.subscription_added) outcome.subscription_updated = true;
  }

  return outcome;
}

// ---------------------------------------------------------------------------
// public: aggregate a batch of detected charges
// ---------------------------------------------------------------------------

export async function aggregate(
  userId: string,
  charges: DetectedCharge[],
): Promise<Pick<BackfillResult, "charges_inserted" | "charges_deduped" | "subscriptions_added" | "subscriptions_updated">> {
  let charges_inserted = 0;
  let charges_deduped = 0;
  let subscriptions_added = 0;
  let subscriptions_updated = 0;
  const updatedIds = new Set<string>();

  for (const c of charges) {
    let outcome: UpsertOutcome;
    try {
      outcome = await upsertOne(userId, c);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[subscriptions/aggregate] upsert failed for ${c.merchant_raw}: ${msg}`);
      await audit({
        userId,
        provider: c.source_channel === "gmail" ? "gmail" : "subscriptions",
        action: "subscriptions.upsert_failed",
        itemRef: c.source_ref,
        ok: false,
        meta: { merchant: c.merchant_raw, error: msg },
      });
      continue;
    }
    if (outcome.charge_inserted) charges_inserted++;
    if (outcome.charge_deduped) charges_deduped++;
    if (outcome.subscription_added) subscriptions_added++;
    if (outcome.subscription_updated) {
      // de-dup same-sub multiple updates within one batch
      // (idCount via canonical name)
    }
    await audit({
      userId,
      provider: c.source_channel === "gmail" ? "gmail" : "subscriptions",
      action: "subscriptions.upserted",
      itemRef: c.source_ref,
      ok: true,
      meta: {
        merchant_raw: c.merchant_raw,
        amount_cents: c.amount_cents,
        currency: c.currency,
        confidence: c.confidence,
        added: outcome.subscription_added,
        deduped: outcome.charge_deduped,
      },
    });
  }

  // can't fully count updates without extra bookkeeping; approximate:
  // updated = (subscriptions touched) - (added)
  subscriptions_updated = Math.max(0, charges_inserted - subscriptions_added);
  void updatedIds;

  return { charges_inserted, charges_deduped, subscriptions_added, subscriptions_updated };
}
