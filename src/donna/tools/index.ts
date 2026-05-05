import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { CacheControlEphemeral } from "@anthropic-ai/sdk/resources/index.js";
import { getCurrentTimeTool, getCurrentTimeHandler } from "./time.js";

// Tool already carries cache_control?: CacheControlEphemeral | null | undefined.
// We alias it here to make the intent explicit without narrowing out null (which
// would create an incompatible intersection).
type ToolWithCache = Tool & {
  cache_control?: CacheControlEphemeral | null;
};

const tools: ToolWithCache[] = [getCurrentTimeTool];

// mark the LAST tool definition with cache_control: ephemeral.
// per anthropic docs, this caches the entire tools block up to and
// including this tool. as we add tools, the cache_control assignment
// stays on the last entry — this loop keeps it correct.
const lastIdx = tools.length - 1;
tools[lastIdx] = {
  ...tools[lastIdx]!,
  cache_control: { type: "ephemeral" },
};

export const tool_definitions: ToolWithCache[] = tools;

export const tool_handlers: Record<
  string,
  (input: unknown) => Promise<unknown>
> = {
  get_current_time: getCurrentTimeHandler,
};
