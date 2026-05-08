import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../brain.js";

export const doNothingTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "do_nothing",
  description: `you considered the cause and decided silence is right. terminator.

call when:
- the cause is stale (user already addressed it in recent chat).
- there is no specific signal worth interrupting for.
- the wake-up was redundant.

provide a one-line reason for telemetry. the reason is never shown to the user.`,
  input_schema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        minLength: 1,
        description: "short reason for the silent skip (logged, not user-facing).",
      },
    },
    required: ["reason"],
  },
  modes: new Set<BrainMode>(["proactive"]),
};

export async function doNothingHandler(input: unknown): Promise<string> {
  const obj = (input ?? {}) as { reason?: unknown };
  const reason = typeof obj.reason === "string" ? obj.reason : "(no reason given)";
  return `acknowledged: ${reason.slice(0, 200)}`;
}
