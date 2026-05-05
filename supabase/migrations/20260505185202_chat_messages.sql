create table chat_messages (
  id          uuid          primary key default gen_random_uuid(),
  seq         bigserial     not null,
  user_id     uuid          not null,
  role        text          not null check (role in ('user', 'assistant')),
  content     jsonb         not null,
  mode        text          not null check (mode in ('reactive', 'proactive')),
  created_at  timestamptz   not null default now()
);

create index idx_chat_messages_user_seq
  on chat_messages (user_id, seq desc);
