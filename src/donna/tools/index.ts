import type {
  Tool,
  CodeExecutionTool20250825,
  MessageCreateParams,
} from "@anthropic-ai/sdk/resources/messages";
import type { CacheControlEphemeral } from "@anthropic-ai/sdk/resources/index.js";
import type { BrainMode } from "../brain.js";
import { getCurrentTimeTool, getCurrentTimeHandler } from "./time.js";
import { sendBurstTool, sendBurstHandler } from "./send_burst.js";
import {
  gmailListRecentTool,
  gmailListRecentHandler,
  gmailSearchTool,
  gmailSearchHandler,
  gmailListSentTool,
  gmailListSentHandler,
  gmailReadThreadTool,
  gmailReadThreadHandler,
} from "./gmail.js";
import {
  integrationStatusTool,
  integrationStatusHandler,
  integrationConnectTool,
  integrationConnectHandler,
  integrationSetModeTool,
  integrationSetModeHandler,
  integrationDisconnectTool,
  integrationDisconnectHandler,
} from "./integrations.js";
import { doNothingTool, doNothingHandler } from "./do_nothing.js";
import { deferTool, deferHandler } from "./defer.js";
import { createScheduleTool, createScheduleHandler } from "./create_schedule.js";
import { recallTool, recallHandler } from "./recall.js";

// Tool already carries cache_control?: CacheControlEphemeral | null | undefined.
// We alias it here to make the intent explicit without narrowing out null (which
// would create an incompatible intersection).
type ToolWithCache = Tool & {
  cache_control?: CacheControlEphemeral | null;
};

export type ToolWithModes = ToolWithCache & {
  modes: ReadonlySet<BrainMode>;
};

// the code_execution server tool. anthropic runs the python sandbox; we only
// see (a) the python claude wrote, (b) any tool_use blocks our handlers must
// answer (now carrying a `caller` field), (c) the final stdout.
//
// tools opted into PTC declare `allowed_callers: ["code_execution_20250825"]`.
// send_burst and the time tool stay direct-only — terminator and single-shot.
export const codeExecutionTool: CodeExecutionTool20250825 = {
  type: "code_execution_20250825",
  name: "code_execution",
};

// no cache_control here. the system block in brain.ts carries cache_control,
// which (per anthropic prefix-match rules) caches tools + system together —
// a strict superset of what a tool-level breakpoint would cover. brain.ts
// also adds a message-level breakpoint per turn, which is where the real
// caching win lives once the conversation prefix exceeds the model's
// minimum cacheable size (2048 tokens on sonnet 4.6).
export const tool_definitions: Array<ToolWithModes | CodeExecutionTool20250825> = [
  codeExecutionTool,
  getCurrentTimeTool,
  gmailListRecentTool,
  gmailSearchTool,
  gmailListSentTool,
  gmailReadThreadTool,
  integrationStatusTool,
  integrationConnectTool,
  integrationSetModeTool,
  integrationDisconnectTool,
  recallTool,
  sendBurstTool,
  doNothingTool,
  deferTool,
  createScheduleTool,
];

// satisfy MessageCreateParams["tools"] (which is a union including the server
// tool variants). this cast is the cleanest way to keep our local inferred
// type while staying compatible with the SDK.
export const sdk_tools = tool_definitions as MessageCreateParams["tools"];

export const tool_handlers: Record<
  string,
  (input: unknown) => Promise<unknown>
> = {
  get_current_time: getCurrentTimeHandler,
  send_burst: sendBurstHandler,
  gmail_list_recent: gmailListRecentHandler,
  gmail_search: gmailSearchHandler,
  gmail_list_sent: gmailListSentHandler,
  gmail_read_thread: gmailReadThreadHandler,
  integration_status: integrationStatusHandler,
  integration_connect: integrationConnectHandler,
  integration_set_mode: integrationSetModeHandler,
  integration_disconnect: integrationDisconnectHandler,
  recall: recallHandler,
  do_nothing: doNothingHandler,
  defer: deferHandler,
  create_schedule: createScheduleHandler,
};

export const TERMINATORS = new Set<string>(["send_burst", "do_nothing", "defer"]);

// names of tools opted into PTC. used by the brain to tag observability
// events so we can split direct vs ptc-driven invocations in metrics.
export const PTC_ELIGIBLE = new Set<string>([
  "gmail_list_recent",
  "gmail_search",
  "gmail_list_sent",
  "gmail_read_thread",
]);

function isCodeExecutionTool(
  t: ToolWithModes | CodeExecutionTool20250825,
): t is CodeExecutionTool20250825 {
  return "type" in t && typeof t.type === "string" && t.type.startsWith("code_execution");
}

export function selectToolsForMode(
  mode: BrainMode,
): Array<ToolWithModes | CodeExecutionTool20250825> {
  return tool_definitions.filter((t) => {
    if (isCodeExecutionTool(t)) return true;
    return t.modes.has(mode);
  });
}
