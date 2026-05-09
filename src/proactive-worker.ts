import "./donna/env.js";
import { closeDb, getSql } from "./donna/db.js";
import { startScheduleTicker } from "./donna/proactive/executor.js";

const TICK_MS = Number(process.env.DONNA_PROACTIVE_TICK_MS ?? 30_000);

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("error: ANTHROPIC_API_KEY not set");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("error: DATABASE_URL not set");
    process.exit(1);
  }
  try {
    const sql = getSql();
    await sql`select 1`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`worker can't reach memory: ${msg}`);
    await closeDb();
    process.exit(1);
  }

  const handle = startScheduleTicker(TICK_MS);
  console.log(`donna proactive worker ticking every ${TICK_MS}ms`);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} — shutting down`);
    clearInterval(handle);
    await closeDb();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch(async (err) => {
  console.error("fatal:", err);
  await closeDb();
  process.exit(1);
});
