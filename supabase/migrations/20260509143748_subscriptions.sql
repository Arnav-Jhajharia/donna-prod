-- subscriptions feature
--
-- three tables. all timestamps utc; user_id always required.
--
-- subscriptions       — one row per recurring obligation, the canonical entity
-- subscription_charges — every detected (or user-volunteered) charge instance
-- donna_state_agendas  — minimal multi-turn agenda state (introduced here, used
--                        first by subscriptions_onboarding; same shape supports
--                        any future "donna offers a multi-question setup" flow)

-- ---------------------------------------------------------------------------
-- subscriptions
-- ---------------------------------------------------------------------------

create table if not exists subscriptions (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null,

  merchant_canonical    text not null,                       -- "Netflix", "Spotify" — display name
  merchant_raw          text[] not null default '{}',        -- every variant we've seen
  category              text,                                -- "entertainment" | "software" | "news" | "fitness" | "ai" | "cloud" | "other" | null

  amount_cents          integer,                             -- nullable when uncertain; smallest currency unit
  currency              text,                                -- iso 4217 ("USD" / "SGD" / etc)
  recurrence            text,                                -- "monthly" | "yearly" | "weekly" | "quarterly" | "unknown"

  status                text not null default 'active',      -- 'active' | 'cancelled' | 'paused' | 'uncertain'
  user_confirmed        boolean not null default false,
  confidence            real not null default 0.5,           -- 0..1

  first_seen_at         timestamptz not null default now(),
  last_charged_at       timestamptz,
  next_estimated_at     timestamptz,

  notes                 text,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create unique index if not exists subscriptions_user_canonical_active_idx
  on subscriptions (user_id, lower(merchant_canonical))
  where status != 'cancelled';

create index if not exists subscriptions_user_status_idx
  on subscriptions (user_id, status);

-- ---------------------------------------------------------------------------
-- subscription_charges
-- ---------------------------------------------------------------------------

create table if not exists subscription_charges (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null,
  subscription_id       uuid references subscriptions(id) on delete set null,

  amount_cents          integer not null,
  currency              text not null,
  charged_at            timestamptz not null,

  source_channel        text not null,                       -- 'gmail' | 'user_volunteered' | future: 'bank' | 'paypal' | 'imessage'
  source_ref            text,                                -- gmail msg_id when source=gmail; null when user-volunteered
  evidence_quote        text,                                -- the line/sentence that proved it
  meta                  jsonb not null default '{}'::jsonb,

  created_at            timestamptz not null default now()
);

create index if not exists subscription_charges_user_charged_idx
  on subscription_charges (user_id, charged_at desc);

create index if not exists subscription_charges_sub_idx
  on subscription_charges (subscription_id, charged_at desc);

-- partial unique index for cross-source dedup. user-volunteered charges have
-- source_ref=null and are deliberately allowed to dedupe-on-collision later
-- via the aggregator's merchant+amount+date heuristic, not via this index.
create unique index if not exists subscription_charges_dedup_idx
  on subscription_charges (user_id, source_channel, source_ref)
  where source_ref is not null;

-- ---------------------------------------------------------------------------
-- donna_state_agendas
-- ---------------------------------------------------------------------------

create table if not exists donna_state_agendas (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null,
  kind         text not null,                                -- 'subscriptions_onboarding' (only one for now)
  step         text not null,                                -- 'ask_install' | 'ask_sources' | 'scanning' | 'ask_confirm' | 'done'
  payload      jsonb not null default '{}'::jsonb,
  status       text not null default 'active',               -- 'active' | 'completed' | 'abandoned'
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists donna_state_agendas_user_active_idx
  on donna_state_agendas (user_id, status, kind);
