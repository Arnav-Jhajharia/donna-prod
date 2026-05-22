// Subscription tracker — shared types.
// One slice of a future expense-tracker feature; not the whole thing.

export type SubscriptionStatus =
  | "active"
  | "paused"
  | "failed"
  | "cancelled"
  | "trial"
  | "unknown";

export type SubscriptionRecurrence =
  | "monthly"
  | "yearly"
  | "weekly"
  | "quarterly"
  | "custom"
  | "one_off";

export type SubscriptionSourceKind =
  | "gmail_scan"
  | "manual"
  | "onboarding"
  | "agenda";

export type SubscriptionEventKind =
  | "welcome"
  | "receipt"
  | "renewal_reminder"
  | "failed"
  | "paused"
  | "cancelled"
  | "manual_record";

export interface Subscription {
  id: string;
  user_id: string;
  vendor_canonical: string;
  vendor_raw: string | null;
  status: SubscriptionStatus;
  recurrence: SubscriptionRecurrence | null;
  amount_cents: number | null;
  monthly_amount_cents: number | null;
  currency: string | null;
  category: string | null;
  first_seen_at: string | null;
  last_charge_at: string | null;
  next_renewal_at: string | null;
  source_kind: SubscriptionSourceKind;
  user_confirmed: boolean;
  notes: string | null;
  is_deleted: boolean;
  created_at: string;
  updated_at: string;
}

export interface SubscriptionEvent {
  id: string;
  subscription_id: string;
  user_id: string;
  event_kind: SubscriptionEventKind;
  amount_cents: number | null;
  currency: string | null;
  occurred_at: string;
  source_kind: "gmail" | "manual";
  source_ref: string | null;
  raw_subject: string | null;
  raw_snippet: string | null;
  created_at: string;
}

export interface Agenda {
  id: string;
  user_id: string;
  kind: string;
  status: "active" | "completed" | "abandoned" | "blocked";
  current_step: string;
  payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface BackfillRow {
  id: string;
  user_id: string;
  agenda_id: string | null;
  status: "pending" | "running" | "done" | "error";
  lookback_days: number;
  detected_count: number;
  scanned_count: number;
  total_monthly_amount_cents: number;
  last_error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}
