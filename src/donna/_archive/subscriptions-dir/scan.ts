// gmail backfill: scan a user's inbox for subscription signals and persist
// to subscriptions + subscription_events. metadata-first — we match on
// SUBJECT only (snippets leak unrelated content) and dedupe events by
// gmail message_id.
//
// signal types per message:
//   welcome | receipt | renewal_reminder | failed | paused | cancelled
//
// vendor status is derived per (user, vendor) from event precedence:
//   cancelled > paused > failed > active > trial > unknown
// recomputed at the end of the scan.

import { Composio } from "@composio/core";
import { readState } from "../integrations/service.js";
import { canonicalizeVendor, extractDomain } from "./canonical.js";
import {
  upsertSubscription,
  recordEvent,
  updateBackfill,
} from "./storage.js";
import type {
  SubscriptionEventKind,
  SubscriptionStatus,
} from "./types.js";

const PROVIDER = "gmail";
const PAGE_SIZE = 25;

let _composio: Composio | null = null;
function getComposio(): Composio {
  if (_composio) return _composio;
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) throw new Error("COMPOSIO_API_KEY not set");
  _composio = new Composio({ apiKey });
  return _composio;
}

interface RawGmailMessage {
  messageId?: string;
  threadId?: string;
  sender?: string;
  subject?: string;
  messageTimestamp?: string;
  labelIds?: string[];
}

// gating: subject must mention at least one of these keywords for us to
// bother classifying. eliminates 99% of newsletter noise.
const SUBJECT_GATE =
  /\b(subscription|invoice|receipt|payment|billing|charged|renew|cancel|paused|suspended|activate|welcome|confirm|order|plan|membership|verify|trial|reactivate|auto.?renew)\b/i;

