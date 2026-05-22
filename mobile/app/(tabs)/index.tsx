import { useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ChatBubble, type ChatRole } from "@/components/ChatBubble";
import { ChatComposer } from "@/components/ChatComposer";
import { useTheme } from "@/design";

type Message = { id: string; role: ChatRole; text: string };

const SEED: Message[] = [
  { id: "1", role: "donna", text: "good morning, bharat." },
  {
    id: "2",
    role: "donna",
    text: "three things since we last spoke. anika hasn't replied to your coffee message in six days. you said you'd work out today, yesterday landed at 2,400 cal against a 2,200 budget. rent goes out tomorrow.",
  },
  { id: "3", role: "donna", text: "want me to draft anika's reply?" },
];

function cannedReply(input: string): string {
  const t = input.toLowerCase().trim();
  if (/^(yes|yeah|yep|sure|ok|okay|do it)$/.test(t)) {
    return "good. drafting now. one minute.";
  }
  if (/^(no|nah|nope|not now)$/.test(t)) {
    return "okay. i'll leave it.";
  }
  if (/(hi|hey|hello)/i.test(t)) {
    return "hi.";
  }
  if (/(thanks|thank you|ty)/.test(t)) {
    return "of course.";
  }
  if (/\?$/.test(t)) {
    return "i'll think about that and come back to you.";
  }
  return "noted.";
}

export default function Live() {
  const { roles, type, space } = useTheme();
  const [messages, setMessages] = useState<Message[]>(SEED);
  const [input, setInput] = useState("");
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    const t = setTimeout(
      () => scrollRef.current?.scrollToEnd({ animated: true }),
      80,
    );
    return () => clearTimeout(t);
  }, [messages.length]);

  function send() {
    const text = input.trim();
    if (!text) return;
    setInput("");
    setMessages((prev) => [
      ...prev,
      { id: String(Date.now()), role: "user", text },
    ]);
    setTimeout(() => {
      setMessages((prev) => [
        ...prev,
        {
          id: String(Date.now() + 1),
          role: "donna",
          text: cannedReply(text),
        },
      ]);
    }, 700);
  }

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: roles.bg.canvas }}
      edges={["top"]}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <View
          style={{
            paddingHorizontal: space[5],
            paddingTop: space[5],
            paddingBottom: space[3],
            gap: space[1],
          }}
        >
          <Text style={[type.eyebrow, { color: roles.fg.muted }]}>
            thursday · may 21 · brief
          </Text>
          <Text style={[type.h3, { color: roles.fg.primary }]}>this morning</Text>
        </View>
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={{
            paddingHorizontal: space[5],
            paddingBottom: space[4],
            gap: space[2],
          }}
          keyboardShouldPersistTaps="handled"
        >
          {messages.map((m) => (
            <ChatBubble key={m.id} role={m.role} text={m.text} />
          ))}
        </ScrollView>
        <ChatComposer value={input} onChangeText={setInput} onSend={send} />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
