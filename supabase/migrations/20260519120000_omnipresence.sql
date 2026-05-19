-- omnipresence foundation: donna has to be everywhere — whatsapp, imessage,
-- dynamic island, a native app, eventually a browser. three things have to be
-- true for that:
--   1. one canonical user can own many surface identities (phone, app device,
--      future email/oauth). today users.phone is the only key — kills any
--      surface that doesn't have a phone number.
--   2. when donna emits a burst, the router needs to know where the user
--      actually lives right now. preferred_channel + last_active_channel give
--      it that.
--   3. surfaces that aren't push-callable (a web client polling, a native app
--      backgrounded, a dynamic island live activity) need an outbox to read
--      from. that's outbound_messages.
--
-- also extends donnaschedule.cause_kind with 'integration_oauth_complete' so
-- the composio webhook can enqueue an ack that survives server restarts
-- (kills the detached-promise sharp edge called out in CLAUDE.md).
--
-- reversible: drop the new tables, drop the new user columns, restore the
-- prior cause_kind check. existing users keep working because every new
-- column has a default and the identity row is backfilled inline.

-- ── 1. users: per-user routing preference ────────────────────────────────────
--
-- preferred_channel  = sticky pick the user (or onboarding) set explicitly.
-- last_active_channel = whichever surface they spoke on most recently. updated
--                       on every inbound webhook. when null, fall back to
--                       preferred_channel.
-- last_active_at      = timestamp of that update; lets the router decay stale
--                       channels in the future (e.g. don't push to an imessage
--                       chat the user hasn't touched in 30 days).

alter table users
  add column preferred_channel   text         not null default 'whatsapp'
    check (preferred_channel in ('whatsapp', 'imessage', 'app')),
  add column last_active_channel text
    check (last_active_channel in ('whatsapp', 'imessage', 'app')),
  add column last_active_at      timestamptz;

create index idx_users_last_active_channel
  on users (last_active_channel)
  where last_active_channel is not null;

-- ── 2. user_identities: many surfaces → one canonical user ───────────────────
--
-- provider examples:
--   whatsapp_phone  (external_id = e164 without leading +)
--   imessage_phone  (same e164; same person, different surface)
--   app_device      (external_id = opaque device uuid the client generates)
--   email           (future — google sign-in for the web client)
--
-- (provider, external_id) is the natural unique key. one user can own many
-- identities; one identity points to exactly one user.
--
-- the existing users.phone column stays — it's still the canonical e164 for
-- whatsapp/imessage routing — but new surfaces resolve via this table.

create table user_identities (
  id           uuid          primary key default gen_random_uuid(),
  user_id      uuid          not null references users(id) on delete cascade,
  provider     text          not null
                 check (provider in ('whatsapp_phone', 'imessage_phone', 'app_device', 'email')),
  external_id  text          not null,
  metadata     jsonb         not null default '{}'::jsonb,
  created_at   timestamptz   not null default now(),
  last_seen_at timestamptz   not null default now(),
  unique (provider, external_id)
);

create index idx_user_identities_user_id
  on user_identities (user_id);

-- backfill: every existing users row has a phone — mirror it as a
-- whatsapp_phone identity so the router has something to resolve. imessage
-- identities are added lazily on first imessage inbound (the dispatcher
-- already calls getOrCreateUser which records the identity).
insert into user_identities (user_id, provider, external_id)
  select id, 'whatsapp_phone', phone from users
  on conflict (provider, external_id) do nothing;

-- ── 3. outbound_messages: the seam every future surface plugs into ───────────
--
-- when the router picks the 'app' channel (dynamic island, native app
-- backgrounded, web client polling), the burst is written here. clients hit
-- GET /app/inbox to drain pending rows and PATCH /app/inbox/:id with delivery
-- + read receipts.
--
-- direct-push channels (whatsapp/imessage) skip this table — they deliver
-- inline and persist into chat_messages as today. only the 'app' lane goes
-- through outbound_messages.

create table outbound_messages (
  id              uuid          primary key default gen_random_uuid(),
  user_id         uuid          not null references users(id) on delete cascade,
  channel         text          not null
                    check (channel in ('whatsapp', 'imessage', 'app')),
  body            text          not null,
  status          text          not null default 'pending'
                    check (status in ('pending', 'delivered', 'read', 'failed')),
  payload         jsonb         not null default '{}'::jsonb,
  external_id     text,
  created_at      timestamptz   not null default now(),
  delivered_at    timestamptz,
  read_at         timestamptz,
  failed_at       timestamptz,
  error_message   text,
  run_id          uuid          references execution_runs(id) on delete set null
);

create index idx_outbound_messages_user_pending
  on outbound_messages (user_id, created_at)
  where status = 'pending';

create index idx_outbound_messages_run_id
  on outbound_messages (run_id)
  where run_id is not null;

-- ── 4. donnaschedule: integration_oauth_complete cause ──────────────────────
--
-- when composio finishes oauth, hitting POST /composio/webhook enqueues a
-- schedule row instead of relying on a detached waitForConnection promise.
-- the proactive worker picks it up — survives restarts, same delivery path
-- as every other proactive trigger.

alter table donnaschedule
  drop constraint donnaschedule_cause_kind_check;

alter table donnaschedule
  add constraint donnaschedule_cause_kind_check
    check (cause_kind in (
      'scheduled',
      'scan_gmail',
      'watch_fired',
      'world_tick',
      'integration_oauth_complete'
    ));
