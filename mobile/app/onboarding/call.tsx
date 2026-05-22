import { useRouter } from "expo-router";
import { OnboardingShell } from "@/components/OnboardingShell";

/**
 * placeholder for the call surface. in production this page never really
 * renders — voip push triggers callkit which takes over the screen
 * before this route is visible. when the call ends, we land on /resume.
 *
 * for now (no voip wiring yet) this is a stub that just moves forward
 * so we can walk the rest of the flow.
 */
export default function Call() {
  const router = useRouter();
  return (
    <OnboardingShell
      eyebrow="calling"
      title="the call is happening here."
      body="placeholder — in production, callkit overlays this page once the voip push lands. for now, tap to advance."
      primaryLabel="pretend the call ended"
      onPrimary={() => router.push("/onboarding/vacuum")}
    />
  );
}
