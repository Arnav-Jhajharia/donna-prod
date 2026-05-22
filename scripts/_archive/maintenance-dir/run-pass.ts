// scripts/maintenance/run-pass.ts
//
// fetches the current INBOX, applies derived rules from rules.json, optionally
// performs the actual gmail label changes (archive = remove INBOX, apply
// donna/skim).
//
// safety:
//   - default mode is --dry-run. live actions require --apply.
//   - actions are logged to scripts/mining/maintenance.sqlite for the brief.
//   - --limit caps how many messages we touch per pass.
//
// run:
//   npx tsx scripts/maintenance/run-pass.ts                       # dry-run, 100 msgs
//   npx tsx scripts/maintenance/run-pass.ts --apply --limit 50    # live, 50 msgs
//   npx tsx scripts/maintenance/run-pass.ts --since-hours 24      # only last 24h

import "dotenv/config";
import { Composio } from "@composio/core";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const STATE_PATH = "scripts/.composio-mining.json";
const RULES_PATH = "scripts/mining/rules.json";
const AUDIT_DB = "scripts/mining/maintenance.sqlite";
const PAGE_SIZE = 25;
const DONNA_LABEL = "donna/skim";

interface ConnState {
  user_id: string;
  connected_account_id: string;
}

interface Rule {
  id: string;
  predicate:
    | { kind: "sender_domain"; domain: string }
    | { kind: "sender_addr"; addr: string };
  action: { kind: "archive_and_label"; label: string };
  evidence: { n_observed: number };
  status: "active" | "suggested";
}

interface RawMessage {
  messageId?: string;
  threadId?: string;
  sender?: string;
  subject?: string;
  messageTimestamp?: string;
  labelIds?: string[];
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    apply: argv.includes("--apply"),
    limit: Number(get("--limit") ?? 100),
    sinceHours: Number(get("--since-hours") ?? 72),
  };
}

function loadConn(): ConnState {
  return JSON.parse(readFileSync(STATE_PATH, "utf8")) as ConnState;
}

function loadRules(): Rule[] {
  if (!existsSync(RULES_PATH)) {
    throw new Error(`${RULES_PATH} not found; run derive-rules.ts first`);
  }
  return (JSON.parse(readFileSync(RULES_PATH, "utf8")) as Rule[]).filter(
    (r) => r.status === "active",
  );
}

