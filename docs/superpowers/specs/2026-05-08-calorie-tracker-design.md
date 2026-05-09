# Calorie Tracker

**Date:** 2026-05-08
**Status:** Brainstorming
**Builds on:** v0.1 (reactive brain, tool registry, integrations service), v0.2 (proactive brain, donnaschedule)

## Purpose

A first-class native feature in donna for tracking what the user eats and computing macros from it. Multimodal — text, photos, voice notes — with implicit detection (no slash commands). Donna recognizes a meal log from context, parses items, computes canonical macros via Nutritionix, persists to a clean schema, and replies with the running daily total. Same data model is dashboard-ready.

This is not a wrapper around an external app. It is a full lifecycle: ingest → parse → log → query → summarize → nudge → recap → edit. Everything lives in donna's own tables and its own tool surface.

## Non-goals (v1)

- Barcode scanning (Open Food Facts) — easy to layer on later via `lookup_food`
- Hydration / water tracking — separate domain
- Weight logs / body measurements — separate
- Social / sharing
- Web dashboard — schema is dashboard-ready, but the UI is its own spec
- Recipe storage / cooking flows
- Multi-user shared meals

## Core principles

1. **Implicit logging.** No `/log` command. The model reads inbound messages and decides "this looks like a meal log." Heuristics live in the system prompt as `<calorie_logging>` xml steering. Counter-examples explicitly listed (recipe questions, restaurant recommendations, dietary debates).

2. **Canonical macros, not vibes.** Per-item macros come from Nutritionix's `/v2/natural/nutrients` endpoint, which is purpose-built for "two slices of pizza and a coke." Their NL endpoint returns serving sizes, kcal, protein, carbs, fat, fiber, sodium, plus `nix_item_id` for branded items. We persist what they return; we don't re-do their math.

3. **LLM as fallback, not primary.** When Nutritionix returns nothing for an item, the model produces an estimate. Confidence flag on the meal row makes this auditable.

4. **One brain, more tools.** No new loop, no parallel pipeline. Calorie work happens inside the existing `runTurn`. Tools follow the existing direct-vs-PTC split.

5. **Dashboard-ready schema.** A future web view reads `meals`, `meal_items`, `food_goals` directly — no tool layer needed for read-only views. All sums are computable from `meal_items`.

6. **Edits are first-class.** "Actually one egg not two" must update the same meal, not append a correction. Soft delete only — never hard delete logged meals.

## End-to-end flow

```
inbound (whatsapp/imessage, text|image|audio)
  → server.ts dispatch
  → ingress: download media (whatsapp graph api / linq url),
             transcribe audio (openai whisper-1), attach images as
             anthropic image content blocks
  → brain.runTurn — claude sees full multimodal user message
  → claude detects meal intent (steered by <calorie_logging> in prompt)
  → ptc python (parallel):
        parse_food_text(description) → nutritionix nl
        get_food_goal()
        get_daily_summary()
  → claude calls log_meal(items, totals, occurred_at, source_kind, ...)
                  direct tool, single tx into meals + meal_items
  → send_burst(["logged: 2 eggs + toast",
                "≈420 kcal • 22p / 28c / 24f",
                "1240 / 2200 today, on track"])
  → execution_runs + execution_events capture the turn timeline
```

## Macro calculation pipeline

For each meal:

1. **Source → text description**
   - Text inbound: passes through verbatim
   - Photo inbound: image block goes into the user message; claude vision describes it ("plate with ~2 scrambled eggs, 1 slice toast, half avocado, black coffee")
   - Voice inbound: audio downloaded → openai whisper-1 → transcribed text replaces audio with `(voice note)` marker prepended
2. **Description → items via `parse_food_text`**
   - PTC tool calls `https://trackapi.nutritionix.com/v2/natural/nutrients` with the text
   - Response is an array of foods with: `food_name`, `serving_qty`, `serving_unit`, `serving_weight_grams`, `nf_calories`, `nf_protein`, `nf_total_carbohydrate`, `nf_total_fat`, `nf_dietary_fiber`, `nf_sodium`, `nix_item_id` (branded), `tag_id` (common)
   - Cached in `food_cache` keyed by normalized query (lowercase, whitespace-collapsed) with 24h ttl
