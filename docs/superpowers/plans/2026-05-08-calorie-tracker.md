# Calorie Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build donna's first-class calorie tracker — multimodal logging (text/photo/voice), canonical macros from Nutritionix, dashboard-ready schema, daily summaries, weekly charts, and proactive meal nudges. Three-meal manual e2e is the v1 acceptance gate.

**Architecture:** Five new tables (`food_goals`, `meals`, `meal_items`, `meal_aliases`, `food_cache`). New tool group under `src/donna/tools/calories/` split into direct (write) and PTC (read). New Nutritionix REST client and OpenAI Whisper client. WhatsApp media plumbing already lives in `ingress/whatsapp.ts`; we wire those bytes into anthropic image content blocks at the dispatch layer. Linq media fetch added to `ingress/imessage.ts`. Charts via `chartjs-node-canvas` server-side, uploaded to supabase storage, sent inline. Proactive nudges piggyback on the existing `donnaschedule` infrastructure.

**Tech Stack:** TypeScript, `@anthropic-ai/sdk`, `postgres@^3` (porsager), Supabase (migrations + storage), Nutritionix REST API, OpenAI Whisper REST API, `chartjs-node-canvas`.

**Testing approach:** donna doesn't have a test suite yet (`tests are TBD per the testing rule` in CLAUDE.md). Each task verifies via `npm run typecheck`. Behavioral verification happens at the three-meal e2e gate (Task 14) and the weekly-chart smoke (Task 15). `npm run inspect` validates prompt/tool-shape changes.

**Spec:** [`docs/superpowers/specs/2026-05-08-calorie-tracker-design.md`](../specs/2026-05-08-calorie-tracker-design.md)

---

## File map

**New:**
- `supabase/migrations/20260508130000_calorie_tracker.sql`
- `src/donna/integrations/nutritionix.ts`
- `src/donna/integrations/whisper.ts`
- `src/donna/calories/types.ts`
- `src/donna/calories/cache.ts`
- `src/donna/calories/storage.ts`
- `src/donna/calories/meals.ts`
- `src/donna/calories/goals.ts`
- `src/donna/calories/aliases.ts`
- `src/donna/calories/summary.ts`
- `src/donna/calories/chart.ts`
- `src/donna/tools/calories/log_meal.ts`
- `src/donna/tools/calories/update_meal.ts`
- `src/donna/tools/calories/delete_meal.ts`
- `src/donna/tools/calories/set_food_goal.ts`
- `src/donna/tools/calories/save_meal_alias.ts`
- `src/donna/tools/calories/log_meal_from_alias.ts`
- `src/donna/tools/calories/parse_food_text.ts`
- `src/donna/tools/calories/lookup_food.ts`
- `src/donna/tools/calories/get_food_goal.ts`
- `src/donna/tools/calories/get_daily_summary.ts`
- `src/donna/tools/calories/get_meal_history.ts`
- `src/donna/tools/calories/list_meal_aliases.ts`
- `src/donna/tools/calories/get_weekly_chart.ts`
- `src/donna/tools/calories/index.ts` (barrel re-exports)

**Modify:**
- `package.json` (deps)
- `.env.example` (vars)
- `src/donna/tools/index.ts` (register tools)
- `src/donna/prompt.ts` (add `<calorie_logging>` section, drop the "you can only see text right now" line)
- `src/donna/ingress/imessage.ts` (fetch Linq media bytes)
- `src/server.ts` (build multimodal user-message content blocks; route media payloads into the brain instead of acking them)

---

## Task 1: Dependencies + env vars

**Files:**
- Modify: `package.json`
- Modify: `.env.example`

- [ ] **Step 1: Install runtime deps**

```bash
npm install chartjs-node-canvas chart.js
```

(`openai` not added — Whisper called via fetch in Task 12 to keep deps lean; matches existing `nutritionix.ts` pattern.)

- [ ] **Step 2: Append env vars to `.env.example`**

Add at the end:

```
# Calorie tracker
NUTRITIONIX_APP_ID=
NUTRITIONIX_API_KEY=
OPENAI_API_KEY=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_STORAGE_BUCKET_MEDIA=meal_media
SUPABASE_STORAGE_BUCKET_CHARTS=meal_charts
CALORIE_QUIET_HOURS=00:00-07:00
```

- [ ] **Step 3: Verify**

```bash
npm run typecheck
```

Expected: PASS (no source changes yet, just deps).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json .env.example
git commit -m "chore(calories): add chartjs-node-canvas + nutritionix/whisper env vars"
```

---

## Task 2: Migration — 5 tables

**Files:**
- Create: `supabase/migrations/20260508130000_calorie_tracker.sql`

- [ ] **Step 1: Write the migration**

Full DDL — paste verbatim from spec:

```sql
-- calorie tracker: food_goals, meals, meal_items, meal_aliases, food_cache.
-- multimodal logging (text|photo|voice), nutritionix-canonical macros,
-- dashboard-ready schema. soft-delete only on meals.

create table if not exists food_goals (
  user_id uuid primary key references users(id) on delete cascade,
  goal_kind text not null check (goal_kind in ('cut','bulk','maintain','custom')),
  daily_kcal int,
  daily_protein_g int,
  daily_carbs_g int,
  daily_fat_g int,
  daily_fiber_g int,
  notes text,
  active_from date not null default current_date,
  proactive_nudges boolean not null default true,
  timezone text not null default 'Asia/Singapore',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists meals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  occurred_at timestamptz not null,
  logged_at timestamptz not null default now(),
  meal_type text check (meal_type in ('breakfast','lunch','dinner','snack')),
  source_kind text not null check (source_kind in ('text','photo','voice','alias','edit')),
  source_message_id text,
  raw_input text,
  vision_description text,
  total_kcal numeric not null default 0,
  total_protein_g numeric not null default 0,
  total_carbs_g numeric not null default 0,
  total_fat_g numeric not null default 0,
  total_fiber_g numeric not null default 0,
  total_sodium_mg numeric not null default 0,
  confidence text check (confidence in ('high','medium','low')),
  parser text check (parser in ('nutritionix','llm','mixed')),
  is_deleted boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists meals_user_occurred_idx
  on meals (user_id, occurred_at desc) where not is_deleted;

create table if not exists meal_items (
  id uuid primary key default gen_random_uuid(),
  meal_id uuid not null references meals(id) on delete cascade,
  position int not null,
  name text not null,
  quantity numeric,
  unit text,
  serving_grams numeric,
  kcal numeric not null default 0,
  protein_g numeric not null default 0,
  carbs_g numeric not null default 0,
  fat_g numeric not null default 0,
  fiber_g numeric not null default 0,
  sodium_mg numeric not null default 0,
  nix_id text,
  fdc_id text,
  unique (meal_id, position)
);

create table if not exists meal_aliases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  alias text not null,
  template jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, alias)
);

