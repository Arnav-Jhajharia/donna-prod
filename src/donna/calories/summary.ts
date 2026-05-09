// daily / weekly aggregate queries. totals are recomputed on every read; the
// data volume here is small per user.

import { getSql } from "../db.js";
import { getGoal } from "./goals.js";
import type { DailySummary, FoodGoalRow, MealRow } from "./types.js";

function isoDate(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
}

function delta(
  totals: DailySummary["totals"],
  goal: FoodGoalRow,
): NonNullable<DailySummary["delta"]> {
  return {
    kcal: (goal.daily_kcal ?? 0) - totals.kcal,
    protein_g: (goal.daily_protein_g ?? 0) - totals.protein_g,
    carbs_g: (goal.daily_carbs_g ?? 0) - totals.carbs_g,
    fat_g: (goal.daily_fat_g ?? 0) - totals.fat_g,
  };
}

export async function getDailySummary(args: {
  userId: string;
  date?: string;
}): Promise<DailySummary> {
  const sql = getSql();
  const goal = await getGoal(args.userId);
  const tz = goal?.timezone ?? "Asia/Singapore";
  const date = args.date ?? isoDate(new Date(), tz);

  const meals = await sql<MealRow[]>`
    select * from meals
    where user_id = ${args.userId}
      and not is_deleted
      and date(occurred_at at time zone ${tz}) = ${date}::date
    order by occurred_at asc
  `;

  const totals = meals.reduce(
    (acc, m) => ({
      kcal: acc.kcal + Number(m.total_kcal),
      protein_g: acc.protein_g + Number(m.total_protein_g),
      carbs_g: acc.carbs_g + Number(m.total_carbs_g),
      fat_g: acc.fat_g + Number(m.total_fat_g),
      fiber_g: acc.fiber_g + Number(m.total_fiber_g),
      sodium_mg: acc.sodium_mg + Number(m.total_sodium_mg),
    }),
    { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, sodium_mg: 0 },
  );

  return {
    date,
    totals,
    goal,
    delta: goal ? delta(totals, goal) : null,
    meals: meals.map((m) => ({
      id: m.id,
      occurred_at: new Date(m.occurred_at).toISOString(),
      meal_type: m.meal_type,
      summary: (m.raw_input ?? m.vision_description ?? "").slice(0, 60),
      kcal: Number(m.total_kcal),
      confidence: m.confidence,
    })),
  };
}

export async function getMealHistory(args: {
  userId: string;
  start: string;
  end: string;
}): Promise<MealRow[]> {
  const sql = getSql();
  const goal = await getGoal(args.userId);
  const tz = goal?.timezone ?? "Asia/Singapore";
  return await sql<MealRow[]>`
    select * from meals
    where user_id = ${args.userId}
      and not is_deleted
      and date(occurred_at at time zone ${tz}) between ${args.start}::date and ${args.end}::date
    order by occurred_at asc
  `;
}
