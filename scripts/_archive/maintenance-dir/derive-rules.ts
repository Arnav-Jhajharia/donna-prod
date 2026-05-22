// scripts/maintenance/derive-rules.ts
//
// reads the mined gmail metadata in scripts/mining/gmail.sqlite, derives
// auto-archive rules at high confidence, writes them to rules.json.
//
// thresholds are intentionally conservative:
//   - domain rule:  archive_rate == 100% AND n >= 20
//   - sender rule:  n_in >= 10 AND n_out == 0  (high volume, never replied)
//
// rule shape:
//   {
//     id: 'archive_domain:tldrnewsletter.com',
//     predicate: { kind: 'sender_domain', domain: '...' },
//     action: { kind: 'archive_and_label', label: 'donna/skim' },
//     evidence: { n_observed, archive_rate, last_seen },
//     status: 'active',
//   }
//
// run: npx tsx scripts/maintenance/derive-rules.ts

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = "scripts/mining/gmail.sqlite";
const OUT_PATH = "scripts/mining/rules.json";

interface DomainRow {
  raw: string;
  n: number;
  in_inbox: number;
  last_seen: string;
}

interface SenderRow {
  from_addr: string;
  in_count: number;
  out_count: number;
  last_seen: string;
}

interface Rule {
  id: string;
  predicate:
    | { kind: "sender_domain"; domain: string }
    | { kind: "sender_addr"; addr: string };
  action: { kind: "archive_and_label"; label: string };
  evidence: {
    n_observed: number;
    archive_rate?: number;
    out_count?: number;
    last_seen: string;
  };
  status: "active" | "suggested";
  created_at: string;
}

function cleanDomain(raw: string): string {
  // strip trailing `>` from `<x@y.com>` style and surrounding whitespace
  return raw.replace(/>$/, "").trim().toLowerCase();
}

function main() {
  const db = new DatabaseSync(DB_PATH);

  // domain rule: 100% archived, n >= 20
  const domainRows = db
    .prepare(
      `
      SELECT
        substr(from_addr, instr(from_addr,'@')+1) as raw,
        count(*) as n,
        sum(CASE WHEN labels_json LIKE '%"INBOX"%' THEN 1 ELSE 0 END) as in_inbox,
        max(date_iso) as last_seen
      FROM messages
      WHERE instr(from_addr,'@') > 0
      GROUP BY raw
      HAVING n >= 20 AND in_inbox = 0
      ORDER BY n DESC
    `,
    )
    .all() as DomainRow[];

  // sender rule: n_in >= 10, n_out = 0
  // approximation for out_count: count of SENT messages where to_addr contains the email
  const senderRows = db
    .prepare(
      `
      SELECT m.from_addr,
        count(*) as in_count,
        (
          SELECT count(*) FROM messages s
          WHERE s.labels_json LIKE '%"SENT"%'
            AND s.to_addr LIKE '%' ||
              replace(replace(substr(m.from_addr, max(1, instr(m.from_addr,'<')+1)), '>', ''), ' ', '')
              || '%'
        ) as out_count,
        max(m.date_iso) as last_seen
      FROM messages m
      WHERE m.from_addr != '' AND m.labels_json NOT LIKE '%"SENT"%'
      GROUP BY m.from_addr
      HAVING in_count >= 10 AND out_count = 0
      ORDER BY in_count DESC
    `,
    )
    .all() as SenderRow[];

  const now = new Date().toISOString();
  const rules: Rule[] = [];

  for (const r of domainRows) {
    const domain = cleanDomain(r.raw);
    if (!domain || domain.length < 4) continue;
    rules.push({
      id: `archive_domain:${domain}`,
      predicate: { kind: "sender_domain", domain },
      action: { kind: "archive_and_label", label: "donna/skim" },
      evidence: {
        n_observed: r.n,
        archive_rate: 1.0,
        last_seen: r.last_seen,
      },
      status: "active",
      created_at: now,
    });
  }

  // dedupe sender rules whose domain is already covered by a domain rule
  const coveredDomains = new Set(
    rules
      .filter((r) => r.predicate.kind === "sender_domain")
      .map((r) => (r.predicate as { domain: string }).domain),
  );

  for (const r of senderRows) {
    // extract email from "Name <email>" or "email"
    const m = r.from_addr.match(/<([^>]+)>/);
    const addr = (m ? m[1] : r.from_addr).trim().toLowerCase();
    if (!addr.includes("@")) continue;
    const domain = addr.split("@")[1];
    if (coveredDomains.has(domain!)) continue;
    rules.push({
      id: `archive_sender:${addr}`,
      predicate: { kind: "sender_addr", addr },
      action: { kind: "archive_and_label", label: "donna/skim" },
      evidence: {
        n_observed: r.in_count,
        out_count: r.out_count,
        last_seen: r.last_seen,
      },
      status: "active",
      created_at: now,
    });
  }

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(rules, null, 2));

  console.log(`derived ${rules.length} rules → ${OUT_PATH}`);
  console.log(`  domain rules:  ${rules.filter((r) => r.predicate.kind === "sender_domain").length}`);
  console.log(`  sender rules:  ${rules.filter((r) => r.predicate.kind === "sender_addr").length}`);
  console.log("\ntop 10 by evidence:");
  for (const r of rules.slice(0, 10)) {
    const pred =
      r.predicate.kind === "sender_domain" ? r.predicate.domain : r.predicate.addr;
    console.log(`  n=${String(r.evidence.n_observed).padStart(4)}  ${r.predicate.kind.padEnd(15)}  ${pred}`);
  }

  db.close();
}

main();
