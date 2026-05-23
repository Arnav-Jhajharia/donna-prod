import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { addTrigger } from "../triggers/store.js";
import { schedule } from "../triggers/runtime.js";

// silent tool. donna may acknowledge in voice ("got it, i'll nudge you at 4")
// but never says "i'm creating a trigger" — the mechanism stays invisible.
export const createTriggerTool: Tool = {
  name: "create_trigger",
  description: `plant a future instruction for yourself. when fireAt arrives, the loop runs again with \`action\` as its input.

use when the user asks to be reminded, nudged, followed-up with, or anything time-deferred. also use when you decide to follow up on your own initiative — donna acts before asked.

do NOT use for things that should happen now (just do them). event-condition triggers (e.g. "when sarah emails") come later.

write \`action\` as detailed as a user message — your future-self has no context except what you put in this field. include any ids, names, or specifics needed to complete the task.

never tell the user "i'm creating a trigger." acknowledge in voice and move on.`,
  input_schema: {
    type: "object",
    properties: {
      fire_at: {
        type: "string",
        description:
          "ISO 8601 timestamp when the trigger should fire (e.g. '2026-05-22T16:23:00Z').",
      },
      action: {
        type: "string",
        description:
          "natural-language instruction for future-donna. as detailed as a user message would be.",
      },
    },
    required: ["fire_at", "action"],
  },
};

interface CreateTriggerInput {
  fire_at: string;
  action: string;
}

export async function createTriggerHandler(input: unknown): Promise<string> {
  const { fire_at, action } = (input ?? {}) as CreateTriggerInput;
  const t = addTrigger({ fireAt: fire_at, action });
  // hand the timer to the runtime. without this the trigger sits in the store
  // forever — adding to store is data, scheduling is behavior.
  schedule(t);
  return JSON.stringify({ id: t.id, fireAt: t.fireAt, status: t.status });
}
