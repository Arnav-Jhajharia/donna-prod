import type { Tool, MessageCreateParams } from "@anthropic-ai/sdk/resources/messages";
import { getCurrentTimeTool, getCurrentTimeHandler } from "./time.js";
import { sendBurstTool, sendBurstHandler } from "./send_burst.js";

// the single registry of tools the model can call. add a new tool by:
// 1. defining its `Tool` + handler in its own file under tools/
// 2. importing + registering it in both arrays below
// 3. if it's a terminator (ends the turn), adding it to TERMINATORS
export const tool_definitions: Tool[] = [
  getCurrentTimeTool,
  sendBurstTool,
];

// the SDK type for `tools` on a MessageCreateParams call. we cast here so the
// brain doesn't have to.
export const sdk_tools = tool_definitions as MessageCreateParams["tools"];

// map of tool name → handler. brain.ts looks tools up here when the model
// emits a tool_use block.
export const tool_handlers: Record<
  string,
  (input: unknown) => Promise<unknown>
> = {
  get_current_time: getCurrentTimeHandler,
  send_burst: sendBurstHandler,
};

// terminators end the turn. brain.ts still runs the handler (to record a
// tool_result, keeping the conversation well-formed for next turn), then
// returns. for now, send_burst is the only terminator.
export const TERMINATORS = new Set<string>(["send_burst"]);
