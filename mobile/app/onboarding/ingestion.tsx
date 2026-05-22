import { useRouter } from "expo-router";
import { useEffect } from "react";
import { OnboardingShell } from "@/components/OnboardingShell";

/**
 * the contemplative loading page. real version cycles through donna-voiced
 * captions as ingestion progresses on the backend. for now: auto-advance
 * after 3s so we can walk the whole flow without waiting for the brain.
 */
export default function Ingestion() {
  const router = useRouter();

  useEffect(() => {
    const t = setTimeout(() => router.push("/onboarding/reveal"), 3000);
    return () => clearTimeout(t);
  }, [router]);

  return (
    <OnboardingShell
      eyebrow="give me a minute"
      title="i'm reading."
      body="placeholder — auto-advances in 3s. real version cycles serif italic captions for ~30-90s while ingestion runs."
    />
  );
}
