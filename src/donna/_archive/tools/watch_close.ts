// watch_close — terminator only available inside a watch thread. closes the
// watch (and its backing thread). prevents further firings.
//
// the handler itself is a no-op for the brain loop: the runner branches on the
// terminator name after the loop and does the actual close. we return a string
// so the tool_result is well-formed.

import type { Tool } from "@anthropic-ai/sdk/resources/messages";

interface WatchCloseInput {
  reason?: string;
}

export const watchCloseTool: Tool = {
  name: "watch_close",
  description: `terminate this watch. use when:
- the condition the watch was for has resolved (the PR merged, the trip passed, the user logged the calories)
- the user clearly asked you to stop pinging about this

provide a short reason. no further firings will happen.`,
  input_schema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description: "one short sentence explaining why you're closing the watch.",
      },
    },
  },
};

export async function watchCloseHandler(input: unknown): Promise<string> {
  const { reason } = (input ?? {}) as WatchCloseInput;
  return `watch_close acknowledged (reason: ${reason ?? "unspecified"})`;
}
