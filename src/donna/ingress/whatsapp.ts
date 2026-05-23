import { Hono } from "hono";
import { createClerkClient } from "@clerk/backend";
import { completePairing } from "../pairing.js";

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
        await tryPair(message.from, message.text.body);
      }
    }
  }
}

async function tryPair(rawPhone: string, rawText: string): Promise<void> {
  // whatsapp delivers numbers without the leading "+". restore it so the
  // value we persist matches the e.164 format clerk and the mobile app use.
  const phone = rawPhone.startsWith("+") ? rawPhone : `+${rawPhone}`;
  const code = rawText.trim().toUpperCase().slice(0, 6);
  if (code.length !== 6) return;

  const entry = completePairing(code, phone);
  if (!entry) return;

  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    console.warn("CLERK_SECRET_KEY missing; pair recorded in memory only");
    return;
  }

  const clerk = createClerkClient({ secretKey });
  await clerk.users.updateUser(entry.userId, {
    privateMetadata: { phone, whatsappPaired: true },
  });
}
