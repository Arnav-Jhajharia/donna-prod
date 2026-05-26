import { useAuth, useUser } from "@clerk/clerk-expo";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Alert } from "react-native";
import { OnboardingShell } from "@/components/OnboardingShell";
import { api } from "@/lib/api";
import { getDeviceToken } from "@/lib/voipCall";

/**
 * page 2 of the design — the call vs text fork.
 *
 * "ring me"  -> trigger /api/mobile/call/start (voip push) → CallKit rings →
 *               donna talks. navigation to /onboarding/call is a fallback
 *               screen shown if callkit doesn't take over fast enough.
 * "text"     -> /onboarding/letter (text fallback path)
 */
export default function Fork() {
  const router = useRouter();
  const { user } = useUser();
  const { getToken } = useAuth();
  const firstName = user?.firstName ?? "you";
  const [ringing, setRinging] = useState(false);

  async function onRingMe() {
    if (ringing) return;
    const deviceToken = getDeviceToken();
    if (!deviceToken) {
      Alert.alert(
        "voip not ready yet",
        "the app hasn't registered with apple's push service yet. wait a few seconds and try again.",
      );
      return;
    }
    setRinging(true);
    try {
      await api("/api/mobile/call/start", {
        method: "POST",
        body: { deviceToken },
        getToken,
      });
      // callkit overlays this screen within ~1-2s. navigate to the placeholder
      // so we have somewhere to be when the user dismisses the native call ui.
      router.push("/onboarding/call");
    } catch (err) {
      Alert.alert("couldn't ring you", String(err));
    } finally {
      setRinging(false);
    }
  }

  return (
    <OnboardingShell
      eyebrow="say hi"
      title={`hi, ${firstName}. mind if i ring you?`}
      body="this is the only call. promise."
      primaryLabel={ringing ? "ringing" : "ring me"}
      onPrimary={onRingMe}
      secondaryLabel="let's type instead"
      onSecondary={() => router.push("/onboarding/letter")}
    />
  );
}
