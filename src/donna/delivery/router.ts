// channel router — single point that turns (userId, burst, optional hint)
// into "go deliver these strings somewhere the user will actually see them."
//
// resolution order:
//   1. explicit sourceHint (the channel that triggered this turn — keep
//      the conversation on the same surface)
//   2. users.last_active_channel (where the user is right now)
//   3. users.preferred_channel (sticky pick)
//   4. fallback: 'app' — the outbox always works, even if every push channel
//      is unreachable. omnipresence guarantee: donna never goes silent.
//
// the router is the seam that lets donna live across whatsapp, imessage,
// dynamic island, native app, browser. brain stays channel-agnostic;
// surfaces plug in here.

import { getSql } from "../db.js";
import { WhatsAppChannel } from "./whatsapp.js";
import { IMessageChannel } from "./imessage.js";
import { AppChannel } from "./app.js";
import type { TextMessage } from "./messages.js";
import { saveMessages } from "../memory/chat.js";
import type { ChannelKind } from "../memory/users.js";
import type { TurnSource } from "../context.js";

export interface DeliveryAttempt {
  channel: ChannelKind;
  ok: boolean;
  externalId?: string | null;
  error?: string;
}

export interface RouteResult {
  channel: ChannelKind | "none";
  delivered: number;
  attempts: DeliveryAttempt[];
}

export interface RouteOptions {
  sourceHint?: TurnSource;
  runId?: string | null;
  /**
   * Pre-existing imessage chat to thread bursts into. The imessage dispatcher
   * has this from the inbound webhook; proactive callers don't.
   */
  imessageChatId?: string | null;
  /**
   * When true (default), save the delivered bursts to chat_messages as
   * proactive assistant rows so the next reactive turn sees the conversation
   * the user just received. Reactive dispatchers do this themselves and pass
   * false.
   */
  persistHistory?: boolean;
}

interface UserRouting {
  id: string;
  phone: string;
  preferred_channel: ChannelKind;
  last_active_channel: ChannelKind | null;
}

function hintToChannel(hint: TurnSource | undefined): ChannelKind | null {
  if (hint === "whatsapp") return "whatsapp";
  if (hint === "imessage") return "imessage";
  if (hint === "app") return "app";
  return null;
}

/**
 * Pick the channel for a given (user, hint) pair without delivering.
 * Exposed so callers that want to log routing decisions can introspect
 * the choice before invoking deliver.
 */
export async function resolveChannel(
  userId: string,
  opts: { sourceHint?: TurnSource } = {},
): Promise<{ channel: ChannelKind; user: UserRouting } | { channel: "none"; user: null }> {
  const sql = getSql();
  const rows = await sql<UserRouting[]>`
    select id, phone, preferred_channel, last_active_channel
    from users where id = ${userId} limit 1
  `;
  const user = rows[0];
  if (!user) return { channel: "none", user: null };

  const hinted = hintToChannel(opts.sourceHint);
  const chosen: ChannelKind =
    hinted ??
    user.last_active_channel ??
    user.preferred_channel ??
    "app";
  return { channel: chosen, user };
}

/**
 * Deliver a list of burst strings to whichever channel resolves for this
 * user. Tries the resolved channel first; on failure walks the fallback
 * chain ending at 'app' (which is durable — never fails on a healthy db).
 *
 * Never throws on a delivery error. The omnipresence guarantee is that
 * donna's words land *somewhere* the user can read them.
 */
export async function deliverBurst(
  userId: string,
  bursts: string[],
  opts: RouteOptions = {},
): Promise<RouteResult> {
  if (bursts.length === 0) {
    return { channel: "none", delivered: 0, attempts: [] };
  }

  const resolved = await resolveChannel(userId, { sourceHint: opts.sourceHint });
  if (resolved.channel === "none") {
    return { channel: "none", delivered: 0, attempts: [] };
  }

  const persistHistory = opts.persistHistory ?? true;
  const order = buildFallbackOrder(resolved.channel);
  const attempts: DeliveryAttempt[] = [];

  for (const channel of order) {
    const ok = await tryChannel({
      channel,
      bursts,
      user: resolved.user,
      runId: opts.runId ?? null,
      imessageChatId: opts.imessageChatId ?? null,
      attempts,
    });
    if (ok) {
      if (persistHistory) {
        await persistBurstsToChat(userId, bursts);
      }
      return { channel, delivered: bursts.length, attempts };
    }
  }

  // every channel including 'app' failed. that's catastrophic — likely the
  // db is down, in which case persistHistory would have failed too. return
  // 'none' so the caller knows nothing landed.
  return { channel: "none", delivered: 0, attempts };
}

function buildFallbackOrder(primary: ChannelKind): ChannelKind[] {
  const order: ChannelKind[] = [primary];
  for (const ch of ["whatsapp", "imessage", "app"] as const) {
    if (!order.includes(ch)) order.push(ch);
  }
  return order;
}

async function tryChannel(args: {
  channel: ChannelKind;
  bursts: string[];
  user: UserRouting;
  runId: string | null;
  imessageChatId: string | null;
  attempts: DeliveryAttempt[];
}): Promise<boolean> {
  const { channel, bursts, user, runId, imessageChatId, attempts } = args;
  try {
    if (channel === "whatsapp") {
      if (!user.phone) {
        attempts.push({ channel, ok: false, error: "no_phone" });
        return false;
      }
      const wa = new WhatsAppChannel();
      const ids: string[] = [];
      for (const body of bursts) {
        const msg: TextMessage = { kind: "text", body, replyToMessageId: null };
        const id = await wa.send(user.phone, msg);
        if (id) ids.push(id);
      }
      attempts.push({ channel, ok: true, externalId: ids[ids.length - 1] ?? null });
      return true;
    }
    if (channel === "imessage") {
      if (!user.phone) {
        attempts.push({ channel, ok: false, error: "no_phone" });
        return false;
      }
      const ch = new IMessageChannel();
      let chatId = imessageChatId;
      let lastMessageId: string | null = null;
      for (const [i, body] of bursts.entries()) {
        const sent = await ch.send({
          toPhone: user.phone,
          body,
          chatId,
          idempotencyKey: runId ? `${runId}:${i}` : undefined,
        });
        chatId = sent.chatId;
        lastMessageId = sent.messageId;
      }
      attempts.push({ channel, ok: true, externalId: lastMessageId });
      return true;
    }
    // 'app' — outbox. enqueue one row per burst.
    const app = new AppChannel();
    for (const body of bursts) {
      await app.enqueue({ userId: user.id, body, runId });
    }
    attempts.push({ channel, ok: true });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    attempts.push({ channel, ok: false, error: msg });
    console.warn(`[router] ${channel} delivery failed: ${msg}`);
    return false;
  }
}

async function persistBurstsToChat(userId: string, bursts: string[]): Promise<void> {
  try {
    await saveMessages(
      userId,
      bursts.map((body) => ({ role: "assistant" as const, content: body })),
      "proactive",
    );
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.warn(`[router] history save failed: ${m}`);
  }
}
