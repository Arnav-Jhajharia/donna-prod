import { ClerkLoaded, ClerkProvider, useAuth, useUser } from "@clerk/clerk-expo";
import { SplashScreen, Stack, useRouter, useSegments } from "expo-router";
import { useEffect } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { PostHogProvider, usePostHog } from "posthog-react-native";
import { ThemeProvider, useDonnaFonts, useTheme } from "@/design";
import { tokenCache } from "@/lib/token-cache";
import { api } from "@/lib/api";
import { onDeviceToken, setupCallSystem } from "@/lib/voipCall";

SplashScreen.preventAutoHideAsync();

// register voip push + callkit + livekit globals once at app boot. lives for
// the app's lifetime; iOS keeps the voip channel open even when suspended.
setupCallSystem();

const CLERK_PUBLISHABLE_KEY = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
const POSTHOG_API_KEY = process.env.EXPO_PUBLIC_POSTHOG_API_KEY;
const POSTHOG_HOST =
  process.env.EXPO_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";

if (!CLERK_PUBLISHABLE_KEY) {
  throw new Error(
    "missing EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY. set it in mobile/.env or app config.",
  );
}

if (!POSTHOG_API_KEY) {
  console.warn(
    "missing EXPO_PUBLIC_POSTHOG_API_KEY. analytics disabled for this session.",
  );
}

export default function RootLayout() {
  const fontsReady = useDonnaFonts();

  useEffect(() => {
    if (fontsReady) SplashScreen.hideAsync();
  }, [fontsReady]);

  if (!fontsReady) return null;

  const tree = (
    <ClerkProvider
      publishableKey={CLERK_PUBLISHABLE_KEY!}
      tokenCache={tokenCache}
    >
      <ClerkLoaded>
        <SafeAreaProvider>
          <ThemeProvider>
            <RootStack />
          </ThemeProvider>
        </SafeAreaProvider>
      </ClerkLoaded>
    </ClerkProvider>
  );

  if (!POSTHOG_API_KEY) return tree;

  return (
    <PostHogProvider
      apiKey={POSTHOG_API_KEY}
      options={{ host: POSTHOG_HOST }}
      autocapture
    >
      {tree}
    </PostHogProvider>
  );
}

/**
 * the gate. three states, three destinations:
 *   - not signed in            -> (auth)/sign-in
 *   - signed in, onboarding tbd -> onboarding/fork
 *   - signed in, onboarded     -> (tabs)
 *
 * "onboarded" is tracked on the clerk user via publicMetadata.onboarded.
 * we flip it true on the handoff page after the user finishes the flow.
 */
function RootStack() {
  const { roles } = useTheme();
  const { isSignedIn, isLoaded, getToken } = useAuth();
  const { user } = useUser();
  const segments = useSegments();
  const router = useRouter();
  const posthog = usePostHog();

  useEffect(() => {
    if (!posthog || !isLoaded) return;
    if (isSignedIn && user) {
      const email = user.primaryEmailAddress?.emailAddress;
      posthog.identify(user.id, email ? { email } : undefined);
    } else if (!isSignedIn) {
      posthog.reset();
    }
  }, [posthog, isLoaded, isSignedIn, user]);

  // register the voip device token with the backend once both:
  //   (a) clerk is signed in (so the request authenticates), and
  //   (b) pushkit has handed us a token (fires once per app boot, usually
  //       within a couple seconds of mount).
  // we don't have to gate on onboarded — the user's row exists from clerk
  // sign-in and the token is just a column on it.
  useEffect(() => {
    if (!isSignedIn) return;
    const unsubscribe = onDeviceToken(async (token) => {
      try {
        await api("/api/mobile/device-token", {
          method: "POST",
          body: { token },
          getToken,
        });
      } catch (err) {
        console.warn("[voipCall] device-token registration failed", err);
      }
    });
    return unsubscribe;
  }, [isSignedIn, getToken]);

  // v1 writes from client via unsafeMetadata. once the brain backend
  // can set publicMetadata via webhook, this check moves to publicMetadata
  // (which is server-only writable and therefore tamper-resistant).
  const onboarded =
    (user?.publicMetadata as { onboarded?: boolean } | undefined)?.onboarded ===
      true ||
    (user?.unsafeMetadata as { onboarded?: boolean } | undefined)?.onboarded ===
      true;

  useEffect(() => {
    if (!isLoaded) return;

    const inAuth = segments[0] === "(auth)";
    const inOnboarding = segments[0] === "onboarding";
    const inTabs = segments[0] === "(tabs)";

    if (!isSignedIn && !inAuth) {
      router.replace("/(auth)/sign-in");
    } else if (isSignedIn && !onboarded && !inOnboarding) {
      router.replace("/onboarding/fork");
    } else if (isSignedIn && onboarded && (inAuth || inOnboarding)) {
      router.replace("/(tabs)");
    }
  }, [isLoaded, isSignedIn, onboarded, segments, router]);

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: roles.bg.canvas },
        animation: "fade",
      }}
    >
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="onboarding" />
      <Stack.Screen name="(tabs)" />
    </Stack>
  );
}
