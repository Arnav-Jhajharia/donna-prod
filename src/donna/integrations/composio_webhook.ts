// composio webhook handler. composio receives provider events (gmail
// pub/sub, slack rtm, etc), normalizes them, and POSTs to our endpoint.
// we verify the hmac signature via the composio sdk, dedupe, resolve the
// integrations row, build a ProactiveCause, and fire runProactiveTurn.
//
// we own three things here:
//   - signature verification (delegated to composio.triggers.verifyWebhook)
//   - per-webhook-id in-memory dedupe (5min ttl, mirrors the wa pattern)
//   - composio_account_id -> donna user_id resolution + cause synthesis
//
// composio handles: gmail watch lifecycle, watch renewal, history pagination,
// the google-side push subscription. our endpoint just receives normalized
// events.

import { randomUUID } from "node:crypto";
import { getComposio, resolveGmailUserEmail } from "./composio.js";
import { getSql } from "../db.js";
import { runProactiveTurn } from "../brain.js";
import { deliverBurstToUser } from "../delivery/proactive.js";
import { classifyPushedThread } from "../extractors/threads/index.js";
import { audit } from "./service.js";
import type { ProactiveCause, ProactiveCauseKind } from "../proactive/cause.js";

// ── dedupe ──────────────────────────────────────────────────────────────────
//
// composio retries on 5xx within ~seconds. an in-memory cache catches the
// retry burst on a single box. multi-box deployments would race, but worst
// case is a duplicate proactive turn — donna might say two similar bursts.
// upgrade to a unique-keyed insert if duplicates show up in production.

const _seenWebhookIds = new Map<string, number>();
const _DEDUP_TTL_MS = 5 * 60 * 1000;

function isDuplicate(webhookId: string): boolean {
  const now = Date.now();
  for (const [k, ts] of _seenWebhookIds) {
    if (now - ts > _DEDUP_TTL_MS) _seenWebhookIds.delete(k);
  }
  if (_seenWebhookIds.has(webhookId)) return true;
  _seenWebhookIds.set(webhookId, now);
  return false;
}

// ── verify ──────────────────────────────────────────────────────────────────

interface ComposioWebhookHeaders {
  signature: string | null;
  webhookId: string | null;
  webhookTimestamp: string | null;
}

export interface VerifiedWebhook {
  triggerSlug: string;
  toolkitSlug: string;
  composioConnectedAccountId: string;
  composioUserId: string;
  payload: Record<string, unknown>;
  webhookId: string;
}

interface ComposioWebhookPayloadShape {
  triggerSlug: string;
  metadata: {
    toolkitSlug: string;
    connectedAccount: { id: string; userId: string };
  };
  payload?: Record<string, unknown>;
}

