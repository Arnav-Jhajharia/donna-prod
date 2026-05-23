-- evolve the existing users table for the two-surface identity model.
--
-- the original schema (20260506020727_users.sql) was whatsapp-first:
-- phone was required, no concept of an app-only identity. now that the
-- mobile app is a real surface, we need to support users who join via
-- clerk (apple sign in) without a phone yet, and link the two later.
--
-- two changes:
--   1. phone becomes nullable. an app-first user has clerk_id only until
--      they verify a phone in onboarding.
--   2. clerk_id added as the mobile resolution key. nullable + unique so
--      whatsapp-only users (no app installed) have it null.
--
-- the linking helper (getOrCreateUserByClerk) reads the phone from the
-- clerk user object server-side, looks up an existing row by phone, and
-- attaches the clerk_id to it instead of creating a duplicate.
alter table users alter column phone drop not null;
alter table users add column clerk_id text unique;
