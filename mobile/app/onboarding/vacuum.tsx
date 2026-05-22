import { useRouter } from "expo-router";
import { OnboardingShell } from "@/components/OnboardingShell";

export default function Vacuum() {
  const router = useRouter();
  return (
    <OnboardingShell
      eyebrow="what i'll read"
      title="give me access."
      body="placeholder for the three integration cards — gmail / calendar / claude conversations. tap to connect via oauth or upload."
      primaryLabel="continue"
      onPrimary={() => router.push("/onboarding/ingestion")}
    />
  );
}
