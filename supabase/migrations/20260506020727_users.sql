-- users: canonical identity, keyed by phone. resolved on every inbound webhook
-- via memory/users.ts:getOrCreateUser. all per-user state (chat_messages.user_id,
-- future profile/preferences/etc) ultimately points back to this id.
--
-- phone is e164 without the leading `+` (e.g. "15551234567"), matching what
-- whatsapp puts in messages[i].from. enforced as the natural unique key.

create table users (
  id              uuid          primary key default gen_random_uuid(),
  phone           text          not null unique,
  profile_name    text,
  created_at      timestamptz   not null default now(),
  updated_at      timestamptz   not null default now()
);

create index idx_users_phone on users (phone);
