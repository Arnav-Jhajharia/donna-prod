import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./db/schema.js";

// the single source of truth for db access. every caller uses `db`.
// the underlying `postgres` client is also exposed as `sql` for the rare
// case where we want raw SQL — keep that rare; reach for drizzle first.

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

// supabase transaction pooler (port 6543) doesn't allow prepared statements.
// `prepare: false` is required there. `transform: { undefined: null }` matches
// the archive's pattern — a js `undefined` value becomes SQL NULL instead of
// raising "did you mean to bind a value here?".
export const sql = postgres(url, {
  prepare: false,
  transform: { undefined: null },
});

export const db = drizzle(sql, { schema });
