import { useRouter } from "expo-router";
import { OnboardingShell } from "@/components/OnboardingShell";

export default function People() {
  const router = useRouter();
  return (
    <OnboardingShell
      eyebrow="the people who matter"
      title="who matters most this week."
      body="placeholder for the multiline input. a name or two. anything they want donna to know about them."
      primaryLabel="save"
      onPrimary={() => router.push("/onboarding/vacuum")}
    />
  );
}
