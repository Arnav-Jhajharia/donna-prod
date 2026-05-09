-- integrations reset: an older codebase created `integrations` and
-- `integration_audit` with a different shape (varchar ids, no mode/config,
-- composio_connection_id instead of composio_account_id). the original
-- 20260507202012_integrations migration used `create table if not exists`
-- and silently no-op'd. this migration drops the legacy tables and applies
-- the canonical schema authoritatively.
--
-- safe at this point in the project: there are no production users; the
-- only rows in the legacy table were leftover slack/googleslides oauth
-- attempts from a prior codebase, none of which are referenced anywhere.

drop table if exists integration_audit cascade;
drop table if exists integrations cascade;

create table integrations (
  user_id              uuid not null,
  provider             text not null,
  status               text not null default 'connected',
  mode                 text not null default 'smart_index',
  exclusions           jsonb not null default '{"banking":true,"medical":true,"legal":true}'::jsonb,
  config               jsonb not null default '{}'::jsonb,
  composio_account_id  text,
  last_sync_at         timestamptz,
  last_error           jsonb,
  connected_at         timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  primary key (user_id, provider)
);

create index integrations_status_idx
  on integrations (status, provider);

create table integration_audit (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null,
  provider     text not null,
  action       text not null,
  item_ref     text,
  caller       text,
  ok           boolean not null default true,
  duration_ms  integer,
  meta         jsonb not null default '{}'::jsonb,
  occurred_at  timestamptz not null default now()
);

create index integration_audit_user_provider_time_idx
  on integration_audit (user_id, provider, occurred_at desc);
