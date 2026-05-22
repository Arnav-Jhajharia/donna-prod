import { SplashScreen, Stack } from "expo-router";
import { useEffect } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ThemeProvider, useDonnaFonts, useTheme } from "@/design";

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const fontsReady = useDonnaFonts();

  useEffect(() => {
    if (fontsReady) SplashScreen.hideAsync();
  }, [fontsReady]);

  if (!fontsReady) return null;

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <Screens />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

function Screens() {
  const { roles } = useTheme();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: roles.bg.canvas },
        animation: "fade",
      }}
    />
  );
}