3. **Items → meal via `log_meal`**
   - One transaction: insert `meals` row, then N `meal_items` rows, then update `meals.total_*` from `SUM(meal_items.*)`
   - `confidence` set per the rule below
   - `parser` field: `nutritionix` if all items matched, `mixed` if some, `llm` if none
4. **Confidence**
   - `high`: every item matched in Nutritionix
   - `medium`: some items matched, others LLM-estimated
   - `low`: API returned nothing; all LLM estimates
5. **Daily totals**
   - Computed on read by `get_daily_summary` — `SUM(total_kcal) WHERE user_id = $1 AND date(occurred_at AT TIME ZONE goal_tz) = $2 AND NOT is_deleted`
   - Not stored. Cheap to recompute. Materialized view considered if perf demands later.
6. **Edits via `update_meal`**
   - Re-runs `parse_food_text` on the corrected description
   - Replaces all `meal_items` for the meal (delete + insert in one tx)
   - Recomputes meal totals
   - Soft delete via `is_deleted = true` for "didn't actually eat that"

Branded items ("starbucks venti latte"): Nutritionix's catalog has them. The NL endpoint returns `nix_item_id`. We persist it in `meal_items.nix_id` for traceability and so the dashboard can link to source.

## Schema

All five tables live in a single migration: `supabase/migrations/<ts>_calorie_tracker.sql`.

### `food_goals`

One row per user. Updated in place by `set_food_goal`.

```sql
create table food_goals (
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
```

### `meals`

One row per logged meal. Totals are denormalized for query speed — recomputed inside `log_meal` / `update_meal` so they always equal `SUM(meal_items)`.

```sql
create table meals (
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

create index meals_user_occurred_idx on meals (user_id, occurred_at desc) where not is_deleted;
```

### `meal_items`

One row per food in a meal. Always re-derived from Nutritionix or LLM — never edited in place; replaced as a unit by `update_meal`.

```sql
create table meal_items (
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
```

### `meal_aliases`

User-named meal templates for "log my usual." Snapshot of items at save time.

```sql
create table meal_aliases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  alias text not null,
  template jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, alias)
);
```

`template` is `[{name, quantity, unit, kcal, protein_g, ...}]` — the materialized item rows from the source meal.

### `food_cache`

De-dupe Nutritionix calls across users (cheap requests, common queries). Not user-scoped.

```sql
create table food_cache (
  query_normalized text primary key,
  source text not null check (source in ('nutritionix')),
  raw_response jsonb not null,
  ttl_until timestamptz not null,
  hit_count int not null default 0,
  created_at timestamptz not null default now()
);

create index food_cache_ttl_idx on food_cache (ttl_until);
```

## Tool surface

All under `src/donna/tools/calories/` (one file per tool group). Registered in `tools/index.ts` alongside existing tools.

### Direct (state-changing, main loop only)

| Tool | Purpose |
|---|---|
| `log_meal` | Insert meals + meal_items in one tx. Inputs: `items[]`, `occurred_at?`, `meal_type?`, `source_kind`, `raw_input`, `vision_description?`, `confidence`, `parser`. |
| `update_meal` | Edit a meal: replace items, change time, change meal_type. Re-runs parse if `raw_input` changed. |
| `delete_meal` | Soft delete (`is_deleted = true`). |
| `set_food_goal` | Upsert `food_goals` row. Toggles `proactive_nudges`, sets timezone. |
| `save_meal_alias` | Save current or specified meal as a named alias. |
| `log_meal_from_alias` | Fast path: snapshot alias template into a fresh meal row. |

### PTC-eligible (parallel reads via python sandbox)

| Tool | Purpose |
|---|---|
| `parse_food_text` | Nutritionix NL endpoint, cached. Pure read. Returns structured items + macros. |
| `lookup_food` | Nutritionix instant search for ambiguous items. |
| `get_food_goal` | Read current goal. |
| `get_daily_summary` | Aggregate today's (or any date's) meals + delta vs goal. |
| `get_meal_history` | List meals in a date range. |
| `list_meal_aliases` | Read aliases. |
| `get_weekly_chart` | Render png chart, upload to supabase storage, return signed url + text summary. |

