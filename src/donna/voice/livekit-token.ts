// mints a livekit room access token for a user. one token per call.
//
// the token is a signed jwt the mobile client passes to livekit when joining
// the room. token expiry is short (default 10 min) so a stolen one can't be
// reused indefinitely.

import { randomUUID } from "node:crypto";
import { AccessToken } from "livekit-server-sdk";

export interface CallToken {
  /** signed jwt the mobile client passes to livekit on connect. */
  token: string;
  /** the room name this token grants access to. */
  roomName: string;
  /** wss:// url of your livekit cloud project. clients connect to this. */
  livekitUrl: string;
}

export interface MintCallTokenInput {
  /** clerk user id — used as the participant identity inside the room. */
  userId: string;
  /** optional fixed room name. otherwise a fresh uuid-derived name is generated. */
  roomName?: string;
  /** token lifetime. default 10 min — calls don't last longer than that for v0. */
  ttlMinutes?: number;
}

export async function mintCallToken(input: MintCallTokenInput): Promise<CallToken> {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const livekitUrl = process.env.LIVEKIT_URL;
  if (!apiKey || !apiSecret || !livekitUrl) {
    throw new Error(
      "livekit env vars missing — set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET",
    );
  }

  const roomName = input.roomName ?? `donna-${input.userId}-${randomUUID().slice(0, 8)}`;
  const ttlMinutes = input.ttlMinutes ?? 10;

  const at = new AccessToken(apiKey, apiSecret, {
    identity: input.userId,
    ttl: ttlMinutes * 60,
  });
  at.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
  });

  const token = await at.toJwt();
  return { token, roomName, livekitUrl };
}
