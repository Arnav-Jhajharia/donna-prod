import { Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "@/design";

type Props = {
  eyebrow: string;
  title: string;
  body?: string;
  primaryLabel?: string;
  onPrimary?: () => void;
  primaryDisabled?: boolean;
  secondaryLabel?: string;
  onSecondary?: () => void;
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
};

/**
 * placeholder shell for onboarding pages. claude design will replace
 * the visuals one page at a time. the navigation, the auth gate, the
 * page order — all driven from outside this component.
 *
 * the shape: eyebrow + serif h2 + optional body + content slot +
 * primary cta + optional secondary cta. matches the design system's
 * editorial-page pattern.
 */
export function OnboardingShell({
  eyebrow,
  title,
  body,
  primaryLabel,
  onPrimary,
  primaryDisabled,
  secondaryLabel,
  onSecondary,
  children,
  style,
}: Props) {
  const { roles, type, space } = useTheme();

  return (
    <SafeAreaView
      style={[{ flex: 1, backgroundColor: roles.bg.canvas }, style]}
      edges={["top", "bottom"]}
    >
      <View
        style={{
          flex: 1,
          paddingHorizontal: space[5],
          paddingTop: space[7],
          paddingBottom: space[5],
        }}
      >
        <View style={{ gap: space[2] }}>
          <Text style={[type.eyebrow, { color: roles.fg.muted }]}>
            {eyebrow}
          </Text>
          <Text style={[type.h2, { color: roles.fg.primary }]}>{title}</Text>
          {body ? (
            <Text
              style={[
                type.lead,
                { color: roles.fg.secondary, marginTop: space[3] },
              ]}
            >
              {body}
            </Text>
          ) : null}
        </View>

        <View style={{ flex: 1, paddingTop: space[5] }}>{children}</View>

        <View style={{ gap: space[3] }}>
          {primaryLabel && onPrimary ? (
            <Pressable
              onPress={onPrimary}
              disabled={primaryDisabled}
              style={{
                height: 56,
                borderRadius: 8,
                backgroundColor: roles.bg.accent,
                alignItems: "center",
                justifyContent: "center",
                opacity: primaryDisabled ? 0.5 : 1,
              }}
            >
              <Text
                style={[type.button, { color: roles.fg.onRust, fontSize: 16 }]}
              >
                {primaryLabel}
              </Text>
            </Pressable>
          ) : null}

          {secondaryLabel && onSecondary ? (
            <Pressable
              onPress={onSecondary}
              style={{
                height: 56,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text
                style={[
                  type.button,
                  {
                    color: roles.fg.primary,
                    fontSize: 15,
                    fontStyle: "italic",
                  },
                ]}
              >
                {secondaryLabel}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </SafeAreaView>
  );
}
