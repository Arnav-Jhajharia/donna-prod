import type { MessageCreateParams } from "@anthropic-ai/sdk/resources/messages";

// an agent bundle is a "role" expressed as data: the prompt, the tools the
// model can call, the handlers that run them, and which of those tools end
// the turn. brain.ts is role-agnostic — it takes a bundle and runs the loop.
//
// today there is one bundle: voice (donna talking to the user). when we add
// executor threads or specialist sub-agents, each is just another bundle.
export interface AgentBundle {
  // grep-able name. stamped onto traces and logs so we know which agent ran.
  name: string;
  // the system prompt sent to the model. caller may still append a per-turn
  // overlay via TurnConfig.systemOverlay.
  systemPrompt: string;
  // tool definitions in the SDK-typed shape. fed straight into buildPayload.
  tools: MessageCreateParams["tools"];
  // map of tool name → handler. brain.ts dispatches into this when the model
  // emits a tool_use block.
  handlers: Record<string, (input: unknown) => Promise<unknown>>;
  // names of tools that end the turn. brain.ts still runs the handler (to
  // keep the conversation well-formed), then returns.
  terminators: Set<string>;
}
