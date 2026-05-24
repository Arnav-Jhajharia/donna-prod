import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { listTriggers } from "../triggers/store.js";
import { userId } from "../context.js";

// silent read tool. used to find ids for cancellation, or to answer "what
// reminders do i have" — the data feeds donna's voice, not a user-visible
// listing of internal records.
export const listTriggersTool: Tool = {
  name: "list_triggers",
  description: `return all triggers (pending, fired, cancelled), newest-first.

use when the user asks about their reminders / what's scheduled, or when you need a trigger's id to cancel it.

do not announce the call — the result is yours to read, not to dump to the user.`,
  input_schema: {
    type: "object",
    properties: {},
  },
};

export async function listTriggersHandler(_input: unknown): Promise<string> {
  return JSON.stringify(await listTriggers(userId()));
}
