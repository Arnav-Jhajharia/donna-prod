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

// the LAST tool definition gets cache_control: ephemeral so the entire tools
// block participates in prompt caching (anthropic api caches up-to-and-including
// the marked block). when a tool is added, move the cache_control marker to that
// new last entry.
export const tool_definitions: ToolWithCache[] = [
  getCurrentTimeTool,
  { ...sendBurstTool, cache_control: { type: "ephemeral" } },
];

export const tool_handlers: Record<
  string,
  (input: unknown) => Promise<unknown>
> = {
  get_current_time: getCurrentTimeHandler,
  send_burst: sendBurstHandler,
};

export const TERMINATORS = new Set<string>(["send_burst"]);
