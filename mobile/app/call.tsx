// post-onboarding call screen. mounted two ways:
//   path-A: user taps "call donna" in the app -> we POST /api/mobile/call/token
//           and navigate here with the resulting token + url + roomName.
//   path-B: voip push arrives -> CallKeep shows native ui -> user accepts ->
//           voipCall.ts navigates here with the same params (plus fromPush=1).
//
// in both cases, <LiveKitRoom> opens a connection on mount, publishes the
// mic, and tears down on unmount. CallKit's native ui (path-B only) overlays
// this screen until the user dismisses it.

import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  LiveKitRoom,
  useConnectionState,
  useLocalParticipant,
} from "@livekit/react-native";
import { useTheme } from "@/design";
import { endCurrentCall } from "@/lib/voipCall";

type CallParams = {
  callId?: string;
  roomName?: string;
  token?: string;
  url?: string;
  callerName?: string;
  fromPush?: string;
};

export default function CallScreen() {
  const params = useLocalSearchParams<CallParams>();
  const router = useRouter();
  const { roles, type } = useTheme();

  // a missing token or url means we got here without going through the proper
  // entry points. bounce back rather than render a broken livekit context.
  useEffect(() => {
    if (!params.token || !params.url) {
      if (router.canGoBack()) router.back();
    }
  }, [params.token, params.url, router]);

  if (!params.token || !params.url) {
    return (
      <SafeAreaView style={[styles.root, { backgroundColor: roles.bg.canvas }]} />
    );
  }

  return (
    <LiveKitRoom
      serverUrl={params.url}
      token={params.token}
      connect
      audio
      onDisconnected={() => {
        if (router.canGoBack()) router.back();
      }}
    >
      <SafeAreaView style={[styles.root, { backgroundColor: roles.bg.canvas }]}>
        <View style={styles.header}>
          <Text style={[type.eyebrow, { color: roles.fg.muted }]}>
            on a call with
          </Text>
          <Text style={[type.display, { color: roles.fg.primary, marginTop: 4 }]}>
            {params.callerName ?? "donna"}
          </Text>
        </View>
        <ConnectionLabel />
        <Controls fromPush={params.fromPush === "1"} />
      </SafeAreaView>
    </LiveKitRoom>
  );
}

function ConnectionLabel() {
  const state = useConnectionState();
  const { roles, type } = useTheme();
  const label =
    state === "connecting" || state === "reconnecting"
      ? "connecting"
      : state === "connected"
        ? ""
        : "disconnected";
  if (!label) return null;
  return (
    <View style={styles.statusRow}>
      <Text style={[type.body, { color: roles.fg.muted }]}>{label}</Text>
    </View>
  );
}

function Controls({ fromPush }: { fromPush: boolean }) {
  const router = useRouter();
  const { roles, type } = useTheme();
  const { localParticipant, isMicrophoneEnabled } = useLocalParticipant();

  const onToggleMute = async () => {
    await localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled);
  };

  const onEnd = async () => {
    if (fromPush) {
      // tells CallKit to tear down the native ui. CallKeep's endCall event
      // then runs in voipCall.ts, which router.back()s us.
      endCurrentCall();
    }
    // disconnect happens via LiveKitRoom.onDisconnected -> router.back()
    // when the room tears down. if we got here from path-A and the user
    // double-taps end, also navigate as a fallback.
    if (router.canGoBack()) router.back();
  };

  return (
    <View style={styles.controlsRow}>
      <Pressable
        onPress={onToggleMute}
        style={[
          styles.controlButton,
          {
            backgroundColor: isMicrophoneEnabled
              ? roles.bg.surface
              : roles.bg.warningTint,
          },
        ]}
      >
        <Text style={[type.body, { color: roles.fg.primary }]}>
          {isMicrophoneEnabled ? "mute" : "unmute"}
        </Text>
      </Pressable>
      <Pressable
        onPress={onEnd}
        style={[styles.controlButton, { backgroundColor: roles.bg.dangerTint }]}
      >
        <Text style={[type.body, { color: roles.fg.danger }]}>end call</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 48,
    paddingBottom: 32,
    justifyContent: "space-between",
  },
  header: {
    alignItems: "center",
    marginTop: 48,
  },
  statusRow: {
    alignItems: "center",
  },
  controlsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
  },
  controlButton: {
    flex: 1,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
  },
});
