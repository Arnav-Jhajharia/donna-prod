create table episodes (
  id          uuid          primary key default gen_random_uuid(),
  user_id     uuid          not null,
  start_seq   bigint        not null,
  end_seq     bigint        not null,
  title       text          not null,
  summary     text          not null,
  topics      text[]        not null default '{}',
  metadata    jsonb         not null default '{}',
  created_at  timestamptz   not null default now(),
  updated_at  timestamptz   not null default now(),
  unique (user_id, start_seq, end_seq)
);

create index idx_episodes_user_end_seq
  on episodes (user_id, end_seq desc);

create table facts (
  id                uuid          primary key default gen_random_uuid(),
  user_id           uuid          not null,
  content           text          not null,
  category          text          not null default 'general',
  source_episode_id uuid          references episodes(id) on delete set null,
  confidence        numeric       not null default 0.8,
  status            text          not null default 'active'
    check (status in ('active', 'superseded', 'deleted')),
  metadata          jsonb         not null default '{}',
  created_at        timestamptz   not null default now(),
  updated_at        timestamptz   not null default now()
);

create index idx_facts_user_status
  on facts (user_id, status, updated_at desc);

create unique index idx_facts_user_content_active
  on facts (user_id, lower(content))
  where status = 'active';

create table open_loops (
  id                uuid          primary key default gen_random_uuid(),
  user_id           uuid          not null,
  content           text          not null,
  source_episode_id uuid          references episodes(id) on delete set null,
  status            text          not null default 'open'
    check (status in ('open', 'closed', 'snoozed')),
  due_at            timestamptz,
  priority          text          not null default 'normal',
  metadata          jsonb         not null default '{}',
  created_at        timestamptz   not null default now(),
  updated_at        timestamptz   not null default now()
);

create index idx_open_loops_user_status
  on open_loops (user_id, status, updated_at desc);

create unique index idx_open_loops_user_content_open
  on open_loops (user_id, lower(content))
  where status = 'open';

create table user_memory_state (
  user_id               uuid          primary key,
  living_profile        text          not null default '',
  situation_brief       text          not null default '',
  last_episode_seq      bigint        not null default 0,
  profile_refreshed_at  timestamptz,
  brief_refreshed_at    timestamptz,
  created_at            timestamptz   not null default now(),
  updated_at            timestamptz   not null default now()
);
