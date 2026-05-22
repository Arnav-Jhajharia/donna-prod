import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlock,
  MessageCreateParamsNonStreaming,
  MessageParam,
  ToolResultBlockParam,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages";
import { randomUUID } from "node:crypto";
import { wrapAnthropic } from "langsmith/wrappers/anthropic";
import { traceable, getCurrentRunTree } from "langsmith/traceable";
import { sdk_tools, tool_handlers, TERMINATORS } from "./tools/index.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { extractMessages } from "./tools/send_burst.js";
import type { OutboundMessage } from "./messages.js";
import { startLedger } from "./ledger.js";

export const DEFAULT_MODEL = "claude-sonnet-4-6";
export const DEFAULT_MAX_TOKENS = 2048;
export const MAX_ITERATIONS = 10;

// wrapAnthropic adds a langsmith span per `messages.create`. when
// LANGSMITH_TRACING is unset it's a no-op passthrough — safe to leave on.
const client = wrapAnthropic(new Anthropic());

// per-turn overrides. when a field is omitted the default above applies.
// granular control means the caller decides these, not a module-level constant.
export interface TurnConfig {
  model?: string;
  maxTokens?: number;
  // appended to SYSTEM_PROMPT for this turn only — useful for mode switches
  // (reactive vs proactive) and one-off steering.
  systemOverlay?: string;
  // identity stamped onto the langsmith parent trace as metadata. when set,
  // the langsmith UI can filter "show every turn for this user / thread."
  // unset → the trace is anonymous; nothing else in the loop depends on these.
  userId?: string;
  threadId?: string;
}

export interface RunTurnResult {
  // outbound items to deliver to the user (from send_burst). empty if no burst.
  // heterogeneous: text, buttons, list, cta_url, image, document, video,
  // audio, delay — any order, any mix. the caller (cli, whatsapp, mobile)
  // renders each one for its channel.
  sends: OutboundMessage[];
  // the tool that ended the turn, or null if we hit MAX_ITERATIONS.
  terminator: string | null;
  // every new message added this turn (assistant blocks + user tool_result
  // blocks). caller appends to its persisted history. assistant content has
  // been filtered (see filterAssistantContent).
  newMessages: MessageParam[];
  // grep-able id; ties together every event the ledger wrote for this turn.
  runId: string;
}

// ---------- pipeline steps (each independently testable) ----------

// step: build the exact payload that would be sent to anthropic this iteration.
// reused by inspect.ts so "what would the model see" is a real function, not
// a guess. when you want to add caching / thinking / tool_choice, change it
// here — one place owns the wire format.
export function buildPayload(
  messages: MessageParam[],
  config: TurnConfig = {},
): MessageCreateParamsNonStreaming {

  const system = config.systemOverlay
    ? `${SYSTEM_PROMPT}\n\n${config.systemOverlay}`
    : SYSTEM_PROMPT;

  // mark the last tool with cache_control: ephemeral. anthropic caches every
  // byte before this breakpoint — the system prompt plus all tool definitions.
  // iteration 0 pays a ~25% write premium on those tokens; every subsequent
  // iteration this turn (and every turn within ~5 min) reads them back at
  // ~10% cost. we don't cache the messages array: it grows each iteration so
  // the breakpoint would move and the write cost wouldn't amortize.
  const tools =
    sdk_tools && sdk_tools.length > 0
      ? [
          ...sdk_tools.slice(0, -1),
          {
            ...sdk_tools[sdk_tools.length - 1]!,
            cache_control: { type: "ephemeral" as const },
          },
        ]
      : sdk_tools;

  return {
    model: config.model ?? DEFAULT_MODEL,
    max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    system,
    tools,
    messages,
  };
}

// step: filter assistant content before persisting. when the model emits text
// alongside tool_use, that text is private reasoning that leaked — persisting
// it poisons future turns (the model sees its own scratch as conversation).
// thinking / redacted_thinking blocks are kept; the api requires us to round-
// trip them and they're already private.
export function filterAssistantContent(
  content: ContentBlock[],
): ContentBlock[] {
  const hasToolUse = content.some((b) => b.type === "tool_use");
  if (!hasToolUse) return content;
  return content.filter((b) => b.type !== "text");
}

