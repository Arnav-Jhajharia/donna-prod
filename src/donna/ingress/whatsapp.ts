// whatsapp webhook adapter — parses raw WA Cloud API payloads into
// IngressPayloads. ported from old repo's ingress/whatsapp.py.
//
// handles:
//   - message type detection: text, image, voice/audio, document, video,
//     location, contacts, sticker, reaction, interactive (button/list reply)
//   - media download (image, voice, document, video, sticker)
//   - caption extraction
//   - reply context (swipe-reply)
//   - profile name extraction
//   - webhook dedup — two layers:
//       L1 in-memory ttl cache (5min) — cheap fast-path skip on bursts
//       L2 db claim via inbound_messages.wa_message_id unique — atomic +
//          durable across restarts. catches every retry, no race window.
//     dedup runs BEFORE media download so dupes don't waste graph api calls.
//   - multi-message webhook iteration
//
// does NOT handle (was in old repo, skipped for v0):
//   - per-phone cancel-and-restart dispatcher
//   - typing indicators (server fires those after parsing)

import { getConfig } from "../config.js";
import { claimInbound } from "../memory/inbound.js";
import type {
  DocumentPayload,
  ImagePayload,
  IngressPayload,
  VoicePayload,
} from "./payload.js";

// ── dedup ────────────────────────────────────────────────────────────────────
const _seenMsgIds = new Map<string, number>();
const _DEDUP_TTL_MS = 5 * 60 * 1000;

function isDuplicate(waMessageId: string | null): boolean {
  if (!waMessageId) return false;
  const now = Date.now();
  // sweep expired
  for (const [k, ts] of _seenMsgIds) {
    if (now - ts > _DEDUP_TTL_MS) _seenMsgIds.delete(k);
  }
  if (_seenMsgIds.has(waMessageId)) return true;
  _seenMsgIds.set(waMessageId, now);
  return false;
}

// ── public ───────────────────────────────────────────────────────────────────

export async function parseWebhook(
  body: unknown,
): Promise<IngressPayload[] | null> {
  if (!body || typeof body !== "object") return null;
  const root = body as Record<string, unknown>;
  const entries = Array.isArray(root.entry) ? root.entry : [];
  const payloads: IngressPayload[] = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const changes = Array.isArray((entry as Record<string, unknown>).changes)
      ? (entry as Record<string, unknown>).changes as unknown[]
      : [];
    for (const change of changes) {
      if (!change || typeof change !== "object") continue;
      const value = ((change as Record<string, unknown>).value ?? {}) as Record<
        string,
        unknown
      >;
      const messages = Array.isArray(value.messages) ? value.messages : [];
      for (const message of messages) {
        if (!message || typeof message !== "object") continue;
        const m = message as Record<string, unknown>;
        const waId = typeof m.id === "string" ? m.id : null;
        if (!waId) continue;

        // L1: in-memory burst cache. cheapest skip.
        if (isDuplicate(waId)) {
          console.info(
            `whatsapp adapter: dropped duplicate ${waId.slice(0, 16)} (mem)`,
          );
          continue;
        }

        // L2: durable db claim. atomic insert-on-conflict; survives restarts
        // and beats the read-then-write race. runs BEFORE parseOne so we
        // never re-download media for retries.
        const phone = typeof m.from === "string" ? m.from : "";
        const claimed = await claimInbound({
          waMessageId: waId,
          phone,
          body: { message: m, value },
        });
        if (!claimed) {
          console.info(
            `whatsapp adapter: dropped duplicate ${waId.slice(0, 16)} (db)`,
          );
          continue;
        }

        const payload = await parseOne(m, value);
        if (payload) payloads.push(payload);
      }
    }
  }

  return payloads.length > 0 ? payloads : null;
}

// ── parser ───────────────────────────────────────────────────────────────────

