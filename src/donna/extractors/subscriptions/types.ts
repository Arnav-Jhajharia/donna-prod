// shared types for the subscriptions detector pipeline. source-agnostic by
// design: gmail today, user-volunteered today, bank/paypal/imessage later.

export type SubscriptionSource =
  | "gmail"
  | "user_volunteered"
  | "bank"
  | "paypal"
  | "imessage";

export type Recurrence =
  | "monthly"
  | "yearly"
  | "weekly"
  | "quarterly"
  | "unknown";

export type SubscriptionStatus = "active" | "cancelled" | "paused" | "uncertain";

// raw input from a source adapter — minimal common shape. each adapter fills
// what it can; classifier reads the union and decides.
export interface Candidate {
  source_channel: SubscriptionSource;
  source_ref: string | null;
  raw: {
    from?: string;
    subject?: string;
    body?: string;
    ts?: string;
    [k: string]: unknown;
  };
}

// classifier output: a charge instance (real or proposed).
export interface DetectedCharge {
  merchant_raw: string;
  amount_cents: number;
  currency: string;
  charged_at: string;                       // iso 8601
  evidence_quote: string;                   // ≤ 280 chars; the line we matched on
  recurrence_hint?: Recurrence | null;
  category_hint?: string | null;
  confidence: number;                       // 0..1
  // back-pointer so the aggregator can audit + dedup
  source_channel: SubscriptionSource;
  source_ref: string | null;
}

// a row in `subscriptions` with charges count and totals — what tools return.
export interface SubscriptionView {
  id: string;
  user_id: string;
  merchant_canonical: string;
  merchant_raw: string[];
  category: string | null;
  amount_cents: number | null;
  currency: string | null;
  recurrence: Recurrence | null;
  status: SubscriptionStatus;
  user_confirmed: boolean;
  confidence: number;
  first_seen_at: string;
  last_charged_at: string | null;
  next_estimated_at: string | null;
  notes: string | null;
  charges_count?: number;
  created_at: string;
  updated_at: string;
}

export interface BackfillResult {
  scanned: number;            // total candidates the source adapter emitted
  classified_yes: number;     // candidates the classifier accepted
  classified_no: number;      // candidates rejected
  charges_inserted: number;
  charges_deduped: number;
  subscriptions_added: number;
  subscriptions_updated: number;
  haiku_calls: number;
  duration_ms: number;
}
