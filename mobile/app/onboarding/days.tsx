import { useRouter } from "expo-router";
import { OnboardingShell } from "@/components/OnboardingShell";

export default function Days() {
  const router = useRouter();
  return (
    <OnboardingShell
      eyebrow="context"
      title="what fills your days right now."
      body="placeholder for the multiline text input. the more they tell donna, the faster she learns."
      primaryLabel="save"
      onPrimary={() => router.push("/onboarding/people")}
    />
  );
}
