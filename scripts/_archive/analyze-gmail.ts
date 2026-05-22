// scripts/analyze-gmail.ts
//
// runs a battery of metadata-only analyses on the mined gmail sqlite db.
// prints a markdown-style report to stdout. safe to re-run as the mining
// progresses — just shows what's known so far.
//
// run:  npx tsx scripts/analyze-gmail.ts

import { DatabaseSync } from "node:sqlite";

const DB_PATH = "scripts/mining/gmail.sqlite";
const db = new DatabaseSync(DB_PATH);

function header(s: string) {
  console.log("\n" + "─".repeat(72));
  console.log(s);
  console.log("─".repeat(72));
}

function table(rows: Array<Record<string, unknown>>, cols: string[]) {
  if (rows.length === 0) {
    console.log("  (no rows)");
    return;
  }
  const widths = cols.map((c) =>
    Math.max(
      c.length,
      ...rows.map((r) => String(r[c] ?? "").length),
    ),
  );
  const fmt = (vals: string[]) =>
    vals.map((v, i) => v.padEnd(widths[i]!)).join("  ");
  console.log("  " + fmt(cols));
  console.log("  " + cols.map((_, i) => "─".repeat(widths[i]!)).join("  "));
  for (const r of rows) {
    console.log("  " + fmt(cols.map((c) => String(r[c] ?? ""))));
  }
}

const total = (db.prepare("SELECT count(*) as n FROM messages").get() as { n: number }).n;
const range = db.prepare(
  "SELECT min(date_iso) as oldest, max(date_iso) as newest FROM messages",
).get() as { oldest: string; newest: string };

console.log("=".repeat(72));
console.log(`GMAIL MINING REPORT — ${new Date().toISOString().slice(0, 19)}`);
console.log("=".repeat(72));
console.log(`total messages: ${total}`);
console.log(`date range:     ${range.oldest?.slice(0,10)}  →  ${range.newest?.slice(0,10)}`);
const days = (new Date(range.newest).getTime() - new Date(range.oldest).getTime()) / 86400000;
console.log(`span:           ${days.toFixed(1)} days`);
console.log(`avg/day:        ${(total / Math.max(days, 1)).toFixed(1)}`);

header("TOP 25 SENDERS (volume)");
const topSenders = db.prepare(`
  SELECT from_addr, count(*) as n,
         sum(CASE WHEN labels_json LIKE '%UNREAD%' THEN 1 ELSE 0 END) as unread
  FROM messages
  WHERE from_addr != ''
  GROUP BY from_addr
  ORDER BY n DESC
  LIMIT 25
`).all() as Array<{ from_addr: string; n: number; unread: number }>;
table(
  topSenders.map((r) => ({
    n: r.n,
    unread: r.unread,
    from: r.from_addr.slice(0, 60),
  })),
  ["n", "unread", "from"],
);

header("TOP 25 DOMAINS (volume)");
const topDomains = db.prepare(`
  SELECT
    CASE
      WHEN instr(from_addr, '<') > 0
        THEN substr(from_addr, instr(from_addr,'@')+1, length(from_addr) - instr(from_addr,'@') - 1)
      ELSE substr(from_addr, instr(from_addr,'@')+1)
    END as domain,
    count(*) as n
  FROM messages
  WHERE instr(from_addr,'@') > 0
  GROUP BY domain
  ORDER BY n DESC
  LIMIT 25
`).all() as Array<{ domain: string; n: number }>;
table(
  topDomains.map((r) => ({ n: r.n, domain: r.domain.replace(/>$/, "").slice(0, 50) })),
  ["n", "domain"],
);

header("HOURLY DISTRIBUTION OF INBOUND (UTC)");
const hourly = db.prepare(`
  SELECT substr(date_iso, 12, 2) as h, count(*) as n
  FROM messages
  WHERE date_iso != ''
  GROUP BY h
  ORDER BY h
`).all() as Array<{ h: string; n: number }>;
const maxH = Math.max(...hourly.map((r) => r.n), 1);
for (const r of hourly) {
  const bar = "█".repeat(Math.round((r.n / maxH) * 40));
  console.log(`  ${r.h}:00  ${String(r.n).padStart(4)}  ${bar}`);
}

