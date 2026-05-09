import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../../brain.js";
import { getTurnContext } from "../../context.js";
import { upsertGoal } from "../../calories/goals.js";
import type { GoalKind } from "../../calories/types.js";

interface SetFoodGoalInput {
  goal_kind?: GoalKind;
  daily_kcal?: number;
  daily_protein_g?: number;
  daily_carbs_g?: number;
  daily_fat_g?: number;
  daily_fiber_g?: number;
  notes?: string;
  proactive_nudges?: boolean;
  timezone?: string;
}

export const setFoodGoalTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "set_food_goal",
  description: `upsert the user's daily food goal. one row per user.

call this when the user says "track me to 2200 a day", "i'm cutting, 180g protein", "stop nudging me about meals" (set proactive_nudges=false), or "switch me to los angeles time".

inputs (all optional, only what you set is changed):
- goal_kind: cut | bulk | maintain | custom.
- daily_kcal, daily_protein_g, daily_carbs_g, daily_fat_g, daily_fiber_g.
- notes: free text the model wants to remember about the goal.
- proactive_nudges: bool — turns daily check-ins on/off.
- timezone: iana zone, e.g. "America/Los_Angeles". default Asia/Singapore.

returns: the saved goal row.`,
  input_schema: {
    type: "object",
    properties: {
      goal_kind: { type: "string", enum: ["cut", "bulk", "maintain", "custom"] },
      daily_kcal: { type: "number" },
      daily_protein_g: { type: "number" },
      daily_carbs_g: { type: "number" },
      daily_fat_g: { type: "number" },
      daily_fiber_g: { type: "number" },
      notes: { type: "string" },
      proactive_nudges: { type: "boolean" },
      timezone: { type: "string" },
    },
  },
  modes: new Set<BrainMode>(["reactive"]),
};

export async function setFoodGoalHandler(input: unknown): Promise<unknown> {
  const i = (input ?? {}) as SetFoodGoalInput;
  const ctx = getTurnContext();
  const row = await upsertGoal({
    userId: ctx.userId,
    goalKind: i.goal_kind,
    dailyKcal: i.daily_kcal,
    dailyProteinG: i.daily_protein_g,
    dailyCarbsG: i.daily_carbs_g,
    dailyFatG: i.daily_fat_g,
    dailyFiberG: i.daily_fiber_g,
    notes: i.notes,
    proactiveNudges: i.proactive_nudges,
    timezone: i.timezone,
  });
  return { goal: row };
}
