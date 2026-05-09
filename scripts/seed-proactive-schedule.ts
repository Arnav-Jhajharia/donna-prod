import "dotenv/config";
import { closeDb, getSql } from "../src/donna/db.js";
import { insertSchedule } from "../src/donna/proactive/schedule.js";
import type { ProactiveCauseKind } from "../src/donna/proactive/cause.js";

interface Args {
  user_id: string;
  fire_in_seconds: number;
  kind: ProactiveCauseKind;
  instruction: string;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--user-id" && argv[i + 1]) {
      args.user_id = argv[++i];
      continue;
    }
    if (arg === "--in" && argv[i + 1]) {
      args.fire_in_seconds = parseInt(argv[++i]!, 10);
      continue;
    }
    if (arg === "--kind" && argv[i + 1]) {
      args.kind = argv[++i] as ProactiveCauseKind;
      continue;
    }
    if (arg === "--instruction" && argv[i + 1]) {
      args.instruction = argv[++i];
      continue;
    }
  }
  if (!args.user_id) throw new Error("--user-id required");
  if (
    typeof args.fire_in_seconds !== "number" ||
    !Number.isFinite(args.fire_in_seconds)
  ) {
    throw new Error("--in required (seconds, integer)");
  }
  if (!args.kind) args.kind = "scheduled";
  if (!args.instruction) throw new Error("--instruction required");
  return args as Args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const sql = getSql();
  await sql`select 1`;
  const fireAt = new Date(
    Date.now() + args.fire_in_seconds * 1000
  ).toISOString();
  const id = await insertSchedule({
    user_id: args.user_id,
    fire_at: fireAt,
    cause_kind: args.kind,
    instruction: args.instruction,
    created_by: "user",
  });
  console.log(`seeded schedule id=${id} fire_at=${fireAt} kind=${args.kind}`);
  await closeDb();
}

main().catch(async (err) => {
  console.error("seed failed:", err);
  await closeDb();
  process.exit(1);
});
