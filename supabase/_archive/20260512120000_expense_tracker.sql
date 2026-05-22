-- expense tracker: expense_goals, expenses, expense_items, expense_aliases.
-- multimodal logging (text|photo|voice), free-form merchant + category, optional
-- line items for receipts. soft-delete only on expenses. all monetary fields in
-- minor units (cents) to avoid floats.
--
-- subscriptions are NOT a separate table here — they're a derived view over
-- expenses with is_recurring = true. detection runs on the expense stream and
-- flips that flag (see src/donna/expenses/summary.ts).

create table if not exists expense_goals (
  user_id uuid primary key references users(id) on delete cascade,
  monthly_total_cents bigint,
  daily_total_cents bigint,
  per_category_monthly_cents jsonb,
  currency text not null default 'USD',
  notes text,
  active_from date not null default current_date,
  proactive_nudges boolean not null default true,
  timezone text not null default 'Asia/Singapore',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists expenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  occurred_at timestamptz not null,
  logged_at timestamptz not null default now(),
  merchant text,
  amount_cents bigint not null,
  currency text not null default 'USD',
  category text,
  source_kind text not null check (source_kind in ('text','photo','voice','alias','edit','gmail','plaid')),
  source_message_id text,
  raw_input text,
  vision_description text,
  confidence text check (confidence in ('high','medium','low')),
  parser text check (parser in ('llm','user','gmail','plaid','mixed')),
  is_recurring boolean not null default false,
  recurrence text check (recurrence in ('weekly','monthly','quarterly','yearly')),
  notes text,
  is_deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists expenses_user_occurred_idx
  on expenses (user_id, occurred_at desc) where not is_deleted;

create index if not exists expenses_user_category_idx
  on expenses (user_id, category) where not is_deleted;

create index if not exists expenses_user_recurring_idx
  on expenses (user_id, merchant)
  where not is_deleted and is_recurring;

create table if not exists expense_items (
  id uuid primary key default gen_random_uuid(),
  expense_id uuid not null references expenses(id) on delete cascade,
  position int not null,
  name text not null,
  quantity numeric,
  unit text,
  amount_cents bigint not null,
  category text,
  notes text,
  unique (expense_id, position)
);

create table if not exists expense_aliases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  alias text not null,
  template jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, alias)
);