create table if not exists food_cache (
  query_normalized text primary key,
  source text not null check (source in ('nutritionix')),
  raw_response jsonb not null,
  ttl_until timestamptz not null,
  hit_count int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists food_cache_ttl_idx on food_cache (ttl_until);
```

- [ ] **Step 2: Apply**

```bash
npm run migrate
```

Expected: success message from `supabase db push`. If it errors on `gen_random_uuid()`, run `create extension if not exists pgcrypto;` once (already on for donna's other tables, but be ready).

- [ ] **Step 3: Verify schema**

```bash
psql "$DATABASE_URL" -c "\d food_goals" -c "\d meals" -c "\d meal_items" -c "\d meal_aliases" -c "\d food_cache"
```

Expected: all five tables print with the exact columns above.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260508130000_calorie_tracker.sql
git commit -m "feat(db): calorie tracker schema — goals, meals, meal_items, aliases, cache"
```

---

## Task 3: Domain types

**Files:**
- Create: `src/donna/calories/types.ts`

- [ ] **Step 1: Write types**

```typescript
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
    kcal: number; protein_g: number; carbs_g: number;
    fat_g: number; fiber_g: number; sodium_mg: number;
  };
  goal: FoodGoalRow | null;
  delta: { // null if no goal set
    kcal: number; protein_g: number; carbs_g: number; fat_g: number;
  } | null;
  meals: Array<{
    id: string;
    occurred_at: string; // iso
    meal_type: MealType | null;
    summary: string; // first 60 chars of raw_input
    kcal: number;
    confidence: Confidence | null;
  }>;
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/donna/calories/types.ts
git commit -m "feat(calories): shared domain types"
```

---

## Task 4: Nutritionix client + cache

**Files:**
- Create: `src/donna/calories/cache.ts`
- Create: `src/donna/integrations/nutritionix.ts`

- [ ] **Step 1: Write `cache.ts`**

```typescript
import { getSql } from "../db.js";

const TTL_HOURS = 24;

function normalize(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

export async function getCached(
  query: string,
): Promise<unknown | null> {
  const sql = getSql();
  const key = normalize(query);
  const rows = await sql<{ raw_response: unknown }[]>`
    update food_cache
       set hit_count = hit_count + 1
     where query_normalized = ${key}
       and ttl_until > now()
     returning raw_response
  `;
  return rows[0]?.raw_response ?? null;
}

export async function putCached(
  query: string,
  response: unknown,
): Promise<void> {
  const sql = getSql();
  const key = normalize(query);
  await sql`
    insert into food_cache (query_normalized, source, raw_response, ttl_until)
    values (
      ${key},
      'nutritionix',
      ${sql.json(response as Parameters<typeof sql.json>[0])},
      now() + interval '${sql.unsafe(String(TTL_HOURS))} hours'
    )
    on conflict (query_normalized) do update
      set raw_response = excluded.raw_response,
          ttl_until    = excluded.ttl_until,
          hit_count    = 0
  `;
}
```

- [ ] **Step 2: Write `nutritionix.ts`**

```typescript
// nutritionix natural-language nutrient lookup. stateless rest client, not an
// oauth integration — does not flow through integrations/service.ts. see
// https://docs.nutritionix.com/

import { getCached, putCached } from "../calories/cache.js";

const NL_URL = "https://trackapi.nutritionix.com/v2/natural/nutrients";
const SEARCH_URL = "https://trackapi.nutritionix.com/v2/search/instant";

export interface NixFood {
  food_name: string;
  serving_qty: number;
  serving_unit: string;
  serving_weight_grams: number | null;
  nf_calories: number;
  nf_protein: number;
  nf_total_carbohydrate: number;
  nf_total_fat: number;
  nf_dietary_fiber: number | null;
  nf_sodium: number | null;
  nix_item_id: string | null;
  tag_id: string | null;
  photo?: { thumb?: string; highres?: string };
}

export interface NixNlResult {
  source: "nutritionix" | "cache";
  foods: NixFood[];
  raw: unknown;
}

function headers(): Record<string, string> {
  const id = process.env.NUTRITIONIX_APP_ID;
  const key = process.env.NUTRITIONIX_API_KEY;
  if (!id || !key) {
    throw new Error("nutritionix: NUTRITIONIX_APP_ID / NUTRITIONIX_API_KEY not set");
  }
  return {
    "x-app-id": id,
    "x-app-key": key,
    "content-type": "application/json",
  };
}

export async function naturalNutrients(query: string): Promise<NixNlResult> {
  const cached = await getCached(query);
  if (cached) {
    return { source: "cache", foods: (cached as { foods: NixFood[] }).foods, raw: cached };
  }
  const res = await fetch(NL_URL, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`nutritionix nl: ${res.status} ${text}`);
  }
  const json = (await res.json()) as { foods?: NixFood[] };
  const foods = json.foods ?? [];
  await putCached(query, { foods, raw: json });
  return { source: "nutritionix", foods, raw: json };
}

export interface NixInstantResult {
  common: Array<{ food_name: string; tag_id: string; serving_qty: number; serving_unit: string }>;
  branded: Array<{ food_name: string; nix_item_id: string; brand_name: string; nf_calories: number }>;
}

export async function instantSearch(query: string, limit = 5): Promise<NixInstantResult> {
  const url = `${SEARCH_URL}?query=${encodeURIComponent(query)}&detailed=true&common=true&branded=true`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`nutritionix instant: ${res.status} ${text}`);
  }
  const json = (await res.json()) as NixInstantResult;
  return {
    common: (json.common ?? []).slice(0, limit),
    branded: (json.branded ?? []).slice(0, limit),
  };
}
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/donna/calories/cache.ts src/donna/integrations/nutritionix.ts
git commit -m "feat(calories): nutritionix client (nl + instant search) with food_cache"
```

---

## Task 5: Storage helpers

**Files:**
- Create: `src/donna/calories/storage.ts`

- [ ] **Step 1: Write storage.ts**

```typescript
// supabase storage uploads for meal media (photos, voice notes) and weekly
// charts. uses the rest endpoint so we don't add the supabase-js dep.

const DEFAULT_MEDIA = "meal_media";
const DEFAULT_CHARTS = "meal_charts";
const SIGNED_TTL_SECONDS = 60 * 60 * 24; // 24h

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`storage: ${name} not set`);
  return v;
}

async function uploadBytes(
  bucket: string,
  path: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  const url = `${need("SUPABASE_URL")}/storage/v1/object/${bucket}/${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${need("SUPABASE_SERVICE_ROLE_KEY")}`,
      "content-type": contentType,
      "x-upsert": "true",
    },
    body: bytes as BlobPart,
  });
  if (!res.ok) {
    throw new Error(`storage upload ${bucket}/${path}: ${res.status} ${await res.text()}`);
  }
}

async function signedUrl(bucket: string, path: string): Promise<string> {
  const url = `${need("SUPABASE_URL")}/storage/v1/object/sign/${bucket}/${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${need("SUPABASE_SERVICE_ROLE_KEY")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ expiresIn: SIGNED_TTL_SECONDS }),
  });
  if (!res.ok) {
    throw new Error(`storage sign ${bucket}/${path}: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { signedURL?: string };
  if (!json.signedURL) throw new Error("storage: no signedURL in response");
  return `${need("SUPABASE_URL")}/storage/v1${json.signedURL}`;
}

export async function uploadMealMedia(args: {
  userId: string;
  messageId: string;
  bytes: Uint8Array;
  mimeType: string;
}): Promise<{ path: string; signedUrl: string }> {
  const bucket = process.env.SUPABASE_STORAGE_BUCKET_MEDIA ?? DEFAULT_MEDIA;
  const ext = args.mimeType.split("/")[1]?.split(";")[0] || "bin";
  const path = `${args.userId}/${args.messageId}.${ext}`;
  await uploadBytes(bucket, path, args.bytes, args.mimeType);
  return { path, signedUrl: await signedUrl(bucket, path) };
}

export async function uploadChartPng(args: {
  userId: string;
  isoWeek: string; // e.g. "2026-W19"
  bytes: Uint8Array;
}): Promise<{ path: string; signedUrl: string }> {
  const bucket = process.env.SUPABASE_STORAGE_BUCKET_CHARTS ?? DEFAULT_CHARTS;
  const path = `${args.userId}/${args.isoWeek}.png`;
  await uploadBytes(bucket, path, args.bytes, "image/png");
  return { path, signedUrl: await signedUrl(bucket, path) };
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Create the storage buckets manually**

In the supabase dashboard (or via the rest api), create two private buckets:
- `meal_media`
- `meal_charts`

(Mark this as a one-time human step in the spec; storage bucket creation isn't part of the migration system.)

- [ ] **Step 4: Commit**

```bash
git add src/donna/calories/storage.ts
git commit -m "feat(calories): supabase storage helpers for media + charts"
```

---

## Task 6: Repositories — meals, goals, aliases, summary

**Files:**
- Create: `src/donna/calories/meals.ts`
- Create: `src/donna/calories/goals.ts`
- Create: `src/donna/calories/aliases.ts`
- Create: `src/donna/calories/summary.ts`

- [ ] **Step 1: Write `meals.ts`**

```typescript
import { getSql } from "../db.js";
import type {
  Confidence, MealItemInput, MealItemRow, MealRow, MealSource, MealType, Parser,
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

function sumItems(items: MealItemInput[]): {
  kcal: number; protein_g: number; carbs_g: number;
  fat_g: number; fiber_g: number; sodium_mg: number;
} {
  return items.reduce(
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
    if (args.items.length > 0) {
      await tx`
        insert into meal_items ${tx(
          args.items.map((it, i) => ({
            meal_id: meal.id,
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
          })),
        )}
      `;
    }
    return meal;
  });
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
      select * from meals where id = ${mealId} and user_id = ${userId} and not is_deleted
    `;
    if (!existing) throw new Error("update_meal: meal not found");

    const items = patch.items ?? null;
    if (items) {
      await tx`delete from meal_items where meal_id = ${mealId}`;
      if (items.length > 0) {
        await tx`
          insert into meal_items ${tx(
            items.map((it, i) => ({
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
            })),
          )}
        `;
      }
    }

    const totals = items ? sumItems(items) : {
      kcal: existing.total_kcal, protein_g: existing.total_protein_g,
      carbs_g: existing.total_carbs_g, fat_g: existing.total_fat_g,
      fiber_g: existing.total_fiber_g, sodium_mg: existing.total_sodium_mg,
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
  });
}

export async function softDeleteMeal(mealId: string, userId: string): Promise<void> {
  const sql = getSql();
  await sql`
    update meals set is_deleted = true, updated_at = now()
    where id = ${mealId} and user_id = ${userId}
  `;
}

export async function getMostRecentMeal(userId: string): Promise<MealRow | null> {
  const sql = getSql();
  const rows = await sql<MealRow[]>`
    select * from meals
    where user_id = ${userId} and not is_deleted
    order by occurred_at desc limit 1
  `;
  return rows[0] ?? null;
}

export async function getMealItems(mealId: string): Promise<MealItemRow[]> {
  const sql = getSql();
  return await sql<MealItemRow[]>`
    select * from meal_items where meal_id = ${mealId} order by position asc
  `;
}
```

- [ ] **Step 2: Write `goals.ts`**

```typescript
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
  return row;
}

export async function getGoal(userId: string): Promise<FoodGoalRow | null> {
  const sql = getSql();
  const rows = await sql<FoodGoalRow[]>`
    select * from food_goals where user_id = ${userId}
  `;
  return rows[0] ?? null;
}
```

- [ ] **Step 3: Write `aliases.ts`**

```typescript
import { getSql } from "../db.js";
import type { MealAliasRow, MealItemInput } from "./types.js";

export async function saveAlias(args: {
  userId: string;
  alias: string;
  template: MealItemInput[];
}): Promise<MealAliasRow> {
  const sql = getSql();
  const [row] = await sql<MealAliasRow[]>`
    insert into meal_aliases (user_id, alias, template)
    values (
      ${args.userId},
      ${args.alias},
      ${sql.json(args.template as Parameters<typeof sql.json>[0])}
    )
    on conflict (user_id, alias) do update set
      template = excluded.template,
      updated_at = now()
    returning *
  `;
  return row;
}

export async function listAliases(userId: string): Promise<MealAliasRow[]> {
  const sql = getSql();
  return await sql<MealAliasRow[]>`
    select * from meal_aliases where user_id = ${userId} order by alias asc
  `;
}

export async function getAlias(userId: string, alias: string): Promise<MealAliasRow | null> {
  const sql = getSql();
  const rows = await sql<MealAliasRow[]>`
    select * from meal_aliases where user_id = ${userId} and alias = ${alias}
  `;
  return rows[0] ?? null;
}
```

- [ ] **Step 4: Write `summary.ts`**

```typescript
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
    kcal:      (goal.daily_kcal ?? 0)      - totals.kcal,
    protein_g: (goal.daily_protein_g ?? 0) - totals.protein_g,
    carbs_g:   (goal.daily_carbs_g ?? 0)   - totals.carbs_g,
    fat_g:     (goal.daily_fat_g ?? 0)     - totals.fat_g,
  };
}

export async function getDailySummary(args: {
  userId: string;
  date?: string; // YYYY-MM-DD in user tz; default = today user tz
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
  start: string; // YYYY-MM-DD
  end: string;   // YYYY-MM-DD inclusive
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
```

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: PASS. If `sql.json` cast errors complain, mirror existing usage in `memory/inbound.ts` line 36.

- [ ] **Step 6: Commit**

```bash
git add src/donna/calories/{meals,goals,aliases,summary}.ts
git commit -m "feat(calories): repositories — meals, goals, aliases, summary"
```

---

## Task 7: Direct write tools

**Files:**
- Create: `src/donna/tools/calories/log_meal.ts`
- Create: `src/donna/tools/calories/update_meal.ts`
- Create: `src/donna/tools/calories/delete_meal.ts`
- Create: `src/donna/tools/calories/set_food_goal.ts`
- Create: `src/donna/tools/calories/save_meal_alias.ts`
- Create: `src/donna/tools/calories/log_meal_from_alias.ts`
- Create: `src/donna/tools/calories/index.ts`
- Modify: `src/donna/tools/index.ts`

- [ ] **Step 1: Write `log_meal.ts`**

```typescript
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../../brain.js";
import { getTurnContext } from "../../context.js";
import { insertMeal } from "../../calories/meals.js";
import type {
  Confidence, MealItemInput, MealSource, MealType, Parser,
} from "../../calories/types.js";
import { recordExecutionEvent } from "../../observability/execution.js";

interface LogMealInput {
  items: MealItemInput[];
  occurred_at?: string; // iso; default now
  meal_type?: MealType;
  source_kind: MealSource;
  source_message_id?: string;
  raw_input?: string;
  vision_description?: string;
  confidence: Confidence;
  parser: Parser;
  notes?: string;
}

export const logMealTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "log_meal",
  description: `persist a meal the user just told you about. one row in meals + N rows in meal_items, in one transaction. all macros come from parse_food_text or your own estimate.

call this AFTER parse_food_text has returned items, or AFTER you've estimated items yourself when nutritionix had nothing.

inputs:
- items: array of {name, quantity?, unit?, serving_grams?, kcal, protein_g, carbs_g, fat_g, fiber_g?, sodium_mg?, nix_id?}
- occurred_at: iso timestamp the meal happened. default now.
- meal_type: breakfast | lunch | dinner | snack. infer from time if obvious.
- source_kind: text | photo | voice | alias | edit. how the user logged it.
- source_message_id: the inbound platform message id, when known.
- raw_input: the user's words / transcription / typed message.
- vision_description: your description of the photo, if there was one.
- confidence: high (all items matched in nutritionix), medium (some matched), low (none).
- parser: nutritionix | mixed | llm.

returns: { meal_id, totals: {kcal, protein_g, carbs_g, fat_g} }.

after logging, call get_daily_summary() so you can tell the user where they are vs goal.`,
  input_schema: {
    type: "object",
    properties: {
      items: { type: "array" },
      occurred_at: { type: "string" },
      meal_type: { type: "string", enum: ["breakfast","lunch","dinner","snack"] },
      source_kind: { type: "string", enum: ["text","photo","voice","alias","edit"] },
      source_message_id: { type: "string" },
      raw_input: { type: "string" },
      vision_description: { type: "string" },
      confidence: { type: "string", enum: ["high","medium","low"] },
      parser: { type: "string", enum: ["nutritionix","llm","mixed"] },
      notes: { type: "string" },
    },
    required: ["items", "source_kind", "confidence", "parser"],
  },
  modes: new Set<BrainMode>(["reactive"]),
};

export async function logMealHandler(input: unknown): Promise<unknown> {
  const i = (input ?? {}) as LogMealInput;
  if (!Array.isArray(i.items) || i.items.length === 0) {
    throw new Error("log_meal: items required");
  }
  const ctx = getTurnContext();
  const occurredAt = i.occurred_at ? new Date(i.occurred_at) : new Date();
  const meal = await insertMeal({
    userId: ctx.userId,
    occurredAt,
    mealType: i.meal_type ?? null,
    sourceKind: i.source_kind,
    sourceMessageId: i.source_message_id ?? null,
    rawInput: i.raw_input ?? null,
    visionDescription: i.vision_description ?? null,
    confidence: i.confidence,
    parser: i.parser,
    notes: i.notes ?? null,
    items: i.items,
  });
  if (ctx.runId) {
    await recordExecutionEvent(ctx.runId, "meal_logged", "calories", {
      meal_id: meal.id,
      kcal: Number(meal.total_kcal),
      item_count: i.items.length,
      source_kind: i.source_kind,
      confidence: i.confidence,
    });
  }
  return {
    meal_id: meal.id,
    totals: {
      kcal: Number(meal.total_kcal),
      protein_g: Number(meal.total_protein_g),
      carbs_g: Number(meal.total_carbs_g),
      fat_g: Number(meal.total_fat_g),
    },
  };
}
```

- [ ] **Step 2: Write `update_meal.ts`**

```typescript
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../../brain.js";
import { getTurnContext } from "../../context.js";
import { updateMeal } from "../../calories/meals.js";
import { recordExecutionEvent } from "../../observability/execution.js";
import type {
  Confidence, MealItemInput, MealType, Parser,
} from "../../calories/types.js";

interface UpdateMealInput {
  meal_id: string;
  items?: MealItemInput[];
  occurred_at?: string;
  meal_type?: MealType;
  raw_input?: string;
  confidence?: Confidence;
  parser?: Parser;
  notes?: string;
}

export const updateMealTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "update_meal",
  description: `edit a previously logged meal. replace items wholesale (all old items deleted, new items inserted), or change occurred_at / meal_type / notes.

call this when the user corrects themselves: "actually one egg, not two", "that was at 1pm not noon".

if items is provided you MUST recompute via parse_food_text first — don't pass numbers you didn't get from nutritionix or estimate explicitly.

returns: { meal_id, totals }.`,
  input_schema: {
    type: "object",
    properties: {
      meal_id: { type: "string" },
      items: { type: "array" },
      occurred_at: { type: "string" },
      meal_type: { type: "string", enum: ["breakfast","lunch","dinner","snack"] },
      raw_input: { type: "string" },
      confidence: { type: "string", enum: ["high","medium","low"] },
      parser: { type: "string", enum: ["nutritionix","llm","mixed"] },
      notes: { type: "string" },
    },
    required: ["meal_id"],
  },
  modes: new Set<BrainMode>(["reactive"]),
};

export async function updateMealHandler(input: unknown): Promise<unknown> {
  const i = (input ?? {}) as UpdateMealInput;
  if (!i.meal_id) throw new Error("update_meal: meal_id required");
  const ctx = getTurnContext();
  const meal = await updateMeal(i.meal_id, ctx.userId, {
    items: i.items,
    occurredAt: i.occurred_at ? new Date(i.occurred_at) : undefined,
    mealType: i.meal_type,
    rawInput: i.raw_input,
    confidence: i.confidence,
    parser: i.parser,
    notes: i.notes,
  });
  if (ctx.runId) {
    await recordExecutionEvent(ctx.runId, "meal_edited", "calories", {
      meal_id: meal.id,
      kcal: Number(meal.total_kcal),
    });
  }
  return {
    meal_id: meal.id,
    totals: {
      kcal: Number(meal.total_kcal),
      protein_g: Number(meal.total_protein_g),
      carbs_g: Number(meal.total_carbs_g),
      fat_g: Number(meal.total_fat_g),
    },
  };
}
```

- [ ] **Step 3: Write `delete_meal.ts`**

```typescript
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../../brain.js";
import { getTurnContext } from "../../context.js";
import { softDeleteMeal } from "../../calories/meals.js";
import { recordExecutionEvent } from "../../observability/execution.js";

interface DeleteMealInput { meal_id: string }

export const deleteMealTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "delete_meal",
  description: `soft-delete a meal. row stays in the table with is_deleted=true; daily summaries skip it.

call this when the user retracts: "i didn't actually eat that", "delete the snack i logged".

returns: { meal_id, deleted: true }.`,
  input_schema: {
    type: "object",
    properties: { meal_id: { type: "string" } },
    required: ["meal_id"],
  },
  modes: new Set<BrainMode>(["reactive"]),
};

export async function deleteMealHandler(input: unknown): Promise<unknown> {
  const i = (input ?? {}) as DeleteMealInput;
  if (!i.meal_id) throw new Error("delete_meal: meal_id required");
  const ctx = getTurnContext();
  await softDeleteMeal(i.meal_id, ctx.userId);
  if (ctx.runId) {
    await recordExecutionEvent(ctx.runId, "meal_deleted", "calories", {
      meal_id: i.meal_id,
    });
  }
  return { meal_id: i.meal_id, deleted: true };
}
```

- [ ] **Step 4: Write `set_food_goal.ts`**

```typescript
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
      goal_kind: { type: "string", enum: ["cut","bulk","maintain","custom"] },
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
```

- [ ] **Step 5: Write `save_meal_alias.ts`**

```typescript
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../../brain.js";
import { getTurnContext } from "../../context.js";
import { saveAlias } from "../../calories/aliases.js";
import { getMealItems, getMostRecentMeal } from "../../calories/meals.js";
import type { MealItemInput } from "../../calories/types.js";

interface SaveMealAliasInput {
  alias: string;
  meal_id?: string; // if absent, snapshot the most recent meal
  template?: MealItemInput[]; // if provided, used directly (skip db lookup)
}

export const saveMealAliasTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "save_meal_alias",
  description: `save a meal as a named template the user can re-log later.

call this when the user says "save this as my usual breakfast" or "remember this lunch as 'office salad'".

inputs:
- alias: short user-facing name. lowercased before save.
- meal_id (optional): meal to snapshot. omit to use the most recent meal.
- template (optional): explicit item list. when set, db isn't read.

returns: { alias, items: [...] }.`,
  input_schema: {
    type: "object",
    properties: {
      alias: { type: "string" },
      meal_id: { type: "string" },
      template: { type: "array" },
    },
    required: ["alias"],
  },
  modes: new Set<BrainMode>(["reactive"]),
};

export async function saveMealAliasHandler(input: unknown): Promise<unknown> {
  const i = (input ?? {}) as SaveMealAliasInput;
  if (!i.alias) throw new Error("save_meal_alias: alias required");
  const ctx = getTurnContext();

  let template: MealItemInput[];
  if (i.template && i.template.length > 0) {
    template = i.template;
  } else {
    const meal = i.meal_id
      ? null // explicit meal_id path falls through to items lookup below
      : await getMostRecentMeal(ctx.userId);
    const mealId = i.meal_id ?? meal?.id;
    if (!mealId) throw new Error("save_meal_alias: no meal to snapshot");
    const items = await getMealItems(mealId);
    template = items.map((it) => ({
      name: it.name,
      quantity: it.quantity ?? undefined,
      unit: it.unit ?? undefined,
      serving_grams: it.serving_grams ?? undefined,
      kcal: Number(it.kcal),
      protein_g: Number(it.protein_g),
      carbs_g: Number(it.carbs_g),
      fat_g: Number(it.fat_g),
      fiber_g: Number(it.fiber_g),
      sodium_mg: Number(it.sodium_mg),
      nix_id: it.nix_id ?? undefined,
    }));
  }

  const row = await saveAlias({
    userId: ctx.userId,
    alias: i.alias.toLowerCase().trim(),
    template,
  });
  return { alias: row.alias, items: row.template };
}
```

- [ ] **Step 6: Write `log_meal_from_alias.ts`**

```typescript
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../../brain.js";
import { getTurnContext } from "../../context.js";
import { getAlias } from "../../calories/aliases.js";
import { insertMeal } from "../../calories/meals.js";
import { recordExecutionEvent } from "../../observability/execution.js";
import type { MealType } from "../../calories/types.js";

interface LogMealFromAliasInput {
  alias: string;
  occurred_at?: string;
  meal_type?: MealType;
}

export const logMealFromAliasTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "log_meal_from_alias",
  description: `fast-path log a meal by alias. snapshots the alias template into a fresh meal row.

call this when the user says "log my usual breakfast", "same as yesterday's salad", "log office lunch".

returns: { meal_id, totals }.`,
  input_schema: {
    type: "object",
    properties: {
      alias: { type: "string" },
      occurred_at: { type: "string" },
      meal_type: { type: "string", enum: ["breakfast","lunch","dinner","snack"] },
    },
    required: ["alias"],
  },
  modes: new Set<BrainMode>(["reactive"]),
};

export async function logMealFromAliasHandler(input: unknown): Promise<unknown> {
  const i = (input ?? {}) as LogMealFromAliasInput;
  if (!i.alias) throw new Error("log_meal_from_alias: alias required");
  const ctx = getTurnContext();
  const aliasRow = await getAlias(ctx.userId, i.alias.toLowerCase().trim());
  if (!aliasRow) throw new Error(`alias "${i.alias}" not found`);

  const meal = await insertMeal({
    userId: ctx.userId,
    occurredAt: i.occurred_at ? new Date(i.occurred_at) : new Date(),
    mealType: i.meal_type ?? null,
    sourceKind: "alias",
    sourceMessageId: null,
    rawInput: `alias:${aliasRow.alias}`,
    visionDescription: null,
    confidence: "high",
    parser: "nutritionix",
    items: aliasRow.template,
  });
  if (ctx.runId) {
    await recordExecutionEvent(ctx.runId, "meal_logged", "calories.alias", {
      meal_id: meal.id,
      alias: aliasRow.alias,
    });
  }
  return {
    meal_id: meal.id,
    totals: {
      kcal: Number(meal.total_kcal),
      protein_g: Number(meal.total_protein_g),
      carbs_g: Number(meal.total_carbs_g),
      fat_g: Number(meal.total_fat_g),
    },
  };
}
```

- [ ] **Step 7: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/donna/tools/calories/
git commit -m "feat(calories): direct write tools — log_meal, update, delete, goal, alias"
```

(The barrel `index.ts` and registry wiring happen in Task 9 once read tools also exist — registering all calorie tools at once is cleaner.)

---

## Task 8: PTC read tools (group 1) — parsing, lookup, goal, daily summary

**Files:**
- Create: `src/donna/tools/calories/parse_food_text.ts`
- Create: `src/donna/tools/calories/lookup_food.ts`
- Create: `src/donna/tools/calories/get_food_goal.ts`
- Create: `src/donna/tools/calories/get_daily_summary.ts`

- [ ] **Step 1: Write `parse_food_text.ts`**

```typescript
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../../brain.js";
import { getTurnContext } from "../../context.js";
import { naturalNutrients } from "../../integrations/nutritionix.js";
import { recordExecutionEvent } from "../../observability/execution.js";

const PTC_CALLER = "code_execution_20250825" as const;

interface ParseFoodTextInput { text: string }

export const parseFoodTextTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "parse_food_text",
  description: `parse a free-form food description into canonical macros via nutritionix natural language. handles "two eggs and toast", "starbucks venti latte", "1 cup of basmati rice with curry".

returns: { source: "nutritionix"|"cache", items: [{name, quantity, unit, serving_grams, kcal, protein_g, carbs_g, fat_g, fiber_g, sodium_mg, nix_id?}] }.

confidence rules for log_meal: if items.length matches what you described and every item has nf data, confidence="high". if some items are missing or estimated, "medium". if items is empty, fall back to your own estimate and pass confidence="low" with parser="llm".

mark this async — call from inside python via asyncio.gather alongside get_food_goal() and get_daily_summary().`,
  input_schema: {
    type: "object",
    properties: {
      text: { type: "string", description: "the food description in plain english." },
    },
    required: ["text"],
  },
  // @ts-expect-error allowed_callers is a beta-tool field not in the public types yet
  allowed_callers: [PTC_CALLER],
  modes: new Set<BrainMode>(["reactive"]),
};

export async function parseFoodTextHandler(input: unknown): Promise<unknown> {
  const i = (input ?? {}) as ParseFoodTextInput;
  if (!i.text) throw new Error("parse_food_text: text required");
  const ctx = getTurnContext();
  const result = await naturalNutrients(i.text);
  const items = result.foods.map((f) => ({
    name: f.food_name,
    quantity: f.serving_qty,
    unit: f.serving_unit,
    serving_grams: f.serving_weight_grams ?? undefined,
    kcal: f.nf_calories,
    protein_g: f.nf_protein,
    carbs_g: f.nf_total_carbohydrate,
    fat_g: f.nf_total_fat,
    fiber_g: f.nf_dietary_fiber ?? 0,
    sodium_mg: f.nf_sodium ?? 0,
    nix_id: f.nix_item_id ?? undefined,
  }));
  if (ctx.runId) {
    const label = result.source === "cache" ? "nutritionix_cached" : (items.length > 0 ? "nutritionix_hit" : "nutritionix_miss");
    await recordExecutionEvent(ctx.runId, label, "calories", {
      query: i.text.slice(0, 80),
      items: items.length,
    });
  }
  return { source: result.source, items };
}
```

(Pattern note: the `@ts-expect-error` on `allowed_callers` matches what `gmail.ts` does — the field is a beta extension. Confirm this matches `gmail.ts` structure when implementing.)

- [ ] **Step 2: Write `lookup_food.ts`**

```typescript
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../../brain.js";
import { getTurnContext } from "../../context.js";
import { instantSearch } from "../../integrations/nutritionix.js";
import { recordExecutionEvent } from "../../observability/execution.js";

const PTC_CALLER = "code_execution_20250825" as const;

interface LookupFoodInput { query: string; limit?: number }

export const lookupFoodTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "lookup_food",
  description: `instant search for foods when parse_food_text was ambiguous. returns common (generic) and branded matches.

use when the user says "log a venti latte" but you're not sure which one — call lookup_food first, pick the right nix_item_id, then use it inside parse_food_text or compose the item directly for log_meal.

returns: { common: [...], branded: [...] }.`,
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "number" },
    },
    required: ["query"],
  },
  // @ts-expect-error allowed_callers is a beta-tool field not in the public types yet
  allowed_callers: [PTC_CALLER],
  modes: new Set<BrainMode>(["reactive"]),
};

