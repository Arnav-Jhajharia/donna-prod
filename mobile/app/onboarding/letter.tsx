import { useRouter } from "expo-router";
import { OnboardingShell } from "@/components/OnboardingShell";

export default function Letter() {
  const router = useRouter();
  return (
    <OnboardingShell
      eyebrow="the letter"
      title="no problem. some things are easier to read."
      body="i'm donna. i hold one person's life — the parts you'd rather not carry. to be useful, i need to know you. fast. i'll show you what i learn so you can correct me. trade fair?"
      primaryLabel="continue"
      onPrimary={() => router.push("/onboarding/identification")}
    />
  );
}
