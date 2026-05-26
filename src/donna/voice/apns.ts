// apple push notification service — voip push sender.
//
// voip pushes wake the donna ios app inside a 5-second window, during which
// it must call CallKit's reportNewIncomingCall. the payload carries the
// livekit room + join token so the device can connect immediately on accept.
//
// apple's quirk: voip pushes REQUIRE a .p12 voip services certificate, not
// the newer .p8 token. you download it from apple developer → certificates →
// "voip services certificate" and bind it to your real bundle id.
//
// env vars required (only when send is actually called — module imports
// without them so typecheck/dev-no-voip stays happy):
//   APNS_VOIP_CERT_PATH        path to the .p12 file on disk
//   APNS_VOIP_CERT_PASSPHRASE  passphrase set during the .p12 export
//   APNS_BUNDLE_ID             your app's bundle id (e.g. com.donna.app)
//   APNS_PRODUCTION            "true" for production / testflight, "false" for dev builds

import { readFile } from "node:fs/promises";
import apn from "@parse/node-apn";

export interface VoipPushPayload {
  /** uuid for this call. matches CallKit's UUID on the device side. */
  callId: string;
  /** livekit room the agent will join. */
  roomName: string;
  /** signed jwt the client uses to connect to livekit. */
  joinToken: string;
  /** wss:// url of your livekit cloud project. */
  livekitUrl: string;
  /** what to render as the caller name in the native call ui. */
  callerName?: string;
}

let providerPromise: Promise<apn.Provider> | null = null;

async function getProvider(): Promise<apn.Provider> {
  if (providerPromise) return providerPromise;

  providerPromise = (async () => {
    const certPath = process.env.APNS_VOIP_CERT_PATH;
    const passphrase = process.env.APNS_VOIP_CERT_PASSPHRASE;
    const production = process.env.APNS_PRODUCTION === "true";

    if (!certPath) {
      throw new Error(
        "apns voip cert missing — set APNS_VOIP_CERT_PATH to the .p12 file",
      );
    }

    const pfx = await readFile(certPath);
    return new apn.Provider({ pfx, passphrase, production });
  })();

  return providerPromise;
}

export async function sendVoipPush(
  deviceToken: string,
  data: VoipPushPayload,
): Promise<void> {
  const bundleId = process.env.APNS_BUNDLE_ID;
  if (!bundleId) {
    throw new Error("APNS_BUNDLE_ID missing — set it to e.g. com.donna.app");
  }

  const provider = await getProvider();

  const notification = new apn.Notification();
  // voip topic is bundle id with .voip suffix. apple enforces this.
  notification.topic = `${bundleId}.voip`;
  notification.pushType = "voip";
  // priority 10 = deliver immediately. voip pushes ignore quiet hours / dnd.
  notification.priority = 10;
  // expiry 0 = drop if not delivered immediately. don't queue stale call invites.
  notification.expiry = 0;
  notification.payload = {
    callId: data.callId,
    roomName: data.roomName,
    joinToken: data.joinToken,
    livekitUrl: data.livekitUrl,
    callerName: data.callerName ?? "donna",
  };

  const result = await provider.send(notification, deviceToken);
  if (result.failed.length > 0) {
    const first = result.failed[0]!;
    // dump the whole failure object — node-apn's failure shape varies (status,
    // response, error, device, reason). printing the full object surfaces
    // whatever the lib actually populated so we can diagnose. omit only the
    // `device` field which echoes the token.
    const { device: _device, ...detail } = first as unknown as Record<string, unknown>;
    throw new Error(
      `apns voip push failed: ${JSON.stringify(detail, (_k, v) => (v instanceof Error ? { message: v.message, name: v.name, stack: v.stack } : v))}`,
    );
  }
}
