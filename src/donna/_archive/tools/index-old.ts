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

type ToolWithCache = Tool & {
  cache_control?: CacheControlEphemeral | null;
};

export type ToolWithModes = ToolWithCache & {
  modes: ReadonlySet<BrainMode>;
};

export const codeExecutionTool: CodeExecutionTool20250825 = {
  type: "code_execution_20250825",
  name: "code_execution",
};

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
  sendBurstTool,
  doNothingTool,
  deferTool,
  createScheduleTool,
];

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
  do_nothing: doNothingHandler,
  defer: deferHandler,
  create_schedule: createScheduleHandler,
};

export const TERMINATORS = new Set<string>(["send_burst", "do_nothing", "defer"]);

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

function stripInternalFields(
  t: ToolWithModes | CodeExecutionTool20250825,
): ToolWithCache | CodeExecutionTool20250825 {
  if (isCodeExecutionTool(t)) return t;
  const { modes: _modes, ...rest } = t;
  return rest;
}

export function selectToolsForMode(
  mode: BrainMode,
): Array<ToolWithCache | CodeExecutionTool20250825> {
  return tool_definitions
    .filter((t) => {
      if (isCodeExecutionTool(t)) return true;
      return t.modes.has(mode);
    })
    .map(stripInternalFields);
}
