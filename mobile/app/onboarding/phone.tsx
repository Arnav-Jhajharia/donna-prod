import { useEffect } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { OnboardingShell } from "@/components/OnboardingShell";
import { useTheme } from "@/design";
import { usePairing } from "@/lib/usePairing";

// the pairing dance. on mount we ask the server for a short code, then
// instruct the user to text it to donna's whatsapp number. backend's
// webhook matches the code -> stores the phone on the clerk user. we poll
// status and auto-advance when linked.
export default function Phone() {
  const router = useRouter();
  const { roles, type, space } = useTheme();
  const { code, whatsappNumber, status, error, start } = usePairing();

  useEffect(() => {
    start();
  }, [start]);

  useEffect(() => {
    if (status === "linked") {
      const t = setTimeout(() => router.push("/onboarding/handoff"), 800);
      return () => clearTimeout(t);
    }
  }, [status, router]);

  const openWhatsApp = () => {
    if (!whatsappNumber || !code) return;
    // wa.me uses the digits-only form. prefilling the text means the user
    // taps once to compose, once to send.
    const digits = whatsappNumber.replace(/[^\d]/g, "");
    const url = `https://wa.me/${digits}?text=${encodeURIComponent(code)}`;
    Linking.openURL(url).catch(() => {});
  };

  return (
    <OnboardingShell
      eyebrow="i live elsewhere too"
      title="text me on whatsapp."
      body={
        status === "linked"
          ? "linked. one less thing to remember."
          : "send me this code from your phone. i'll know it's you."
      }
      primaryLabel={status === "linked" ? "continue" : "open whatsapp"}
      onPrimary={
        status === "linked"
          ? () => router.push("/onboarding/handoff")
          : openWhatsApp
      }
      primaryDisabled={!code || !whatsappNumber}
    >
      <View style={{ gap: space[5] }}>
        <View
          style={{
            backgroundColor: roles.bg.surface,
            borderRadius: 12,
            padding: space[5],
            alignItems: "center",
            gap: space[2],
          }}
        >
          <Text style={[type.eyebrow, { color: roles.fg.muted }]}>
            your code
          </Text>
          <Text
            style={[
              type.h1,
              {
                color: roles.fg.primary,
                letterSpacing: 6,
                fontVariant: ["tabular-nums"],
              },
            ]}
          >
            {code ?? "······"}
          </Text>
          {whatsappNumber ? (
            <Text style={[type.body, { color: roles.fg.secondary }]}>
              send to {whatsappNumber}
            </Text>
          ) : null}
        </View>

        {status === "pending" && code ? (
          <Pressable onPress={openWhatsApp} hitSlop={8}>
            <Text
              style={[
                type.body,
                { color: roles.fg.muted, textAlign: "center" },
              ]}
            >
              waiting for your message…
            </Text>
          </Pressable>
        ) : null}

        {status === "error" && error ? (
          <Text
            style={[
              type.body,
              { color: roles.fg.muted, textAlign: "center" },
            ]}
          >
            something went wrong. {error}
          </Text>
        ) : null}
      </View>
    </OnboardingShell>
  );
}
