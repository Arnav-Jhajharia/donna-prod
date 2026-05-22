import { Pressable, Text, TextInput, View } from "react-native";
import { useTheme } from "@/design";

type Props = {
  value: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
};

export function ChatComposer({ value, onChangeText, onSend }: Props) {
  const { roles, type, space } = useTheme();
  const canSend = value.trim().length > 0;

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space[3],
        paddingVertical: space[2],
        paddingHorizontal: space[4],
        backgroundColor: roles.bg.inset,
        borderWidth: 1,
        borderColor: roles.border.hairline,
        borderRadius: 999,
        margin: space[4],
        marginTop: space[2],
      }}
    >
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder="say something"
        placeholderTextColor={roles.fg.placeholder}
        onSubmitEditing={canSend ? onSend : undefined}
        returnKeyType="send"
        style={[
          type.body,
          {
            flex: 1,
            color: roles.fg.primary,
            fontSize: 15,
            paddingVertical: space[2],
          },
        ]}
      />
      <Pressable onPress={onSend} disabled={!canSend} hitSlop={12}>
        <Text
          style={[
            type.button,
            {
              color: canSend ? roles.fg.accent : roles.fg.placeholder,
              fontSize: 14,
            },
          ]}
        >
          send
        </Text>
      </Pressable>
    </View>
  );
}
