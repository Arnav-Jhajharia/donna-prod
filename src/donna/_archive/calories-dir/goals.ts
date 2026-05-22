// food_goals repo. one row per user; upserted on every set_food_goal call.

import { getSql } from "../db.js";
import type { FoodGoalRow, GoalKind } from "./types.js";

export interface UpsertGoalArgs {
  userId: string;
  goalKind?: GoalKind;
  dailyKcal?: number;
  dailyProteinG?: number;
  dailyCarbsG?: number;
  dailyFatG?: number;
  dailyFiberG?: number;
  notes?: string;
  proactiveNudges?: boolean;
  timezone?: string;
}

export async function upsertGoal(args: UpsertGoalArgs): Promise<FoodGoalRow> {
  const sql = getSql();
  const [row] = await sql<FoodGoalRow[]>`
    insert into food_goals (
      user_id, goal_kind, daily_kcal, daily_protein_g, daily_carbs_g,
      daily_fat_g, daily_fiber_g, notes, proactive_nudges, timezone
    ) values (
      ${args.userId},
      ${args.goalKind ?? "maintain"},
      ${args.dailyKcal ?? null},
      ${args.dailyProteinG ?? null},
      ${args.dailyCarbsG ?? null},
      ${args.dailyFatG ?? null},
      ${args.dailyFiberG ?? null},
      ${args.notes ?? null},
      ${args.proactiveNudges ?? true},
      ${args.timezone ?? "Asia/Singapore"}
    )
    on conflict (user_id) do update set
      goal_kind        = coalesce(${args.goalKind ?? null}, food_goals.goal_kind),
      daily_kcal       = coalesce(${args.dailyKcal ?? null}, food_goals.daily_kcal),
      daily_protein_g  = coalesce(${args.dailyProteinG ?? null}, food_goals.daily_protein_g),
      daily_carbs_g    = coalesce(${args.dailyCarbsG ?? null}, food_goals.daily_carbs_g),
      daily_fat_g      = coalesce(${args.dailyFatG ?? null}, food_goals.daily_fat_g),
      daily_fiber_g    = coalesce(${args.dailyFiberG ?? null}, food_goals.daily_fiber_g),
      notes            = coalesce(${args.notes ?? null}, food_goals.notes),
      proactive_nudges = coalesce(${args.proactiveNudges ?? null}, food_goals.proactive_nudges),
      timezone         = coalesce(${args.timezone ?? null}, food_goals.timezone),
      updated_at       = now()
    returning *
  `;
  if (!row) throw new Error("upsert_goal: insert returned no row");
  return row;
}

export async function getGoal(userId: string): Promise<FoodGoalRow | null> {
  const sql = getSql();
  const rows = await sql<FoodGoalRow[]>`
    select * from food_goals where user_id = ${userId}
  `;
  return rows[0] ?? null;
}
