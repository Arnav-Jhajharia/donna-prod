// scripts/maintenance/morning-brief.ts
//
// formats a one-burst morning brief summarizing the autonomous maintenance
// that happened in the last 24 hours. matches donna's voice: lowercase, no
// em dashes, no semicolons, no markdown, terse.
//
// run:
//   npx tsx scripts/maintenance/morning-brief.ts                 # last 24h
//   npx tsx scripts/maintenance/morning-brief.ts --hours 48      # custom window
//   npx tsx scripts/maintenance/morning-brief.ts --include-dry   # include dry-run actions

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";

const AUDIT_DB = "scripts/mining/maintenance.sqlite";

function parseArgs() {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    hours: Number(get("--hours") ?? 24),
    includeDry: argv.includes("--include-dry"),
  };
}

function fmtCount(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : plural ?? singular + "s"}`;
}

function main() {
  const { hours, includeDry } = parseArgs();
  if (!existsSync(AUDIT_DB)) {
    console.log("no maintenance audit db yet — nothing to brief on.");
    return;
  }

  const db = new DatabaseSync(AUDIT_DB);
  const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const dryClause = includeDry ? "" : "AND dry_run = 0";

  const archived = db
    .prepare(
      `
      SELECT count(*) as n
      FROM maintenance_actions
      WHERE ts >= ? AND action = 'archive_and_label' AND (applied = 1 OR (dry_run = 1 AND ${includeDry ? "1=1" : "1=0"}))
    `,
    )
    .get(cutoff) as { n: number };

  const errors = db
    .prepare(
      `
      SELECT count(*) as n
      FROM maintenance_actions
      WHERE ts >= ? AND action = 'archive_and_label' AND applied = 0 AND error IS NOT NULL ${dryClause}
    `,
    )
    .get(cutoff) as { n: number };

  const dryMatches = includeDry
    ? (db
        .prepare(
          `
          SELECT count(*) as n
          FROM maintenance_actions
          WHERE ts >= ? AND action = 'archive_and_label' AND dry_run = 1
        `,
        )
        .get(cutoff) as { n: number })
    : null;

  const byCategory = db
    .prepare(
      `
      SELECT
        CASE
          WHEN from_addr LIKE '%newsletter%' OR from_addr LIKE '%digest%' THEN 'newsletter'
          WHEN from_addr LIKE '%linkedin%' OR from_addr LIKE '%notify%' OR from_addr LIKE '%noreply%' THEN 'automation'
          WHEN from_addr LIKE '%receipt%' OR from_addr LIKE '%no-reply%' THEN 'receipt'
          ELSE 'other'
        END as cat,
        count(*) as n
      FROM maintenance_actions
      WHERE ts >= ? AND action = 'archive_and_label' AND (applied = 1 OR (dry_run = 1 AND ${includeDry ? "1=1" : "1=0"}))
      GROUP BY cat
      ORDER BY n DESC
    `,
    )
    .all(cutoff) as Array<{ cat: string; n: number }>;

  const topSenders = db
    .prepare(
      `
      SELECT from_addr, count(*) as n
      FROM maintenance_actions
      WHERE ts >= ? AND action = 'archive_and_label' AND (applied = 1 OR (dry_run = 1 AND ${includeDry ? "1=1" : "1=0"}))
      GROUP BY from_addr
      ORDER BY n DESC
      LIMIT 5
    `,
    )
    .all(cutoff) as Array<{ from_addr: string; n: number }>;

  // build the burst
  console.log("─".repeat(72));
  console.log("MORNING BRIEF — " + new Date().toISOString().slice(0, 16).replace("T", " "));
  console.log("─".repeat(72));
  console.log("");

  if (archived.n === 0 && (dryMatches?.n ?? 0) === 0) {
    console.log("nothing to maintain in the last " + hours + "h.");
  } else {
    const head =
      archived.n > 0
        ? `cleared ${fmtCount(archived.n, "thing", "things")} from your inbox in the last ${hours}h.`
        : `${dryMatches!.n} ${dryMatches!.n === 1 ? "thing" : "things"} would have been cleared (dry-run).`;
    console.log(head);

    if (byCategory.length > 0) {
      const parts = byCategory
        .filter((c) => c.cat !== "other")
        .map((c) => `${c.n} ${c.cat}${c.n === 1 ? "" : "s"}`);
      const other = byCategory.find((c) => c.cat === "other");
      if (other) parts.push(`${other.n} other`);
      console.log(parts.join(", "));
    }

    if (topSenders.length > 0) {
      console.log("");
      console.log("top offenders:");
      for (const s of topSenders) {
        console.log(`  ${String(s.n).padStart(3)}  ${s.from_addr.slice(0, 60)}`);
      }
    }

    if (errors.n > 0) {
      console.log("");
      console.log(`${errors.n} failed (logged in maintenance_actions).`);
    }

    console.log("");
    console.log("everything is in donna/skim. say 'undo today' to put it all back.");
  }

  console.log("");
  console.log("─".repeat(72));
  db.close();
}

main();