`send_burst` remains the only terminator. Charts attach as `image` content blocks inside the burst (whatsapp/imessage media support).

## Multimodal ingest plumbing

### Photos

**WhatsApp:** webhook payload includes `messages[].image.id`. Resolve via `GET https://graph.facebook.com/v17.0/{media_id}` (auth: `Bearer ${WHATSAPP_TOKEN}`) → media url → second GET for bytes. Stream to supabase storage `meal_media/{user_id}/{message_id}.{ext}` and base64-encode for the anthropic content block.

**iMessage (Linq):** payload includes media url directly (or attachment manifest — verify against current Linq schema during implementation). Same download → store → encode pipeline.

User message becomes:
```ts
{ role: "user", content: [
  { type: "image", source: { type: "base64", media_type: "image/jpeg", data } },
  { type: "text",  text: "(photo) had this for lunch" }
]}
```

### Voice

WhatsApp voice notes arrive as `messages[].audio.id` (ogg/opus). Same media-fetch pipeline. Then:

```ts
const transcript = await openai.audio.transcriptions.create({
  file: bytes,
  model: "whisper-1"
});
```

Replace audio with `(voice note) ${transcript}` text. Store original audio in supabase storage for re-listening / debugging.

### Storage layout

```
meal_media/
  {user_id}/
    {inbound_message_id}.{jpg|png|ogg|m4a}
```

Referenced from `meals.source_message_id`. Dashboard can render the original photo next to the parsed entry.

## Proactive nudges

Wired through existing `donnaschedule` + `world_engine`. When `set_food_goal({proactive_nudges: true})` runs:

1. Compute four daily fire times in user tz (defaults configurable):
   - `10:30` — breakfast check
   - `13:30` — lunch check
   - `20:00` — dinner check
   - `21:30` — end-of-day summary
2. Insert four recurring `donnaschedule` rows with `cause_kind = 'meal_nudge'` and payload `{ slot: 'breakfast' | ... }`.
3. Sunday `20:00` — weekly recap (`cause_kind = 'meal_recap_weekly'`).

Each fire wakes `runProactiveTurn` with the cause. The proactive prompt's `<meal_nudge>` section says:

> "before sending: call `get_daily_summary()`. if a meal in this slot was already logged today, skip via `do_nothing`. if logged but light vs goal, you may still send a contextual ping. respect quiet hours (00:00–07:00 user tz)."

This piggy-backs on the existing proactive infrastructure. No new scheduler, no new worker.

## Charts

Server-side via `chartjs-node-canvas`. Default `get_weekly_chart`:

- Stacked bar: kcal by day for the last 7 days, broken into protein/carbs/fat (4/4/9 kcal-weighted)
- Goal line at `food_goals.daily_kcal`
- Title: "last 7 days, avg X kcal/day"
- 1080×1080 png

Output uploaded to supabase storage `meal_charts/{user_id}/{iso_week}.png` with a signed url (24h expiry, regenerable). Attached to the burst as an image content block.

## Implicit detection prompt steering

New section in `prompt.ts`:

```xml
<calorie_logging>
  the user logs meals casually, in passing, while talking about other things.
  treat any of these as a meal log:
    - declarative food statements: "had two eggs", "ate a sandwich", "just finished dinner"
    - photos of food, plates, packaged items, restaurant tables
    - voice notes describing what they ate
    - "i'm having X right now"

  these are NOT meal logs:
    - questions about food: "is salmon healthy?", "what's a good lunch?"
    - hypothetical: "thinking of getting pizza"
    - recipe / cooking discussions
    - someone else's meal: "she had pasta"

  when you detect a meal log:
    1. inside python sandbox, fan out:
       - parse_food_text(description) for canonical macros
       - get_food_goal() for the user's targets
       - get_daily_summary() for running totals
    2. then call log_meal(...) with the parsed items
    3. terminator burst: 1 line confirming what was logged,
       1 line with macros (kcal • p / c / f),
       1 line with running daily total vs goal

  on edits ("actually one egg, not two"):
    - find the most recent meal with get_meal_history(today)
    - call update_meal with the corrected items
    - confirm in the burst

  never dump full meal lists. never re-state macros the user didn't ask for.
  follow voice rules: lowercase, no markdown, no emoji.
</calorie_logging>
```

