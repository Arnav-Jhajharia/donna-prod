import { useRouter } from "expo-router";
import { OnboardingShell } from "@/components/OnboardingShell";

export default function Phone() {
  const router = useRouter();
  return (
    <OnboardingShell
      eyebrow="i live elsewhere too"
      title="your number."
      body="placeholder — phone input + OTP verification for whatsapp pairing. real version uses clerk's phone verification flow."
      primaryLabel="save"
      onPrimary={() => router.push("/onboarding/handoff")}
      secondaryLabel="skip for now"
      onSecondary={() => router.push("/onboarding/handoff")}
    />
  );
}
