// deliver runtime-triggered bursts (oauth completed, commitment overdue,
// backfill done, etc) to whichever channel the user actually lives in.
//
// today: whatsapp users get the bursts via WhatsAppChannel.send. cli-only
// users (no phone row) get nothing here — caller falls back to printing.
//
// the proactive event lane will eventually call this. for now, the connect
// script is the first caller.

import { getSql } from "../db.js";
import { WhatsAppChannel } from "./whatsapp.js";
import type { TextMessage } from "./messages.js";
import { saveMessages } from "../memory/chat.js";

export interface DeliveryResult {
  channel: "whatsapp" | "none";
  delivered: number;
  wamids: string[];
}

interface UserRow {
  id: string;
  phone: string;
}

export async function deliverBurstToUser(
  userId: string,
  bursts: string[],
): Promise<DeliveryResult> {
  if (bursts.length === 0) return { channel: "none", delivered: 0, wamids: [] };

  const sql = getSql();
  const rows = await sql<UserRow[]>`
    select id, phone from users where id = ${userId} limit 1
  `;
  const user = rows[0];
  if (!user || !user.phone) {
    return { channel: "none", delivered: 0, wamids: [] };
  }

  const wa = new WhatsAppChannel();
  const wamids: string[] = [];
  for (const body of bursts) {
    const msg: TextMessage = { kind: "text", body, replyToMessageId: null };
    try {
      const wamid = await wa.send(user.phone, msg);
      if (wamid) wamids.push(wamid);
    } catch (err) {
      // delivery failure shouldn't crash the trigger flow. log + continue.
      const m = err instanceof Error ? err.message : String(err);
      console.warn(`[proactive] whatsapp send failed: ${m}`);
      break;
    }
  }

  // persist these as proactive assistant messages so the next reactive turn
  // sees the same conversation the user just received on their phone.
  if (wamids.length > 0) {
    try {
      await saveMessages(
        userId,
        bursts.map((body) => ({
          role: "assistant" as const,
          content: body,
        })),
        "proactive",
      );
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.warn(`[proactive] history save failed: ${m}`);
    }
  }

  return { channel: "whatsapp", delivered: wamids.length, wamids };
}