## Observability

New `execution_events` labels:

- `meal_detected` — model identified a meal log (logged before tool call)
- `meal_logged` — `log_meal` returned successfully
- `meal_edited` / `meal_deleted`
- `nutritionix_hit` / `nutritionix_miss` — with `query_normalized` in meta
- `nutritionix_cached` — served from `food_cache`
- `vision_described` — claude described a photo
- `voice_transcribed` — whisper produced a transcript
- `chart_generated` — png url + iso_week
- `nudge_sent` / `nudge_skipped` — for proactive ticks

`/debug/runs` already renders the timeline; new labels render automatically.

## Env vars

New required:
- `NUTRITIONIX_APP_ID`
- `NUTRITIONIX_API_KEY`
- `OPENAI_API_KEY` (whisper-1)

New optional:
- `SUPABASE_STORAGE_BUCKET_MEDIA=meal_media` (default)
- `SUPABASE_STORAGE_BUCKET_CHARTS=meal_charts` (default)
- `CALORIE_QUIET_HOURS=00:00-07:00` (proactive suppression window)

Update `.env.example`.

## Testing strategy

Three real meals end-to-end as the v1 acceptance gate:

1. **Text:** "had two eggs and toast for breakfast" — verify Nutritionix parse, meal logged, daily total updated, burst formatted correctly
2. **Photo:** picture of a plate — verify vision description flows into parse, meal logged with `source_kind = 'photo'`, photo persists in storage
3. **Voice:** voice note describing dinner — verify whisper transcribes, transcript flows into parse, meal logged with `source_kind = 'voice'`

Plus one edit ("actually one egg") and one daily summary query to round out v1.

## Out of scope / risks

- **Nutritionix accuracy ceiling**: their NL parser is good but not perfect on Asian / fusion / homemade foods. The `confidence = medium` flag exposes this; we accept it for v1 and revisit if it becomes a complaint.
- **Vision drift**: claude describing a photo introduces variance ("looks like ~2 eggs" vs "1 large egg"). Mitigated by surfacing the description in the burst so the user can correct: "actually 1 egg."
- **Whisper cost**: $0.006/min. Personal volume is fine. Add a guard: skip transcription if audio > 60s and ask the user to text instead.
- **Race on edits**: if user edits while a proactive nudge is being authored, the nudge sees pre-edit data. Acceptable for v1; serialization not worth it yet.
- **Time-zone bugs**: all date logic uses `food_goals.timezone`. `occurred_at` stored UTC, summed in user tz. Tested against the three-meal v1 gate.
- **Composio webhook for nutritionix**: not applicable — Nutritionix is a stateless REST API, not an OAuth integration. Goes through a thin `nutritionix.ts` client, not `integrations/service.ts`.

## Implementation order

1. Migration: 5 tables (food_goals, meals, meal_items, meal_aliases, food_cache)
2. Nutritionix client (`src/donna/integrations/nutritionix.ts`) + cache
3. Direct tools: `set_food_goal`, `log_meal`, `update_meal`, `delete_meal`, `save_meal_alias`, `log_meal_from_alias`
4. PTC tools: `parse_food_text`, `lookup_food`, `get_food_goal`, `get_daily_summary`, `get_meal_history`, `list_meal_aliases`
5. Whatsapp media plumbing in `ingress/payload.ts`
6. iMessage media plumbing in `ingress/imessage.ts`
7. Whisper client + voice pipeline
8. Prompt update: `<calorie_logging>` section
9. Three-meal manual e2e
10. Charts: `chartjs-node-canvas` renderer + storage upload + `get_weekly_chart` tool
11. Proactive nudges: schedule rows + proactive prompt section + cause handling
12. Observability labels in `execution_events`
