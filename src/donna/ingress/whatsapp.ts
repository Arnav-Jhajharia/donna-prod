import { Hono } from "hono";
import { createClerkClient } from "@clerk/backend";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { runTurn } from "../brain.js";
import { completePairing } from "../pairing.js";
import { getOrCreateUserByPhone } from "../users.js";
import { loadRecentMessages, saveMessages } from "../chat.js";
import { sendText } from "../delivery/whatsapp.js";

// meta sends two kinds of requests to this endpoint:
//   GET ?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
//     -> respond with the challenge value verbatim to confirm ownership
//   POST { entry: [{ changes: [{ value: { messages: [...] } }] }] }
//     -> incoming message payload
//
// the webhook is unauthenticated from clerk's perspective. meta authenticates
// itself by knowing the verify token (handshake) and via the x-hub-signature-256
// hmac on the body. signature verification lands when we have time; for now we
// rely on the verify token + the obscurity of the url.
export const whatsapp = new Hono();

whatsapp.get("/webhook", (c) => {
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");
  const expected = process.env.WHATSAPP_VERIFY_TOKEN;
  if (mode === "subscribe" && token && expected && token === expected) {
    return c.text(challenge ?? "", 200);
  }
  return c.text("forbidden", 403);
});

type WhatsAppMessage = {
  from: string; // e.g. "919876543210"
  id: string;
  timestamp: string; // unix seconds, as a string
  type: string;
  text?: { body: string };
};

type WhatsAppWebhookBody = {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: WhatsAppMessage[];
      };
    }>;
  }>;
};

whatsapp.post("/webhook", async (c) => {
  // ack fast. meta retries aggressively on 5xx, so we do the work after
  // returning 200. any error inside the handler is logged but not surfaced.
  const body = await c.req
    .json<WhatsAppWebhookBody>()
    .catch(() => ({}) as WhatsAppWebhookBody);

  void handleIncoming(body).catch((err) => {
    console.error("whatsapp webhook error:", err);
  });

  return c.text("ok", 200);
});

async function handleIncoming(body: WhatsAppWebhookBody): Promise<void> {
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const message of change.value?.messages ?? []) {
        if (message.type !== "text" || !message.text) continue;
        await dispatch(message);
      }
    }
  }
}

// per-message handler. two outcomes:
//   1. message is a pairing code -> claim it, send ack, stop.
//   2. anything else -> resolve user_id by phone, run the brain, deliver sends.
async function dispatch(message: WhatsAppMessage): Promise<void> {
  const phone = message.from.startsWith("+") ? message.from : `+${message.from}`;
  const text = message.text!.body;

  if (await tryPair(phone, text)) {
    await sendText(phone, "paired. donna here.").catch((err) => {
      console.error("whatsapp paired-ack send failed:", err);
    });
    return;
  }

  const user = await getOrCreateUserByPhone(phone);
  const history = await loadRecentMessages(user.id);
  const userMsg: MessageParam = { role: "user", content: text };

  const result = await runTurn([...history, userMsg], { userId: user.id });

  await saveMessages(user.id, [userMsg, ...result.newMessages]);

  for (const send of result.sends) {
    if (send.type === "text") {
      await sendText(phone, send.text);
    } else {
      // buttons / list / cta_url / image / etc. — port renderers from
      // _archive/delivery-dir/whatsapp.ts when we want them.
      console.warn(`whatsapp: skipping unsupported send type: ${send.type}`);
    }
  }
}

// returns true if the text was a valid pairing code and we claimed it.
// false means "this wasn't a pairing code, do something else with it".
async function tryPair(phone: string, rawText: string): Promise<boolean> {
  const code = rawText.trim().toUpperCase().slice(0, 6);
  if (code.length !== 6) return false;

  const entry = completePairing(code, phone);
  if (!entry) return false;

  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    console.warn("CLERK_SECRET_KEY missing; pair recorded in memory only");
    return true;
  }

  const clerk = createClerkClient({ secretKey });
  await clerk.users.updateUser(entry.userId, {
    privateMetadata: { phone, whatsappPaired: true },
  });
  return true;
}
