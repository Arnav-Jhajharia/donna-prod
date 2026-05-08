-- integrations: per-user, per-provider state + consent settings
-- one row per (user, provider). owns mode/exclusions, oauth status, sync watermarks.

create table if not exists integrations (
  user_id              uuid not null,
  provider             text not null,                                   -- 'gmail', 'gcal', 'imessage', 'notion', ...
  status               text not null default 'connected',               -- 'connected' | 'expired' | 'revoked' | 'error'
  mode                 text not null default 'smart_index',             -- 'search_only' | 'smart_index' | 'full'
  exclusions           jsonb not null default '{"banking":true,"medical":true,"legal":true}'::jsonb,
  config               jsonb not null default '{}'::jsonb,              -- provider-specific knobs
  composio_account_id  text,                                            -- the composio entity/user id with the oauth grant
  last_sync_at         timestamptz,
  last_error           jsonb,
  connected_at         timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  primary key (user_id, provider)
);

create index if not exists integrations_status_idx
  on integrations (status, provider);

-- integration_audit: every read or write donna performs against a user's
-- integration data writes one row here. recoverable + auditable.

create table if not exists integration_audit (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null,
  provider     text not null,
  action       text not null,                                           -- 'read.list' | 'read.search' | 'read.thread' | 'write.draft' | 'write.send' | ...
  item_ref     text,                                                    -- e.g. gmail message id, thread id
  caller       text,                                                    -- 'direct' | 'code_execution' (matches brain caller tagging)
  ok           boolean not null default true,
  duration_ms  integer,
  meta         jsonb not null default '{}'::jsonb,
  occurred_at  timestamptz not null default now()
);

create index if not exists integration_audit_user_provider_time_idx
  on integration_audit (user_id, provider, occurred_at desc);

create index if not exists integration_audit_action_time_idx
  on integration_audit (action, occurred_at desc);

-- donna_state_drafts: minimal start of the working-memory slab.
-- one row per draft she's staged but not yet sent. visible to BRAIN every turn.

create table if not exists donna_state_drafts (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null,
  provider           text not null,                                     -- 'gmail', etc.
  thread_ref         text,                                              -- gmail thread_id or equivalent
  intent             text,                                              -- short string the model wrote when staging
  status             text not null default 'pending_preview',           -- 'pending_preview' | 'previewed' | 'sent' | 'discarded'
  external_draft_id  text,                                              -- the gmail draft_id once the provider has it
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists donna_state_drafts_user_status_idx
  on donna_state_drafts (user_id, status, created_at desc);
