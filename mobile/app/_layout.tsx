import { ClerkLoaded, ClerkProvider, useAuth, useUser } from "@clerk/clerk-expo";
import { SplashScreen, Stack, useRouter, useSegments } from "expo-router";
import { useEffect } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { PostHogProvider, usePostHog } from "posthog-react-native";
import { ThemeProvider, useDonnaFonts, useTheme } from "@/design";
import { tokenCache } from "@/lib/token-cache";

SplashScreen.preventAutoHideAsync();

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
  const { isSignedIn, isLoaded } = useAuth();
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