async function parseOne(
  message: Record<string, unknown>,
  value: Record<string, unknown>,
): Promise<IngressPayload | null> {
  const senderPhone = typeof message.from === "string" ? message.from : "";
  if (!senderPhone) return null;

  const waMessageId = typeof message.id === "string" ? message.id : null;

  // profile name
  const contacts = Array.isArray(value.contacts) ? value.contacts : [];
  let profileName: string | null = null;
  if (contacts.length > 0 && typeof contacts[0] === "object" && contacts[0]) {
    const profile = (contacts[0] as Record<string, unknown>).profile;
    if (profile && typeof profile === "object") {
      const name = (profile as Record<string, unknown>).name;
      profileName = typeof name === "string" ? name : null;
    }
  }

  // reply context
  let replyToId: string | null = null;
  const ctx = message.context;
  if (ctx && typeof ctx === "object") {
    const id = (ctx as Record<string, unknown>).id;
    replyToId = typeof id === "string" ? id : null;
  }

  const waType = typeof message.type === "string" ? message.type : "";
  const base = {
    userId: "",
    phone: senderPhone,
    source: "whatsapp" as const,
    platformMessageId: waMessageId,
    platformProfileName: profileName,
    replyToId,
  };

  // ── route by message type ─────────────────────────────────────────────
  if (waType === "text") {
    const textObj = (message.text ?? {}) as Record<string, unknown>;
    const body = typeof textObj.body === "string" ? textObj.body : "";
    return { ...base, message: body, messageType: "text" };
  }

  if (waType === "image") {
    const obj = (message.image ?? {}) as Record<string, unknown>;
    const mediaId = typeof obj.id === "string" ? obj.id : null;
    const caption = typeof obj.caption === "string" ? obj.caption : null;
    const mimeType =
      typeof obj.mime_type === "string" ? obj.mime_type : "image/jpeg";
    const bytes = mediaId ? await downloadMedia(mediaId) : null;
    const image: ImagePayload | undefined = bytes
      ? { fileBytes: bytes, mimeType }
      : undefined;
    return { ...base, message: caption, messageType: "image", image };
  }

  if (waType === "audio" || waType === "voice") {
    const obj = ((message.audio ?? message.voice) ?? {}) as Record<
      string,
      unknown
    >;
    const mediaId = typeof obj.id === "string" ? obj.id : null;
    const mimeType =
      typeof obj.mime_type === "string" ? obj.mime_type : "audio/ogg";
    const bytes = mediaId ? await downloadMedia(mediaId) : null;
    const voice: VoicePayload | undefined = bytes
      ? { fileBytes: bytes, mimeType }
      : undefined;
    return { ...base, message: null, messageType: "voice", voice };
  }

  if (waType === "document") {
    const obj = (message.document ?? {}) as Record<string, unknown>;
    const mediaId = typeof obj.id === "string" ? obj.id : null;
    const caption = typeof obj.caption === "string" ? obj.caption : null;
    const filename = typeof obj.filename === "string" ? obj.filename : "document";
    const mimeType =
      typeof obj.mime_type === "string"
        ? obj.mime_type
        : "application/octet-stream";
    const bytes = mediaId ? await downloadMedia(mediaId) : null;
    const document: DocumentPayload | undefined = bytes
      ? { fileBytes: bytes, filename, mimeType }
      : undefined;
    return { ...base, message: caption, messageType: "document", document };
  }

  if (waType === "video") {
    const obj = (message.video ?? {}) as Record<string, unknown>;
    const mediaId = typeof obj.id === "string" ? obj.id : null;
    const caption = typeof obj.caption === "string" ? obj.caption : null;
    const mimeType =
      typeof obj.mime_type === "string" ? obj.mime_type : "video/mp4";
    const bytes = mediaId ? await downloadMedia(mediaId) : null;
    // videos are treated as documents downstream
    const document: DocumentPayload | undefined = bytes
      ? { fileBytes: bytes, filename: "video.mp4", mimeType }
      : undefined;
    return { ...base, message: caption, messageType: "document", document };
  }

  if (waType === "location") {
    const loc = (message.location ?? {}) as Record<string, unknown>;
    const lat = loc.latitude ?? "";
    const lon = loc.longitude ?? "";
    const name = typeof loc.name === "string" ? loc.name : "";
    const address = typeof loc.address === "string" ? loc.address : "";
    const text = `shared location: ${name} ${address} (${lat}, ${lon})`.trim();
    return { ...base, message: text, messageType: "text" };
  }

  if (waType === "contacts") {
    const contactsList = Array.isArray(message.contacts)
      ? (message.contacts as unknown[])
      : [];
    const parts: string[] = [];
    for (const c of contactsList) {
      if (!c || typeof c !== "object") continue;
      const co = c as Record<string, unknown>;
      const nameObj = (co.name ?? {}) as Record<string, unknown>;
      const display =
        typeof nameObj.formatted_name === "string" ? nameObj.formatted_name : "";
      const phones = Array.isArray(co.phones) ? (co.phones as unknown[]) : [];
      const phoneStrs = phones
        .map((p) =>
          p && typeof p === "object" &&
          typeof (p as Record<string, unknown>).phone === "string"
            ? ((p as Record<string, unknown>).phone as string)
            : "",
        )
        .filter(Boolean);
      parts.push(
        phoneStrs.length > 0 ? `${display} (${phoneStrs.join(", ")})` : display,
      );
    }
    const text =
      parts.length > 0 ? `shared contact: ${parts.join("; ")}` : "shared a contact";
    return { ...base, message: text, messageType: "text" };
  }

  if (waType === "sticker") {
    const obj = (message.sticker ?? {}) as Record<string, unknown>;
    const mediaId = typeof obj.id === "string" ? obj.id : null;
    const mimeType =
      typeof obj.mime_type === "string" ? obj.mime_type : "image/webp";
    const bytes = mediaId ? await downloadMedia(mediaId) : null;
    const image: ImagePayload | undefined = bytes
      ? { fileBytes: bytes, mimeType }
      : undefined;
    return { ...base, message: null, messageType: "image", image };
  }

  if (waType === "reaction") {
    const reaction = (message.reaction ?? {}) as Record<string, unknown>;
    const emoji = typeof reaction.emoji === "string" ? reaction.emoji : "";
    const reactedMsgId =
      typeof reaction.message_id === "string" ? reaction.message_id : "";
    return {
      ...base,
      message: emoji ? `reacted ${emoji}` : null,
      messageType: "text",
      replyToId: reactedMsgId || replyToId,
    };
  }

  if (waType === "interactive") {
    const interactive = (message.interactive ?? {}) as Record<string, unknown>;
    const reply = ((interactive.button_reply ?? interactive.list_reply) ??
      {}) as Record<string, unknown>;
    const text = typeof reply.title === "string" ? reply.title : "";
    return { ...base, message: text, messageType: "text" };
  }

  // unknown type — normalize as text with a note
  console.warn(
    `whatsapp adapter: unhandled message type ${waType} — passing through`,
  );
  return {
    ...base,
    message: `[sent a ${waType} message]`,
    messageType: "text",
  };
}

// ── media download ───────────────────────────────────────────────────────────

async function downloadMedia(mediaId: string): Promise<Uint8Array | null> {
  const cfg = getConfig().whatsapp;
  const headers = { Authorization: `Bearer ${cfg.token}` };
  try {
    const urlResp = await fetch(
      `https://graph.facebook.com/${cfg.graphVersion}/${mediaId}`,
      { headers },
    );
    if (!urlResp.ok) throw new Error(`media url lookup ${urlResp.status}`);
    const meta = (await urlResp.json()) as { url?: string };
    if (!meta.url) throw new Error("media url missing in response");
    const dl = await fetch(meta.url, { headers });
    if (!dl.ok) throw new Error(`media download ${dl.status}`);
    return new Uint8Array(await dl.arrayBuffer());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `whatsapp adapter: media download failed for ${mediaId.slice(0, 8)}: ${msg}`,
    );
    return null;
  }
}