header("LABEL USAGE (top 15)");
const labelCount = new Map<string, number>();
const rows = db.prepare("SELECT labels_json FROM messages WHERE labels_json != ''").all() as Array<{ labels_json: string }>;
for (const r of rows) {
  try {
    const labels = JSON.parse(r.labels_json) as string[];
    for (const l of labels) labelCount.set(l, (labelCount.get(l) ?? 0) + 1);
  } catch {}
}
const sortedLabels = [...labelCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
table(
  sortedLabels.map(([l, n]) => ({ n, label: l })),
  ["n", "label"],
);

header("THREAD DEPTH DISTRIBUTION");
const threadDepth = db.prepare(`
  SELECT n_msgs, count(*) as n_threads
  FROM (
    SELECT thread_id, count(*) as n_msgs
    FROM messages
    WHERE thread_id != ''
    GROUP BY thread_id
  )
  GROUP BY n_msgs
  ORDER BY n_msgs
  LIMIT 20
`).all() as Array<{ n_msgs: number; n_threads: number }>;
table(threadDepth as Array<Record<string, unknown>>, ["n_msgs", "n_threads"]);

header("LONGEST OPEN THREADS (8+ messages)");
const longThreads = db.prepare(`
  SELECT thread_id, count(*) as n,
    max(subject) as subject,
    min(date_iso) as first_at,
    max(date_iso) as last_at
  FROM messages
  WHERE thread_id != '' AND subject != ''
  GROUP BY thread_id
  HAVING n >= 8
  ORDER BY n DESC
  LIMIT 15
`).all() as Array<{ n: number; subject: string; first_at: string; last_at: string }>;
table(
  longThreads.map((r) => ({
    n: r.n,
    span: `${r.first_at.slice(0, 10)} → ${r.last_at.slice(0, 10)}`,
    subject: r.subject.slice(0, 50),
  })),
  ["n", "span", "subject"],
);

header("SENT vs INBOUND (rough)");
// SENT label means user-authored
const sentRows = db.prepare(`
  SELECT count(*) as n FROM messages WHERE labels_json LIKE '%SENT%'
`).get() as { n: number };
const inboundRows = db.prepare(`
  SELECT count(*) as n FROM messages WHERE labels_json NOT LIKE '%SENT%'
`).get() as { n: number };
console.log(`  sent (you):    ${sentRows.n}`);
console.log(`  inbound:       ${inboundRows.n}`);
console.log(`  ratio:         ${(inboundRows.n / Math.max(sentRows.n, 1)).toFixed(1)}× inbound per sent`);

header("AUTOMATION/NEWSLETTER SUSPECTS (no reply ever)");
// senders with high volume but zero outbound to them
const autoSuspects = db.prepare(`
  SELECT from_addr, count(*) as in_count,
    (SELECT count(*) FROM messages s
      WHERE s.labels_json LIKE '%SENT%'
        AND s.to_addr LIKE '%' || replace(replace(substr(m.from_addr, max(1, instr(m.from_addr,'<')+1)), '>', ''), ' ', '') || '%'
    ) as out_count
  FROM messages m
  WHERE m.from_addr != '' AND m.labels_json NOT LIKE '%SENT%'
  GROUP BY from_addr
  HAVING in_count >= 5 AND out_count = 0
  ORDER BY in_count DESC
  LIMIT 20
`).all() as Array<{ from_addr: string; in_count: number; out_count: number }>;
table(
  autoSuspects.map((r) => ({
    n_in: r.in_count,
    out: r.out_count,
    from: r.from_addr.slice(0, 60),
  })),
  ["n_in", "out", "from"],
);

header("DOMAINS THAT ALWAYS GET ARCHIVED (no INBOX label)");
const archivedDomains = db.prepare(`
  SELECT
    substr(from_addr, instr(from_addr,'@')+1) as raw,
    count(*) as n,
    sum(CASE WHEN labels_json LIKE '%"INBOX"%' THEN 1 ELSE 0 END) as in_inbox
  FROM messages
  WHERE instr(from_addr,'@') > 0
  GROUP BY raw
  HAVING n >= 5
  ORDER BY (CAST(in_inbox AS REAL)/n) ASC, n DESC
  LIMIT 15
`).all() as Array<{ raw: string; n: number; in_inbox: number }>;
table(
  archivedDomains.map((r) => ({
    n: r.n,
    in_inbox: r.in_inbox,
    archive_rate: `${(((r.n - r.in_inbox) / r.n) * 100).toFixed(0)}%`,
    domain: r.raw.replace(/>$/, "").slice(0, 50),
  })),
  ["n", "in_inbox", "archive_rate", "domain"],
);

console.log("\n" + "=".repeat(72));
console.log("END REPORT");
console.log("=".repeat(72));

db.close();