export async function lookupFoodHandler(input: unknown): Promise<unknown> {
  const i = (input ?? {}) as LookupFoodInput;
  if (!i.query) throw new Error("lookup_food: query required");
  const ctx = getTurnContext();
  const result = await instantSearch(i.query, i.limit ?? 5);
  if (ctx.runId) {
    await recordExecutionEvent(ctx.runId, "nutritionix_lookup", "calories", {
      query: i.query.slice(0, 80),
      common: result.common.length,
      branded: result.branded.length,
    });
  }
  return result;
}
```

- [ ] **Step 3: Write `get_food_goal.ts`**

```typescript
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../../brain.js";
import { getTurnContext } from "../../context.js";
import { getGoal } from "../../calories/goals.js";

const PTC_CALLER = "code_execution_20250825" as const;

export const getFoodGoalTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "get_food_goal",
  description: `read the user's daily food goal. returns null if none set.

call inside python alongside get_daily_summary so you can compute delta vs target before composing the burst.`,
  input_schema: { type: "object", properties: {} },
  // @ts-expect-error allowed_callers is a beta-tool field not in the public types yet
  allowed_callers: [PTC_CALLER],
  modes: new Set<BrainMode>(["reactive", "proactive"]),
};

export async function getFoodGoalHandler(): Promise<unknown> {
  const ctx = getTurnContext();
  const goal = await getGoal(ctx.userId);
  return { goal };
}
```

- [ ] **Step 4: Write `get_daily_summary.ts`**

```typescript
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../../brain.js";
import { getTurnContext } from "../../context.js";
import { getDailySummary } from "../../calories/summary.js";

