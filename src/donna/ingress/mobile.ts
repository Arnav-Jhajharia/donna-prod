import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { runTurn } from "../brain.js";
import { getOrCreateUserByClerk } from "../users.js";
import { loadRecentMessages, saveMessages } from "../chat.js";
import { sendVoipPush } from "../voice/apns.js";
import { mintCallToken } from "../voice/livekit-token.js";
import { requireUser, userId } from "./auth.js";

// mobile routes mount under /api/mobile. clerk jwt is verified upstream by
// requireUser; handlers can safely call userId(c).
export const mobile = new Hono();

mobile.use("*", requireUser);

// the text loop. mirrors ingress/whatsapp.ts:dispatch except:
//   - identity resolution uses getOrCreateUserByClerk (option-B linker
//     reads phone from clerk profile to merge with whatsapp rows).
//   - sends come back in the json response instead of an out-of-band push,
//     because the app rendered the user's bubble already and is waiting
//     for donna's reply inline.
mobile.post("/message", async (c) => {
  const body = await c.req
    .json<{ text?: string }>()
    .catch(() => ({}) as { text?: string });
  const text = body.text?.trim();
  if (!text) return c.json({ error: "text required" }, 400);

  const clerkId = userId(c);
  const user = await getOrCreateUserByClerk(clerkId);
  const history = await loadRecentMessages(user.id);
  const userMsg: MessageParam = { role: "user", content: text };

  const result = await runTurn([...history, userMsg], { userId: user.id });

  await saveMessages(user.id, [userMsg, ...result.newMessages]);

  return c.json({
    runId: result.runId,
    terminator: result.terminator,
    sends: result.sends,
  });
});

// path-A: user opens the in-app call screen and the app pulls a livekit join
// token directly. simpler than voip push but does NOT show the native incoming
// call ui. used for testing the voice loop before callkit is fully wired.
mobile.post("/call/token", async (c) => {
  const uid = userId(c);
  if (!uid) return c.json({ error: "unauthorized" }, 401);

  const callId = randomUUID();
  const { token, roomName, livekitUrl } = await mintCallToken({
    userId: uid,
    roomName: `donna-${uid}-${callId.slice(0, 8)}`,
  });
  return c.json({ callId, token, roomName, livekitUrl });
});

// path-B: donna initiates a call. server mints a token and fires a voip
// push to the device, which wakes the app and triggers CallKit's incoming
// call ui. the device must accept within 5s of the push.
//
// for v0 the mobile app passes its current apns voip device token in the
// request body. later this moves into the db (linked to the clerk user) so
// donna can call unprompted.
mobile.post("/call/start", async (c) => {
  const uid = userId(c);
  if (!uid) return c.json({ error: "unauthorized" }, 401);

  const body = await c.req
    .json<{ deviceToken?: string }>()
    .catch(() => ({}) as { deviceToken?: string });
  if (!body.deviceToken) {
    return c.json({ error: "deviceToken required" }, 400);
  }

  const callId = randomUUID();
  const { token, roomName, livekitUrl } = await mintCallToken({
    userId: uid,
    roomName: `donna-${uid}-${callId.slice(0, 8)}`,
  });

  await sendVoipPush(body.deviceToken, {
    callId,
    roomName,
    joinToken: token,
    livekitUrl,
  });

  return c.json({ callId, roomName });
});
