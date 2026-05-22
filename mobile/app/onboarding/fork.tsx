import { useUser } from "@clerk/clerk-expo";
import { useRouter } from "expo-router";
import { OnboardingShell } from "@/components/OnboardingShell";

/**
 * page 2 of the design — the call vs text fork.
 *
 * "ring me"  -> /onboarding/call   (callkit + voip push triggers, livekit room)
 * "text"     -> /onboarding/letter (text fallback path)
 *
 * note: the actual voip push trigger is server-side. for v1 placeholder
 * the call route is just a screen; we wire push + livekit in a later pr.
 */
export default function Fork() {
  const router = useRouter();
  const { user } = useUser();
  const firstName = user?.firstName ?? "you";

  return (
    <OnboardingShell
      eyebrow="say hi"
      title={`hi, ${firstName}. mind if i ring you?`}
      body="this is the only call. promise."
      primaryLabel="ring me"
      onPrimary={() => router.push("/onboarding/call")}
      secondaryLabel="let's type instead"
      onSecondary={() => router.push("/onboarding/letter")}
    />
  );
}