const PTC_CALLER = "code_execution_20250825" as const;

interface GetDailySummaryInput { date?: string }

export const getDailySummaryTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "get_daily_summary",
  description: `aggregate today's (or any date's) meals + delta vs goal. dates are YYYY-MM-DD in the user's tz.

returns: {date, totals: {kcal, protein_g, carbs_g, fat_g, fiber_g, sodium_mg}, goal, delta: {kcal, protein_g, carbs_g, fat_g} | null, meals: [{id, occurred_at, meal_type, summary, kcal, confidence}]}.

mark this async — fan out alongside get_food_goal() and parse_food_text() in python.`,
  input_schema: {
    type: "object",
    properties: { date: { type: "string", description: "YYYY-MM-DD; default today user tz." } },
  },
  // @ts-expect-error allowed_callers is a beta-tool field not in the public types yet
  allowed_callers: [PTC_CALLER],
  modes: new Set<BrainMode>(["reactive", "proactive"]),
};

export async function getDailySummaryHandler(input: unknown): Promise<unknown> {
  const i = (input ?? {}) as GetDailySummaryInput;
  const ctx = getTurnContext();
  return await getDailySummary({ userId: ctx.userId, date: i.date });
}
```

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/donna/tools/calories/{parse_food_text,lookup_food,get_food_goal,get_daily_summary}.ts
git commit -m "feat(calories): ptc read tools — parse, lookup, goal, daily summary"
```

---

## Task 9: PTC read tools (group 2) + tool registry wiring

**Files:**
- Create: `src/donna/tools/calories/get_meal_history.ts`
- Create: `src/donna/tools/calories/list_meal_aliases.ts`
- Create: `src/donna/tools/calories/index.ts`
- Modify: `src/donna/tools/index.ts`

- [ ] **Step 1: Write `get_meal_history.ts`**

```typescript
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../../brain.js";
import { getTurnContext } from "../../context.js";
import { getMealHistory } from "../../calories/summary.js";

const PTC_CALLER = "code_execution_20250825" as const;

interface GetMealHistoryInput { start: string; end: string }

export const getMealHistoryTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "get_meal_history",
  description: `list meals in a date range (inclusive). dates are YYYY-MM-DD in user tz.

use when the user asks "what did i have monday", "show me last week", or when computing a weekly recap.

returns: array of meal rows with totals + raw_input + confidence.`,
  input_schema: {
    type: "object",
    properties: {
      start: { type: "string" },
      end: { type: "string" },
    },
    required: ["start", "end"],
  },
  // @ts-expect-error allowed_callers is a beta-tool field not in the public types yet
  allowed_callers: [PTC_CALLER],
  modes: new Set<BrainMode>(["reactive", "proactive"]),
};

export async function getMealHistoryHandler(input: unknown): Promise<unknown> {
  const i = (input ?? {}) as GetMealHistoryInput;
  if (!i.start || !i.end) throw new Error("get_meal_history: start + end required");
  const ctx = getTurnContext();
  const meals = await getMealHistory({ userId: ctx.userId, start: i.start, end: i.end });
  return { meals };
}
```

- [ ] **Step 2: Write `list_meal_aliases.ts`**

```typescript
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../../brain.js";
import { getTurnContext } from "../../context.js";
import { listAliases } from "../../calories/aliases.js";

const PTC_CALLER = "code_execution_20250825" as const;

export const listMealAliasesTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "list_meal_aliases",
  description: `list all saved meal aliases for the user.

use when the user asks "what did i save" or before logging by alias to confirm the name.

