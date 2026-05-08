-- v0.2 proactive substrate.
-- 1. donnaschedule: pending fires for the worker to claim.
-- 2. chat_messages.metadata: round-trip non-content data (synthetic flag, schedule_id, cause_kind).

create table donnaschedule (
  id              uuid          primary key default gen_random_uuid(),
  user_id         uuid          not null references users(id) on delete cascade,
  fire_at         timestamptz   not null,
  cause_kind      text          not null check (cause_kind in ('scheduled', 'scan_gmail', 'watch_fired')),
  cause_payload   jsonb         not null default '{}'::jsonb,
  instruction     text,
  status          text          not null default 'pending'
                    check (status in ('pending', 'claimed', 'fired', 'errored', 'cancelled')),
  created_at      timestamptz   not null default now(),
  claimed_at      timestamptz,
  fired_at        timestamptz,
  errored_at      timestamptz,
  error_message   text,
  created_by      text          not null
                    check (created_by in ('user', 'donna_reactive', 'donna_proactive', 'system'))
);

create index donnaschedule_pending_fire_at
  on donnaschedule (fire_at)
  where status = 'pending';

create index donnaschedule_user_id
  on donnaschedule (user_id);

create index donnaschedule_claimed_recovery
  on donnaschedule (claimed_at)
  where status = 'claimed';

alter table chat_messages
  add column metadata jsonb not null default '{}'::jsonb;
