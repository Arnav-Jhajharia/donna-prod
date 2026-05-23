import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { cancelTrigger } from "../triggers/store.js";
import { unschedule } from "../triggers/runtime.js";

// silent tool. cancels a pending trigger by id. result tells you whether
// anything was actually cancelled — for self-cancelling pairs (the jony
// pattern) it's normal for one half to be a no-op on the other half having
// already fired.
export const cancelTriggerTool: Tool = {
  name: "cancel_trigger",
  description: `cancel a pending trigger by id. returns true if it was pending and is now cancelled, false if it had already fired / been cancelled / doesn't exist.

use when the user says "never mind, don't remind me about X" — first list_triggers to find the id, then cancel.

also use inside a trigger's own action when forming self-cancelling pairs (e.g. one trigger cancels its partner once it has acted).

never announce; acknowledge in voice if the user requested the cancel.`,
  input_schema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "the trigger id from create_trigger or list_triggers.",
      },
    },
    required: ["id"],
  },
};

interface CancelTriggerInput {
  id: string;
}

export async function cancelTriggerHandler(input: unknown): Promise<string> {
  const { id } = (input ?? {}) as CancelTriggerInput;
  const ok = cancelTrigger(id);
  // tear down the timer too. order is store-first so we never have a live
  // setTimeout for a status that says cancelled.
  if (ok) unschedule(id);
  return JSON.stringify({ id, cancelled: ok });
}
