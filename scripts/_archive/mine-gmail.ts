// scripts/mine-gmail.ts
//
// pulls gmail metadata for the connected account into a local sqlite db
// (scripts/mining/gmail.sqlite). resumable: progress tracked per-month.
//
// metadata-first by design — we ignore the full body, store only the
// 280-char snippet/preview alongside subject/from/to/date/labels/thread.
// bodies come in a second pass once metadata analysis identifies the
// interesting ~500 threads worth deep-reading.
//
// run:
//   npx tsx scripts/mine-gmail.ts                       # 1 month (default)
//   npx tsx scripts/mine-gmail.ts --months 24           # full 2-year sweep
//   npx tsx scripts/mine-gmail.ts --months 24 --resume  # continue an interrupted run

import "dotenv/config";
import { Composio } from "@composio/core";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = "scripts/mining/gmail.sqlite";
const STATE_FILE = "scripts/.composio-mining.json";
// composio caps response payload size; 25 is the safe upper bound when
// GMAIL_FETCH_EMAILS returns full messageText. 100 → 413 Upstream_PayloadTooLarge.
const PAGE_SIZE = 25;
const MAX_RETRIES = 3;

interface ConnState {
  user_id: string;
  connected_account_id: string;
  toolkit: string;
}

interface RawMessage {
  messageId?: string;
  threadId?: string;
  sender?: string;
  to?: string;
  subject?: string;
  messageText?: string;
  preview?: { body?: string };
  labelIds?: string[];
  messageTimestamp?: string;
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const months = Number(get("--months") ?? 1);
  const resume = argv.includes("--resume");
  return { months, resume };
}

function loadState(): ConnState {
  if (!existsSync(STATE_FILE)) {
    throw new Error(
      `${STATE_FILE} not found. run scripts/connect-gmail-local.ts first.`,
    );
  }
  const raw = readFileSync(STATE_FILE, "utf8");
  return JSON.parse(raw) as ConnState;
}

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthBounds(d: Date): { after: string; before: string } {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  // gmail query syntax: after:YYYY/MM/DD (inclusive), before:YYYY/MM/DD (exclusive)
  const after = `${y}/${String(m + 1).padStart(2, "0")}/01`;
  const next = new Date(Date.UTC(y, m + 1, 1));
  const before = `${next.getUTCFullYear()}/${String(
    next.getUTCMonth() + 1,
  ).padStart(2, "0")}/01`;
  return { after, before };
}

