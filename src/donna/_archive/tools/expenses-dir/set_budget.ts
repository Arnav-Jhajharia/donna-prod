import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../../brain.js";
import { getTurnContext } from "../../context.js";
import { upsertBudget } from "../../expenses/goals.js";

interface SetBudgetInput {
  monthly_total_cents?: number;
  daily_total_cents?: number;
  per_category_monthly_cents?: Record<string, number>;
  currency?: string;
  proactive_nudges?: boolean;
  timezone?: string;
  notes?: string;
}

export const setBudgetTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "set_budget",
  description: `upsert the user's monthly/daily budget targets. only set the fields the user mentioned — leave the rest unchanged.

inputs (all optional, but at least one should be set):
- monthly_total_cents: overall monthly cap (e.g. $3000 → 300000).
- daily_total_cents: optional daily ceiling.
- per_category_monthly_cents: { food: 30000, transport: 15000, ... } — keys are free-form categories matching what you use in log_expense.
- currency: ISO code. default USD.
- proactive_nudges: true to receive "you're at 80% of food this month" style nudges. default true.
- timezone: IANA tz for day boundaries. default Asia/Singapore.

returns the upserted row.`,
  input_schema: {
    type: "object",
    properties: {
      monthly_total_cents: { type: "number" },
      daily_total_cents: { type: "number" },
      per_category_monthly_cents: { type: "object" },
      currency: { type: "string" },
      proactive_nudges: { type: "boolean" },
      timezone: { type: "string" },
      notes: { type: "string" },
    },
  },
  modes: new Set<BrainMode>(["reactive"]),
};

export async function setBudgetHandler(input: unknown): Promise<unknown> {
  const i = (input ?? {}) as SetBudgetInput;
  const ctx = getTurnContext();
  const row = await upsertBudget({
    userId: ctx.userId,
    monthlyTotalCents: i.monthly_total_cents,
    dailyTotalCents: i.daily_total_cents,
    perCategoryMonthlyCents: i.per_category_monthly_cents,
    currency: i.currency,
    proactiveNudges: i.proactive_nudges,
    timezone: i.timezone,
    notes: i.notes,
  });
  return row;
}