const PATTERNS: Array<{ kind: SubscriptionEventKind; re: RegExp }> = [
  { kind: "cancelled",        re: /\b(your (plan|subscription|recurring payment|order|membership) (will be |has been )?cancel(l?ed)?|cancellation (notification|confirmation)|we'?ve cancel(l?ed)?|unsubscribed from)\b/i },
  { kind: "paused",           re: /\b(subscription access.*(paused|suspended)|access has been (paused|suspended)|(account|subscription) (has been )?(paused|suspended)|temporarily paused|on hold)\b/i },
  { kind: "failed",           re: /\b(payment (failed|unsuccessful|declined|couldn'?t|didn'?t|issue|wasn'?t)|update.*billing|update.*payment method|transaction declined|reactivate.*(billing|workspace|account)|your products are at risk)\b/i },
  { kind: "renewal_reminder", re: /\b(renews? (in|on)|renewal (reminder|on)|upcoming (invoice|renewal|charge)|will (be )?renew|next (billing|charge|payment)|auto.?renew)\b/i },
  { kind: "receipt",          re: /\b(receipt|invoice (available|is ready)|order (placed|confirmation)|thank you for (your )?(order|payment|purchase)|payment (received|successful)|here'?s your (order|receipt)|automatic payment.*(sent|paid))\b/i },
  { kind: "welcome",          re: /\b(welcome to|signing up|account.*(created|activated)|get(ting)? started|activate your|magic link|confirmation code)\b/i },
];

function classifyMessage(subject: string): SubscriptionEventKind | null {
  if (!SUBJECT_GATE.test(subject)) return null;
  for (const { kind, re } of PATTERNS) {
    if (re.test(subject)) return kind;
  }
  return null;
}

// status precedence: which event-kind wins
const STATUS_FROM_KIND: Record<SubscriptionEventKind, SubscriptionStatus> = {
  cancelled:        "cancelled",
  paused:           "paused",
  failed:           "failed",
  receipt:          "active",
  renewal_reminder: "active",
  welcome:          "trial",
  manual_record:    "unknown",
};

const STATUS_RANK: Record<SubscriptionStatus, number> = {
  cancelled: 5,
  paused:    4,
  failed:    3,
  active:    2,
  trial:     1,
  unknown:   0,
};

// recurrence guess from subject patterns. yearly hints win over monthly.
function guessRecurrence(subject: string): "monthly" | "yearly" | null {
  if (/\b(annual|yearly|per year|\/year|\/yr)\b/i.test(subject)) return "yearly";
  if (/\b(monthly|per month|\/month|\/mo)\b/i.test(subject)) return "monthly";
  return null;
}

// money extractor. covers $X.YZ, ₹X, S$X, USD X, INR X, EUR/GBP.
function extractMoney(text: string): { amount_cents: number; currency: string } | null {
  const re = /(?:(USD|INR|SGD|EUR|GBP)\s*)?([₹$€£]|S\$|Rs\.?)\s?(\d{1,3}(?:[,]\d{3})*(?:\.\d{1,2})?)/i;
  const m = re.exec(text);
  if (!m) return null;
  const sym = m[2];
  let currency = m[1] ?? "";
  if (!currency) {
    if (sym === "₹" || sym === "Rs" || sym === "Rs.") currency = "INR";
    else if (sym === "S$") currency = "SGD";
    else if (sym === "$") currency = "USD";
    else if (sym === "€") currency = "EUR";
    else if (sym === "£") currency = "GBP";
  }
  const numeric = parseFloat(m[3]!.replace(/,/g, ""));
  if (!Number.isFinite(numeric)) return null;
  return { amount_cents: Math.round(numeric * 100), currency: currency || "USD" };
}

// fetch a single page from gmail via composio directly. bypasses
// integrations/service.executeForUser (which requires turn context) so we
// can be called from a detached backfill promise. audit happens at the
// backfill row level instead.
async function fetchPage(
  composioAccountId: string,
  query: string,
  pageToken: string | null,
): Promise<{ messages: RawGmailMessage[]; nextPageToken: string | null }> {
  const composio = getComposio();
  const args: Record<string, unknown> = { query, max_results: PAGE_SIZE };
  if (pageToken) args.page_token = pageToken;
  const resp = (await composio.tools.execute("GMAIL_FETCH_EMAILS", {
    userId: composioAccountId,
    dangerouslySkipVersionCheck: true,
    arguments: args,
  } as never)) as {
    successful?: boolean;
    data?: { messages?: RawGmailMessage[]; nextPageToken?: string };
    error?: unknown;
  };
  if (resp.successful === false) {
    throw new Error(`composio GMAIL_FETCH_EMAILS failed: ${JSON.stringify(resp.error)}`);
  }
  return {
    messages: resp.data?.messages ?? [],
    nextPageToken: resp.data?.nextPageToken ?? null,
  };
}

interface ScanArgs {
  userId: string;
  lookbackDays?: number;
  backfillId?: string;
}

export interface ScanResult {
  detected_count: number;
  scanned_count: number;
  total_monthly_amount_cents: number;
  by_status: Record<SubscriptionStatus, number>;
}

export async function scanGmailForSubscriptions(args: ScanArgs): Promise<ScanResult> {
  const lookbackDays = Math.max(1, Math.min(args.lookbackDays ?? 180, 730));
  const state = await readState(args.userId, PROVIDER);
  if (!state) throw new Error(`gmail not configured for user ${args.userId}`);
  if (state.status !== "connected") throw new Error(`gmail status=${state.status}`);
  if (!state.composio_account_id) throw new Error(`gmail: missing composio_account_id`);
  const composioAccountId = state.composio_account_id;

  if (args.backfillId) {
    await updateBackfill(args.backfillId, {
      status: "running",
      started_at: new Date().toISOString(),
    });
  }

  // monthly chunks. older chunks first so the user sees the modern stuff
  // ranked correctly when we recompute status at the end (latest event wins).
  const now = new Date();
  const months: Array<{ after: string; before: string; label: string }> = [];
  const monthsBack = Math.ceil(lookbackDays / 30);
  for (let i = monthsBack - 1; i >= 0; i--) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i + 1, 1));
    const after = `${start.getUTCFullYear()}/${String(start.getUTCMonth() + 1).padStart(2, "0")}/01`;
    const before = `${end.getUTCFullYear()}/${String(end.getUTCMonth() + 1).padStart(2, "0")}/01`;
    months.push({ after, before, label: after.slice(0, 7) });
  }

  // accumulate per-vendor evidence as we sweep, then upsert at the end.
  interface VendorAccum {
    vendor_canonical: string;
    vendor_raw: string;
    category: string;
    events: Array<{
      kind: SubscriptionEventKind;
      occurred_at: string;
      source_ref: string;
      raw_subject: string;
      amount_cents?: number;
      currency?: string;
    }>;
    recurrence_hint: "monthly" | "yearly" | null;
  }
  const accum = new Map<string, VendorAccum>();
  let scanned = 0;

  for (const m of months) {
    const query = `after:${m.after} before:${m.before}`;
    let pageToken: string | null = null;
    // hard cap on pages per month so a pathological inbox can't run forever
    let safety = 200;
    while (safety-- > 0) {
      const { messages, nextPageToken } = await fetchPage(composioAccountId, query, pageToken);
      scanned += messages.length;
      for (const msg of messages) {
        const subj = msg.subject ?? "";
        const kind = classifyMessage(subj);
        if (!kind) continue;
        const sender = msg.sender ?? "";
        const { name, category } = canonicalizeVendor(sender);
        const key = name;
        if (!accum.has(key)) {
          accum.set(key, {
            vendor_canonical: name,
            vendor_raw: extractDomain(sender),
            category,
            events: [],
            recurrence_hint: null,
          });
        }
        const v = accum.get(key)!;
        const money = extractMoney(subj);
        v.events.push({
          kind,
          occurred_at: msg.messageTimestamp ?? new Date().toISOString(),
          source_ref: msg.messageId ?? "",
          raw_subject: subj,
          amount_cents: money?.amount_cents,
          currency: money?.currency,
        });
        const rec = guessRecurrence(subj);
        if (rec && !v.recurrence_hint) v.recurrence_hint = rec;
      }
      pageToken = nextPageToken;
      if (!pageToken) break;
    }
  }

  // upsert + insert events, derive status
  const byStatus: Record<SubscriptionStatus, number> = {
    cancelled: 0, paused: 0, failed: 0, active: 0, trial: 0, unknown: 0,
  };
  let totalMonthlyCents = 0;

  for (const v of accum.values()) {
    // pick the dominant status by precedence over the latest event of each kind.
    const latestByKind = new Map<SubscriptionEventKind, typeof v.events[number]>();
    for (const e of v.events) {
      const cur = latestByKind.get(e.kind);
      if (!cur || e.occurred_at > cur.occurred_at) latestByKind.set(e.kind, e);
    }
    let chosenStatus: SubscriptionStatus = "unknown";
    let chosenDate = "";
    for (const e of latestByKind.values()) {
      const s = STATUS_FROM_KIND[e.kind];
      if (STATUS_RANK[s] > STATUS_RANK[chosenStatus]) {
        chosenStatus = s;
        chosenDate = e.occurred_at;
      } else if (
        STATUS_RANK[s] === STATUS_RANK[chosenStatus] &&
        e.occurred_at > chosenDate
      ) {
        chosenDate = e.occurred_at;
      }
    }

    // pick the latest known amount as the "monthly_amount" baseline.
    // (refinement: yearly recurrence → divide by 12)
    const withMoney = v.events.filter((e) => e.amount_cents).sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
    let amountCents: number | null = withMoney[0]?.amount_cents ?? null;
    let currency: string | null = withMoney[0]?.currency ?? null;
    let monthlyAmountCents: number | null = null;
    if (amountCents !== null) {
      monthlyAmountCents = v.recurrence_hint === "yearly" ? Math.round(amountCents / 12) : amountCents;
    }

    const occurredDates = v.events.map((e) => e.occurred_at).sort();
    const firstSeen = occurredDates[0] ?? null;
    const lastSeen = occurredDates[occurredDates.length - 1] ?? null;

    const sub = await upsertSubscription({
      userId: args.userId,
      vendor_canonical: v.vendor_canonical,
      vendor_raw: v.vendor_raw,
      status: chosenStatus,
      recurrence: v.recurrence_hint,
      amount_cents: amountCents,
      monthly_amount_cents: monthlyAmountCents,
      currency,
      category: v.category,
      first_seen_at: firstSeen,
      last_charge_at: lastSeen,
      source_kind: "gmail_scan",
    });

    for (const e of v.events) {
      await recordEvent({
        subscription_id: sub.id,
        user_id: args.userId,
        event_kind: e.kind,
        amount_cents: e.amount_cents ?? null,
        currency: e.currency ?? null,
        occurred_at: e.occurred_at,
        source_kind: "gmail",
        source_ref: e.source_ref || null,
        raw_subject: e.raw_subject,
      });
    }

    byStatus[chosenStatus]++;
    if (chosenStatus === "active" && monthlyAmountCents) {
      totalMonthlyCents += monthlyAmountCents;
    }
  }

  const result: ScanResult = {
    detected_count: accum.size,
    scanned_count: scanned,
    total_monthly_amount_cents: totalMonthlyCents,
    by_status: byStatus,
  };

  if (args.backfillId) {
    await updateBackfill(args.backfillId, {
      status: "done",
      detected_count: result.detected_count,
      scanned_count: result.scanned_count,
      total_monthly_amount_cents: result.total_monthly_amount_cents,
      finished_at: new Date().toISOString(),
    });
  }

  return result;
}
