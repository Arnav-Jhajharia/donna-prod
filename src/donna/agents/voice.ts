import type { AgentBundle } from "./types.js";
import { SYSTEM_PROMPT } from "../prompt.js";
import { sdk_tools, tool_handlers, TERMINATORS } from "../tools/index.js";

// donna's voice agent. this is the agent that talks to the user — its tool
// catalog is voice-shaped (terminates on send_burst) and its prompt holds the
// voice rules. for now it just composes the existing module-level constants;
// when voice grows its own dedicated tool set, those move under agents/voice/.
export const voiceBundle: AgentBundle = {
  name: "donna.voice",
  systemPrompt: SYSTEM_PROMPT,
  tools: sdk_tools,
  handlers: tool_handlers,
  terminators: TERMINATORS,
};
