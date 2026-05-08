-- v0.2 world engine — donna actively looks at the world (exa).
-- minimum viable: dedup ledger + per-day budget. signal queue, watchlists,
-- per-user-tz date math come in v0.3.

create table world_ledger (
  user_id     uuid          not null references users(id) on delete cascade,
  dedup_key   text          not null,
  fired_at    timestamptz   not null default now(),
  primary key (user_id, dedup_key)
);

create index world_ledger_fired_at on world_ledger (fired_at);

create table world_daily_count (
  user_id     uuid          not null references users(id) on delete cascade,
  -- utc date for now. v0.3: switch to user-local date once user.timezone lands.
  local_date  date          not null,
  count       integer       not null default 0,
  primary key (user_id, local_date)
);
