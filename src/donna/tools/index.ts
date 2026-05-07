import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { CacheControlEphemeral } from "@anthropic-ai/sdk/resources/index.js";
import { getCurrentTimeTool, getCurrentTimeHandler } from "./time.js";
import { sendBurstTool, sendBurstHandler } from "./send_burst.js";

// Tool already carries cache_control?: CacheControlEphemeral | null | undefined.
// We alias it here to make the intent explicit without narrowing out null (which
// would create an incompatible intersection).
type ToolWithCache = Tool & {
  cache_control?: CacheControlEphemeral | null;
};

// no cache_control here. the system block in brain.ts carries cache_control,
// which (per anthropic prefix-match rules) caches tools + system together —
// a strict superset of what a tool-level breakpoint would cover. brain.ts
// also adds a message-level breakpoint per turn, which is where the real
// caching win lives once the conversation prefix exceeds the model's
// minimum cacheable size (2048 tokens on sonnet 4.6).
export const tool_definitions: ToolWithCache[] = [
  getCurrentTimeTool,
  sendBurstTool,
];

export const tool_handlers: Record<
  string,
  (input: unknown) => Promise<unknown>
> = {
  get_current_time: getCurrentTimeHandler,
  send_burst: sendBurstHandler,
};

export const TERMINATORS = new Set<string>(["send_burst"]);