export async function verifyComposioWebhook(args: {
  rawBody: string;
  headers: ComposioWebhookHeaders;
}): Promise<VerifiedWebhook | null> {
  const secret = process.env.COMPOSIO_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[composio] COMPOSIO_WEBHOOK_SECRET not set — rejecting webhook");
    return null;
  }
  const { signature, webhookId, webhookTimestamp } = args.headers;
  if (!signature || !webhookId || !webhookTimestamp) {
    console.warn("[composio] missing webhook signature headers");
    return null;
  }

  const composio = getComposio();
  let result: Awaited<ReturnType<typeof composio.triggers.verifyWebhook>>;
  try {
    result = await composio.triggers.verifyWebhook({
      payload: args.rawBody,
      signature,
      id: webhookId,
      timestamp: webhookTimestamp,
      secret,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[composio] webhook signature verification failed: ${msg}`);
    return null;
  }

  const verified = result.payload as ComposioWebhookPayloadShape;
  return {
    triggerSlug: verified.triggerSlug,
    toolkitSlug: verified.metadata.toolkitSlug,
    composioConnectedAccountId: verified.metadata.connectedAccount.id,
    composioUserId: verified.metadata.connectedAccount.userId,
    payload: verified.payload ?? {},
    webhookId,
  };
}

// ── dispatch ────────────────────────────────────────────────────────────────
//
// resolve the composio connected_account back to donna's user. we wrote
// composio_account_id into integrations on connect, so this is a single
// lookup. if no row matches, it's an orphaned trigger (account deleted on
// our side but still firing on composio's) — log + drop.

interface ResolvedUser {
  user_id: string;
  provider: string;
}

async function resolveUserFromConnectedAccount(
  composioConnectedAccountId: string,
  expectedToolkit: string,
): Promise<ResolvedUser | null> {
  const sql = getSql();
  const rows = await sql<ResolvedUser[]>`
    select user_id, provider
    from integrations
    where composio_account_id = ${composioConnectedAccountId}
      and provider = ${expectedToolkit}
      and status = 'connected'
    limit 1
  `;
  return rows[0] ?? null;
}

function extractThreadId(payload: Record<string, unknown>): string | null {
  if (typeof payload.threadId === "string") return payload.threadId;
  if (typeof payload.thread_id === "string") return payload.thread_id;
  return null;
}

// only called once we know there IS a thread classification worth surfacing.
function causeForGmailEvent(args: {
  triggerSlug: string;
  threadId: string;
  donnaThreadDbId: string;
  oneLineSummary: string;
  importance: number;
  from: string | null;
  subject: string | null;
  daysWaiting: number | null;
}): ProactiveCause {
  const fromHint = args.from ? ` from ${args.from}` : "";
  const subjectHint = args.subject ? ` (subject: "${args.subject}")` : "";

  return {
    kind: "gmail_event",
    payload: {
      trigger_slug: args.triggerSlug,
      gmail_thread_id: args.threadId,
      thread_db_id: args.donnaThreadDbId,
      one_line_summary: args.oneLineSummary,
      importance: args.importance,
      from: args.from,
      subject: args.subject,
      days_waiting: args.daysWaiting,
    },
    set_at: new Date().toISOString(),
    schedule_id: randomUUID(),
    instruction:
      `new gmail thread on you (ball=user, importance=${args.importance.toFixed(2)})${fromHint}${subjectHint}. ` +
      `donna already classified the thread — use threads_get(id="${args.donnaThreadDbId}") for state, ` +
      `gmail_read_thread(thread_id="${args.threadId}") if you need bodies. ` +
      `summary so far: "${args.oneLineSummary}". ` +
      `default is still silence unless this is genuinely time-sensitive.`,
  };
}

function causeForUnknown(args: {
  triggerSlug: string;
  payload: Record<string, unknown>;
}): ProactiveCause {
  return {
    kind: "scheduled",
    payload: { trigger_slug: args.triggerSlug, ...args.payload },
    set_at: new Date().toISOString(),
    schedule_id: randomUUID(),
    instruction:
      `composio trigger ${args.triggerSlug} fired. you've not been taught ` +
      `to handle this kind explicitly — read history, decide if it's worth ` +
      `interrupting, default to do_nothing.`,
  };
}

export async function dispatchComposioWebhook(verified: VerifiedWebhook): Promise<void> {
  if (isDuplicate(verified.webhookId)) {
    console.info(`[composio] dedupe: ${verified.webhookId} already seen`);
    return;
  }

  const resolved = await resolveUserFromConnectedAccount(
    verified.composioConnectedAccountId,
    verified.toolkitSlug.toLowerCase(),
  );
  if (!resolved) {
    console.warn(
      `[composio] orphaned trigger: connected_account=${verified.composioConnectedAccountId} ` +
        `toolkit=${verified.toolkitSlug} — no integrations row. ignoring.`,
    );
    return;
  }

  // gmail-specific: classify the pushed thread before deciding whether to
  // wake the brain. cheap path: heuristic-only classifier handles ~90% of
  // events without an LLM call. only "ball is on user, importance ≥ floor"
  // events earn a proactive turn.
  let cause: ProactiveCause;
  let kind: ProactiveCauseKind;
  const slugUp = verified.triggerSlug.toUpperCase();
  if (slugUp.startsWith("GMAIL_")) {
    const threadId = extractThreadId(verified.payload);
    if (!threadId) {
      console.info(`[composio] ${verified.triggerSlug} no thread_id in payload — dropping`);
      return;
    }
    const userEmail = await resolveGmailUserEmail(resolved.user_id);
    if (!userEmail) {
      console.warn(`[composio] ${verified.triggerSlug} no gmail email for user — dropping`);
      return;
    }

    let pushResult;
    try {
      pushResult = await classifyPushedThread({
        userId: resolved.user_id,
        userEmail,
        gmailThreadId: threadId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[composio] thread classify failed for ${threadId}: ${msg}`);
      return;
    }
    if (!pushResult) {
      console.info(`[composio] ${verified.triggerSlug} thread ${threadId} not classifiable`);
      return;
    }

    if (!pushResult.is_worth_interrupting) {
      console.info(
        `[composio] ${verified.triggerSlug} thread ${threadId} not worth burst (${pushResult.reason})`,
      );
      await audit({
        userId: resolved.user_id,
        provider: "gmail",
        action: "threads.push_silenced",
        itemRef: threadId,
        ok: true,
        meta: {
          state: pushResult.classified.state,
          ball: pushResult.classified.ball_in_court,
          importance: pushResult.classified.importance_score,
          reason: pushResult.reason,
        },
      });
      return;
    }

    // pull the donna thread row id we just upserted, for the cause payload
    const sql = getSql();
    const rows = await sql<Array<{ id: string }>>`
      select id from gmail_threads
      where user_id = ${resolved.user_id} and gmail_thread_id = ${threadId}
      limit 1
    `;
    const donnaThreadDbId = rows[0]?.id ?? "";

    cause = causeForGmailEvent({
      triggerSlug: verified.triggerSlug,
      threadId,
      donnaThreadDbId,
      oneLineSummary: pushResult.classified.one_line_summary,
      importance: pushResult.classified.importance_score,
      from: pushResult.candidate.last_message.from_email || null,
      subject: pushResult.candidate.last_message.subject || null,
      daysWaiting: null,
    });
    kind = "gmail_event";
  } else {
    cause = causeForUnknown({
      triggerSlug: verified.triggerSlug,
      payload: verified.payload,
    });
    kind = "scheduled";
  }

  console.info(
    `[composio] ${verified.triggerSlug} -> ${kind} for user=${resolved.user_id.slice(0, 8)}`,
  );

  let result;
  try {
    result = await runProactiveTurn({
      userId: resolved.user_id,
      source: "proactive_worker",
      cause,
      langsmithExtra: {
        tags: ["composio", "proactive", verified.triggerSlug],
        metadata: {
          user_id: resolved.user_id,
          provider: resolved.provider,
          composio_trigger: verified.triggerSlug,
          composio_webhook_id: verified.webhookId,
        },
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[composio] proactive turn failed for ${verified.triggerSlug}: ${msg}`);
    return;
  }

  if (result.sends.length === 0) {
    console.info(`[composio] ${verified.triggerSlug} -> ${result.terminator} (no burst)`);
    return;
  }

  try {
    const delivery = await deliverBurstToUser(resolved.user_id, result.sends);
    console.info(
      `[composio] ${verified.triggerSlug} -> delivered ${delivery.delivered}/${result.sends.length} via ${delivery.channel}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[composio] delivery failed: ${msg}`);
  }
}
