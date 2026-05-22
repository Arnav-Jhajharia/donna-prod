-- subscriptions tracker. one slice of a future expense-tracker feature; not
-- the whole thing. expense tracker (calorie-tracker-parallel) will live in a
-- separate migration when built.
--
-- shape:
-- 1. subscriptions: one row per (user, vendor). authoritative state — status,
--    recurrence, normalized monthly amount, next renewal.
-- 2. subscription_events: per-charge history (welcome / receipt / renewal /
--    failed / paused / cancelled). source-of-truth for cadence + audit.
-- 3. agendas: generic multi-turn flow state. subscriptions_onboarding is the
--    first kind; later: expense_tracker_onboarding, hiring_pipeline, etc.

create table if not exists subscriptions (
  id                    uuid          primary key default gen_random_uuid(),
  user_id               uuid          not null references users(id) on delete cascade,
  vendor_canonical      text          not null,
  vendor_raw            text,
  status                text          not null default 'unknown'
                          check (status in ('active','paused','failed','cancelled','trial','unknown')),
  recurrence            text          check (recurrence in ('monthly','yearly','weekly','quarterly','custom','one_off')),
  amount_cents          int,
  monthly_amount_cents  int,
  currency              text,
  category              text,
  first_seen_at         timestamptz,
  last_charge_at        timestamptz,
  next_renewal_at       timestamptz,
  source_kind           text          not null
                          check (source_kind in ('gmail_scan','manual','onboarding','agenda')),
  user_confirmed        boolean       not null default false,
  notes                 text,
  is_deleted            boolean       not null default false,
  created_at            timestamptz   not null default now(),
  updated_at            timestamptz   not null default now()
);

-- one active row per (user, vendor). soft-deleted rows allowed alongside.
create unique index if not exists subscriptions_user_vendor_active_uniq
  on subscriptions (user_id, vendor_canonical) where not is_deleted;

create index if not exists subscriptions_user_status_idx
  on subscriptions (user_id, status) where not is_deleted;

create index if not exists subscriptions_user_renewal_idx
  on subscriptions (user_id, next_renewal_at)
  where not is_deleted and next_renewal_at is not null;

create table if not exists subscription_events (
  id              uuid          primary key default gen_random_uuid(),
  subscription_id uuid          not null references subscriptions(id) on delete cascade,
  user_id         uuid          not null references users(id) on delete cascade,
  event_kind      text          not null
                    check (event_kind in ('welcome','receipt','renewal_reminder','failed','paused','cancelled','manual_record')),
  amount_cents    int,
  currency        text,
  occurred_at     timestamptz   not null,
  source_kind     text          not null check (source_kind in ('gmail','manual')),
  source_ref      text,
  raw_subject     text,
  raw_snippet     text,
  created_at      timestamptz   not null default now()
);

-- dedupe re-scans of the same gmail message
create unique index if not exists subscription_events_source_uniq
  on subscription_events (subscription_id, source_kind, source_ref)
  where source_ref is not null;

create index if not exists subscription_events_subscription_occurred_idx
  on subscription_events (subscription_id, occurred_at desc);

create index if not exists subscription_events_user_occurred_idx
  on subscription_events (user_id, occurred_at desc);

create table if not exists agendas (
  id              uuid          primary key default gen_random_uuid(),
  user_id         uuid          not null references users(id) on delete cascade,
  kind            text          not null,
  status          text          not null default 'active'
                    check (status in ('active','completed','abandoned','blocked')),
  current_step    text          not null,
  payload         jsonb         not null default '{}'::jsonb,
  created_at      timestamptz   not null default now(),
  updated_at      timestamptz   not null default now()
);

create index if not exists agendas_user_status_idx
  on agendas (user_id, status);

-- subscriptions_backfills: tracks a one-time gmail-scan run. enables resuming
-- and lets the runtime emit progress / completion as a proactive trigger.
create table if not exists subscriptions_backfills (
  id              uuid          primary key default gen_random_uuid(),
  user_id         uuid          not null references users(id) on delete cascade,
  agenda_id       uuid          references agendas(id) on delete set null,
  status          text          not null default 'pending'
                    check (status in ('pending','running','done','error')),
  lookback_days   int           not null default 180,
  detected_count  int           not null default 0,
  scanned_count   int           not null default 0,
  total_monthly_amount_cents int not null default 0,
  last_error      text,
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz   not null default now()
);

create index if not exists subscriptions_backfills_user_status_idx
  on subscriptions_backfills (user_id, status);
