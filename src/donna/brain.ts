import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  ContentBlock,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import { wrapAnthropic } from "langsmith/wrappers/anthropic";
import { traceable } from "langsmith/traceable";
import { tool_definitions, tool_handlers, TERMINATORS } from "./tools/index.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { filterSends } from "./voice_filter.js";
import { recordExecutionEvent } from "./observability/execution.js";

export const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 2048;
const MAX_LOOP_ITERATIONS = 10;
const CAP_HIT_FALLBACK = "sorry, got stuck in a loop. try again.";

export type BrainMode = "reactive" | "proactive" | "proactive_tier3";
export type TerminatorReason = "send_burst" | "cap_hit";

export interface RunTurnArgs {
  mode: BrainMode;
  messages: MessageParam[];
  userInput: string;
  runId?: string | null;
}

export interface RunTurnResult {
  messages: MessageParam[];      // full updated history (including userInput + everything added this turn)
  newMessages: MessageParam[];   // just the messages added this turn (for persistence)
  sends: string[];               // visible sends emitted this turn (cap_hit fallback if loop exhausted)
  terminator: TerminatorReason;
  voiceViolations: string[];
  model: string;
  iterations: number;
}

// wrapAnthropic auto-traces every messages.create call when LANGSMITH_TRACING=true.
// no-ops cleanly when tracing is off — same client, no overhead.
const client = wrapAnthropic(new Anthropic());

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

async function _runTurn({
  mode,
  messages,
  userInput,
  runId = null,
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

    await recordExecutionEvent(runId, "model_start", "anthropic.messages.create", {
      iteration: iterations,
      model: MODEL,
      message_count: working.length,
      tool_count: tool_definitions.length,
    });
    const modelStartedAt = Date.now();
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
    await recordExecutionEvent(runId, "model_end", "anthropic.messages.create", {
      iteration: iterations,
      stop_reason: resp.stop_reason,
      duration_ms: Date.now() - modelStartedAt,
      input_tokens: resp.usage.input_tokens,
      output_tokens: resp.usage.output_tokens,
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
        await recordExecutionEvent(runId, "tool_error", block.name, {
          tool_use_id: block.id,
          error: "unknown_tool",
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `error: unknown tool '${block.name}'`,
          is_error: true,
        });
        continue;
      }

      try {
        await recordExecutionEvent(runId, "tool_start", block.name, {
          tool_use_id: block.id,
          input: block.input,
          terminator: TERMINATORS.has(block.name),
        });
        const toolStartedAt = Date.now();
        const output = await handler(block.input);
        await recordExecutionEvent(runId, "tool_end", block.name, {
          tool_use_id: block.id,
          duration_ms: Date.now() - toolStartedAt,
          output_preview:
            typeof output === "string"
              ? output.slice(0, 500)
              : JSON.stringify(output).slice(0, 500),
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content:
            typeof output === "string" ? output : JSON.stringify(output),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await recordExecutionEvent(runId, "tool_error", block.name, {
          tool_use_id: block.id,
          error: msg,
        });
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
  let voiceViolations: string[] = [];

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

  const filtered = filterSends(sends);
  sends = filtered.messages;
  voiceViolations = filtered.violations;
  if (voiceViolations.length > 0) {
    console.warn(`[brain] voice filter repaired: ${voiceViolations.join(",")}`);
  }

  const newMessages = working.slice(messages.length);

  return {
    messages: working,
    newMessages,
    sends,
    terminator,
    voiceViolations,
    model: MODEL,
    iterations,
  };
}

// public entry point. langsmith parent trace per turn — children are the LLM
// calls (auto-traced via wrapAnthropic). callers may pass a RunnableConfigLike
// as a first arg to attach metadata/tags (server.ts uses this for user_id +
// phone). when LANGSMITH_TRACING is unset, the wrapper is a pass-through.
export const runTurn = traceable(_runTurn, {
  name: "runTurn",
  run_type: "chain",
});
