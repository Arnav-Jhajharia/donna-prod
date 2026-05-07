import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { MODEL, runTurn } from "./donna/brain.js";
import { loadRecentMessages, saveMessages } from "./donna/memory/chat.js";
import { closeDb, getSql } from "./donna/db.js";
import { getConfig } from "./donna/config.js";
import { parseWebhook } from "./donna/ingress/whatsapp.js";
import type { IngressPayload } from "./donna/ingress/payload.js";
import { WhatsAppChannel } from "./donna/delivery/whatsapp.js";
import type { TextMessage } from "./donna/delivery/messages.js";
import { getOrCreateUser } from "./donna/memory/users.js";
import {
  createExecutionRun,
  finishExecutionRun,
  listExecutionEvents,
  listExecutionRuns,
  recordExecutionEvent,
} from "./donna/observability/execution.js";

const wa = new WhatsAppChannel();

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
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
    // langsmith config as first arg — attaches user_id/phone/source/wa_id to
    // the parent trace. no-op when LANGSMITH_TRACING is unset.
    result = await runTurn(
      {
        tags: ["whatsapp", "reactive"],
        metadata: {
          user_id: user.id,
          phone: user.phone,
          profile_name: user.profileName,
          source: "whatsapp",
          wa_message_id: payload.platformMessageId,
        },
      },
      {
        mode: "reactive",
        messages,
        userInput: text,
        runId,
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[wa] brain failed: ${msg}`);
    await recordExecutionEvent(runId, "brain_error", "runTurn", {
      error: msg,
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
