import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "@/design";

type TabBarProps = {
  state: { index: number; routes: Array<{ key: string; name: string; params?: object }> };
  descriptors: Record<string, { options: { title?: string } }>;
  navigation: {
    emit: (event: { type: string; target: string; canPreventDefault: boolean }) => { defaultPrevented: boolean };
    navigate: (name: string, params?: object) => void;
  };
};

export function TabBar({ state, descriptors, navigation }: TabBarProps) {
  const { roles, type, space } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View
      style={{
        flexDirection: "row",
        backgroundColor: roles.bg.canvas,
        borderTopWidth: 1,
        borderTopColor: roles.border.hairline,
        paddingTop: space[3],
        paddingBottom: Math.max(insets.bottom, space[3]),
        paddingHorizontal: space[5],
      }}
    >
      {state.routes.map((route, index) => {
        const isFocused = state.index === index;
        const { options } = descriptors[route.key];
        const label =
          typeof options.title === "string" ? options.title : route.name;

        return (
          <Pressable
            key={route.key}
            onPress={() => {
              const event = navigation.emit({
                type: "tabPress",
                target: route.key,
                canPreventDefault: true,
              });
              if (!isFocused && !event.defaultPrevented) {
                navigation.navigate(route.name, route.params);
              }
            }}
            hitSlop={12}
            style={{
              flex: 1,
              alignItems: "center",
              paddingVertical: space[2],
            }}
          >
            <Text
              style={[
                type.eyebrow,
                {
                  color: isFocused ? roles.fg.accent : roles.fg.muted,
                  fontSize: 11,
                },
              ]}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
