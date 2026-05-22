import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "@/design";

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
  const [integrations, setIntegrations] = useState(INITIAL_INTEGRATIONS);

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
