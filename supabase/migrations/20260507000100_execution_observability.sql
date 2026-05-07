-- execution_runs + execution_events: durable turn-level observability.
--
-- execution_runs is the envelope for one donna turn. execution_events is the
-- ordered timeline inside that turn: model calls, tool calls, persistence, and
-- delivery steps. Keep payloads compact and avoid storing raw provider secrets.

create table execution_runs (
  id                  uuid          primary key default gen_random_uuid(),
  user_id             uuid          not null references users(id) on delete cascade,
  channel             text          not null,
  mode                text          not null,
  inbound_message_id  text,
  status              text          not null check (status in ('running', 'completed', 'failed')),
  model               text,
  terminator          text,
  final_sends         jsonb         not null default '[]'::jsonb,
  voice_violations    jsonb         not null default '[]'::jsonb,
  metadata            jsonb         not null default '{}'::jsonb,
  error               text,
  started_at          timestamptz   not null default now(),
  ended_at            timestamptz
);

create index idx_execution_runs_user_started
  on execution_runs (user_id, started_at desc);

create index idx_execution_runs_inbound_message
  on execution_runs (inbound_message_id);

create table execution_events (
  id          uuid          primary key default gen_random_uuid(),
  seq         bigserial     not null,
  run_id      uuid          not null references execution_runs(id) on delete cascade,
  type        text          not null,
  name        text,
  payload     jsonb         not null default '{}'::jsonb,
  created_at  timestamptz   not null default now()
);

create index idx_execution_events_run_seq
  on execution_events (run_id, seq asc);
