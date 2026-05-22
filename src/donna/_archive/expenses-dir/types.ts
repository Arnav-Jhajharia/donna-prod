// shared types for the expense tracker domain. these match the schema 1:1
// where applicable; tool-input types live next to their tool files.
//
// subscriptions are not a separate type — they're expenses with is_recurring=true.

export type ExpenseSource =
  | "text"
  | "photo"
  | "voice"
  | "alias"
  | "edit"
  | "gmail"
  | "plaid";
export type Confidence = "high" | "medium" | "low";
export type Parser = "llm" | "user" | "gmail" | "plaid" | "mixed";
export type Recurrence = "weekly" | "monthly" | "quarterly" | "yearly";

export interface ExpenseItemInput {
  name: string;
  quantity?: number;
  unit?: string;
  amount_cents: number;
  category?: string;
  notes?: string;
}

export interface ExpenseItemRow extends ExpenseItemInput {
  id: string;
  expense_id: string;
  position: number;
}

export interface ExpenseRow {
  id: string;
  user_id: string;
  occurred_at: Date;
  logged_at: Date;
  merchant: string | null;
  amount_cents: number;
  currency: string;
  category: string | null;
  source_kind: ExpenseSource;
  source_message_id: string | null;
  raw_input: string | null;
  vision_description: string | null;
  confidence: Confidence | null;
  parser: Parser | null;
  is_recurring: boolean;
  recurrence: Recurrence | null;
  notes: string | null;
  is_deleted: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface ExpenseGoalRow {
  user_id: string;
  monthly_total_cents: number | null;
  daily_total_cents: number | null;
  per_category_monthly_cents: Record<string, number> | null;
  currency: string;
  notes: string | null;
  active_from: Date;
  proactive_nudges: boolean;
  timezone: string;
}

export interface ExpenseAliasRow {
  id: string;
  user_id: string;
  alias: string;
  template: ExpenseAliasTemplate;
}

// the snapshot saved when you say "this is my usual coffee" — replayed by
// log_expense_from_alias.
export interface ExpenseAliasTemplate {
  merchant?: string;
  amount_cents: number;
  currency?: string;
  category?: string;
  items?: ExpenseItemInput[];
  notes?: string;
}

export interface DailySpendSummary {
  date: string; // YYYY-MM-DD in user tz
  currency: string;
  total_cents: number;
  by_category: Record<string, number>; // category → cents
  goal: ExpenseGoalRow | null;
  delta: {
    daily_cents: number | null; // goal.daily_total - total. null if no daily cap.
    monthly_remaining_cents: number | null; // monthly cap - month-to-date
  } | null;
  expenses: Array<{
    id: string;
    occurred_at: string;
    merchant: string | null;
    amount_cents: number;
    category: string | null;
    confidence: Confidence | null;
  }>;
}

export interface MonthlySpendSummary {
  month: string; // YYYY-MM in user tz
  currency: string;
  total_cents: number;
  by_category: Record<string, number>;
  by_day: Record<string, number>; // YYYY-MM-DD → cents
  goal: ExpenseGoalRow | null;
  delta: {
    monthly_cents: number | null; // goal.monthly_total - total
    per_category: Record<string, number> | null; // category → remaining
  } | null;
  top_merchants: Array<{ merchant: string; total_cents: number; count: number }>;
}

export interface RecurringCharge {
  merchant: string;
  recurrence: Recurrence;
  estimated_amount_cents: number;
  last_charged_at: string;
  occurrences: number;
  category: string | null;
}
