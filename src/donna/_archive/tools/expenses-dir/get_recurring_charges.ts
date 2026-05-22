import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../../brain.js";
import { getTurnContext } from "../../context.js";
import { detectRecurringCharges } from "../../expenses/summary.js";

const PTC_CALLER = "code_execution_20250825" as const;

export const getRecurringChargesTool: Tool & {
  modes: ReadonlySet<BrainMode>;
} = {
  name: "get_recurring_charges",
  description: `detected recurring charges (subscriptions) over the user's expense history. detection looks for ≥3 charges from the same merchant at weekly/monthly/quarterly/yearly cadence with stable amounts (±15%).

returns: array of {merchant, recurrence, estimated_amount_cents, last_charged_at, occurrences, category}, sorted by estimated_amount_cents desc.

note: this is a derived view — there is no separate subscriptions table. as a side effect, matching expenses get is_recurring=true so subsequent reads are cheaper.

call this for "what am i paying for monthly", "show me my subscriptions", "what subs can i cancel".`,
  input_schema: { type: "object", properties: {} },
  allowed_callers: [PTC_CALLER],
  modes: new Set<BrainMode>(["reactive", "proactive"]),
};

export async function getRecurringChargesHandler(
  _input: unknown,
): Promise<unknown> {
  const ctx = getTurnContext();
  const charges = await detectRecurringCharges(ctx.userId);
  return { charges, count: charges.length };
}
