const BANNED_PHRASES = [
  "I understand",
  "Great question",
  "AI assistant",
  "I'm here to help",
] as const;

const BANNED_PATTERNS = BANNED_PHRASES.map(
  (phrase) => new RegExp(`\\b${escapeRegExp(phrase)}\\b[\\s,.!:;-]*`, "gi"),
);
const EM_DASH = /\s*[—–]\s*/g;
const SEMICOLON = /\s*;\s*/g;
const MULTI_SPACE = /[ \t]{2,}/g;
const SENTENCE_START = /(^|(?<=[.!?]\s))([A-Z])/g;

export interface VoiceFilterResult {
  text: string;
  violations: string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function filterText(input: string): VoiceFilterResult {
  if (!input) return { text: "", violations: [] };

  const violations: string[] = [];
  let text = input;

  for (const pattern of BANNED_PATTERNS) {
    if (pattern.test(text)) {
      violations.push("banned_phrase");
      text = text.replace(pattern, "");
    }
    pattern.lastIndex = 0;
  }

  if (EM_DASH.test(text)) {
    violations.push("em_dash");
    text = text.replace(EM_DASH, ", ");
  }
  EM_DASH.lastIndex = 0;

  if (SEMICOLON.test(text)) {
    violations.push("semicolon");
    text = text.replace(SEMICOLON, ". ");
  }
  SEMICOLON.lastIndex = 0;

  const lowered = text.replace(
    SENTENCE_START,
    (_match, prefix: string, letter: string) => `${prefix}${letter.toLowerCase()}`,
  );
  if (lowered !== text) {
    violations.push("uppercase_sentence_start");
    text = lowered;
  }

  text = text.replace(MULTI_SPACE, " ").trim();
  return { text, violations };
}

export function filterSends(messages: string[]): {
  messages: string[];
  violations: string[];
} {
  const violations: string[] = [];
  const filtered = messages.map((message) => {
    const result = filterText(message);
    violations.push(...result.violations);
    return result.text;
  });
  return { messages: filtered, violations };
}
