# tests

uses node's built-in test runner via tsx. no jest, no vitest.

run all tests: `npm test`
run one file: `npm run test:once -- tests/proactive/cause.test.ts`

unit tests (pure functions): no setup needed.

integration tests (DB): require `DATABASE_URL` set. tests use a synthetic
test user_id (`00000000-0000-0000-0000-000000000001`) and clean up after
themselves. do not run against production.