returns: { aliases: [{alias, items_summary}] } — items_summary is the first item name + count.`,
  input_schema: { type: "object", properties: {} },
  // @ts-expect-error allowed_callers is a beta-tool field not in the public types yet
  allowed_callers: [PTC_CALLER],
  modes: new Set<BrainMode>(["reactive"]),
};

export async function listMealAliasesHandler(): Promise<unknown> {
  const ctx = getTurnContext();
  const rows = await listAliases(ctx.userId);
  return {
    aliases: rows.map((r) => ({
      alias: r.alias,
      items_summary: r.template.length === 0
        ? "(empty)"
        : `${r.template[0].name}${r.template.length > 1 ? ` +${r.template.length - 1}` : ""}`,
    })),
  };
}
```

- [ ] **Step 3: Write barrel `index.ts`**

```typescript
export { logMealTool, logMealHandler } from "./log_meal.js";
export { updateMealTool, updateMealHandler } from "./update_meal.js";
export { deleteMealTool, deleteMealHandler } from "./delete_meal.js";
export { setFoodGoalTool, setFoodGoalHandler } from "./set_food_goal.js";
export { saveMealAliasTool, saveMealAliasHandler } from "./save_meal_alias.js";
export { logMealFromAliasTool, logMealFromAliasHandler } from "./log_meal_from_alias.js";
export { parseFoodTextTool, parseFoodTextHandler } from "./parse_food_text.js";
export { lookupFoodTool, lookupFoodHandler } from "./lookup_food.js";
export { getFoodGoalTool, getFoodGoalHandler } from "./get_food_goal.js";
export { getDailySummaryTool, getDailySummaryHandler } from "./get_daily_summary.js";
export { getMealHistoryTool, getMealHistoryHandler } from "./get_meal_history.js";
export { listMealAliasesTool, listMealAliasesHandler } from "./list_meal_aliases.js";
```

- [ ] **Step 4: Wire into `src/donna/tools/index.ts`**

Add import block after the existing imports (near line 33):

```typescript
import {
  logMealTool, logMealHandler,
  updateMealTool, updateMealHandler,
  deleteMealTool, deleteMealHandler,
  setFoodGoalTool, setFoodGoalHandler,
  saveMealAliasTool, saveMealAliasHandler,
  logMealFromAliasTool, logMealFromAliasHandler,
  parseFoodTextTool, parseFoodTextHandler,
  lookupFoodTool, lookupFoodHandler,
  getFoodGoalTool, getFoodGoalHandler,
  getDailySummaryTool, getDailySummaryHandler,
  getMealHistoryTool, getMealHistoryHandler,
  listMealAliasesTool, listMealAliasesHandler,
} from "./calories/index.js";
```

Append to `tool_definitions` array (before the closing `]`):

```typescript
  // calorie tracker (12 tools — direct writes + ptc reads)
  logMealTool,
  updateMealTool,
  deleteMealTool,
  setFoodGoalTool,
  saveMealAliasTool,
  logMealFromAliasTool,
  parseFoodTextTool,
  lookupFoodTool,
  getFoodGoalTool,
  getDailySummaryTool,
  getMealHistoryTool,
  listMealAliasesTool,
```

Append to `tool_handlers` map (before the closing `}`):

```typescript
  log_meal: logMealHandler,
  update_meal: updateMealHandler,
  delete_meal: deleteMealHandler,
  set_food_goal: setFoodGoalHandler,
  save_meal_alias: saveMealAliasHandler,
  log_meal_from_alias: logMealFromAliasHandler,
  parse_food_text: parseFoodTextHandler,
  lookup_food: lookupFoodHandler,
  get_food_goal: getFoodGoalHandler,
  get_daily_summary: getDailySummaryHandler,
  get_meal_history: getMealHistoryHandler,
  list_meal_aliases: listMealAliasesHandler,
```

Append to `PTC_ELIGIBLE` set:

```typescript
  "parse_food_text",
  "lookup_food",
  "get_food_goal",
  "get_daily_summary",
  "get_meal_history",
  "list_meal_aliases",
```

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Inspect prompt to confirm registration**

```bash
npm run inspect
```

Expected: 12 new tool names appear in the printed tools block. PTC_ELIGIBLE check shows the 6 read tools.

- [ ] **Step 7: Commit**

```bash
git add src/donna/tools/calories/ src/donna/tools/index.ts
git commit -m "feat(calories): register all 12 calorie tools in the registry"
```

---

## Task 10: Multimodal user message — wire whatsapp media into anthropic content blocks

**Files:**
- Modify: `src/server.ts`

The IngressPayload already carries `image` / `voice` `fileBytes` from `ingress/whatsapp.ts`. Today `dispatchPayload` skips non-text and sends a wave reaction (server.ts:109-141). We change that branch so a media payload becomes a multimodal user message instead of a wave.

- [ ] **Step 1: Read the current dispatch logic**

```bash
sed -n '100,180p' src/server.ts
```

Note the `text = payload.message?.trim()` check and the `runTurn` call shape at ~line 170.

- [ ] **Step 2: Add a multimodal builder**

In `src/server.ts`, near the top (after imports), add:

```typescript
import { uploadMealMedia } from "./donna/calories/storage.js";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages";

async function buildUserContentBlocks(args: {
  userId: string;
  payload: IngressPayload;
}): Promise<{ blocks: ContentBlockParam[]; transcribedText: string | null }> {
  const blocks: ContentBlockParam[] = [];
  let transcribedText: string | null = null;
  const { payload, userId } = args;

  if (payload.image && payload.platformMessageId) {
    // persist for dashboard / re-render later
    void uploadMealMedia({
      userId,
      messageId: payload.platformMessageId,
      bytes: payload.image.fileBytes,
      mimeType: payload.image.mimeType,
    }).catch((err) => console.warn(`[wa] image upload failed: ${err}`));

    blocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: payload.image.mimeType as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
        data: Buffer.from(payload.image.fileBytes).toString("base64"),
      },
    });
  }

  if (payload.voice && payload.platformMessageId) {
    // upload + transcribe; transcript becomes a text block
    const { transcribeAudio } = await import("./donna/integrations/whisper.js");
    void uploadMealMedia({
      userId,
      messageId: payload.platformMessageId,
      bytes: payload.voice.fileBytes,
      mimeType: payload.voice.mimeType,
    }).catch((err) => console.warn(`[wa] voice upload failed: ${err}`));

    try {
      transcribedText = await transcribeAudio({
        bytes: payload.voice.fileBytes,
        mimeType: payload.voice.mimeType,
      });
    } catch (err) {
      console.warn(`[wa] whisper transcribe failed: ${err}`);
    }
  }

  const composedText = [
    transcribedText ? `(voice note) ${transcribedText}` : null,
    payload.message?.trim() || null,
    payload.image && !payload.message ? "(photo)" : null,
  ].filter(Boolean).join("\n");

  if (composedText) {
    blocks.push({ type: "text", text: composedText });
  }
  return { blocks, transcribedText };
}
```

(Whisper module is created in Task 12; keep this dynamic-import path so this task can ship before whisper exists. If `whisper.js` is missing at runtime, the catch falls through and the voice block is silently dropped — wave reaction still happens via the empty-blocks branch below.)

- [ ] **Step 3: Replace the non-text-payload branch in `dispatchPayload`**

Replace the block at server.ts:109-141 (the `if (!text)` branch that sends a wave reaction) with:

```typescript
  const built = await buildUserContentBlocks({ userId: user.id, payload });
  if (built.blocks.length === 0) {
    // genuinely empty inbound (no text, no media, or media we couldn't handle)
    if (payload.platformMessageId) {
      void wa.sendReaction(payload.phone, payload.platformMessageId, "👋").catch(() => undefined);
    }
    await recordExecutionEvent(runId, "brain_skipped", "no_content", {
      message_type: payload.messageType,
    });
    await finishExecutionRun(runId, { status: "completed", terminator: "brain_skipped", finalSends: [] });
    return;
  }
  if (built.transcribedText) {
    await recordExecutionEvent(runId, "voice_transcribed", "whisper", {
      length: built.transcribedText.length,
    });
  }
  if (payload.image) {
    await recordExecutionEvent(runId, "image_attached", "whatsapp", {
      mime: payload.image.mimeType,
    });
  }
```

- [ ] **Step 4: Pass the blocks into runTurn**

`runTurn` accepts `userInput: string` for reactive turns. We need to extend that to allow either a string OR a content-block array. Check `brain.ts:73-77` (`RunTurnArgsReactive`).

In `src/donna/brain.ts`, change `userInput: string` to:

```typescript
  userInput: string | ContentBlockParam[];
```

(Add `ContentBlockParam` to the imports at the top of brain.ts if not already there.)

Where `userInput` is consumed inside `runTurn` to push the user message, branch on type:

```typescript
const userMessage: MessageParam = {
  role: "user",
  content: typeof userInput === "string" ? userInput : userInput,
};
```

(`MessageParam.content` already accepts `string | ContentBlockParam[]` per the SDK types — no further plumbing needed.)

- [ ] **Step 5: Wire blocks through dispatchPayload**

Replace the existing `runTurn({ ... userInput: text, ...})` call shape so it uses `built.blocks` when there's media:

```typescript
const turnInput: string | ContentBlockParam[] =
  built.blocks.length === 1 && built.blocks[0].type === "text"
    ? built.blocks[0].text
    : built.blocks;

result = await runTurn({
  mode: "reactive",
  messages,
  userInput: turnInput,
  userId: user.id,
  source: "whatsapp",
  runId,
  langsmithExtra: {
    tags: ["whatsapp", "reactive"],
    metadata: {
      message_type: payload.messageType,
      has_image: Boolean(payload.image),
      has_voice: Boolean(payload.voice),
    },
  },
});
```

(Keep the existing langsmith metadata fields you find around server.ts:177; only the `userInput` line and the metadata additions are new.)

- [ ] **Step 6: Update `memory/inbound.ts` save path if needed**

Find where the user message is persisted (`saveMessage` or similar around `memory/chat.ts`). The persisted `content` should be the *string* form when text-only, or a *string description* when media so chat history stays readable. Check existing logic — if it already serializes content blocks, leave it; otherwise add a fallback that joins text blocks for storage.

```bash
grep -n "saveMessage\|chat_messages" src/donna/memory/chat.ts
```

Inspect; the goal is just that history loads correctly on the next turn.

- [ ] **Step 7: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Manual smoke (text-only path still works)**

```bash
npm run wa
# from another terminal: curl your /webhook with a text payload OR send a real text whatsapp message
```

Expected: text turn completes normally (the new code paths are inert for text-only). Logs show `inbound_received` then a normal flow.

- [ ] **Step 9: Commit**

```bash
git add src/server.ts src/donna/brain.ts
git commit -m "feat(calories): multimodal user message — wire whatsapp media into anthropic blocks"
```

---

## Task 11: Linq media fetch (iMessage)

**Files:**
- Modify: `src/donna/ingress/imessage.ts`

