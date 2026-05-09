// backfill-gmail: paginate gmail history via composio, filter the obvious
// noise, write surviving messages to supermemory, audit everything, then
// fire a proactive ack so donna tells the user it's done.
//
// usage:
//   npx tsx scripts/backfill-gmail.ts                                  # defaults
//   npx tsx scripts/backfill-gmail.ts --scope sent --since-days 14
//   npx tsx scripts/backfill-gmail.ts --scope both --since-days 30 --limit 500
//
// defaults: --scope sent --since-days 30 --limit 500
//   small enough to finish in 1-2 minutes, big enough to feel real.
//   sent-only by default because every sent email is high-signal by definition.
//
// scope options:
//   sent   → in:sent only
//   inbox  → in:inbox only (with hard noise filter)
//   both   → in:inbox + in:sent (with filter on inbox side)

import "../src/donna/env.js";
import { randomUUID } from "node:crypto";
import { closeDb, getSql } from "../src/donna/db.js";
import { withTurnContext } from "../src/donna/context.js";
import { executeForUser, readState } from "../src/donna/integrations/service.js";
import {
  getMemoryClient,
  buildEntityContext,
} from "../src/donna/integrations/supermemory.js";
import { runProactiveTurn } from "../src/donna/brain.js";
import type { ProactiveCause } from "../src/donna/proactive/cause.js";
import { deliverBurstToUser } from "../src/donna/delivery/proactive.js";

// ---------------------------------------------------------------------------
// types — the bits of composio's GMAIL_FETCH_EMAILS response we care about.
// ---------------------------------------------------------------------------

