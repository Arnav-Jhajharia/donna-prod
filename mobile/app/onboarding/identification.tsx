import { useRouter } from "expo-router";
import { OnboardingShell } from "@/components/OnboardingShell";

export default function Identification() {
  const router = useRouter();
  return (
    <OnboardingShell
      eyebrow="introductions"
      title="first, the basics."
      body="placeholder for name + city fields. claude design fills this in."
      primaryLabel="save"
      onPrimary={() => router.push("/onboarding/days")}
    />
  );
}
