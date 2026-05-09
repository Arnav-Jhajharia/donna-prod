import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  ContentBlock,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import { tool_definitions, tool_handlers, TERMINATORS } from "./tools/index.js";
import { SYSTEM_PROMPT } from "./prompt.js";

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 2048;
const MAX_LOOP_ITERATIONS = 10;
const CAP_HIT_FALLBACK = "sorry, got stuck in a loop. try again.";

export type BrainMode = "reactive" | "proactive" | "proactive_tier3";
export type TerminatorReason = "send_burst" | "cap_hit";

export interface RunTurnArgs {
  mode: BrainMode;
  messages: MessageParam[];
  userInput: string;
  memoryContext?: string;
}

export interface RunTurnResult {
  messages: MessageParam[];      // full updated history (including userInput + everything added this turn)
  newMessages: MessageParam[];   // just the messages added this turn (for persistence)
  sends: string[];               // visible sends emitted this turn (cap_hit fallback if loop exhausted)
  terminator: TerminatorReason;
}

const client = new Anthropic();

function extractSends(content: ContentBlock[]): string[] {
  for (const block of content) {
    if (block.type === "tool_use" && block.name === "send_burst") {
      const input = block.input as { messages?: unknown };
      if (Array.isArray(input.messages)) {
        return input.messages.filter((s): s is string => typeof s === "string");
      }
    }
  }
  return [];
}

export async function runTurn({
  mode,
  messages,
  userInput,
  memoryContext,
}: RunTurnArgs): Promise<RunTurnResult> {
  if (mode !== "reactive") {
    throw new Error(`brain mode '${mode}' not implemented yet`);
  }

  // never mutate the caller's messages array. work on a fresh copy.
  const working: MessageParam[] = [
    ...messages,
    { role: "user", content: userInput },
  ];

  let iterations = 0;
  let terminatorHit = false;
  let lastAssistantContent: ContentBlock[] = [];

  while (iterations < MAX_LOOP_ITERATIONS) {
    iterations++;

    const system = [
      {
        type: "text" as const,
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" as const },
      },
    ];
    if (memoryContext?.trim()) {
      system.push({
        type: "text" as const,
        text: `memory_context:\n${memoryContext.trim()}`,
        cache_control: { type: "ephemeral" as const },
      });
    }

    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      tools: tool_definitions,
      messages: working,
    });

    working.push({ role: "assistant", content: resp.content });
    lastAssistantContent = resp.content;

    if (resp.stop_reason !== "tool_use") {
      // model produced text without calling a terminator. break and let the
      // post-loop logic decide between fallback and (no-op) extracted sends.
      break;
    }

    const toolResults: ToolResultBlockParam[] = [];
    let sawTerminator = false;

    for (const block of resp.content) {
      if (block.type !== "tool_use") continue;

      if (TERMINATORS.has(block.name)) sawTerminator = true;

      const handler = tool_handlers[block.name];
      if (!handler) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `error: unknown tool '${block.name}'`,
          is_error: true,
        });
        continue;
      }

      try {
        const output = await handler(block.input);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content:
            typeof output === "string" ? output : JSON.stringify(output),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `error: ${msg}`,
          is_error: true,
        });
      }
    }

    working.push({ role: "user", content: toolResults });

    if (sawTerminator) {
      terminatorHit = true;
      break;
    }
  }

  let sends: string[];
  let terminator: TerminatorReason;

  if (terminatorHit) {
    sends = extractSends(lastAssistantContent);
    if (sends.length === 0) {
      console.warn("[brain] send_burst called with empty messages array");
      sends = [CAP_HIT_FALLBACK];
      terminator = "cap_hit";
    } else {
      terminator = "send_burst";
    }
  } else {
    console.warn(
      `[brain] hit max iterations (${MAX_LOOP_ITERATIONS}) without terminator`,
    );
    sends = [CAP_HIT_FALLBACK];
    terminator = "cap_hit";
  }

  const newMessages = working.slice(messages.length);

  return { messages: working, newMessages, sends, terminator };
}