interface RawGmailMessage {
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

interface FetchEmailsResponse {
  messages?: RawGmailMessage[];
  nextPageToken?: string;
  next_page_token?: string;
}

interface NormalizedMessage {
  id: string;
  thread_id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  date: string;
  labels: string[];
}

function normalize(raw: RawGmailMessage): NormalizedMessage {
  const body = raw.messageText ?? raw.preview?.body ?? "";
  return {
    id: raw.messageId ?? "",
    thread_id: raw.threadId ?? "",
    from: raw.sender ?? "",
    to: raw.to ?? "",
    subject: raw.subject ?? "",
    body,
    date: raw.messageTimestamp ?? "",
    labels: raw.labelIds ?? [],
  };
}

// ---------------------------------------------------------------------------
// the cheap noise filter — gmail labels + sender heuristics. zero llm.
// applied to inbox; the sent folder is always indexed.
// ---------------------------------------------------------------------------

const NOISE_LABELS = new Set([
  "CATEGORY_PROMOTIONS",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
  "CATEGORY_SOCIAL",
]);

const NOISE_SENDER_RE =
  /(?:^|<|\s)(?:no[-_.]?reply|noreply|notify|notifications?|alerts?|mailer|do[-_.]?not[-_.]?reply|donotreply|automated)@/i;

function shouldIndexInbox(msg: NormalizedMessage): boolean {
  for (const label of msg.labels) {
    if (NOISE_LABELS.has(label)) return false;
  }
  if (NOISE_SENDER_RE.test(msg.from)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// cli args
// ---------------------------------------------------------------------------

type Scope = "sent" | "inbox" | "both";

interface CliArgs {
  provider: string;
  scope: Scope;
  sinceDays: number;
  limit: number;
  batchSize: number;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const provider = get("--provider") ?? "gmail";
  const scopeRaw = (get("--scope") ?? "sent") as Scope;
  if (!["sent", "inbox", "both"].includes(scopeRaw)) {
    throw new Error(`--scope must be sent | inbox | both (got ${scopeRaw})`);
  }
  const sinceDays = Number(get("--since-days") ?? 30);
  const limit = Number(get("--limit") ?? 500);
  const batchSize = Number(get("--batch-size") ?? 100);
  return { provider, scope: scopeRaw, sinceDays, limit, batchSize };
}

function buildQuery(scope: Scope, sinceDays: number): string {
  const newer = `newer_than:${Math.max(1, Math.ceil(sinceDays))}d`;
  if (scope === "sent") return `in:sent ${newer}`;
  if (scope === "inbox") return `in:inbox ${newer}`;
  return `(in:inbox OR in:sent) ${newer}`;
}

// ---------------------------------------------------------------------------
// dedup — pre-load the set of msg_ids we've already indexed for this user
// so we skip them without round-tripping per message.
// ---------------------------------------------------------------------------

async function loadIndexedSet(userId: string): Promise<Set<string>> {
  const sql = getSql();
  const rows = await sql<{ item_ref: string }[]>`
    select item_ref
    from integration_audit
    where user_id = ${userId}
      and provider = 'gmail'
      and action = 'backfill.indexed'
      and ok = true
      and item_ref is not null
  `;
  const set = new Set<string>();
  for (const r of rows) if (r.item_ref) set.add(r.item_ref);
  return set;
}

// ---------------------------------------------------------------------------
// audit — one row per per-message decision. uses the same integration_audit
// table the runtime uses; cross-referenceable by time.
// ---------------------------------------------------------------------------

async function auditRow(args: {
  userId: string;
  action: string;
  itemRef?: string | null;
  ok: boolean;
  durationMs?: number;
  meta?: Record<string, unknown>;
}): Promise<void> {
  try {
    const sql = getSql();
    await sql`
      insert into integration_audit (user_id, provider, action, item_ref, ok, duration_ms, meta)
      values (
        ${args.userId},
        'gmail',
        ${args.action},
        ${args.itemRef ?? null},
        ${args.ok},
        ${args.durationMs ?? null},
        ${sql.json((args.meta ?? {}) as Parameters<typeof sql.json>[0])}
      )
    `;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[backfill] audit write failed (${args.action}): ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const userId = process.env.DONNA_USER_ID;
  if (!userId) throw new Error("DONNA_USER_ID not set");

  const args = parseArgs();
  console.log(`[backfill] user=${userId.slice(0, 8)} scope=${args.scope} since=${args.sinceDays}d limit=${args.limit}`);

  const state = await readState(userId, args.provider);
  if (!state || state.status !== "connected") {
    throw new Error(
      `gmail not connected for this user (status=${state?.status ?? "missing"}). run scripts/connect-integration.ts first.`,
    );
  }

  const memory = getMemoryClient();
  if (!memory.available) {
    throw new Error("supermemory unavailable — set SUPERMEMORY_API_KEY in .env");
  }

  // pre-load the dedup set ONCE up front. cheap query (indexed),
  // saves N round-trips during the loop.
  const indexed = await loadIndexedSet(userId);
  console.log(`[backfill] dedup: ${indexed.size} msg_ids already indexed (skipping on re-encounter)`);

  const query = buildQuery(args.scope, args.sinceDays);
  console.log(`[backfill] query: ${query}`);

  const entityContext = buildEntityContext();

  let processed = 0;
  let kept = 0;
  let skippedNoise = 0;
  let skippedDedup = 0;
  let failed = 0;
  let pageToken: string | undefined;
  let pageNum = 0;

  const startedAt = Date.now();

  // executeForUser requires a turn context (userId + runId). use a synthetic
  // runId for this backfill run — it appears in audit rows and any langsmith
  // traces of internal handler calls.
  const synthRunId = randomUUID();

  await withTurnContext(
    { userId, runId: synthRunId, source: "proactive_worker" },
    async () => {
      while (kept < args.limit) {
        pageNum++;
        const data = await executeForUser<FetchEmailsResponse>(
          args.provider,
          "GMAIL_FETCH_EMAILS",
          {
            query,
            max_results: Math.min(args.batchSize, args.limit - kept),
            ...(pageToken ? { page_token: pageToken } : {}),
          },
          { action: "backfill.fetch_page", meta: { query, page: pageNum, page_token: pageToken ?? null } },
        );

        const messages = data.messages ?? [];
        const nextToken = data.nextPageToken ?? data.next_page_token;
        if (messages.length === 0) {
          console.log(`[backfill] page ${pageNum}: empty, stopping.`);
          break;
        }

        for (const raw of messages) {
          processed++;
          const msg = normalize(raw);
          if (!msg.id) {
            failed++;
            continue;
          }

          // dedup
          if (indexed.has(msg.id)) {
            skippedDedup++;
            await auditRow({
              userId,
              action: "backfill.skip",
              itemRef: msg.id,
              ok: true,
              meta: { reason: "dedup" },
            });
            continue;
          }

          // noise filter — sent always passes; inbox runs through shouldIndexInbox
          const inSent = msg.labels.includes("SENT");
          if (!inSent && !shouldIndexInbox(msg)) {
            skippedNoise++;
            await auditRow({
              userId,
              action: "backfill.skip",
              itemRef: msg.id,
              ok: true,
              meta: {
                reason: "noise",
                labels: msg.labels.filter((l) => NOISE_LABELS.has(l)),
                from_match: NOISE_SENDER_RE.test(msg.from),
              },
            });
            continue;
          }

          // index into supermemory. customId = `gmail:${msg_id}` makes
          // re-runs idempotent on supermemory's side too.
          const content = formatEmailForRecall(msg);
          const itemStartedAt = Date.now();
          let smId: string;
          try {
            smId = await memory.addEpisode({
              userId,
              content,
              messageType: "email",
              customId: `gmail:${msg.id}`,
              entityContext,
              metadata: {
                source: "gmail",
                msg_id: msg.id,
                thread_id: msg.thread_id,
                from: msg.from,
                to: msg.to,
                subject: msg.subject,
                date: msg.date,
                labels: msg.labels,
              },
            });
          } catch (err) {
            failed++;
            const errMsg = err instanceof Error ? err.message : String(err);
            await auditRow({
              userId,
              action: "backfill.failed",
              itemRef: msg.id,
              ok: false,
              durationMs: Date.now() - itemStartedAt,
              meta: { error: errMsg },
            });
            continue;
          }

          if (!smId) {
            // wrapper degraded silently — treat as failure for accounting
            failed++;
            await auditRow({
              userId,
              action: "backfill.failed",
              itemRef: msg.id,
              ok: false,
              durationMs: Date.now() - itemStartedAt,
              meta: { error: "supermemory returned empty id" },
            });
            continue;
          }

          kept++;
          indexed.add(msg.id);
          await auditRow({
            userId,
            action: "backfill.indexed",
            itemRef: msg.id,
            ok: true,
            durationMs: Date.now() - itemStartedAt,
            meta: { sm_id: smId, subject: msg.subject.slice(0, 120) },
          });

          if (kept % 25 === 0) {
            console.log(
              `[backfill] kept=${kept} skipped_noise=${skippedNoise} skipped_dedup=${skippedDedup} failed=${failed}`,
            );
          }

          // light throttle so we don't slam supermemory
          await sleep(40);

          if (kept >= args.limit) break;
        }

        if (!nextToken) {
          console.log(`[backfill] no nextPageToken, history exhausted.`);
          break;
        }
        pageToken = nextToken;
        // small breath between pages
        await sleep(150);
      }
    },
  );

  const durationMs = Date.now() - startedAt;
  console.log(
    `\n[backfill] done in ${(durationMs / 1000).toFixed(1)}s. ` +
      `processed=${processed} kept=${kept} ` +
      `skipped_noise=${skippedNoise} skipped_dedup=${skippedDedup} failed=${failed}`,
  );

  // proactive ack — donna tells the user the backfill is done, in her voice.
  console.log(`\n[backfill] asking donna to acknowledge...\n`);
  try {
    const cause: ProactiveCause = {
      kind: "scheduled",
      payload: {
        provider: args.provider,
        scope: args.scope,
        since_days: args.sinceDays,
        kept,
        skipped_noise: skippedNoise,
        skipped_dedup: skippedDedup,
        failed,
        duration_seconds: Math.round(durationMs / 1000),
      },
      set_at: new Date().toISOString(),
      schedule_id: synthRunId,
      instruction:
        `gmail backfill into supermemory just finished. scope=${args.scope}, last ${args.sinceDays} days. ` +
        `indexed ${kept} new emails, skipped ${skippedNoise} as noise and ${skippedDedup} as dedup. ` +
        `acknowledge briefly and offer one next move (e.g. let user try a recall query, or trigger a triage).`,
    };

    const result = await runProactiveTurn({ userId, source: "whatsapp", cause });
    if (result.sends.length === 0) {
      console.log("(donna had nothing to say)");
    } else {
      for (const send of result.sends) console.log(`donna: ${send}`);
    }
    const delivery = await deliverBurstToUser(userId, result.sends);
    if (delivery.channel === "whatsapp") {
      console.log(
        `\n→ delivered ${delivery.delivered}/${result.sends.length} burst(s) via whatsapp.`,
      );
    } else {
      console.log("\n(no phone on file — bursts printed only.)");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`(proactive ack failed: ${msg})`);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function formatEmailForRecall(msg: NormalizedMessage): string {
  // supermemory's extractor reads this. structured header + body keeps both
  // metadata fields and content searchable.
  return [
    `From: ${msg.from}`,
    `To: ${msg.to}`,
    `Subject: ${msg.subject}`,
    `Date: ${msg.date}`,
    `Labels: ${msg.labels.join(", ")}`,
    "",
    msg.body.slice(0, 6000), // cap to keep payloads sane
  ].join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

run()
  .catch((err) => {
    console.error("[backfill] failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
