import { useAuth } from "@clerk/clerk-expo";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "@/design";
import { api } from "@/lib/api";
import { getDeviceToken } from "@/lib/voipCall";

type IntegrationState = "live" | "paused" | "off";

type Integration = {
  id: string;
  name: string;
  status: string;
  state: IntegrationState;
};

const INITIAL_INTEGRATIONS: Integration[] = [
  { id: "gmail", name: "gmail", status: "read and reply · 3,402 in 30 days", state: "live" },
  { id: "gcal", name: "google calendar", status: "read · 47 events visible", state: "live" },
  { id: "wa", name: "whatsapp", status: "your number · since may 9", state: "live" },
  { id: "imsg", name: "imessage", status: "paused since tuesday", state: "paused" },
  { id: "notion", name: "notion", status: "never connected", state: "off" },
];

function Dot({ state }: { state: IntegrationState }) {
  const { palette } = useTheme();
  const color =
    state === "live" ? palette.moss[700] :
    state === "paused" ? palette.amber[700] :
    palette.ink[400];
  return (
    <View
      style={{
        width: 8,
        height: 8,
        borderRadius: 999,
        backgroundColor: color,
      }}
    />
  );
}

function Row({
  title,
  detail,
  right,
  onPress,
}: {
  title: React.ReactNode;
  detail?: string;
  right?: React.ReactNode;
  onPress?: () => void;
}) {
  const { roles, type, space } = useTheme();
  const content = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: space[3],
        paddingVertical: space[3],
        borderBottomWidth: 1,
        borderBottomColor: roles.border.hairline,
      }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        {typeof title === "string" ? (
          <Text style={[type.body, { fontWeight: "500", color: roles.fg.primary }]}>
            {title}
          </Text>
        ) : (
          title
        )}
        {detail && (
          <Text style={[type.caption, { color: roles.fg.tertiary }]}>{detail}</Text>
        )}
      </View>
      {right}
    </View>
  );

  return onPress ? (
    <Pressable onPress={onPress}>{content}</Pressable>
  ) : (
    content
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const { roles, type, space } = useTheme();
  return (
    <View style={{ marginTop: space[5] }}>
      <Text
        style={[
          type.eyebrow,
          { color: roles.fg.muted, marginBottom: space[2] },
        ]}
      >
        {label}
      </Text>
      {children}
    </View>
  );
}

export default function Dashboard() {
  const { roles, type, space } = useTheme();
  const { getToken } = useAuth();
  const router = useRouter();
  const [integrations, setIntegrations] = useState(INITIAL_INTEGRATIONS);
  const [calling, setCalling] = useState(false);

  async function onCallDonna() {
    if (calling) return;
    setCalling(true);
    try {
      const res = await api<{
        callId: string;
        token: string;
        roomName: string;
        livekitUrl: string;
      }>("/api/mobile/call/token", {
        method: "POST",
        body: {},
        getToken,
      });
      router.push({
        pathname: "/call",
        params: {
          callId: res.callId,
          roomName: res.roomName,
          token: res.token,
          url: res.livekitUrl,
          callerName: "donna",
        },
      });
    } catch (err) {
      Alert.alert("couldn't start the call", String(err));
    } finally {
      setCalling(false);
    }
  }

  // path-B test: trigger an actual voip push from the backend that wakes
  // callkit on this device. proves the .p12 cert + apns sender + pushkit
  // wiring all work end-to-end. once /api/mobile/device-token is wired we
  // wouldn't pass the token here — the server would look it up by user.
  async function onRingMeFromDonna() {
    if (calling) return;
    const deviceToken = getDeviceToken();
    if (!deviceToken) {
      Alert.alert(
        "no voip token yet",
        "the app hasn't registered with apple's push service yet. wait a few seconds after launch and try again.",
      );
      return;
    }
    setCalling(true);
    try {
      await api("/api/mobile/call/start", {
        method: "POST",
        body: { deviceToken },
        getToken,
      });
      // callkit will ring momentarily on this device — no router push needed.
    } catch (err) {
      Alert.alert("couldn't trigger ring", String(err));
    } finally {
      setCalling(false);
    }
  }

  function toggle(id: string) {
    setIntegrations((prev) =>
      prev.map((i) =>
        i.id === id
          ? {
              ...i,
              state: i.state === "live" ? "paused" : "live",
              status:
                i.state === "live"
                  ? "paused just now"
                  : i.name === "gmail"
                  ? "read and reply · 3,402 in 30 days"
                  : "live",
            }
          : i,
      ),
    );
  }

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: roles.bg.canvas }}
      edges={["top"]}
    >
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: space[5],
          paddingTop: space[5],
          paddingBottom: space[7],
        }}
      >
        <Text style={[type.eyebrow, { color: roles.fg.muted }]}>you</Text>
        <Text
          style={[type.h2, { color: roles.fg.primary, marginTop: space[1] }]}
        >
          donna's settings
        </Text>

        <Pressable
          onPress={onCallDonna}
          disabled={calling}
          style={{
            backgroundColor: calling ? roles.bg.surface : roles.bg.accent,
            borderRadius: 28,
            height: 56,
            alignItems: "center",
            justifyContent: "center",
            marginTop: space[4],
          }}
        >
          <Text style={[type.body, { color: roles.fg.onRust, fontWeight: "500" }]}>
            {calling ? "connecting" : "call donna"}
          </Text>
        </Pressable>

        <Pressable
          onPress={onRingMeFromDonna}
          disabled={calling}
          style={{
            backgroundColor: roles.bg.surface,
            borderRadius: 28,
            height: 56,
            alignItems: "center",
            justifyContent: "center",
            marginTop: space[2],
            borderWidth: 1,
            borderColor: roles.border.hairline,
          }}
        >
          <Text style={[type.body, { color: roles.fg.primary, fontWeight: "500" }]}>
            ring me from donna
          </Text>
        </Pressable>

        <Section label="integrations">
          {integrations.map((i) => (
            <Row
              key={i.id}
              onPress={i.state !== "off" ? () => toggle(i.id) : undefined}
              title={
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: space[3],
                  }}
                >
                  <Dot state={i.state} />
                  <Text
                    style={[
                      type.body,
                      { fontWeight: "500", color: roles.fg.primary },
                    ]}
                  >
                    {i.name}
                  </Text>
                </View>
              }
              detail={i.status}
              right={
                <Text style={[type.caption, { color: roles.fg.tertiary }]}>
                  {i.state === "off" ? "add" : "›"}
                </Text>
              }
            />
          ))}
        </Section>

        <Section label="voice">
          <Row title="tone" detail="quiet · steady · attentive" right={
            <Text style={[type.caption, { color: roles.fg.tertiary }]}>›</Text>
          } />
          <Row title="how she signs off" detail="— d." right={
            <Text style={[type.caption, { color: roles.fg.tertiary }]}>›</Text>
          } />
        </Section>

        <Section label="quiet hours">
          <Row
            title={
              <Text
                style={[
                  type.body,
                  { fontWeight: "500", color: roles.fg.primary, fontVariant: ["tabular-nums"] },
                ]}
              >
                11 pm — 8 am
              </Text>
            }
            detail="all days · except urgent"
            right={
              <Text style={[type.caption, { color: roles.fg.tertiary }]}>›</Text>
            }
          />
        </Section>

        <Section label="account">
          <Row title="sign out" />
          <Row
            title={
              <Text
                style={[type.body, { fontWeight: "500", color: roles.fg.danger }]}
              >
                delete all my data
              </Text>
            }
          />
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}
