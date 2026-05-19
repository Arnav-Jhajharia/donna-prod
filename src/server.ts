import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { MODEL, runTurn } from "./donna/brain.js";
import { loadRecentMessages, saveMessages } from "./donna/memory/chat.js";
import { closeDb, getSql } from "./donna/db.js";
import { getConfig } from "./donna/config.js";
import { parseWebhook } from "./donna/ingress/whatsapp.js";
import {
  parseWebhook as parseImessageWebhook,
  verifyWebhookSignature as verifyImessageSignature,
} from "./donna/ingress/imessage.js";
import type { IngressPayload } from "./donna/ingress/payload.js";
import { WhatsAppChannel } from "./donna/delivery/whatsapp.js";
import { IMessageChannel } from "./donna/delivery/imessage.js";
import type { TextMessage } from "./donna/delivery/messages.js";
import { getOrCreateUser, getUserByIdentity, recordIdentity, updateActivity } from "./donna/memory/users.js";
import { deliverSilenceFallback } from "./donna/delivery/omnipresence.js";
import { listPendingForUser, markDelivered, markRead } from "./donna/delivery/app.js";
import { insertSchedule } from "./donna/proactive/schedule.js";
import { upsertState, readState } from "./donna/integrations/service.js";
import {
  createExecutionRun,
  finishExecutionRun,
  listExecutionEvents,
  listExecutionRuns,
  recordExecutionEvent,
} from "./donna/observability/execution.js";

const wa = new WhatsAppChannel();
// imessage channel constructed lazily — IMessageChannel reads getLinqConfig()
// only on send, so the wa-only deployment path keeps working without LINQ_*.
let _imessage: IMessageChannel | null = null;
function getImessage(): IMessageChannel {
  if (!_imessage) _imessage = new IMessageChannel();
  return _imessage;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
  if (!raw) return {};
  return JSON.parse(raw);
}

function send(
  res: ServerResponse,
  status: number,
  body: string,
  contentType: string = "text/plain",
): void {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  send(res, status, JSON.stringify(obj), "application/json");
}

function isObservabilityAuthorized(req: IncomingMessage): boolean {
  const token = process.env.DONNA_OBSERVABILITY_TOKEN;
  if (!token) return false;
  const auth = req.headers.authorization ?? "";
  return auth === `Bearer ${token}`;
}

