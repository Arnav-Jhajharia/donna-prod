import { Text, View } from "react-native";
import { useTheme } from "@/design";

export type ChatRole = "donna" | "user";

export function ChatBubble({ role, text }: { role: ChatRole; text: string }) {
  const { roles, type, space } = useTheme();
  const isDonna = role === "donna";

  return (
    <View
      style={{
        alignSelf: isDonna ? "flex-start" : "flex-end",
        backgroundColor: isDonna ? roles.bg.surface : roles.bg.inverse,
        paddingVertical: space[3],
        paddingHorizontal: space[4],
        borderRadius: 14,
        maxWidth: "78%",
        marginVertical: space[1],
      }}
    >
      <Text
        style={[
          type.body,
          {
            color: isDonna ? roles.fg.primary : roles.fg.inverse,
            fontSize: 15,
            lineHeight: 23,
          },
        ]}
      >
        {text}
      </Text>
    </View>
  );
}
