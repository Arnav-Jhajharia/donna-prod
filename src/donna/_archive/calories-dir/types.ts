// shared types for the calorie tracker domain. these match the schema 1:1
// where applicable; tool-input types live next to their tool files.

export type MealSource = "text" | "photo" | "voice" | "alias" | "edit";
export type MealType = "breakfast" | "lunch" | "dinner" | "snack";
export type Confidence = "high" | "medium" | "low";
export type Parser = "nutritionix" | "llm" | "mixed";
export type GoalKind = "cut" | "bulk" | "maintain" | "custom";

export interface MealItemInput {
  name: string;
  quantity?: number;
  unit?: string;
  serving_grams?: number;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g?: number;
  sodium_mg?: number;
  nix_id?: string;
  fdc_id?: string;
}

export interface MealItemRow extends MealItemInput {
  id: string;
  meal_id: string;
  position: number;
  fiber_g: number;
  sodium_mg: number;
}

export interface MealRow {
  id: string;
  user_id: string;
  occurred_at: Date;
  logged_at: Date;
  meal_type: MealType | null;
  source_kind: MealSource;
  source_message_id: string | null;
  raw_input: string | null;
  vision_description: string | null;
  total_kcal: number;
  total_protein_g: number;
  total_carbs_g: number;
  total_fat_g: number;
  total_fiber_g: number;
  total_sodium_mg: number;
  confidence: Confidence | null;
  parser: Parser | null;
  is_deleted: boolean;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface FoodGoalRow {
  user_id: string;
  goal_kind: GoalKind;
  daily_kcal: number | null;
  daily_protein_g: number | null;
  daily_carbs_g: number | null;
  daily_fat_g: number | null;
  daily_fiber_g: number | null;
  notes: string | null;
  active_from: Date;
  proactive_nudges: boolean;
  timezone: string;
}

export interface MealAliasRow {
  id: string;
  user_id: string;
  alias: string;
  template: MealItemInput[];
}

export interface DailySummary {
  date: string; // YYYY-MM-DD in user tz
  totals: {
    kcal: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
    fiber_g: number;
    sodium_mg: number;
  };
  goal: FoodGoalRow | null;
  delta: {
    kcal: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
  } | null;
  meals: Array<{
    id: string;
    occurred_at: string;
    meal_type: MealType | null;
    summary: string;
    kcal: number;
    confidence: Confidence | null;
  }>;
}