async function dispatchPayload(payload: IngressPayload): Promise<void> {
  // resolve sender → canonical user_id (creates on first contact, refreshes
  // profile_name when the platform offers a fresher one). fail-closed: if
  // we can't identify the user we don't run the brain.
  let user;
  try {
    user = await getOrCreateUser(payload.phone, payload.platformProfileName);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[wa] user resolution failed for ${payload.phone}: ${msg}`);
    return;
  }

  // stamp last_active_channel so the router knows where to push proactive
  // bursts. fire-and-forget — a stale stamp is a soft regression, never a
  // reason to drop the turn.
  void updateActivity(user.id, "whatsapp").catch(() => undefined);

  const runId = await createExecutionRun({
    userId: user.id,
    channel: "whatsapp",
    mode: "reactive",
    inboundMessageId: payload.platformMessageId,
    model: MODEL,
    metadata: {
      phone: user.phone,
      profile_name: user.profileName,
      platform_profile_name: payload.platformProfileName,
      message_type: payload.messageType,
      source: payload.source,
    },
  });
  await recordExecutionEvent(runId, "inbound_received", "whatsapp", {
    message_type: payload.messageType,
    has_text: Boolean(payload.message?.trim()),
  });

  // typing indicator (best-effort, fire-and-forget)
  if (payload.platformMessageId) {
    void wa
      .sendTyping(payload.phone, payload.platformMessageId)
      .catch(() => undefined);
  }

  // v0: only text-bearing payloads enter the brain. non-text gets a wave reaction.
  const text = payload.message?.trim();
  if (!text) {
    if (payload.platformMessageId) {
      await recordExecutionEvent(runId, "delivery_start", "whatsapp.reaction", {
        reaction: "wave",
      });
      void wa
        .sendReaction(payload.phone, payload.platformMessageId, "👋")
        .then(() =>
          recordExecutionEvent(runId, "delivery_end", "whatsapp.reaction", {
            ok: true,
          }),
        )
        .catch((err) =>
          recordExecutionEvent(runId, "delivery_error", "whatsapp.reaction", {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
    }
    console.info(
      `[wa] non-text payload (${payload.messageType}) from ${user.id.slice(0, 8)} — acked, brain skipped`,
    );
    await recordExecutionEvent(runId, "brain_skipped", "non_text_payload", {
      message_type: payload.messageType,
    });
    await finishExecutionRun(runId, {
      status: "completed",
      terminator: "brain_skipped",
      finalSends: [],
    });
    return;
  }

  let messages: MessageParam[];
  try {
    await recordExecutionEvent(runId, "memory_start", "loadRecentMessages", {
      limit: 50,
    });
    messages = await loadRecentMessages(user.id, 50);
    await recordExecutionEvent(runId, "memory_end", "loadRecentMessages", {
      message_count: messages.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[wa] couldn't load history: ${msg}`);
    await recordExecutionEvent(runId, "memory_error", "loadRecentMessages", {
      error: msg,
    });
    await finishExecutionRun(runId, {
      status: "failed",
      error: msg,
    });
    return;
  }

  let result;
  try {
    // langsmith metadata/tags travel via `langsmithExtra` — the brain's
    // traceable wrapper extracts and strips this field before invoking
    // _runTurn. no-op when LANGSMITH_TRACING is unset.
    result = await runTurn({
      mode: "reactive",
      messages,
      userInput: text,
      userId: user.id,
      source: "whatsapp",
      runId,
      langsmithExtra: {
        tags: ["whatsapp", "reactive"],
        metadata: {
          user_id: user.id,
          phone: user.phone,
          profile_name: user.profileName,
          source: "whatsapp",
          wa_message_id: payload.platformMessageId,
        },
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[wa] brain failed: ${msg}`);
    await recordExecutionEvent(runId, "brain_error", "runTurn", {
      error: msg,
    });
    // omnipresence: never let a brain failure become silence on the user's
    // surface. fallback burst still lands via the channel router.
    await deliverSilenceFallback({
      userId: user.id,
      runId,
      source: "whatsapp",
      error: err,
    });
    await finishExecutionRun(runId, {
      status: "failed",
      error: msg,
    });
    return;
  }

  try {
    await recordExecutionEvent(runId, "memory_start", "saveMessages", {
      message_count: result.newMessages.length,
    });
    await saveMessages(user.id, result.newMessages, "reactive");
    await recordExecutionEvent(runId, "memory_end", "saveMessages", {
      message_count: result.newMessages.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[wa] couldn't persist messages: ${msg}`);
    await recordExecutionEvent(runId, "memory_error", "saveMessages", {
      error: msg,
    });
  }

  // emit each visible send as a TextMessage. first one quote-replies the inbound.
  let deliveryError: string | null = null;
  for (const [i, body] of result.sends.entries()) {
    const out: TextMessage = {
      kind: "text",
      body,
      replyToMessageId: i === 0 ? payload.platformMessageId : null,
    };
    try {
      await recordExecutionEvent(runId, "delivery_start", "whatsapp.send", {
        index: i,
        total: result.sends.length,
        reply_to_message_id: out.replyToMessageId,
        body_preview: body.slice(0, 500),
      });
      await wa.send(payload.phone, out);
      await recordExecutionEvent(runId, "delivery_end", "whatsapp.send", {
        index: i,
        ok: true,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[wa] send failed (${i + 1}/${result.sends.length}): ${msg}`);
      deliveryError = msg;
      await recordExecutionEvent(runId, "delivery_error", "whatsapp.send", {
        index: i,
        error: msg,
      });
      break;
    }
  }

  if (result.terminator === "cap_hit") {
    console.error("[wa] cap_hit");
  }
  await finishExecutionRun(runId, {
    status: deliveryError ? "failed" : "completed",
    terminator: result.terminator,
    finalSends: result.sends,
    voiceViolations: result.voiceViolations,
    error: deliveryError,
  });
}

// ── imessage dispatcher ─────────────────────────────────────────────────────
//
// runs the brain on an inbound iMessage payload and delivers each visible
// send via the linq partner api. parallel to dispatchPayload (whatsapp).

async function dispatchImessagePayload(payload: IngressPayload): Promise<void> {
  let user;
  try {
    user = await getOrCreateUser(payload.phone, payload.platformProfileName);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[imessage] user resolution failed for ${payload.phone}: ${msg}`);
    return;
  }

  // stamp last_active_channel + ensure an imessage_phone identity exists so
  // future surfaces can resolve this user from the imessage side.
  void updateActivity(user.id, "imessage").catch(() => undefined);
  void recordIdentity({
    userId: user.id,
    provider: "imessage_phone",
    externalId: user.phone,
    metadata: payload.chatId ? { chat_id: payload.chatId } : {},
  }).catch(() => undefined);

  const runId = await createExecutionRun({
    userId: user.id,
    channel: "imessage",
    mode: "reactive",
    inboundMessageId: payload.platformMessageId,
    model: MODEL,
    metadata: {
      phone: user.phone,
      profile_name: user.profileName,
      message_type: payload.messageType,
      source: payload.source,
      chat_id: payload.chatId ?? null,
    },
  });
  await recordExecutionEvent(runId, "inbound_received", "imessage", {
    message_type: payload.messageType,
    has_text: Boolean(payload.message?.trim()),
    chat_id: payload.chatId ?? null,
  });

  const ch = getImessage();
  // typing indicator (best-effort, fire-and-forget)
  if (payload.chatId) {
    void ch.sendTyping(payload.chatId).catch(() => undefined);
  }

  const text = payload.message?.trim();
  if (!text) {
    if (payload.platformMessageId) {
      await recordExecutionEvent(runId, "delivery_start", "imessage.reaction", {
        reaction: "wave",
      });
      void ch
        .sendReaction(payload.platformMessageId, "👋")
        .then(() =>
          recordExecutionEvent(runId, "delivery_end", "imessage.reaction", {
            ok: true,
          }),
        )
        .catch((err) =>
          recordExecutionEvent(runId, "delivery_error", "imessage.reaction", {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
    }
    console.info(
      `[imessage] non-text payload (${payload.messageType}) from ${user.id.slice(0, 8)} — acked, brain skipped`,
    );
    await recordExecutionEvent(runId, "brain_skipped", "non_text_payload", {
      message_type: payload.messageType,
    });
    await finishExecutionRun(runId, {
      status: "completed",
      terminator: "brain_skipped",
      finalSends: [],
    });
    return;
  }

  let messages: MessageParam[];
  try {
    await recordExecutionEvent(runId, "memory_start", "loadRecentMessages", {
      limit: 50,
    });
    messages = await loadRecentMessages(user.id, 50);
    await recordExecutionEvent(runId, "memory_end", "loadRecentMessages", {
      message_count: messages.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[imessage] couldn't load history: ${msg}`);
    await recordExecutionEvent(runId, "memory_error", "loadRecentMessages", {
      error: msg,
    });
    await finishExecutionRun(runId, { status: "failed", error: msg });
    return;
  }

  let result;
  try {
    result = await runTurn({
      mode: "reactive",
      messages,
      userInput: text,
      userId: user.id,
      source: "imessage",
      runId,
      langsmithExtra: {
        tags: ["imessage", "reactive"],
        metadata: {
          user_id: user.id,
          phone: user.phone,
          profile_name: user.profileName,
          source: "imessage",
          linq_message_id: payload.platformMessageId,
          linq_chat_id: payload.chatId,
        },
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[imessage] brain failed: ${msg}`);
    await recordExecutionEvent(runId, "brain_error", "runTurn", { error: msg });
    // omnipresence: never let a brain failure become silence.
    await deliverSilenceFallback({
      userId: user.id,
      runId,
      source: "imessage",
      error: err,
    });
    await finishExecutionRun(runId, { status: "failed", error: msg });
    return;
  }

  try {
    await recordExecutionEvent(runId, "memory_start", "saveMessages", {
      message_count: result.newMessages.length,
    });
    await saveMessages(user.id, result.newMessages, "reactive");
    await recordExecutionEvent(runId, "memory_end", "saveMessages", {
      message_count: result.newMessages.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[imessage] couldn't persist messages: ${msg}`);
    await recordExecutionEvent(runId, "memory_error", "saveMessages", {
      error: msg,
    });
  }

  // first send threads as a reply to the inbound message; subsequent sends
  // chain into the same chat without reply-context. linq dedupes via the
  // optional idempotency_key below.
  let deliveryError: string | null = null;
  let chatId = payload.chatId ?? null;
  for (const [i, body] of result.sends.entries()) {
    try {
      await recordExecutionEvent(runId, "delivery_start", "imessage.send", {
        index: i,
        total: result.sends.length,
        chat_id: chatId,
        body_preview: body.slice(0, 500),
      });
      const sent = await ch.send({
        toPhone: payload.phone,
        body,
        chatId,
        replyToMessageId:
          i === 0 ? payload.platformMessageId : null,
        idempotencyKey: `${runId}:${i}`,
      });
      chatId = sent.chatId;
      await recordExecutionEvent(runId, "delivery_end", "imessage.send", {
        index: i,
        ok: true,
        message_id: sent.messageId,
        chat_id: sent.chatId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[imessage] send failed (${i + 1}/${result.sends.length}): ${msg}`);
      deliveryError = msg;
      await recordExecutionEvent(runId, "delivery_error", "imessage.send", {
        index: i,
        error: msg,
      });
      break;
    }
  }

  if (payload.chatId) {
    void ch.stopTyping(payload.chatId).catch(() => undefined);
  }

  if (result.terminator === "cap_hit") {
    console.error("[imessage] cap_hit");
  }
  await finishExecutionRun(runId, {
    status: deliveryError ? "failed" : "completed",
    terminator: result.terminator,
    finalSends: result.sends,
    voiceViolations: result.voiceViolations,
    error: deliveryError,
  });
}

async function handleImessageWebhook(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // raw body required for HMAC verification — re-serialized JSON breaks it.
  let rawBody: string;
  try {
    rawBody = await readBody(req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[imessage] body read failed: ${msg}`);
    sendJson(res, 400, { status: "bad_request" });
    return;
  }

  const secret = process.env.LINQ_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[imessage] LINQ_WEBHOOK_SECRET not set — rejecting webhook");
    sendJson(res, 500, { status: "not_configured" });
    return;
  }

  const sigHeader = req.headers["x-webhook-signature"];
  const tsHeader = req.headers["x-webhook-timestamp"];
  const signature =
    (Array.isArray(sigHeader) ? sigHeader[0] : sigHeader) ?? null;
  const timestamp =
    (Array.isArray(tsHeader) ? tsHeader[0] : tsHeader) ?? null;

  const ok = verifyImessageSignature({
    secret,
    rawBody,
    signature,
    timestamp,
  });
  if (!ok) {
    console.warn("[imessage] webhook signature verification failed");
    sendJson(res, 401, { status: "invalid_signature" });
    return;
  }

  let body: unknown;
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[imessage] bad json body: ${msg}`);
    sendJson(res, 400, { status: "bad_request" });
    return;
  }

  // ack within linq's 10s budget — process async after responding.
  sendJson(res, 200, { status: "ok" });

  let parsed: Awaited<ReturnType<typeof parseImessageWebhook>>;
  try {
    parsed = await parseImessageWebhook(body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[imessage] parse_webhook failed: ${msg}`);
    return;
  }
  if (!parsed || !parsed.payload) return;
  await dispatchImessagePayload(parsed.payload);
}

// ── composio webhook ────────────────────────────────────────────────────────
//
// kills the detached-promise sharp edge in tools/integrations.ts: if the
// server restarts during the oauth window, the in-process waitForConnection
// is lost. this endpoint persists the oauth completion as a donnaschedule row
// (cause_kind='integration_oauth_complete') so the proactive worker picks it
// up and delivers the ack via the channel router.
//
// auth: shared-secret bearer token, set via DONNA_COMPOSIO_WEBHOOK_TOKEN.
// configure composio to send `Authorization: Bearer <token>` on webhook hits.
// (full HMAC verification can replace this once we surface composio's
// signature header — for v0 a strong shared secret is sufficient.)
//
// payload shape (composio's auth-events): { type, data: { entity_id,
//   app_name | toolkit_slug, connected_account_id, status, ... } }.
// we accept either toolkit_slug or app_name as the provider key for
// compatibility across composio SDK versions.

interface ComposioWebhookPayload {
  type?: string;
  data?: {
    entity_id?: string;
    user_id?: string;
    app_name?: string;
    toolkit_slug?: string;
    connected_account_id?: string;
    status?: string;
  };
}

function extractProvider(data: ComposioWebhookPayload["data"]): string | null {
  if (!data) return null;
  const raw = data.toolkit_slug ?? data.app_name;
  return raw ? raw.toLowerCase() : null;
}

async function handleComposioWebhook(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const token = process.env.DONNA_COMPOSIO_WEBHOOK_TOKEN;
  if (!token) {
    console.error("[composio] DONNA_COMPOSIO_WEBHOOK_TOKEN not set");
    sendJson(res, 500, { status: "not_configured" });
    return;
  }
  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${token}`) {
    sendJson(res, 401, { status: "unauthorized" });
    return;
  }

  let body: ComposioWebhookPayload;
  try {
    body = (await readJson(req)) as ComposioWebhookPayload;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[composio] bad json body: ${msg}`);
    sendJson(res, 400, { status: "bad_request" });
    return;
  }

  // ack fast — composio retries on >5s.
  sendJson(res, 200, { status: "ok" });

  const data = body.data;
  const userId = data?.entity_id ?? data?.user_id;
  const provider = extractProvider(data);
  const accountId = data?.connected_account_id ?? null;
  const eventType = body.type ?? "";

  // only flip state on actual success events. composio emits other auth
  // event types (initiated, expired, revoked) we don't need to act on here.
  const isSuccess =
    eventType.toLowerCase().includes("success") ||
    (data?.status ?? "").toLowerCase() === "connected" ||
    (data?.status ?? "").toLowerCase() === "active";

  if (!userId || !provider || !isSuccess) {
    console.info(
      `[composio] skipping webhook event_type=${eventType} provider=${provider ?? "?"} user=${userId?.slice(0, 8) ?? "?"} success=${isSuccess}`,
    );
    return;
  }

  try {
    const existing = await readState(userId, provider);
    // idempotent: if integration is already connected with this account, the
    // detached in-process completion handler already won the race. record
    // nothing and let it deliver the ack.
    if (
      existing &&
      existing.status === "connected" &&
      existing.composio_account_id === accountId
    ) {
      console.info(
        `[composio] webhook is a no-op — ${provider} already connected for ${userId.slice(0, 8)}`,
      );
      return;
    }

    await upsertState({
      userId,
      provider,
      status: "connected",
      mode: existing?.mode ?? "smart_index",
      composio_account_id: accountId,
    });

    // enqueue an immediate proactive ack. the worker runs it through the
    // brain in proactive mode (arbiter bypasses quiet hours for this cause
    // kind) and routes the burst via the omnipresence router.
    await insertSchedule({
      user_id: userId,
      fire_at: new Date().toISOString(),
      cause_kind: "integration_oauth_complete",
      cause_payload: { provider, account_id: accountId, mode: existing?.mode ?? "smart_index" },
      instruction: `${provider} just finished oauth and is now connected. tell the user briefly, in your voice. do not greet, do not preamble.`,
      created_by: "system",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[composio] processing failed for ${provider}/${userId}: ${msg}`);
  }
}

// ── app inbox ───────────────────────────────────────────────────────────────
//
// app surfaces (native app, dynamic island live activity, browser) pull
// pending bursts from outbound_messages here. auth is via the X-App-Device
// header carrying the opaque token stored as a user_identities row of
// provider='app_device'. device pairing is out of scope for this branch —
// tokens are provisioned out-of-band for now. clients should:
//
//   GET  /app/inbox                       → { messages: [...] }
//   POST /app/inbox/<id>/delivered        → mark delivered (received on device)
//   POST /app/inbox/<id>/read             → mark read (user actually saw it)

async function authenticateAppDevice(
  req: IncomingMessage,
): Promise<{ userId: string } | null> {
  const header = req.headers["x-app-device"];
  const token = Array.isArray(header) ? header[0] : header;
  if (!token) return null;
  const user = await getUserByIdentity("app_device", token);
  return user ? { userId: user.id } : null;
}

async function handleAppInbox(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = await authenticateAppDevice(req);
  if (!auth) {
    sendJson(res, 401, { status: "unauthorized" });
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/app/inbox") {
    const rawLimit = Number(url.searchParams.get("limit") ?? 50);
    const limit = Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(200, rawLimit))
      : 50;
    const messages = await listPendingForUser(auth.userId, limit);
    sendJson(res, 200, { messages });
    return;
  }

  const ackMatch = url.pathname.match(
    /^\/app\/inbox\/([0-9a-f-]+)\/(delivered|read)$/i,
  );
  if (req.method === "POST" && ackMatch) {
    const id = ackMatch[1]!;
    const kind = ackMatch[2]!.toLowerCase() as "delivered" | "read";
    if (kind === "delivered") await markDelivered(id);
    else await markRead(id);
    sendJson(res, 200, { status: "ok" });
    return;
  }

  sendJson(res, 404, { status: "not_found" });
}

async function handleVerify(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cfg = getConfig().whatsapp;
  const url = new URL(req.url ?? "/", "http://localhost");
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge") ?? "";
  if (mode === "subscribe" && token === cfg.verifyToken) {
    send(res, 200, challenge);
    return;
  }
  send(res, 403, "forbidden");
}

async function handleWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown;
  try {
    body = await readJson(req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[wa] bad json body: ${msg}`);
    sendJson(res, 400, { status: "bad_request" });
    return;
  }

  // ack fast — Meta retries on >5s. process payloads after responding.
  sendJson(res, 200, { status: "ok" });

  let payloads: IngressPayload[] | null;
  try {
    payloads = await parseWebhook(body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[wa] parse_webhook failed: ${msg}`);
    return;
  }
  if (!payloads) return;

  for (const payload of payloads) {
    await dispatchPayload(payload);
  }
}

async function handleDebug(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isObservabilityAuthorized(req)) {
    sendJson(res, 404, { status: "not_found" });
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/debug/runs") {
    const rawLimit = Number(url.searchParams.get("limit") ?? 50);
    const runs = await listExecutionRuns(Number.isFinite(rawLimit) ? rawLimit : 50);
    sendJson(res, 200, { runs });
    return;
  }

  const eventsMatch = url.pathname.match(/^\/debug\/runs\/([^/]+)\/events$/);
  const runId = eventsMatch?.[1];
  if (runId) {
    const events = await listExecutionEvents(runId);
    sendJson(res, 200, { events });
    return;
  }

  sendJson(res, 404, { status: "not_found" });
}

async function main(): Promise<void> {
  const cfg = getConfig();
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("error: ANTHROPIC_API_KEY not set");
    process.exit(1);
  }

  // db health check
  try {
    const sql = getSql();
    await sql`select 1`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`donna can't reach her memory: ${msg}`);
    await closeDb();
    process.exit(1);
  }

  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (req.method === "GET" && url === "/health") {
      sendJson(res, 200, { status: "ok" });
      return;
    }
    if (req.method === "GET" && url.startsWith("/debug/")) {
      void handleDebug(req, res);
      return;
    }
    if (req.method === "GET" && url.startsWith("/webhook")) {
      void handleVerify(req, res);
      return;
    }
    if (req.method === "POST" && url === "/webhook") {
      void handleWebhook(req, res);
      return;
    }
    if (req.method === "POST" && url.startsWith("/imessage/webhook")) {
      void handleImessageWebhook(req, res);
      return;
    }
    if (req.method === "POST" && url === "/composio/webhook") {
      void handleComposioWebhook(req, res);
      return;
    }
    if (url.startsWith("/app/inbox")) {
      void handleAppInbox(req, res);
      return;
    }
    send(res, 404, "not found");
  });

  server.listen(cfg.port, () => {
    console.log(`donna whatsapp server listening on :${cfg.port}`);
    console.log(`  webhook verify token: ${cfg.whatsapp.verifyToken}`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} — shutting down`);
    server.close();
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
