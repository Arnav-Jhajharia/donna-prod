import type { Tool } from "@anthropic-ai/sdk/resources/messages";

export const sendBurstTool: Tool = {
  name: "send_burst",
  description: `the only way to talk to the user. pass an array of strings; each becomes a separate message the user sees. one message is fine. multiple is fine when you have distinct thoughts that should land separately.

when to use:
- always, to talk to the user.

when NOT to use:
- never put reasoning in here. these strings are what the user reads.`,
  input_schema: {
    type: "object",
    properties: {
      messages: {
        type: "array",
        items: { type: "string", minLength: 1 },
        minItems: 1,
        description: "one or more visible messages, in order.",
      },
    },
    required: ["messages"],
  },
};

export async function sendBurstHandler(input: unknown): Promise<string> {
  const obj = (input ?? {}) as { messages?: unknown };
  const messages = Array.isArray(obj.messages) ? obj.messages : [];
  return `sent ${messages.length} message(s).`;
}
