import { useUser } from "@clerk/clerk-expo";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { OnboardingShell } from "@/components/OnboardingShell";

/**
 * final onboarding beat. flips publicMetadata.onboarded = true on the
 * clerk user, which the root auth gate watches — once true, all
 * subsequent app launches skip onboarding and land in (tabs).
 *
 * after marking onboarded, redirects to /(tabs) which is the Live tab.
 */
export default function Handoff() {
  const router = useRouter();
  const { user } = useUser();
  const [marking, setMarking] = useState(true);

  useEffect(() => {
    if (!user) return;

    (async () => {
      try {
        await user.update({
          unsafeMetadata: {
            ...(user.unsafeMetadata ?? {}),
            onboarded: true,
          },
        });
        // note: publicMetadata can only be set via backend, so we use
        // unsafeMetadata here. the auth gate reads from publicMetadata
        // first, then falls back to unsafeMetadata for the v1 path.
      } catch (err) {
        console.error("[handoff] failed to mark onboarded", err);
      } finally {
        setMarking(false);
      }
    })();
  }, [user]);

  useEffect(() => {
    if (marking) return;
    const t = setTimeout(() => router.replace("/(tabs)"), 1500);
    return () => clearTimeout(t);
  }, [marking, router]);

  return (
    <OnboardingShell
      eyebrow="settling in"
      title="i'll be quiet for a moment."
      body="when i have something for you, you'll know. — d."
    />
  );
}
