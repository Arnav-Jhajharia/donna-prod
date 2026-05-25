-- consent ledger. every time a user grants or revokes a privilege — an OAuth
-- scope set, the ToS, the privacy policy, the Google Limited Use policy — we
-- record it here with the policy version that was in force at the moment.
--
-- this is the audit trail that lets us answer "what exactly did the user
-- agree to, and when" — required for GDPR, CCPA, DPDP Act, and for Google's
-- own data-handling reviews.
--
-- design notes:
--   * one row per consent event. revoking creates a new row with revoked_at
--     set, instead of mutating the original — the historical record stays
--     intact (compliance demands it).
--   * scopes is jsonb so we can store the exact scope list for OAuth grants
--     without a separate join table.
--   * policy_version is a free-form string. for OAuth: the app version.
--     for ToS / privacy: the version published at /privacy and /terms.

create table user_consents (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,

  consent_type    text not null,
  scopes          jsonb not null default '[]'::jsonb,
  policy_version  text not null,

  granted_at      timestamptz not null default now(),
  revoked_at      timestamptz,

  user_agent      text,
  ip_address      text,
  app_version     text,

  revoked_reason  text,

  check (consent_type = any (array[
    'oauth_google',
    'oauth_notion',
    'oauth_spotify',
    'tos',
    'privacy_policy',
    'limited_use_policy'
  ]))
);

-- "every consent for this user of this type, newest first" — the most common
-- read pattern (the latest active grant).
create index idx_user_consents_user_type
  on user_consents (user_id, consent_type, granted_at desc);

-- partial index for "what's currently active" lookups.
create index idx_user_consents_active
  on user_consents (user_id, consent_type)
  where revoked_at is null;
