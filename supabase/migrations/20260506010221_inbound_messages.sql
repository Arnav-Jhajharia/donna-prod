-- inbound_messages: durable dedup + audit log for whatsapp inbound webhooks.
--
-- meta retries webhook deliveries on missing/late ack. the unique constraint on
-- wa_message_id makes claim atomic — two concurrent retries race the insert,
-- exactly one wins, the rest get on-conflict-do-nothing. this is the durable
-- layer behind the in-memory 5-min ttl cache in src/donna/ingress/whatsapp.ts.
--
-- body stores the raw wa message dict for future replay / audit. we don't read
-- it back yet but it's cheap to store (jsonb) and expensive to add later.

create table inbound_messages (
  id              uuid          primary key default gen_random_uuid(),
  wa_message_id   text          not null unique,
  phone           text          not null,
  source          text          not null default 'whatsapp',
  body            jsonb         not null,
  received_at     timestamptz   not null default now()
);

create index idx_inbound_messages_phone_received
  on inbound_messages (phone, received_at desc);
