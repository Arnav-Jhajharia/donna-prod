// meals + meal_items repository. all writes are transactional; totals on the
// meals row are denormalized from sum(meal_items) and recomputed inside
// insertMeal / updateMeal.

import { getSql } from "../db.js";
import type {
  Confidence,
  MealItemInput,
  MealItemRow,
  MealRow,
  MealSource,
  MealType,
  Parser,
} from "./types.js";

interface InsertMealArgs {
  userId: string;
  occurredAt: Date;
  mealType: MealType | null;
  sourceKind: MealSource;
  sourceMessageId: string | null;
  rawInput: string | null;
  visionDescription: string | null;
  confidence: Confidence;
  parser: Parser;
  notes?: string | null;
  items: MealItemInput[];
}

interface Totals {
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
  sodium_mg: number;
}

function sumItems(items: MealItemInput[]): Totals {
  return items.reduce<Totals>(
    (acc, it) => ({
      kcal: acc.kcal + (it.kcal ?? 0),
      protein_g: acc.protein_g + (it.protein_g ?? 0),
      carbs_g: acc.carbs_g + (it.carbs_g ?? 0),
      fat_g: acc.fat_g + (it.fat_g ?? 0),
      fiber_g: acc.fiber_g + (it.fiber_g ?? 0),
      sodium_mg: acc.sodium_mg + (it.sodium_mg ?? 0),
    }),
    { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, sodium_mg: 0 },
  );
}

function rowsForItems(mealId: string, items: MealItemInput[]) {
  return items.map((it, i) => ({
    meal_id: mealId,
    position: i,
    name: it.name,
    quantity: it.quantity ?? null,
    unit: it.unit ?? null,
    serving_grams: it.serving_grams ?? null,
    kcal: it.kcal,
    protein_g: it.protein_g,
    carbs_g: it.carbs_g,
    fat_g: it.fat_g,
    fiber_g: it.fiber_g ?? 0,
    sodium_mg: it.sodium_mg ?? 0,
    nix_id: it.nix_id ?? null,
    fdc_id: it.fdc_id ?? null,
  }));
}

export async function insertMeal(args: InsertMealArgs): Promise<MealRow> {
  const sql = getSql();
  const totals = sumItems(args.items);
  return await sql.begin(async (tx) => {
    const [meal] = await tx<MealRow[]>`
      insert into meals (
        user_id, occurred_at, meal_type, source_kind, source_message_id,
        raw_input, vision_description,
        total_kcal, total_protein_g, total_carbs_g,
        total_fat_g, total_fiber_g, total_sodium_mg,
        confidence, parser, notes
      ) values (
        ${args.userId}, ${args.occurredAt}, ${args.mealType}, ${args.sourceKind}, ${args.sourceMessageId},
        ${args.rawInput}, ${args.visionDescription},
        ${totals.kcal}, ${totals.protein_g}, ${totals.carbs_g},
        ${totals.fat_g}, ${totals.fiber_g}, ${totals.sodium_mg},
        ${args.confidence}, ${args.parser}, ${args.notes ?? null}
      )
      returning *
    `;
    if (!meal) throw new Error("insert_meal: insert returned no row");
    if (args.items.length > 0) {
      const rows = rowsForItems(meal.id, args.items);
      await tx`insert into meal_items ${tx(rows)}`;
    }
    return meal;
  }) as MealRow;
}

interface UpdateMealPatch {
  occurredAt?: Date;
  mealType?: MealType | null;
  rawInput?: string | null;
  items?: MealItemInput[];
  confidence?: Confidence;
  parser?: Parser;
  notes?: string | null;
}

export async function updateMeal(
  mealId: string,
  userId: string,
  patch: UpdateMealPatch,
): Promise<MealRow> {
  const sql = getSql();
  return await sql.begin(async (tx) => {
    const [existing] = await tx<MealRow[]>`
      select * from meals
       where id = ${mealId} and user_id = ${userId} and not is_deleted
    `;
    if (!existing) throw new Error("update_meal: meal not found");

    const items = patch.items ?? null;
    if (items) {
      await tx`delete from meal_items where meal_id = ${mealId}`;
      if (items.length > 0) {
        const rows = rowsForItems(mealId, items);
        await tx`insert into meal_items ${tx(rows)}`;
      }
    }

    const totals: Totals = items
      ? sumItems(items)
      : {
          kcal: Number(existing.total_kcal),
          protein_g: Number(existing.total_protein_g),
          carbs_g: Number(existing.total_carbs_g),
          fat_g: Number(existing.total_fat_g),
          fiber_g: Number(existing.total_fiber_g),
          sodium_mg: Number(existing.total_sodium_mg),
        };

    const [updated] = await tx<MealRow[]>`
      update meals set
        occurred_at = coalesce(${patch.occurredAt ?? null}, occurred_at),
        meal_type   = coalesce(${patch.mealType ?? null}, meal_type),
        raw_input   = coalesce(${patch.rawInput ?? null}, raw_input),
        confidence  = coalesce(${patch.confidence ?? null}, confidence),
        parser      = coalesce(${patch.parser ?? null}, parser),
        notes       = coalesce(${patch.notes ?? null}, notes),
        total_kcal      = ${totals.kcal},
        total_protein_g = ${totals.protein_g},
        total_carbs_g   = ${totals.carbs_g},
        total_fat_g     = ${totals.fat_g},
        total_fiber_g   = ${totals.fiber_g},
        total_sodium_mg = ${totals.sodium_mg},
        updated_at  = now()
      where id = ${mealId}
      returning *
    `;
    return updated;
  }) as MealRow;
}

export async function softDeleteMeal(
  mealId: string,
  userId: string,
): Promise<void> {
  const sql = getSql();
  await sql`
    update meals set is_deleted = true, updated_at = now()
     where id = ${mealId} and user_id = ${userId}
  `;
}

export async function getMostRecentMeal(
  userId: string,
): Promise<MealRow | null> {
  const sql = getSql();
  const rows = await sql<MealRow[]>`
    select * from meals
     where user_id = ${userId} and not is_deleted
     order by occurred_at desc
     limit 1
  `;
  return rows[0] ?? null;
}

export async function getMealItems(mealId: string): Promise<MealItemRow[]> {
  const sql = getSql();
  return await sql<MealItemRow[]>`
    select * from meal_items where meal_id = ${mealId} order by position asc
  `;
}
