-- v0.3 watches substrate.
--
-- a "watch" is a persistent, named goal that fires on a trigger (cron today,
-- email-match later) and runs in its own agent thread. each firing wakes up
-- the thread, appends a <trigger_fired> message, and the watch runner emits a
-- terminator (send_burst → user-visible burst, do_nothing → silent, watch_close
-- → end this watch).
--
-- three tables:
-- 1. agent_threads: one row per long-lived sub-agent (watches are the only
--    kind today; later: tasks, planning sessions, etc).
-- 2. agent_messages: per-thread conversation history. thread's own
--    deliberation log, independent of chat_messages.
-- 3. watches: links a thread to a trigger spec + description. one watch row
--    references exactly one thread row.
--
-- causes: watch_fired is already allowed in donnaschedule.cause_kind
-- (added in 20260509120000_world_tick_cause_kind.sql).
--
-- ledger of writes:
-- - create_watch  → insert agent_threads + insert watches + insert donnaschedule
-- - watch fires   → insert agent_messages (trigger + assistant reply)
--                   + optional insert chat_messages (when terminator=send_burst)
--                   + insert next donnaschedule (for recurring cron)
-- - close_watch   → update watches.status='closed' + agent_threads.status='done'

create table agent_threads (
  id              uuid          primary key default gen_random_uuid(),
  user_id         uuid          not null references users(id) on delete cascade,
  kind            text          not null check (kind in ('watch')),
  name            text          not null,
  -- arbitrary metadata the thread accumulates (e.g. structured state a watch
  -- wants to remember outside the message log — last_seen_price, baseline,
  -- etc). small, json-serializable. avoid blob dumps.
  metadata        jsonb         not null default '{}'::jsonb,
  status          text          not null default 'open'
                    check (status in ('open', 'paused', 'done')),
  created_at      timestamptz   not null default now(),
  updated_at      timestamptz   not null default now()
);

create index agent_threads_user_status
  on agent_threads (user_id, status);

create table agent_messages (
  id              bigserial     primary key,
  thread_id       uuid          not null references agent_threads(id) on delete cascade,
  role            text          not null check (role in ('user', 'assistant')),
  content         jsonb         not null,
  created_at      timestamptz   not null default now()
);

-- ordered scan within a thread. seq is the bigserial primary key — globally
-- monotonic, also monotonic within any single thread, so order by id asc gives
-- chronological order.
create index agent_messages_thread_id_id
  on agent_messages (thread_id, id);

create table watches (
  id              uuid          primary key default gen_random_uuid(),
  user_id         uuid          not null references users(id) on delete cascade,
  thread_id       uuid          not null references agent_threads(id) on delete cascade,
  name            text          not null,
  description     text          not null,
  -- discriminated union by .kind. v1 supports:
  --   { kind: "cron",     schedule: "0 21 * * *", timezone: "America/Los_Angeles" }
  --   { kind: "one_shot", fire_at:  "2026-05-13T17:00:00-07:00" }
  trigger_spec    jsonb         not null,
  -- initial seed for the thread (json object the LLM sees once in the
  -- agent's history under <initial_context>). e.g. for a PR watch:
  -- { pr_url: "...", baseline_status: "open" }
  initial_context jsonb         not null default '{}'::jsonb,
  status          text          not null default 'active'
                    check (status in ('active', 'paused', 'closed')),
  created_at      timestamptz   not null default now(),
  updated_at      timestamptz   not null default now()
);

create index watches_user_status
  on watches (user_id, status);

create index watches_thread_id
  on watches (thread_id);
