import { Stack } from "expo-router";

/**
 * onboarding stack — no tab bar, linear left-to-right slide between
 * pages. each route in this group is one beat of the 12-page flow.
 * RootStack in app/_layout.tsx gates entry: only signed-in users
 * without `publicMetadata.onboarded === true` end up here.
 *
 * page order (the design):
 *   fork  -> call  -> resume  -> vacuum -> ingestion -> reveal -> demo -> phone -> handoff
 *   fork  -> letter -> identification -> days -> people -> vacuum -> (...) -> handoff
 */
export default function OnboardingLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        animation: "slide_from_right",
        gestureEnabled: false,
      }}
    />
  );
}
