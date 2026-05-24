import { db } from "./db.js";
import { inboundMessages } from "./db/schema.js";

// claim an inbound whatsapp webhook message. returns true if this is the
// first time we've seen this wa_message_id, false if it's a meta retry of
// an already-processed message.
//
// load-bearing: meta retries 5xx responses and slow 200s aggressively, so
// the same wa_message_id lands in /webhook 3-5 times for one user text.
// without this dedup, every retry would re-run the brain, charge anthropic
// again, and write duplicate chat_messages rows.
//
// `inbound_messages.wa_message_id` is `unique`; the insert hits the
// constraint on duplicates. onConflictDoNothing returns an empty rows
// array in that case, which is our signal to skip.
export async function claimWhatsAppInbound(
  waMessageId: string,
  phone: string,
  body: unknown,
): Promise<boolean> {
  const rows = await db
    .insert(inboundMessages)
    .values({
      waMessageId,
      phone,
      body: body as Record<string, unknown>,
      source: "whatsapp",
    })
    .onConflictDoNothing({ target: inboundMessages.waMessageId })
    .returning({ id: inboundMessages.id });
  return rows.length > 0;
}