function openAuditDb(): DatabaseSync {
  mkdirSync(dirname(AUDIT_DB), { recursive: true });
  const db = new DatabaseSync(AUDIT_DB);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS maintenance_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      message_id TEXT NOT NULL,
      thread_id TEXT,
      from_addr TEXT,
      subject TEXT,
      rule_id TEXT,
      action TEXT NOT NULL,             -- 'archive_and_label' | 'skip'
      reason TEXT,
      add_labels TEXT,                  -- json
      remove_labels TEXT,               -- json
      dry_run INTEGER NOT NULL,
      applied INTEGER NOT NULL,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_actions_ts ON maintenance_actions(ts);
    CREATE INDEX IF NOT EXISTS idx_actions_dry ON maintenance_actions(dry_run);
  `);
  return db;
}

interface RuleIndex {
  byDomain: Map<string, Rule>;
  byAddr: Map<string, Rule>;
}

function indexRules(rules: Rule[]): RuleIndex {
  const byDomain = new Map<string, Rule>();
  const byAddr = new Map<string, Rule>();
  for (const r of rules) {
    if (r.predicate.kind === "sender_domain") {
      byDomain.set(r.predicate.domain.toLowerCase(), r);
    } else if (r.predicate.kind === "sender_addr") {
      byAddr.set(r.predicate.addr.toLowerCase(), r);
    }
  }
  return { byDomain, byAddr };
}

function extractEmail(rawSender: string): { addr: string; domain: string } {
  const m = rawSender.match(/<([^>]+)>/);
  const addr = (m ? m[1] : rawSender).trim().toLowerCase();
  const domain = addr.includes("@") ? addr.split("@")[1]! : "";
  return { addr, domain };
}

function matchRule(rawSender: string, idx: RuleIndex): Rule | null {
  const { addr, domain } = extractEmail(rawSender);
  if (idx.byAddr.has(addr)) return idx.byAddr.get(addr)!;
  if (idx.byDomain.has(domain)) return idx.byDomain.get(domain)!;
  return null;
}

async function ensureDonnaLabel(
  composio: Composio,
  state: ConnState,
): Promise<string> {
  const r = (await composio.tools.execute("GMAIL_LIST_LABELS", {
    userId: state.user_id,
    connectedAccountId: state.connected_account_id,
    dangerouslySkipVersionCheck: true,
    arguments: {},
  } as never)) as { data?: { labels?: Array<{ id?: string; name?: string }> } };
  const existing = r.data?.labels?.find((l) => l.name === DONNA_LABEL);
  if (existing?.id) return existing.id;

  console.log(`[label] creating '${DONNA_LABEL}'`);
  const created = (await composio.tools.execute("GMAIL_CREATE_LABEL", {
    userId: state.user_id,
    connectedAccountId: state.connected_account_id,
    dangerouslySkipVersionCheck: true,
    arguments: { label_name: DONNA_LABEL },
  } as never)) as { data?: { id?: string } };
  const id = created.data?.id;
  if (!id) throw new Error("GMAIL_CREATE_LABEL returned no id");
  return id;
}

async function applyArchiveAndLabel(
  composio: Composio,
  state: ConnState,
  messageId: string,
  donnaLabelId: string,
): Promise<void> {
  await composio.tools.execute("GMAIL_ADD_LABEL_TO_EMAIL", {
    userId: state.user_id,
    connectedAccountId: state.connected_account_id,
    dangerouslySkipVersionCheck: true,
    arguments: {
      message_id: messageId,
      add_label_ids: [donnaLabelId],
      remove_label_ids: ["INBOX"],
    },
  } as never);
}

async function fetchInbox(
  composio: Composio,
  state: ConnState,
  sinceHours: number,
  limit: number,
): Promise<RawMessage[]> {
  const days = Math.max(1, Math.ceil(sinceHours / 24));
  const q = `in:inbox newer_than:${days}d`;
  const out: RawMessage[] = [];
  let pageToken: string | null = null;
  while (out.length < limit) {
    const remaining = limit - out.length;
    const max = Math.min(PAGE_SIZE, remaining);
    const args: Record<string, unknown> = { query: q, max_results: max };
    if (pageToken) args.page_token = pageToken;
    const r = (await composio.tools.execute("GMAIL_FETCH_EMAILS", {
      userId: state.user_id,
      connectedAccountId: state.connected_account_id,
      dangerouslySkipVersionCheck: true,
      arguments: args,
    } as never)) as {
      data?: { messages?: RawMessage[]; nextPageToken?: string };
    };
    const msgs = r.data?.messages ?? [];
    if (msgs.length === 0) break;
    out.push(...msgs);
    pageToken = r.data?.nextPageToken ?? null;
    if (!pageToken) break;
  }
  return out.slice(0, limit);
}

async function main() {
  const { apply, limit, sinceHours } = parseArgs();
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) throw new Error("COMPOSIO_API_KEY not set");

  const state = loadConn();
  const rules = loadRules();
  const idx = indexRules(rules);
  const composio = new Composio({ apiKey });
  const audit = openAuditDb();
  const insertAction = audit.prepare(`
    INSERT INTO maintenance_actions
      (ts, message_id, thread_id, from_addr, subject, rule_id, action,
       reason, add_labels, remove_labels, dry_run, applied, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  console.log(
    `[run-pass] mode=${apply ? "APPLY (live)" : "dry-run"}  limit=${limit}  since=${sinceHours}h  rules=${rules.length}`,
  );

  const donnaLabelId = apply ? await ensureDonnaLabel(composio, state) : "<dry-run>";
  if (apply) console.log(`[run-pass] donna/skim label id: ${donnaLabelId}`);

  const inbox = await fetchInbox(composio, state, sinceHours, limit);
  console.log(`[run-pass] fetched ${inbox.length} inbox messages`);

  let matched = 0;
  let applied = 0;
  let errors = 0;
  const matchedSamples: Array<{ from: string; subject: string; rule: string }> = [];

  for (const m of inbox) {
    const sender = m.sender ?? "";
    const rule = matchRule(sender, idx);
    const ts = new Date().toISOString();
    if (!rule) {
      insertAction.run(
        ts,
        m.messageId ?? "",
        m.threadId ?? "",
        sender,
        m.subject ?? "",
        null,
        "skip",
        "no rule match",
        null,
        null,
        apply ? 0 : 1,
        0,
        null,
      );
      continue;
    }
    matched++;
    if (matchedSamples.length < 20) {
      matchedSamples.push({ from: sender, subject: m.subject ?? "", rule: rule.id });
    }
    if (apply) {
      try {
        await applyArchiveAndLabel(composio, state, m.messageId ?? "", donnaLabelId);
        insertAction.run(
          ts,
          m.messageId ?? "",
          m.threadId ?? "",
          sender,
          m.subject ?? "",
          rule.id,
          "archive_and_label",
          "rule match",
          JSON.stringify([DONNA_LABEL]),
          JSON.stringify(["INBOX"]),
          0,
          1,
          null,
        );
        applied++;
      } catch (e) {
        errors++;
        insertAction.run(
          ts,
          m.messageId ?? "",
          m.threadId ?? "",
          sender,
          m.subject ?? "",
          rule.id,
          "archive_and_label",
          "rule match",
          JSON.stringify([DONNA_LABEL]),
          JSON.stringify(["INBOX"]),
          0,
          0,
          (e as Error).message,
        );
      }
    } else {
      insertAction.run(
        ts,
        m.messageId ?? "",
        m.threadId ?? "",
        sender,
        m.subject ?? "",
        rule.id,
        "archive_and_label",
        "rule match (dry-run)",
        JSON.stringify([DONNA_LABEL]),
        JSON.stringify(["INBOX"]),
        1,
        0,
        null,
      );
    }
  }

  console.log("");
  console.log("─".repeat(72));
  console.log(`scanned:   ${inbox.length}`);
  console.log(`matched:   ${matched}  (${((matched / Math.max(inbox.length, 1)) * 100).toFixed(0)}%)`);
  console.log(`unmatched: ${inbox.length - matched}`);
  if (apply) {
    console.log(`applied:   ${applied}`);
    console.log(`errors:    ${errors}`);
  }
  console.log("─".repeat(72));
  console.log(`would ${apply ? "be" : "be"} archived ${matched ? "(samples):" : ""}`);
  for (const s of matchedSamples) {
    console.log(`  [${s.rule}]  ${s.from.slice(0, 50).padEnd(50)}  ${s.subject.slice(0, 50)}`);
  }
  if (matched > matchedSamples.length) {
    console.log(`  ... and ${matched - matchedSamples.length} more`);
  }

  audit.close();
}

main().catch((err) => {
  console.error("[run-pass] failed:", err);
  process.exit(1);
});
