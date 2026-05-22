import { useRouter } from "expo-router";
import { OnboardingShell } from "@/components/OnboardingShell";

export default function Demo() {
  const router = useRouter();
  return (
    <OnboardingShell
      eyebrow="watch"
      title="the first thing i'll do for you."
      body="placeholder — one card with a real action donna identified during ingestion. draft / send / edit / skip."
      primaryLabel="continue"
      onPrimary={() => router.push("/onboarding/phone")}
    />
  );
}
