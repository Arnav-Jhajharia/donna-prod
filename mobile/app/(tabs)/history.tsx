import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "@/design";

type ItemType = "memory" | "brief" | "chat" | "held";

type Item = {
  id: string;
  type: ItemType;
  date: string;
  text: string;
};

const ITEMS: Item[] = [
  { id: "1", type: "brief", date: "may 21", text: "three things this morning: anika, workout, rent" },
  { id: "2", type: "memory", date: "may 6", text: "you don't drink alcohol after wednesdays" },
  { id: "3", type: "held", date: "may 20", text: "amazon order arrived. i didn't ping you." },
  { id: "4", type: "chat", date: "may 18", text: "discussed the q3 budget with priya" },
  { id: "5", type: "memory", date: "may 4", text: "cut to 78kg by august" },
  { id: "6", type: "brief", date: "may 18", text: "two things: priya's email, dentist appointment" },
  { id: "7", type: "memory", date: "march 12", text: "coffee, milk, no sugar" },
  { id: "8", type: "held", date: "may 17", text: "phone storage at 92%. waited for a better moment." },
  { id: "9", type: "chat", date: "may 16", text: "asked donna to draft a sick leave note" },
  { id: "10", type: "memory", date: "february 28", text: "karan is your younger brother. cs at iit-d." },
];

const FILTERS: { id: ItemType | "all"; label: string }[] = [
  { id: "all", label: "all" },
  { id: "memory", label: "memories" },
  { id: "brief", label: "briefs" },
  { id: "chat", label: "chats" },
  { id: "held", label: "held back" },
];

function TypeChip({ type }: { type: ItemType }) {
  const { roles, type: typeRoles, space, palette } = useTheme();
  const map: Record<ItemType, { bg: string; fg: string; label: string }> = {
    memory: { bg: palette.rust[50], fg: palette.rust[700], label: "memory" },
    brief: { bg: palette.paper[300], fg: palette.ink[600], label: "brief" },
    chat: { bg: palette.paper[300], fg: palette.ink[600], label: "chat" },
    held: { bg: palette.amber[100], fg: palette.amber[700], label: "held back" },
  };
  const s = map[type];
  return (
    <View
      style={{
        paddingVertical: 3,
        paddingHorizontal: space[2],
        borderRadius: 999,
        backgroundColor: s.bg,
        alignSelf: "flex-start",
      }}
    >
      <Text
        style={[
          typeRoles.eyebrow,
          { color: s.fg, fontSize: 10, letterSpacing: 0.6 },
        ]}
      >
        {s.label}
      </Text>
    </View>
  );
}

export default function History() {
  const { roles, type, space } = useTheme();
  const [filter, setFilter] = useState<ItemType | "all">("all");

  const visible = filter === "all" ? ITEMS : ITEMS.filter((i) => i.type === filter);

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: roles.bg.canvas }}
      edges={["top"]}
    >
      <View
        style={{
          paddingHorizontal: space[5],
          paddingTop: space[5],
          gap: space[1],
        }}
      >
        <Text style={[type.eyebrow, { color: roles.fg.muted }]}>the record</Text>
        <Text style={[type.h2, { color: roles.fg.primary }]}>everything</Text>
        <Text
          style={[type.caption, { color: roles.fg.tertiary, marginTop: space[2] }]}
        >
          {visible.length} {visible.length === 1 ? "thing" : "things"} donna
          remembers
        </Text>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0, marginTop: space[4] }}
        contentContainerStyle={{
          paddingHorizontal: space[5],
          gap: space[2],
        }}
      >
        {FILTERS.map((f) => {
          const active = filter === f.id;
          return (
            <Pressable key={f.id} onPress={() => setFilter(f.id)} hitSlop={8}>
              <View
                style={{
                  paddingVertical: space[2],
                  paddingHorizontal: space[3],
                  borderRadius: 999,
                  backgroundColor: active ? roles.bg.accent : "transparent",
                  borderWidth: 1,
                  borderColor: active ? roles.bg.accent : roles.border.hairline,
                }}
              >
                <Text
                  style={[
                    type.small,
                    {
                      color: active ? roles.fg.onRust : roles.fg.secondary,
                      fontWeight: "500",
                    },
                  ]}
                >
                  {f.label}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </ScrollView>

      <ScrollView
        style={{ flex: 1, marginTop: space[3] }}
        contentContainerStyle={{
          paddingHorizontal: space[5],
          paddingBottom: space[7],
        }}
      >
        {visible.map((item) => (
          <Pressable key={item.id} onPress={() => {}}>
            <View
              style={{
                paddingVertical: space[4],
                borderBottomWidth: 1,
                borderBottomColor: roles.border.hairline,
                gap: space[2],
              }}
            >
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: space[3],
                }}
              >
                <TypeChip type={item.type} />
                <Text
                  style={[
                    type.caption,
                    { color: roles.fg.muted, fontVariant: ["tabular-nums"] },
                  ]}
                >
                  {item.date}
                </Text>
              </View>
              <Text
                style={[
                  type.body,
                  { color: roles.fg.primary, fontSize: 15, lineHeight: 22 },
                ]}
              >
                {item.text}
              </Text>
            </View>
          </Pressable>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}
