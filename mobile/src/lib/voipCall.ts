// the central wiring for the call surface. one module, three concerns:
//
//   1. PushKit (react-native-voip-push-notification)
//      - register for voip tokens
//      - receive voip pushes (donna ringing you)
//
//   2. CallKit (react-native-callkeep)
//      - render the native incoming call ui on push arrival (5-second rule)
//      - handle accept/end actions from the native ui
//
//   3. LiveKit (@livekit/react-native)
//      - register globals once so audio/webrtc work
//      - the actual room connection lives in app/call.tsx via <LiveKitRoom>
//
// the lifecycle: setupCallSystem() runs once from app/_layout.tsx on mount.
// listeners stay alive for the app's lifetime — iOS keeps voip push delivery
// active even when the app is suspended.

import { router } from "expo-router";
import { Platform } from "react-native";
import RNCallKeep from "react-native-callkeep";
import VoipPushNotification from "react-native-voip-push-notification";
import { registerGlobals } from "@livekit/react-native";

export interface PendingCall {
  /** uuid string. matches CallKit's call uuid for this incoming call. */
  callId: string;
  /** room donna's agent will be dispatched to. */
  roomName: string;
  /** signed jwt the client uses to join the room. */
  joinToken: string;
  /** wss:// url of livekit cloud. */
  livekitUrl: string;
  /** display name in the native call ui. */
  callerName: string;
}

// module-level state. memoized across the app's lifetime.
let initialized = false;
let cachedDeviceToken: string | null = null;
let pendingCall: PendingCall | null = null;
const deviceTokenListeners = new Set<(token: string) => void>();

/**
 * one-shot init. safe to call multiple times — only the first call does work.
 * call from app/_layout.tsx on first mount.
 */
export function setupCallSystem(): void {
  if (initialized) return;
  initialized = true;

  // register webrtc + audio session globals so livekit-client can publish/subscribe.
  // must run before any room connection. cheap if called multiple times.
  registerGlobals();

  if (Platform.OS !== "ios") {
    // android voip path is different (firebase + ConnectionService). out of scope for v0.
    return;
  }

  setupCallKeep();
  setupPushKit();
}

function setupCallKeep(): void {
  RNCallKeep.setup({
    ios: {
      appName: "donna",
      // includesCallsInRecents=true puts donna calls into the system phone app's
      // "All" recents tab. feels like a real phone log. would be false if we want
      // to keep donna calls separate (more private), but for v0 we'll show.
      includesCallsInRecents: true,
      supportsVideo: false,
    },
    android: {
      // unused on ios but required by the typings.
      alertTitle: "donna",
      alertDescription: "incoming call",
      cancelButton: "cancel",
      okButton: "ok",
      additionalPermissions: [],
    },
  }).catch((err) => {
    console.warn("[voipCall] callkeep setup failed", err);
  });

  // user swiped accept on the native call ui. navigate to the call screen,
  // which reads pendingCall to find the livekit room + join token.
  RNCallKeep.addEventListener("answerCall", ({ callUUID }) => {
    if (!pendingCall || pendingCall.callId !== callUUID) {
      console.warn("[voipCall] answerCall with no matching pendingCall", callUUID);
      return;
    }
    router.push({
      pathname: "/call",
      params: {
        callId: pendingCall.callId,
        roomName: pendingCall.roomName,
        token: pendingCall.joinToken,
        url: pendingCall.livekitUrl,
        callerName: pendingCall.callerName,
        fromPush: "1",
      },
    });
  });

  // user tapped end on the native ui, or another participant ended. the call
  // screen disconnects on unmount, so we just navigate back here. clearing
  // pendingCall ensures stale state doesn't leak into the next call.
  RNCallKeep.addEventListener("endCall", () => {
    pendingCall = null;
    if (router.canGoBack()) router.back();
  });
}

function setupPushKit(): void {
  // ask the system for a voip push device token. result arrives via the
  // "register" event. on cold boot iOS may also deliver pushes that arrived
  // before the app was running — those come through "didLoadWithEvents".
  VoipPushNotification.addEventListener("register", (token) => {
    cachedDeviceToken = token;
    // dev debug: surface the token in metro logs so we can grab it for
    // curl-based testing before /api/mobile/device-token is wired. remove
    // this log once the device-token route is in.
    console.log("[voipCall] voip device token:", token);
    for (const listener of deviceTokenListeners) listener(token);
  });

  VoipPushNotification.addEventListener("notification", (payload) => {
    onVoipPushReceived(payload as Record<string, unknown>);
  });

  // events delivered before listeners attached (cold start case).
  VoipPushNotification.addEventListener("didLoadWithEvents", (events) => {
    for (const event of events) {
      if (event.name === VoipPushNotification.RNVoipPushRemoteNotificationsRegisteredEvent) {
        cachedDeviceToken = event.data as string;
        for (const listener of deviceTokenListeners) listener(event.data as string);
      } else if (
        event.name === VoipPushNotification.RNVoipPushRemoteNotificationReceivedEvent
      ) {
        onVoipPushReceived(event.data as Record<string, unknown>);
      }
    }
  });

  VoipPushNotification.registerVoipToken();
}

/**
 * runs when a voip push arrives. has a hard 5-second budget — apple
 * suspends and eventually blacklists apps that miss it. we MUST call
 * displayIncomingCall before the budget expires.
 */
function onVoipPushReceived(payload: Record<string, unknown>): void {
  const callId = typeof payload.callId === "string" ? payload.callId : undefined;
  const roomName = typeof payload.roomName === "string" ? payload.roomName : undefined;
  const joinToken = typeof payload.joinToken === "string" ? payload.joinToken : undefined;
  const livekitUrl = typeof payload.livekitUrl === "string" ? payload.livekitUrl : undefined;
  const callerName =
    typeof payload.callerName === "string" ? payload.callerName : "donna";

  if (!callId || !roomName || !joinToken || !livekitUrl) {
    console.warn("[voipCall] voip push missing required fields", payload);
    return;
  }

  pendingCall = { callId, roomName, joinToken, livekitUrl, callerName };

  // critical: must happen synchronously here so we beat the 5s window.
  RNCallKeep.displayIncomingCall(
    callId,
    callerName,
    callerName,
    "generic",
    false,
  );

  // tell pushkit we handled this push. iOS releases the background slot.
  VoipPushNotification.onVoipNotificationCompleted(callId);
}

/**
 * read the most recent voip device token, if PushKit has registered one yet.
 * mobile app uses this to pass the token in /api/mobile/call/start so the
 * backend knows where to send the voip push.
 */
export function getDeviceToken(): string | null {
  return cachedDeviceToken;
}

/**
 * subscribe to device-token updates. fires immediately if a token is already
 * cached, then again on each subsequent registration. returns an unsubscribe.
 */
export function onDeviceToken(listener: (token: string) => void): () => void {
  deviceTokenListeners.add(listener);
  if (cachedDeviceToken) listener(cachedDeviceToken);
  return () => deviceTokenListeners.delete(listener);
}

/**
 * fetch the pending incoming call's payload, set just before CallKit's
 * native ui appeared. used by the call screen on mount.
 */
export function getPendingCall(): PendingCall | null {
  return pendingCall;
}

/**
 * called by the call screen when the user taps the in-screen "end" button.
 * tells CallKit to tear down the call ui; CallKit's endCall event then
 * navigates us back to wherever we came from.
 */
export function endCurrentCall(): void {
  const id = pendingCall?.callId;
  if (id) RNCallKeep.endCall(id);
  pendingCall = null;
}