Linq sends media `parts` with `url` + `mime_type`. We need to fetch them so the iMessage `IngressPayload` carries `fileBytes` like the whatsapp adapter does.

- [ ] **Step 1: Add a fetch helper**

In `src/donna/ingress/imessage.ts`, after `inferMessageType` (line ~191), add:

```typescript
async function fetchMediaPart(part: LinqMessagePart): Promise<{
  bytes: Uint8Array;
  mimeType: string;
} | null> {
  if (part.type !== "media" || !part.url) return null;
  try {
    const res = await fetch(part.url);
    if (!res.ok) {
      console.warn(`[imessage] media fetch ${part.url}: ${res.status}`);
      return null;
    }
    const buf = await res.arrayBuffer();
    return {
      bytes: new Uint8Array(buf),
      mimeType: part.mime_type ?? "application/octet-stream",
    };
  } catch (err) {
    console.warn(`[imessage] media fetch threw: ${err}`);
    return null;
  }
}

async function collectFirstMedia(parts: LinqMessagePart[]): Promise<{
  image?: { fileBytes: Uint8Array; mimeType: string };
  voice?: { fileBytes: Uint8Array; mimeType: string };
  document?: { fileBytes: Uint8Array; mimeType: string; filename: string };
} | null> {
  for (const p of parts) {
    if (p.type !== "media") continue;
    const fetched = await fetchMediaPart(p);
    if (!fetched) continue;
    const mime = fetched.mimeType.toLowerCase();
    if (mime.startsWith("image/")) {
      return { image: { fileBytes: fetched.bytes, mimeType: fetched.mimeType } };
    }
    if (mime.startsWith("audio/")) {
      return { voice: { fileBytes: fetched.bytes, mimeType: fetched.mimeType } };
    }
    return {
      document: {
        fileBytes: fetched.bytes,
        mimeType: fetched.mimeType,
        filename: p.filename ?? "attachment",
      },
    };
  }
  return null;
}
```

- [ ] **Step 2: Plumb media into the payload**

Replace the payload construction at imessage.ts:155-165 with:

```typescript
  const media = await collectFirstMedia(data.parts ?? []);

  const payload: IngressPayload = {
    userId: "",
    phone: sender,
    message: text,
    messageType,
    image: media?.image,
    voice: media?.voice,
    document: media?.document,
    source: "imessage",
    platformMessageId: data.id ?? null,
    platformProfileName: null,
    replyToId: null,
    chatId: data.chat?.id ?? null,
  };
```

- [ ] **Step 3: Mirror dispatchPayload's media handling for imessage**

Find `dispatchImessagePayload` in `src/server.ts` (around line 266). Apply the same `buildUserContentBlocks` + branching as Task 10 step 3, but with `"imessage"` everywhere `"whatsapp"` was used.

