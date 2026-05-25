// retention cron for the per-day jsonl ledger files written by
// src/donna/ledger.ts. removes whole files older than KEEP_DAYS days.
//
// usage:
//   npm run prune-ledger                # default: keep 90 days
//   npm run prune-ledger -- 30          # keep 30 days
//   DONNA_LEDGER_DIR=/foo npm run prune-ledger
//
// not run automatically anywhere yet. wire into a cron (railway scheduler,
// supabase cron, a github action, or a daily call from src/server.ts at
// startup-plus-24h) once the retention policy is reviewed by counsel.
//
// granular per-user scrubbing (delete-account → forget specific users'
// lines without nuking unrelated audit data) is a separate, future pass.
// this script intentionally only does whole-file pruning — the simplest
// thing that satisfies "data ages out."

import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const LEDGER_DIR = process.env.DONNA_LEDGER_DIR ?? ".donna/ledger";
const KEEP_DAYS = Number(process.argv[2] ?? 90);

if (!Number.isFinite(KEEP_DAYS) || KEEP_DAYS < 1) {
  console.error(`invalid KEEP_DAYS: ${process.argv[2]}. must be a positive integer.`);
  process.exit(1);
}

const cutoffMs = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;

let removed = 0;
let kept = 0;
let bytesFreed = 0;

let files: string[];
try {
  files = readdirSync(LEDGER_DIR);
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === "ENOENT") {
    console.log(`ledger dir ${LEDGER_DIR} does not exist; nothing to prune`);
    process.exit(0);
  }
  throw err;
}

for (const file of files) {
  if (!file.endsWith(".jsonl")) continue;
  const path = join(LEDGER_DIR, file);
  const stat = statSync(path);
  if (stat.mtimeMs < cutoffMs) {
    unlinkSync(path);
    removed++;
    bytesFreed += stat.size;
  } else {
    kept++;
  }
}

console.log(
  `pruned ${removed} ledger file(s) older than ${KEEP_DAYS} day(s), ` +
    `kept ${kept}, freed ${(bytesFreed / 1024).toFixed(1)} KiB`,
);
