// dotenv with override: true.
// reason: a stale DATABASE_URL (or other env var) in the shell can silently
// shadow what's actually configured in .env. project values are the source
// of truth — anything in the shell from a previous project is wrong by
// definition. import this module FIRST in any entrypoint that reads env vars.

import { config } from "dotenv";

config({ override: true });
