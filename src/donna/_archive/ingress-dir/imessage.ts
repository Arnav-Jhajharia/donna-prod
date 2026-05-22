// linq webhook adapter — verifies HMAC, parses message.received events,
// and emits IngressPayload. parallel to ingress/whatsapp.ts.
//
// signature scheme (per docs.linqapp.com/guides/webhooks):
//   HMAC-SHA256(secret, "{x-webhook-timestamp}.{raw_body_utf8}") hex-encoded,
//   delivered in the X-Webhook-Signature header. raw bytes matter — never
//   verify against re-serialized JSON.
//
// dedup: linq guarantees at-least-once delivery. we use the existing
// inbound_messages table (keyed on wa_message_id; opaque in this adapter,
// reused for the linq event_id). burst-cache layer sits in front.

import crypto from "node:crypto";
import { claimInbound } from "../memory/inbound.js";
import type { IngressPayload } from "./payload.js";

const _seenEventIds = new Map<string, number>();
const _DEDUP_TTL_MS = 5 * 60 * 1000;

function isDuplicate(eventId: string | null): boolean {
  if (!eventId) return false;
  const now = Date.now();
  for (const [k, ts] of _seenEventIds) {
    if (now - ts > _DEDUP_TTL_MS) _seenEventIds.delete(k);
  }
  if (_seenEventIds.has(eventId)) return true;
  _seenEventIds.set(eventId, now);
  return false;
}

// ── signature verification ───────────────────────────────────────────────────

export interface VerifyArgs {
  secret: string;
  rawBody: string;
  timestamp: string | null;
  signature: string | null;
  toleranceSeconds?: number; // reject signatures older than this; default 5min
}

export function verifyWebhookSignature(args: VerifyArgs): boolean {
  const { secret, rawBody, timestamp, signature } = args;
  if (!secret || !rawBody || !timestamp || !signature) return false;

  // optional replay-protection window
  const tolerance = args.toleranceSeconds ?? 300;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const drift = Math.abs(Date.now() / 1000 - ts);
  if (drift > tolerance) return false;

  const signed = `${timestamp}.${rawBody}`;
  const expected = crypto.createHmac("sha256", secret).update(signed).digest("hex");

  // hex strings → buffers; lengths must match before timingSafeEqual
  if (expected.length !== signature.length) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(signature, "hex"),
    );
  } catch {
    return false;
  }
}

// ── envelope + payload types (subset; see docs for full schemas) ────────────

interface LinqHandleRef {
  handle?: string;
  is_me?: boolean;
  service?: string;
}

interface LinqMessagePart {
  type: "text" | "media" | "link";
  value?: string;
  url?: string;
  filename?: string;
  mime_type?: string;
}

interface LinqMessageReceivedData {
  chat?: { id?: string; is_group?: boolean };
  id?: string;
  direction?: "inbound" | "outbound";
  sender_handle?: LinqHandleRef;
  parts?: LinqMessagePart[];
  sent_at?: string;
}

export interface LinqWebhookEnvelope {
  api_version?: string;
  webhook_version?: string;
  event_type?: string;
  event_id?: string;
  created_at?: string;
  trace_id?: string;
  data?: LinqMessageReceivedData;
}

// ── parser ───────────────────────────────────────────────────────────────────

export interface ParsedEvent {
  payload: IngressPayload | null; // null for non-actionable events (delivered/read/etc)
  eventType: string;
  eventId: string | null;
}

export async function parseWebhook(body: unknown): Promise<ParsedEvent | null> {
  if (!body || typeof body !== "object") return null;
  const env = body as LinqWebhookEnvelope;

  const eventType = env.event_type ?? "";
  const eventId = env.event_id ?? null;

  // burst-cache skip
  if (isDuplicate(eventId)) {
    console.info(
      `[imessage] dropped duplicate event ${eventId?.slice(0, 16)} (mem)`,
    );
    return { payload: null, eventType, eventId };
  }

  // brain only runs on inbound messages. ack everything else upstream so the
  // server can record telemetry without pushing through the brain.
  if (eventType !== "message.received") {
    return { payload: null, eventType, eventId };
  }

  const data = env.data ?? {};
  const sender = data.sender_handle?.handle ?? "";
  if (!sender) {
    console.warn(`[imessage] message.received without sender_handle, skipping`);
    return { payload: null, eventType, eventId };
  }

  // durable claim — uses event_id as the dedup key (legacy column wa_message_id)
  if (eventId) {
    const claimed = await claimInbound({
      waMessageId: eventId,
      phone: sender,
      body: env,
      source: "imessage",
    });
    if (!claimed) {
      console.info(`[imessage] dropped duplicate ${eventId.slice(0, 16)} (db)`);
      return { payload: null, eventType, eventId };
    }
  }

  const text = collectText(data.parts ?? []);
  const messageType = inferMessageType(data.parts ?? []);

  const payload: IngressPayload = {
    userId: "",
    phone: sender,
    message: text,
    messageType,
    source: "imessage",
    platformMessageId: data.id ?? null,
    platformProfileName: null, // linq doesn't include a profile name field
    replyToId: null,
    chatId: data.chat?.id ?? null,
  };

  return { payload, eventType, eventId };
}

function collectText(parts: LinqMessagePart[]): string | null {
  const buf: string[] = [];
  for (const p of parts) {
    if (p.type === "text" && typeof p.value === "string") buf.push(p.value);
    else if (p.type === "link" && typeof p.value === "string") buf.push(p.value);
  }
  const joined = buf.join(" ").trim();
  return joined || null;
}

function inferMessageType(parts: LinqMessagePart[]): IngressPayload["messageType"] {
  // brain only branches on text/voice/image/document — we collapse media into
  // image/document/voice based on mime_type. parts without media stay "text".
  for (const p of parts) {
    if (p.type !== "media") continue;
    const mime = (p.mime_type ?? "").toLowerCase();
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("audio/")) return "voice";
    return "document";
  }
  return "text";
}