// step: run one tool call. handlers throw on error; we convert to is_error
// tool_results so the model can see the failure and recover next iteration.
async function dispatchTool(tu: ToolUseBlock): Promise<ToolResultBlockParam> {
  const handler = tool_handlers[tu.name];
  if (!handler) {
    return {
      type: "tool_result",
      tool_use_id: tu.id,
      content: `unknown tool: ${tu.name}`,
      is_error: true,
    };
  }
  // wrap each handler invocation as a langsmith span named after the tool.
  // wrapping per-call (not at registry-load time) means the span name is the
  // tool name, not a generic "dispatchTool". inert when tracing is off.
  const tracedHandler = traceable(handler, {
    name: tu.name,
    run_type: "tool",
  });
  try {
    const result = await tracedHandler(tu.input);
    return {
      type: "tool_result",
      tool_use_id: tu.id,
      content: typeof result === "string" ? result : JSON.stringify(result),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      type: "tool_result",
      tool_use_id: tu.id,
      content: msg,
      is_error: true,
    };
  }
}

// step: run every tool_use in this iteration sequentially. fan-out parallelism
// belongs inside a dedicated sandbox tool (when ptc returns), not here.
async function dispatchToolCalls(
  toolUses: ToolUseBlock[],
): Promise<ToolResultBlockParam[]> {
  const results: ToolResultBlockParam[] = [];
  for (const tu of toolUses) {
    results.push(await dispatchTool(tu));
  }
  return results;
}

// ---------- the loop, expressed as composition of those steps ----------
//
// each iteration:
// 1. buildPayload  — exact bytes to api
// 2. messages.create
// 3. filterAssistantContent — drop leaked reasoning text
// 4. dispatchToolCalls — run handlers, collect tool_results
// 5. check for terminator → return, else loop
//
// loop caps at MAX_ITERATIONS to avoid runaway tool chains. every step is
// logged to the ledger keyed by runId.
async function _runTurn(
  messages: MessageParam[],
  config: TurnConfig = {},
): Promise<RunTurnResult> {
  const runId = randomUUID();
  const ledger = startLedger(runId, config);

  // stamp identity + runId onto the langsmith parent trace so the UI can
  // filter by user/thread and ledger ↔ trace are cross-referenceable. when
  // tracing is off getCurrentRunTree throws; we ignore — no-op trace.
  try {
    const tree = getCurrentRunTree();
    tree.extra = tree.extra ?? {};
    tree.extra.metadata = {
      ...(tree.extra.metadata ?? {}),
      run_id: runId,
      ...(config.userId ? { user_id: config.userId } : {}),
      ...(config.threadId ? { thread_id: config.threadId } : {}),
    };
  } catch {}

  const convo: MessageParam[] = [...messages];
  const newMessages: MessageParam[] = [];

  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const payload = buildPayload(convo, config);
      ledger.modelCallStart(i, payload);

      const response = await client.messages.create(payload);
      ledger.modelCallEnd(i, response);

      const filtered = filterAssistantContent(response.content);
      const assistantMessage: MessageParam = {
        role: "assistant",
        content: filtered,
      };
      convo.push(assistantMessage);
      newMessages.push(assistantMessage);

      const toolUses = filtered.filter(
        (b): b is ToolUseBlock => b.type === "tool_use",
      );

      // model emitted only text — no tool call. shouldn't happen if the prompt
      // is doing its job (every turn must end with send_burst). bail.
      if (toolUses.length === 0) {
        ledger.finish("no_tool_calls", null, []);
        return { sends: [], terminator: null, newMessages, runId };
      }

      // run every tool call (including terminator). this keeps the conversation
      // well-formed: tool_use blocks always get matching tool_result blocks.
      const toolResults = await dispatchToolCalls(toolUses);
      ledger.toolCalls(toolUses, toolResults);

      const userMessage: MessageParam = {
        role: "user",
        content: toolResults,
      };
      convo.push(userMessage);
      newMessages.push(userMessage);

      const terminator = toolUses.find((tu) => TERMINATORS.has(tu.name));
      if (terminator) {
        const sends =
          terminator.name === "send_burst"
            ? extractMessages(terminator.input)
            : [];
        ledger.finish("terminator", terminator.name, sends);
        return { sends, terminator: terminator.name, newMessages, runId };
      }
    }

    ledger.finish("max_iterations", null, []);
    return { sends: [], terminator: null, newMessages, runId };
  } catch (err) {
    ledger.error(err);
    throw err;
  }
}

// public entry point. traceable wraps _runTurn as the parent span; the per-
// iteration messages.create calls (already traced by wrapAnthropic) nest
// underneath. when LANGSMITH_TRACING is unset this is an inert wrapper.
export const runTurn = traceable(_runTurn, {
  name: "donna.runTurn",
  run_type: "chain",
});
