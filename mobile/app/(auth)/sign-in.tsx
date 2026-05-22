import { useSSO } from "@clerk/clerk-expo";
import * as AppleAuthentication from "expo-apple-authentication";
import { useCallback, useEffect, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "@/design";

/**
 * sign-in is the splash. one canvas, one tap.
 *
 * uses clerk's native apple sign in flow under the hood (via expo-apple-auth).
 * subsequent auth events propagate through useAuth() — root _layout's
 * RootStack handles the redirect to /onboarding/fork once signed in.
 */
export default function SignIn() {
  const { roles, type, space } = useTheme();
  const { startSSOFlow } = useSSO();
  const [appleAvailable, setAppleAvailable] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (Platform.OS !== "ios") {
      setAppleAvailable(false);
      return;
    }
    AppleAuthentication.isAvailableAsync().then(setAppleAvailable);
  }, []);

  const onAppleSignIn = useCallback(async () => {
    if (pending) return;
    setPending(true);
    try {
      const result = await startSSOFlow({ strategy: "oauth_apple" });
      if (result.createdSessionId && result.setActive) {
        await result.setActive({ session: result.createdSessionId });
      }
    } catch (err) {
      console.error("[sign-in] apple sso failed", err);
    } finally {
      setPending(false);
    }
  }, [pending, startSSOFlow]);

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: roles.bg.inverse }}
      edges={["top", "bottom"]}
    >
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          paddingHorizontal: space[5],
          gap: space[4],
        }}
      >
        <Text
          style={{
            fontFamily: "EBGaramond_400Regular",
            fontStyle: "italic",
            fontWeight: "500",
            fontSize: 64,
            letterSpacing: -0.64,
            color: roles.fg.inverse,
          }}
        >
          donna
        </Text>
        <Text
          style={[
            type.lead,
            {
              color: roles.fg.muted,
              fontStyle: "italic",
              fontFamily: "EBGaramond_400Regular",
              textAlign: "center",
            },
          ]}
        >
          she'll need ten seconds of you.
        </Text>
      </View>

      <View
        style={{
          paddingHorizontal: space[5],
          paddingBottom: space[5],
          gap: space[3],
        }}
      >
        {appleAvailable ? (
          <Pressable
            onPress={onAppleSignIn}
            disabled={pending}
            style={{
              height: 56,
              borderRadius: 8,
              backgroundColor: roles.fg.inverse,
              alignItems: "center",
              justifyContent: "center",
              opacity: pending ? 0.6 : 1,
            }}
          >
            <Text
              style={[
                type.button,
                {
                  color: roles.bg.inverse,
                  fontSize: 16,
                },
              ]}
            >
              {pending ? "signing in" : "continue with apple"}
            </Text>
          </Pressable>
        ) : (
          <Text
            style={[
              type.caption,
              { color: roles.fg.muted, textAlign: "center" },
            ]}
          >
            apple sign in isn't available on this device.
          </Text>
        )}
      </View>
    </SafeAreaView>
  );
}