function openDb(): DatabaseSync {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT,
      from_addr TEXT,
      to_addr TEXT,
      subject TEXT,
      date_iso TEXT,
      snippet TEXT,
      labels_json TEXT,
      fetched_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date_iso);
    CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_addr);
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);

    CREATE TABLE IF NOT EXISTS progress (
      month_key TEXT PRIMARY KEY,
      status TEXT,
      inserted_count INTEGER DEFAULT 0,
      last_page_token TEXT,
      last_error TEXT,
      completed_at TEXT,
      updated_at TEXT
    );
  `);
  return db;
}

async function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function fetchPage(
  composio: Composio,
  state: ConnState,
  query: string,
  pageToken: string | null,
): Promise<{ messages: RawMessage[]; nextPageToken: string | null }> {
  const args: Record<string, unknown> = {
    query,
    max_results: PAGE_SIZE,
  };
  if (pageToken) args.page_token = pageToken;

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = (await composio.tools.execute("GMAIL_FETCH_EMAILS", {
        userId: state.user_id,
        connectedAccountId: state.connected_account_id,
        dangerouslySkipVersionCheck: true,
        arguments: args,
      } as never)) as {
        successful?: boolean;
        data?: { messages?: RawMessage[]; nextPageToken?: string };
        error?: unknown;
      };
      if (resp.successful === false) {
        throw new Error(`composio: ${JSON.stringify(resp.error)}`);
      }
      return {
        messages: resp.data?.messages ?? [],
        nextPageToken: resp.data?.nextPageToken ?? null,
      };
    } catch (e) {
      lastErr = e;
      const wait = 1000 * 2 ** (attempt - 1);
      console.warn(
        `  [retry ${attempt}/${MAX_RETRIES}] ${(e as Error).message}; waiting ${wait}ms`,
      );
      await sleep(wait);
    }
  }
  throw lastErr ?? new Error("fetchPage: exhausted retries");
}

async function main() {
  const { months: scanMonths, resume } = parseArgs();
  if (scanMonths < 1 || scanMonths > 60) {
    throw new Error(`--months must be 1..60 (got ${scanMonths})`);
  }

  const state = loadState();
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) throw new Error("COMPOSIO_API_KEY not set");

  console.log(`[mine] ${scanMonths} month(s), user=${state.user_id}, ca=${state.connected_account_id}`);
  console.log(`[mine] resume=${resume}`);

  const composio = new Composio({ apiKey });
  const db = openDb();

  const insertMessage = db.prepare(`
    INSERT OR IGNORE INTO messages
      (id, thread_id, from_addr, to_addr, subject, date_iso, snippet, labels_json, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const upsertProgress = db.prepare(`
    INSERT INTO progress
      (month_key, status, inserted_count, last_page_token, last_error, completed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(month_key) DO UPDATE SET
      status = excluded.status,
      inserted_count = excluded.inserted_count,
      last_page_token = excluded.last_page_token,
      last_error = excluded.last_error,
      completed_at = excluded.completed_at,
      updated_at = excluded.updated_at
  `);
  const getProgress = db.prepare(`
    SELECT status, inserted_count, last_page_token FROM progress WHERE month_key = ?
  `);

  const insertBatch = (rows: RawMessage[]) => {
    const now = new Date().toISOString();
    db.exec("BEGIN");
    try {
      for (const m of rows) {
        insertMessage.run(
          m.messageId ?? "",
          m.threadId ?? "",
          m.sender ?? "",
          m.to ?? "",
          m.subject ?? "",
          m.messageTimestamp ?? "",
          (m.preview?.body ?? m.messageText ?? "").slice(0, 280),
          JSON.stringify(m.labelIds ?? []),
          now,
        );
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };

  const now = new Date();
  const monthsToMine: Date[] = [];
  for (let i = 0; i < scanMonths; i++) {
    monthsToMine.push(
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)),
    );
  }

  let totalInserted = 0;
  let totalPages = 0;
  const startedAt = Date.now();

  for (const monthStart of monthsToMine) {
    const key = monthKey(monthStart);
    const prog = getProgress.get(key) as
      | { status: string; inserted_count: number; last_page_token: string | null }
      | undefined;
    if (prog?.status === "done") {
      console.log(`[skip] ${key} already done (${prog.inserted_count} msgs)`);
      continue;
    }

    const { after, before } = monthBounds(monthStart);
    const query = `after:${after} before:${before}`;
    console.log(`[mine] ${key}  query="${query}"`);

    let pageToken = resume ? (prog?.last_page_token ?? null) : null;
    let inserted = resume ? (prog?.inserted_count ?? 0) : 0;
    let pages = 0;

    try {
      while (true) {
        const { messages, nextPageToken } = await fetchPage(
          composio,
          state,
          query,
          pageToken,
        );
        if (messages.length > 0) insertBatch(messages);
        inserted += messages.length;
        pages++;
        totalPages++;
        pageToken = nextPageToken;
        upsertProgress.run(
          key,
          "running",
          inserted,
          pageToken,
          null,
          null,
          new Date().toISOString(),
        );
        console.log(
          `  page ${pages}: +${messages.length} (month total ${inserted})${pageToken ? "" : "  [done]"}`,
        );
        if (!pageToken) break;
      }
      upsertProgress.run(
        key,
        "done",
        inserted,
        null,
        null,
        new Date().toISOString(),
        new Date().toISOString(),
      );
      totalInserted += inserted;
    } catch (e) {
      const msg = (e as Error).message;
      console.error(`  [error] ${msg}`);
      upsertProgress.run(
        key,
        "error",
        inserted,
        pageToken,
        msg,
        null,
        new Date().toISOString(),
      );
    }
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  const total = (db.prepare("SELECT count(*) as n FROM messages").get() as { n: number }).n;
  console.log("");
  console.log("=".repeat(72));
  console.log(`[mine] done. this run: +${totalInserted} msgs across ${totalPages} pages in ${elapsedSec}s`);
  console.log(`[mine] db total: ${total} messages at ${DB_PATH}`);
  console.log("=".repeat(72));

  db.close();
}

main().catch((err) => {
  console.error("[mine] failed:", err);
  process.exit(1);
});
