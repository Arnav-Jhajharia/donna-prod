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
