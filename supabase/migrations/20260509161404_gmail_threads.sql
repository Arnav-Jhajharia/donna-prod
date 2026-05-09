-- gmail intelligence layer: threads + people.
--
-- the spine is `gmail_threads`. every gmail thread donna learns about gets a
-- typed row tracking ball-in-court (who owes a reply), state, and importance.
-- backfilled once from history; updated on every gmail_event push.
--
-- `gmail_people` is the people-graph: who emails the user, how often, what
-- the reply rate looks like, and a derived salience score that the brain uses
-- to decide whether a push event is worth interrupting for.

create table gmail_threads (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null,

  -- gmail's thread id is the natural key.
  gmail_thread_id       text not null,

  subject               text,
  participants          text[] not null default '{}',  -- normalized emails seen on this thread
  last_inbound_from     text,                          -- most recent sender NOT the user
  message_count         integer not null default 0,

  -- thread state machine.
  state                 text not null default 'awaiting_user',
    -- 'awaiting_user' | 'awaiting_other' | 'scheduled' | 'closed' | 'fyi'
  ball_in_court         text,                          -- 'user' | 'other' | null
  awaiting_since        timestamptz,                   -- when ball started sitting in current court

  -- one-line summary written by haiku judge. enough for donna to triage
  -- without re-reading the thread.
  one_line_summary      text,

  -- importance is salience-of-counterparty × content-signal × age.
  -- recomputed on every advance. 0..1.
  importance_score      real not null default 0.5,

  -- timestamps mirroring gmail's semantics.
  last_inbound_at       timestamptz,                   -- last message NOT from user
  last_outbound_at      timestamptz,                   -- last message FROM user
  last_event_at         timestamptz not null default now(),

  -- user-level state.
  user_dismissed        boolean not null default false, -- "stop showing me this"
  user_pinned           boolean not null default false, -- "always show me this"

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create unique index gmail_threads_user_thread_idx
  on gmail_threads (user_id, gmail_thread_id);

create index gmail_threads_user_open_idx
  on gmail_threads (user_id, state, ball_in_court, importance_score desc)
  where user_dismissed = false;

create index gmail_threads_user_awaiting_idx
  on gmail_threads (user_id, awaiting_since)
  where state = 'awaiting_user' and user_dismissed = false;

-- people-graph: derived from gmail_threads + gmail history. one row per
-- counterparty email. salience is the prior the brain uses on every push.
create table gmail_people (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null,

  email                 text not null,                  -- normalized lowercase
  display_name          text,                           -- best guess from "Name <email>"
  domain                text,                           -- email@<domain>

  first_seen_at         timestamptz not null default now(),
  last_inbound_at       timestamptz,                    -- last time THEY emailed user
  last_outbound_at      timestamptz,                    -- last time USER emailed them

  inbound_count_30d     integer not null default 0,
  outbound_count_30d    integer not null default 0,
  inbound_count_total   integer not null default 0,
  outbound_count_total  integer not null default 0,

  -- 0..1: of inbound threads from this person, what fraction did the user
  -- ever reply to? a low rate + high inbound count = likely automated noise.
  reply_rate            real,

  -- 0..1: composite. high = real human the user cares about.
  -- recomputed by the people-stats job (or inline on push).
  salience_score        real not null default 0.5,

  is_bot_likely         boolean not null default false, -- noreply@, notifications@, ...

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create unique index gmail_people_user_email_idx
  on gmail_people (user_id, email);

create index gmail_people_user_salience_idx
  on gmail_people (user_id, salience_score desc)
  where is_bot_likely = false;
