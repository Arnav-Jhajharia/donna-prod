import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  ContentBlock,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import { tool_definitions, tool_handlers } from "./tools/index.js";
import { SYSTEM_PROMPT } from "./prompt.js";

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 2048;
const MAX_LOOP_ITERATIONS = 10;

export type BrainMode = "reactive" | "proactive" | "proactive_tier3";

export interface RunTurnArgs {
  mode: BrainMode;
  messages: MessageParam[];
  userInput: string;
}

export interface RunTurnResult {
  messages: MessageParam[];
  reply: string;
}

const client = new Anthropic();

export async function runTurn({
  mode,
  messages,
  userInput,
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
  let finalContent: ContentBlock[] = [];

  while (iterations < MAX_LOOP_ITERATIONS) {
    iterations++;

    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: tool_definitions,
      messages: working,
    });

    working.push({ role: "assistant", content: resp.content });
    finalContent = resp.content;

    if (resp.stop_reason !== "tool_use") {
      break;
    }

    const toolResults: ToolResultBlockParam[] = [];
    for (const block of resp.content) {
      if (block.type !== "tool_use") continue;

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
  }

  if (iterations >= MAX_LOOP_ITERATIONS) {
    console.warn(
      `[brain] hit max iterations (${MAX_LOOP_ITERATIONS}) — returning last text`,
    );
  }

  const reply = finalContent
    .filter(
      (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text",
    )
    .map((b) => b.text)
    .join("\n")
    .trim();

  return { messages: working, reply };
}