(Refactor opportunity: if both dispatch functions now share the multimodal blocks logic verbatim, extract it into a private helper called by both. Don't over-engineer — extract only if the two are byte-identical after this task.)

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/donna/ingress/imessage.ts src/server.ts
git commit -m "feat(calories): linq media fetch — image/voice/document into IngressPayload"
```

---

## Task 12: Whisper voice transcription

**Files:**
- Create: `src/donna/integrations/whisper.ts`

- [ ] **Step 1: Write the whisper client**

```typescript
// openai whisper-1 transcription. stateless rest client, called from
// server.ts when ingress yields a voice IngressPayload.

const WHISPER_URL = "https://api.openai.com/v1/audio/transcriptions";
const MAX_BYTES = 25 * 1024 * 1024; // openai per-file cap

interface TranscribeArgs {
  bytes: Uint8Array;
  mimeType: string;
  language?: string;
}

export async function transcribeAudio(args: TranscribeArgs): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("whisper: OPENAI_API_KEY not set");
  if (args.bytes.byteLength > MAX_BYTES) {
    throw new Error(`whisper: audio too large (${args.bytes.byteLength} bytes > 25MB)`);
  }

  const ext = args.mimeType.split("/")[1]?.split(";")[0] || "ogg";
  const blob = new Blob([args.bytes as BlobPart], { type: args.mimeType });
  const form = new FormData();
  form.append("file", blob, `audio.${ext}`);
  form.append("model", "whisper-1");
  if (args.language) form.append("language", args.language);
  form.append("response_format", "json");

  const res = await fetch(WHISPER_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`whisper: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { text?: string };
  return (json.text ?? "").trim();
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: PASS. The dynamic import in server.ts (Task 10 step 2) now resolves; voice transcription becomes live.

- [ ] **Step 3: Commit**

```bash
git add src/donna/integrations/whisper.ts
git commit -m "feat(calories): openai whisper-1 client for voice transcription"
```

---

## Task 13: Prompt update — `<calorie_logging>`

**Files:**
- Modify: `src/donna/prompt.ts`

- [ ] **Step 1: Drop the "you can only see text" line**

In `prompt.ts` around line 38, edit `<whatsapp_rules>`:

```typescript
- non-text inbound (voice notes, photos, reactions): you can only see text right now. don't pretend you saw something you didn't.
```

Replace with:

```typescript
- non-text inbound: photos and voice notes are passed in directly. images arrive as image content blocks; voice notes arrive transcribed with a "(voice note)" marker. read them like any other message.
```

- [ ] **Step 2: Add `<calorie_logging>` section**

Append after the `<inbox_copilot_intents>` block (before the closing backtick of `REACTIVE_SYSTEM_PROMPT`):

```typescript
<calorie_logging>
the user logs meals casually, in passing, while talking about other things. it is YOUR job to recognize a meal log without being asked.

what counts as a meal log:
- declarative food statements: "had two eggs", "ate a sandwich", "just finished dinner"
- a photo of food, a plate, packaged items, a restaurant table
- a voice note describing what they ate
- "i'm having X right now"
- "log my usual" / "same as yesterday's lunch" → fast-path through log_meal_from_alias

what is NOT a meal log:
- questions about food: "is salmon healthy?", "what's a good lunch?"
- hypothetical: "thinking of getting pizza", "should i order sushi"
- recipe / cooking discussions
- talk about someone else's meal: "she had pasta"
- nutrition questions in the abstract

when you detect a meal log, this is the discipline:

1. inside python (code_execution), fan out in parallel:
   - parse_food_text(description) — canonical macros from nutritionix
   - get_food_goal() — the user's targets (may be null)
   - get_daily_summary() — running totals for today
2. read the digest. compose item array with these confidence rules:
   - all items returned by nutritionix → confidence "high", parser "nutritionix"
   - some matched, others you estimated → confidence "medium", parser "mixed"
   - nutritionix returned nothing → confidence "low", parser "llm" (your estimates only)
3. call log_meal directly (NOT from python) with the items. include source_kind (text|photo|voice|alias|edit), source_message_id when known, raw_input (the user's words / transcript), vision_description if there was a photo.
4. terminator burst — three short bubbles:
   - line 1: confirm what you logged ("logged: 2 eggs + toast")
   - line 2: macros ("≈420 kcal • 22p / 28c / 24f")
   - line 3: running total vs goal ("1240 / 2200 today, on track" — or just running total if no goal set)

photo handling specifically:
- describe what you see in vision_description before parse_food_text. e.g. "plate with about 2 scrambled eggs, 1 slice toast, half avocado, black coffee".
- pass that description to parse_food_text. when uncertain ("looks like 2 eggs but might be 1 large"), pick the lower estimate and tell the user in the burst so they can correct.

voice handling:
- the inbound user message will start with "(voice note)" followed by the transcript. treat the transcript as the raw_input.

corrections ("actually one egg, not two", "that was at 1pm not noon"):
- call get_meal_history(today, today) inside python, find the most recent meal
- call update_meal with the corrected items (re-run parse_food_text first if items changed)
- confirm in the burst: "fixed: 1 egg + toast — 320 kcal"

retractions ("i didn't actually eat that"):
- delete_meal on the most recent meal. confirm.

never:
- never log something the user didn't claim. "thinking of pizza" is not a log.
- never dump full meal lists in the burst.
- never re-state macros the user didn't ask for.
- never log from inside python — log_meal is direct-only.
- never invent macros without nutritionix; if it returned nothing, mark confidence "low" and tell the user.

aliases:
- "save this as my usual breakfast" → save_meal_alias(alias="usual breakfast")
- "log my usual" → log_meal_from_alias(alias="usual breakfast"). if you're not sure which alias, list_meal_aliases first.

goals:
- when the user states a target ("track me to 2200 a day", "i want 180g protein"), call set_food_goal. confirm in one bubble.
- when they say "stop nudging me" → set_food_goal(proactive_nudges=false).
</calorie_logging>
```

- [ ] **Step 3: Update the `<tools>` section to enumerate calorie tools**

Inside the existing `<tools>` block (around line 41-58), append after the gmail tools:

```typescript
direct-only (calorie tracker):
- log_meal({items, source_kind, confidence, parser, ...}): persist a meal you just parsed. items[] from parse_food_text or your own estimate.
- update_meal({meal_id, items?, ...}): edit a logged meal in place.
- delete_meal({meal_id}): soft delete.
- set_food_goal({goal_kind?, daily_kcal?, daily_protein_g?, ..., proactive_nudges?, timezone?}): upsert daily target.
- save_meal_alias({alias, meal_id?}): snapshot current/specified meal as a named template.
- log_meal_from_alias({alias, occurred_at?, meal_type?}): fast-path log "my usual breakfast".

ptc-callable (calorie tracker):
- parse_food_text({text}): nutritionix nl. returns items with kcal/p/c/f/fiber/sodium.
- lookup_food({query, limit?}): instant search when a description was ambiguous.
- get_food_goal(): current goal row or null.
- get_daily_summary({date?}): aggregated totals + delta vs goal + meal list for date (default today user tz).
- get_meal_history({start, end}): meals in inclusive YYYY-MM-DD range.
- list_meal_aliases(): saved aliases.
```

- [ ] **Step 4: Inspect**

```bash
npm run inspect
```

Expected: the new `<calorie_logging>` section appears in the printed system prompt; calorie tool blurbs appear in `<tools>`; tools list shows 12 calorie tools registered; tokens still cache (verify `cache_read_input_tokens` over multiple turns, not just one — see CLAUDE.md sharp edges).

- [ ] **Step 5: Commit**

```bash
git add src/donna/prompt.ts
git commit -m "feat(calories): <calorie_logging> prompt section + tool catalog update"
```

---

## Task 14: Three-meal manual e2e (acceptance gate)

**Files:** none. This is a behavioral verification, not code.

The whole point of v1 — three real meals end-to-end. Anything that fails here is a bug, not a feature gap.

- [ ] **Step 1: Set baseline**

In a fresh terminal:

```bash
npm run wa
```

In another terminal, prepare to watch:

```bash
psql "$DATABASE_URL" -c "select id, source_kind, total_kcal, confidence, parser, raw_input from meals where user_id = '$DONNA_USER_ID' order by occurred_at desc limit 5"
```

- [ ] **Step 2: Set a goal**

From your whatsapp: "track me to 2200 kcal a day, 160g protein"

Expected:
- donna calls `set_food_goal`
- burst confirms ("locked in: 2200 kcal, 160g protein")
- `psql -c "select * from food_goals"` shows the row

- [ ] **Step 3: Meal 1 — text**

Send: `had two eggs and toast for breakfast`

Expected:
- `inbound_received` event with `message_type: "text"`
- python calls `parse_food_text("two eggs and toast")` → `nutritionix_hit` event
- direct call to `log_meal` → `meal_logged` event
- burst with three lines: confirmation, macros, running total
- meals row exists with `source_kind = "text"`, `confidence = "high"`, `parser = "nutritionix"`
- meal_items has 2-3 rows (eggs, toast)

- [ ] **Step 4: Meal 2 — photo**

Send a clear photo of a plate (e.g. salmon + rice + greens) with no caption.

Expected:
- `inbound_received` event with `message_type: "image"`
- `image_attached` event
- meals row with `source_kind = "photo"`, `vision_description` populated
- meal_items reflect what was on the plate
- meal photo appears in `meal_media/{user_id}/...` in supabase storage

If donna doesn't recognize the photo as a meal log, that's a prompt bug — go back to Task 13 and tighten the heuristics. If she recognizes but parse fails, look at `nutritionix_miss` events in /debug/runs.

- [ ] **Step 5: Meal 3 — voice**

Record and send a voice note: "for dinner i had a chicken caesar wrap and a coke"

Expected:
- `inbound_received` event with `message_type: "voice"`
- `voice_transcribed` event with the transcript length
- meals row with `source_kind = "voice"`, `raw_input` starting with "(voice note)"
- meal_items match the voice description

- [ ] **Step 6: Edit**

Send: `actually that wasn't a coke, it was diet coke`

Expected:
- python `get_meal_history(today, today)` finds the dinner meal
- `update_meal` called → `meal_edited` event
- meal_items for that meal now show diet coke instead of coke
- burst confirms

- [ ] **Step 7: Daily summary**

Send: `how am i doing today`

Expected:
- python `get_daily_summary()` called
- burst with totals + delta vs goal in 1-2 lines

- [ ] **Step 8: Verify totals match**

```bash
psql "$DATABASE_URL" <<SQL
select
  date(occurred_at at time zone 'Asia/Singapore') as day,
  sum(total_kcal) as kcal,
  sum(total_protein_g) as protein,
  count(*) as meals
from meals
where user_id = '$DONNA_USER_ID'
  and not is_deleted
  and date(occurred_at at time zone 'Asia/Singapore') = current_date
group by 1;
SQL
```

Expected: matches what donna reported in the daily summary burst.

- [ ] **Step 9: Check observability**

Open `/debug/runs` (`Authorization: Bearer $DONNA_OBSERVABILITY_TOKEN`). Confirm event timeline for all three meal turns includes the new labels. Any unexpected `meal_edited` / `meal_deleted` is a bug.

- [ ] **Step 10: No commit**

This task is a behavioral gate. Take notes on any rough edges; capture as Task 14b if anything needs a fix before charts/proactivity.

---

## Task 15: Charts (`get_weekly_chart`)

**Files:**
- Create: `src/donna/calories/chart.ts`
- Create: `src/donna/tools/calories/get_weekly_chart.ts`
- Modify: `src/donna/tools/calories/index.ts`
- Modify: `src/donna/tools/index.ts`

- [ ] **Step 1: Write `chart.ts`**

```typescript
import { ChartJSNodeCanvas } from "chartjs-node-canvas";
import type { MealRow } from "./types.js";

const WIDTH = 1080;
const HEIGHT = 1080;

const canvas = new ChartJSNodeCanvas({
  width: WIDTH,
  height: HEIGHT,
  backgroundColour: "white",
});

interface DayBucket {
  date: string;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  kcal: number;
}

function bucketize(meals: MealRow[], days: string[], tz: string): DayBucket[] {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: tz });
  const map = new Map<string, DayBucket>();
  for (const d of days) map.set(d, { date: d, protein_g: 0, carbs_g: 0, fat_g: 0, kcal: 0 });
  for (const m of meals) {
    const d = formatter.format(new Date(m.occurred_at));
    const b = map.get(d);
    if (!b) continue;
    b.protein_g += Number(m.total_protein_g);
    b.carbs_g += Number(m.total_carbs_g);
    b.fat_g += Number(m.total_fat_g);
    b.kcal += Number(m.total_kcal);
  }
  return days.map((d) => map.get(d)!);
}

export interface RenderArgs {
  meals: MealRow[];
  days: string[]; // YYYY-MM-DD asc, length 7
  tz: string;
  goalKcal: number | null;
  title: string;
}

export async function renderWeeklyChart(args: RenderArgs): Promise<Uint8Array> {
  const buckets = bucketize(args.meals, args.days, args.tz);
  const labels = args.days.map((d) => d.slice(5)); // MM-DD
  const protein = buckets.map((b) => Math.round(b.protein_g * 4));
  const carbs   = buckets.map((b) => Math.round(b.carbs_g * 4));
  const fat     = buckets.map((b) => Math.round(b.fat_g * 9));
  const goalLine = args.goalKcal ? Array(7).fill(args.goalKcal) : [];

  const cfg = {
    type: "bar" as const,
    data: {
      labels,
      datasets: [
        { label: "protein (kcal)", data: protein, backgroundColor: "#4ade80" },
        { label: "carbs (kcal)",   data: carbs,   backgroundColor: "#60a5fa" },
        { label: "fat (kcal)",     data: fat,     backgroundColor: "#facc15" },
        ...(goalLine.length
          ? [{
              label: "goal", data: goalLine, type: "line" as const,
              borderColor: "#dc2626", borderDash: [6, 6], pointRadius: 0, fill: false,
            }]
          : []),
      ],
    },
    options: {
      responsive: false,
      plugins: {
        title: { display: true, text: args.title, font: { size: 28 } },
        legend: { position: "bottom" as const },
      },
      scales: {
        x: { stacked: true },
        y: { stacked: true, title: { display: true, text: "kcal" } },
      },
    },
  };

  return await canvas.renderToBuffer(cfg);
}
```

- [ ] **Step 2: Write `get_weekly_chart.ts`**

```typescript
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../../brain.js";
import { getTurnContext } from "../../context.js";
import { getMealHistory } from "../../calories/summary.js";
import { getGoal } from "../../calories/goals.js";
import { renderWeeklyChart } from "../../calories/chart.js";
import { uploadChartPng } from "../../calories/storage.js";
import { recordExecutionEvent } from "../../observability/execution.js";

const PTC_CALLER = "code_execution_20250825" as const;

interface GetWeeklyChartInput { end_date?: string }

function isoWeekId(d: Date, tz: string): string {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz });
  const ymd = f.format(d);
  const date = new Date(`${ymd}T00:00:00Z`);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const day = (date.getTime() - yearStart.getTime()) / 86400000;
  const week = Math.ceil((day + yearStart.getUTCDay() + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function lastSevenDays(end: string): string[] {
  const out: string[] = [];
  const d = new Date(`${end}T00:00:00Z`);
  for (let i = 6; i >= 0; i--) {
    const day = new Date(d.getTime() - i * 86400000);
    out.push(day.toISOString().slice(0, 10));
  }
  return out;
}

export const getWeeklyChartTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "get_weekly_chart",
  description: `render a stacked-bar chart of the last 7 days (kcal/day, broken into protein/carbs/fat with a goal line). uploads a png to supabase storage and returns a signed url + 1-line summary.

returns: { signed_url, summary: "last 7 days, avg X kcal/day", days: [...] }.

attach the signed_url as an image content block in the next send_burst — whatsapp / imessage will render it inline.`,
  input_schema: {
    type: "object",
    properties: { end_date: { type: "string", description: "YYYY-MM-DD; default today user tz." } },
  },
  // @ts-expect-error allowed_callers is a beta-tool field not in the public types yet
  allowed_callers: [PTC_CALLER],
  modes: new Set<BrainMode>(["reactive", "proactive"]),
};

export async function getWeeklyChartHandler(input: unknown): Promise<unknown> {
  const i = (input ?? {}) as GetWeeklyChartInput;
  const ctx = getTurnContext();
  const goal = await getGoal(ctx.userId);
  const tz = goal?.timezone ?? "Asia/Singapore";
  const end = i.end_date ?? new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
  const days = lastSevenDays(end);
  const meals = await getMealHistory({ userId: ctx.userId, start: days[0], end: days[6] });

  const totalKcal = meals.reduce((acc, m) => acc + Number(m.total_kcal), 0);
  const avg = Math.round(totalKcal / 7);

  const png = await renderWeeklyChart({
    meals,
    days,
    tz,
    goalKcal: goal?.daily_kcal ?? null,
    title: `last 7 days, avg ${avg} kcal/day`,
  });
  const upload = await uploadChartPng({
    userId: ctx.userId,
    isoWeek: isoWeekId(new Date(end), tz),
    bytes: png,
  });
  if (ctx.runId) {
    await recordExecutionEvent(ctx.runId, "chart_generated", "calories", {
      iso_week: isoWeekId(new Date(end), tz),
      meals: meals.length,
    });
  }
  return {
    signed_url: upload.signedUrl,
    summary: `last 7 days, avg ${avg} kcal/day, ${meals.length} meals logged`,
    days,
  };
}
```

- [ ] **Step 3: Add to barrel + registry**

Edit `src/donna/tools/calories/index.ts` — append:

```typescript
export { getWeeklyChartTool, getWeeklyChartHandler } from "./get_weekly_chart.js";
```

Edit `src/donna/tools/index.ts` — add to imports, `tool_definitions`, `tool_handlers`, and `PTC_ELIGIBLE`:

```typescript
import {
  // ...existing calorie imports
  getWeeklyChartTool, getWeeklyChartHandler,
} from "./calories/index.js";
```

Add `getWeeklyChartTool` to `tool_definitions`. Add `get_weekly_chart: getWeeklyChartHandler` to `tool_handlers`. Add `"get_weekly_chart"` to `PTC_ELIGIBLE`.

- [ ] **Step 4: Tell the prompt about it**

Add to `<calorie_logging>` (Task 13's section) under aliases/goals:

```
weekly recap:
- when the user asks "how was last week", "show me my week", "weekly chart", or you're authoring a weekly proactive recap → call get_weekly_chart inside python.
- the signed_url returned can be attached to send_burst as an image. send_burst accepts content blocks per string element when you really need an image — see send_burst docs. or include the url in a text bubble; whatsapp will preview it.
```

(If `send_burst` doesn't currently accept image content blocks, the simplest v1 ships the signed url as a text line — whatsapp auto-previews. Improving send_burst to accept media is a follow-up; flag it but don't block on it.)

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Smoke test**

From whatsapp: "show me my week"

Expected:
- python calls `get_weekly_chart`
- `chart_generated` event in /debug/runs
- supabase storage shows the new png
- burst includes the signed url; whatsapp renders the chart

- [ ] **Step 7: Commit**

```bash
git add src/donna/calories/chart.ts src/donna/tools/calories/get_weekly_chart.ts src/donna/tools/calories/index.ts src/donna/tools/index.ts src/donna/prompt.ts
git commit -m "feat(calories): get_weekly_chart — stacked-bar png via chartjs-node-canvas"
```

---

## Task 16: Proactive nudges

**Files:**
- Modify: `src/donna/tools/calories/set_food_goal.ts` (insert/update donnaschedule rows)
- Modify: `src/donna/prompt.ts` (proactive `<meal_nudge>` section)
- Modify: `src/donna/proactive/cause.ts` (or wherever cause-kind dispatch lives — check the v0.2 spec)

- [ ] **Step 1: Read existing schedule infra**

```bash
cat src/donna/proactive/cause.ts | head -60
ls src/donna/proactive/
grep -n "cause_kind\|donnaschedule" src/donna/ -r | head -30
```

Note the existing cause-kind enum (`scheduled`, `scan_gmail`, `watch_fired`, etc.). We'll add `meal_nudge` and `meal_recap_weekly`.

- [ ] **Step 2: Extend the cause-kind type**

In `src/donna/proactive/cause.ts`, add `"meal_nudge"` and `"meal_recap_weekly"` to the cause kind union. Update `synthesizeCauseMessage` to render a tagged xml block:

```xml
<proactive_cause kind="meal_nudge" set_at="..." slot="lunch">
  daily lunch check-in. user has not logged lunch today as of 13:30 their time.
</proactive_cause>
```

- [ ] **Step 3: Schedule helper**

In `src/donna/calories/goals.ts` add:

```typescript
import { ensureSchedule, deleteSchedules } from "../proactive/schedule.js"; // or whatever the v0.2 helper is named

const NUDGE_SLOTS: Array<{ slot: "breakfast" | "lunch" | "dinner" | "wrap"; cron: string }> = [
  { slot: "breakfast", cron: "30 10 * * *" },
  { slot: "lunch",     cron: "30 13 * * *" },
  { slot: "dinner",    cron: "0 20 * * *" },
  { slot: "wrap",      cron: "30 21 * * *" },
];
const WEEKLY = { slot: "weekly_recap", cron: "0 20 * * 0" };

export async function syncMealNudgeSchedules(args: {
  userId: string;
  enabled: boolean;
  timezone: string;
}): Promise<void> {
  if (!args.enabled) {
    await deleteSchedules({
      userId: args.userId,
      causeKindIn: ["meal_nudge", "meal_recap_weekly"],
    });
    return;
  }
  for (const s of NUDGE_SLOTS) {
    await ensureSchedule({
      userId: args.userId,
      causeKind: "meal_nudge",
      cron: s.cron,
      timezone: args.timezone,
      payload: { slot: s.slot },
    });
  }
  await ensureSchedule({
    userId: args.userId,
    causeKind: "meal_recap_weekly",
    cron: WEEKLY.cron,
    timezone: args.timezone,
    payload: { slot: WEEKLY.slot },
  });
}
```

(Names of `ensureSchedule` / `deleteSchedules` come from the donnaschedule helper in the v0.2 codebase — verify names during implementation. If they don't exist, add a thin wrapper around the schedule table inside `proactive/`.)

- [ ] **Step 4: Wire into `set_food_goal`**

Modify `setFoodGoalHandler` in `src/donna/tools/calories/set_food_goal.ts` after the upsert:

```typescript
import { syncMealNudgeSchedules } from "../../calories/goals.js";

// ...inside the handler, after `const row = await upsertGoal(...)`:
await syncMealNudgeSchedules({
  userId: ctx.userId,
  enabled: row.proactive_nudges,
  timezone: row.timezone,
});
```

- [ ] **Step 5: Add `<meal_nudge>` to PROACTIVE_SYSTEM_PROMPT**

In `src/donna/prompt.ts`, append to `PROACTIVE_SYSTEM_PROMPT` after `<proactive_rules>`:

```typescript
<meal_nudge>
you woke up because the user opted into meal check-ins via set_food_goal. the cause's slot tells you which check-in fired.

before deciding to send:
- inside python, fan out get_daily_summary() and get_food_goal().
- if a meal in this slot has already been logged today (look at meals[].meal_type or occurred_at clusters), call do_nothing(reason="already logged ${slot}").
- if it's quiet hours (00:00-07:00 user tz), do_nothing.
- if the user has logged but is way under goal vs time-of-day, you may send a contextual line. otherwise do_nothing — silence is the default.

when you do send, write one short bubble. examples that work:
  slot=breakfast → "what'd you have for breakfast"
  slot=lunch → "lunch yet"
  slot=dinner → "dinner check-in"
  slot=wrap → 1-bubble end-of-day summary with totals vs goal — only if any meals were logged today. otherwise do_nothing.

never:
  never invent meals on the user's behalf. nudges ask, they do not log.
  never start with "hey" or any greeting. you are continuous.
  never re-explain the system to them. they know what this is.
</meal_nudge>

<meal_recap_weekly>
weekly recap fires sunday 20:00 user tz.

discipline:
1. inside python, call get_weekly_chart() and get_meal_history(start, end) covering the last 7 days.
2. compose a 2-3 bubble burst:
   - one bubble with the signed_url (chart image)
   - one bubble with one sharp observation ("you hit protein 5/7 days, missed friday/saturday")
   - one bubble with one suggested adjustment, only if there's a real pattern
3. if fewer than 3 meals were logged all week → do_nothing(reason="not enough data").
</meal_recap_weekly>
```

- [ ] **Step 6: Typecheck + inspect**

```bash
npm run typecheck && npm run inspect
```

Expected: PASS; new sections appear in PROACTIVE_SYSTEM_PROMPT.

- [ ] **Step 7: Smoke test (manual nudge fire)**

Insert a `donnaschedule` row that fires in 60s with `cause_kind = "meal_nudge"` and `payload = {"slot": "lunch"}`. Wait. Confirm:
- proactive worker picks it up
- runProactiveTurn runs with the synthesized cause
- `nudge_sent` or `nudge_skipped` event lands in /debug/runs
- if a lunch was already logged today, donna picks `do_nothing`

(If you don't want to wait, a manual `world:tick` invocation does the same thing; check `scripts/world-tick.ts`.)

- [ ] **Step 8: Commit**

```bash
git add src/donna/proactive/cause.ts src/donna/calories/goals.ts src/donna/tools/calories/set_food_goal.ts src/donna/prompt.ts
git commit -m "feat(calories): proactive nudges — meal check-ins + weekly recap via donnaschedule"
```

---

## Task 17: Observability event labels (audit + fill gaps)

**Files:**
- Audit only.

This is a clean-up task. Walk through the calorie tool handlers and confirm every meaningful state change emits an `execution_events` row. Spec calls for:

- `meal_detected` (optional — emit before parse_food_text fires inside python; tracking requires a small hook in the brain's tool-call dispatch, see below)
- `meal_logged` (Task 7, log_meal handler) ✓
- `meal_edited` (Task 7, update_meal handler) ✓
- `meal_deleted` (Task 7, delete_meal handler) ✓
- `nutritionix_hit` / `nutritionix_miss` / `nutritionix_cached` (Task 8, parse_food_text handler) ✓
- `nutritionix_lookup` (Task 8, lookup_food handler) ✓
- `vision_described` — emit when claude includes a vision_description in log_meal
- `voice_transcribed` (Task 10, server.ts) ✓
- `chart_generated` (Task 15, get_weekly_chart handler) ✓
- `nudge_sent` / `nudge_skipped` — emit from the proactive turn at terminator selection

- [ ] **Step 1: Add `vision_described` to log_meal**

In `src/donna/tools/calories/log_meal.ts`, in the handler after the insertMeal call:

```typescript
if (ctx.runId && i.vision_description) {
  await recordExecutionEvent(ctx.runId, "vision_described", "calories", {
    meal_id: meal.id,
    description_length: i.vision_description.length,
  });
}
```

- [ ] **Step 2: Add `nudge_sent` / `nudge_skipped` to brain**

In `src/donna/brain.ts`, find where the proactive terminator is recorded (search `terminator` near the end of `runProactiveTurn`). After the terminator is determined, emit:

```typescript
if (mode === "proactive" && cause?.kind === "meal_nudge") {
  await recordExecutionEvent(runId, terminator === "send_burst" ? "nudge_sent" : "nudge_skipped", "calories", {
    slot: (cause.payload as { slot?: string }).slot,
    reason: terminator,
  });
}
```

- [ ] **Step 3: Verify in /debug/runs**

Trigger a meal log + a manual nudge fire. Open /debug/runs. Confirm new labels render in the timeline.

- [ ] **Step 4: Typecheck + commit**

```bash
npm run typecheck
git add src/donna/tools/calories/log_meal.ts src/donna/brain.ts
git commit -m "feat(calories): observability — vision_described, nudge_sent/skipped"
```

---

## Spec coverage check

| Spec section | Task |
|---|---|
| End-to-end flow | 7-12, 14 |
| Macro calc pipeline | 4, 6, 7, 8 |
| Schema (5 tables) | 2 |
| Direct tools | 7, 16 |
| PTC tools | 8, 9, 15 |
| Multimodal ingest (whatsapp) | 10 |
| Multimodal ingest (imessage) | 11 |
| Whisper voice | 12 |
| `<calorie_logging>` prompt | 13 |
| Implicit detection rules | 13 |
| Charts (chartjs-node-canvas) | 15 |
| Proactive nudges (donnaschedule) | 16 |
| Observability labels | 17, plus in-handler emissions across 7-15 |
| Storage layout | 5, 10 |
| Three-meal e2e gate | 14 |

No gaps.

## Out-of-band manual steps (one-time)

- Create supabase storage buckets `meal_media` and `meal_charts` in the dashboard.
- Set env vars: `NUTRITIONIX_APP_ID`, `NUTRITIONIX_API_KEY`, `OPENAI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
- Sign up for Nutritionix developer account (free tier covers personal volume).

## Risks / open items (carried from spec)

- `send_burst` accepting an image content block isn't part of v1 — chart shipping as URL is acceptable; whatsapp auto-previews. If you want inline images, a follow-up plan adds an `images?: string[]` field to `send_burst` input.
- The proactive `ensureSchedule` / `deleteSchedules` helpers may not exist by those exact names in v0.2 — verify and rename in Task 16 step 3.
- Race-on-edit between proactive and reactive turns is acknowledged in spec; no v1 fix.
