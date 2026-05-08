import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  MessageCreateParams,
  ContentBlock,
  ToolResultBlockParam,
  ToolUseBlock,
  ServerToolUseBlock,
  CodeExecutionToolResultBlock,
} from "@anthropic-ai/sdk/resources/messages";
import { wrapAnthropic } from "langsmith/wrappers/anthropic";
import { traceable } from "langsmith/traceable";
import {
  sdk_tools,
  selectToolsForMode,
  tool_definitions,
  tool_handlers,
  PTC_ELIGIBLE,
  TERMINATORS,
} from "./tools/index.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { filterSends } from "./voice_filter.js";
import { recordExecutionEvent } from "./observability/execution.js";
import { withTurnContext } from "./context.js";

export const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 2048;
const MAX_LOOP_ITERATIONS = 10;
const CAP_HIT_FALLBACK = "sorry, got stuck in a loop. try again.";

// the advanced-tool-use beta enables `code_execution_20250825` server tool +
// `allowed_callers` opt-in on user-defined tools. claude writes python in a
// sandbox; tool calls from inside the sandbox arrive as regular `tool_use`
// blocks carrying a `caller` field, which our handlers serve unchanged.
const ANTHROPIC_BETA_HEADER = "advanced-tool-use-2025-11-20";

export type BrainMode = "reactive" | "proactive" | "proactive_tier3";
export type TerminatorReason = "send_burst" | "cap_hit";
export type CallerKind = "direct" | "code_execution";

export interface RunTurnArgs {
  mode: BrainMode;
  messages: MessageParam[];
  userInput: string;
  // donna's user_id (uuid). required so handlers can resolve per-user
  // integration state, audit, slabs. flows via AsyncLocalStorage.
  userId: string;
  // where the turn originated. cli runs and channel webhook runs differ
  // in their downstream side effects (egress, dedup, etc).
  source?: "cli" | "whatsapp" | "imessage";
  runId?: string | null;
  // optional langsmith RunTreeConfig (tags, metadata, etc.). when LANGSMITH_TRACING
  // is set, these flow into the parent trace. the traceable wrapper extracts and
  // strips this field before calling _runTurn — so it never reaches the inner fn.
  langsmithExtra?: {
    tags?: string[];
    metadata?: Record<string, unknown>;
  };
}

export interface RunTurnResult {
  messages: MessageParam[];      // full updated history (including userInput + everything added this turn)
  newMessages: MessageParam[];   // just the messages added this turn (for persistence)
  sends: string[];               // visible sends emitted this turn (cap_hit fallback if loop exhausted)
  terminator: TerminatorReason;
  voiceViolations: string[];
  model: string;
  iterations: number;
  ptcInvocations: number;        // # of code_execution server-tool blocks observed this turn
}

// wrapAnthropic auto-traces every messages.create call when LANGSMITH_TRACING=true.
// no-ops cleanly when tracing is off — same client, no overhead. defaultHeaders
// flips the advanced-tool-use beta on for every request.
const client = wrapAnthropic(
  new Anthropic({
    defaultHeaders: { "anthropic-beta": ANTHROPIC_BETA_HEADER },
  }),
);

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

function callerKind(block: ToolUseBlock): CallerKind {
  // when the caller field is missing OR { type: "direct" } the model invoked
  // the tool itself. anything else (code_execution_20250825 /
  // code_execution_20260120) means it came from inside the python sandbox.
  const caller = (block as ToolUseBlock & { caller?: { type?: string } }).caller;
  if (!caller) return "direct";
  if (caller.type === "direct") return "direct";
  return "code_execution";
}

function extractCodeExecutionStdout(block: CodeExecutionToolResultBlock): string {
  const content = block.content;
  if ("type" in content && content.type === "code_execution_result") {
    return content.stdout ?? "";
  }
  return "";
}

function extractCodeExecutionStderr(block: CodeExecutionToolResultBlock): string {
  const content = block.content;
  if ("type" in content && content.type === "code_execution_result") {
    return content.stderr ?? "";
  }
  return "";
}

function isCodeExecutionError(block: CodeExecutionToolResultBlock): boolean {
  return "type" in block.content && block.content.type === "code_execution_tool_result_error";
}

// Returns a shallow-cloned messages array where the last content block of the
// last message carries `cache_control: ephemeral`. The caller's array is not
// mutated; the marker is a per-request artifact and must not leak into
// persisted chat_messages rows. This is the multi-turn prefix-cache pattern:
// the marker caches everything before AND including the last block, so the
// next api call (this turn's next loop iter, or the next turn within ~5min)
// reads the prior prefix from cache.
//
// Type note: ContentBlockParam is a union that includes ThinkingBlockParam,
// which does not accept cache_control. Our flow never produces thinking blocks
// (no extended thinking enabled), so we cast through `as ContentBlockParam`
// for the blocks that legitimately accept the marker (text / tool_use /
// tool_result / image / document).
function withTrailingCacheControl(messages: MessageParam[]): MessageParam[] {
  if (messages.length === 0) return messages;
  const lastIdx = messages.length - 1;
  const last = messages[lastIdx]!;

  // string content: convert to a single text block carrying cache_control
  if (typeof last.content === "string") {
    const block = {
      type: "text" as const,
      text: last.content,
      cache_control: { type: "ephemeral" as const },
    };
    return [
      ...messages.slice(0, lastIdx),
      { ...last, content: [block] },
    ];
  }

  // array content: clone, attach cache_control to the last block
  const blocks = last.content;
  if (blocks.length === 0) return messages;
  const lastBlockIdx = blocks.length - 1;
  const lastBlock = blocks[lastBlockIdx]!;
  if (lastBlock.type === "thinking" || lastBlock.type === "redacted_thinking") {
    // thinking blocks don't accept cache_control. shouldn't appear in our
    // flow, but bail safely if they do.
    return messages;
  }
  const markedBlock = {
    ...lastBlock,
    cache_control: { type: "ephemeral" as const },
  };
  return [
    ...messages.slice(0, lastIdx),
    {
      ...last,
      content: [...blocks.slice(0, lastBlockIdx), markedBlock],
    },
  ];
}

async function _runTurn({
  mode,
  messages,
  userInput,
  userId,
  source = "cli",
  runId = null,
}: RunTurnArgs): Promise<RunTurnResult> {
  if (mode === "proactive_tier3") {
    throw new Error(`brain mode 'proactive_tier3' not implemented yet`);
  }
  // 'reactive' and 'proactive' share the loop below. proactive turns differ
  // only in WHO triggered them: caller passes a synthetic userInput
  // describing the runtime trigger, optionally with empty messages.

  return withTurnContext({ userId, runId, source }, () =>
    _runTurnInner({ mode, messages, userInput, userId, source, runId }),
  );
}

// helper for runtime-triggered proactive bursts (oauth completed, commitment
// overdue, backfill done, etc). caller provides a human-readable trigger
// description; donna composes a single short burst acknowledging it.
//
// for cli: caller prints result.sends. for whatsapp: caller delivers via
// WhatsAppChannel.send (when the proactive lane lands). messages defaults
// to [] — proactive notifications don't need conversation history unless
// the caller explicitly passes recent context.
export async function runProactiveTurn(args: {
  userId: string;
  source: "cli" | "whatsapp" | "imessage";
  trigger: string;
  messages?: MessageParam[];
  runId?: string | null;
}): Promise<RunTurnResult> {
  const synthetic =
    `[runtime trigger, not from the user]: ${args.trigger}\n\n` +
    `respond in one short burst (1-2 bubbles) acknowledging the trigger and ` +
    `offering exactly one next move. do not greet. stay in voice. do not narrate ` +
    `that this was an automated trigger.`;
  return runTurn({
    mode: "proactive",
    messages: args.messages ?? [],
    userInput: synthetic,
    userId: args.userId,
    source: args.source,
    runId: args.runId ?? null,
  });
}

async function _runTurnInner({
  mode,
  messages,
  userInput,
  runId = null,
}: RunTurnArgs): Promise<RunTurnResult> {
  const toolsForMode = selectToolsForMode(mode) as MessageCreateParams["tools"];

  // never mutate the caller's messages array. work on a fresh copy.
  const working: MessageParam[] = [
    ...messages,
    { role: "user", content: userInput },
  ];

  let iterations = 0;
  let terminatorHit = false;
  let ptcInvocations = 0;
  let lastAssistantContent: ContentBlock[] = [];

  while (iterations < MAX_LOOP_ITERATIONS) {
    iterations++;

    await recordExecutionEvent(runId, "model_start", "anthropic.messages.create", {
      iteration: iterations,
      model: MODEL,
      message_count: working.length,
      tool_count: (toolsForMode as unknown[]).length,
    });
    const modelStartedAt = Date.now();

    // build the messages array for the API with a cache_control marker on the
    // last content block of the last message. this caches the entire prefix
    // (tools + system + all prior turns) so subsequent api calls (within the
    // same loop iteration AND within the next turn, while the cache is warm)
    // pay only for the new tail. we don't mutate `working` itself — the cache
    // marker is a per-request artifact, not part of persisted history.
    const messagesForApi = withTrailingCacheControl(working);

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
      tools: toolsForMode,
      messages: messagesForApi,
    });
    await recordExecutionEvent(runId, "model_end", "anthropic.messages.create", {
      iteration: iterations,
      stop_reason: resp.stop_reason,
      duration_ms: Date.now() - modelStartedAt,
      input_tokens: resp.usage.input_tokens,
      cache_creation_input_tokens: resp.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: resp.usage.cache_read_input_tokens ?? 0,
      output_tokens: resp.usage.output_tokens,
    });

    working.push({ role: "assistant", content: resp.content });
    lastAssistantContent = resp.content;

    // observability pass over server-side blocks. these don't require our
    // handler — anthropic ran/produced them — but they're the most valuable
    // trace artifact: the python claude wrote, and the stdout she saw.
    for (const block of resp.content) {
      if (
        block.type === "server_tool_use" &&
        (block as ServerToolUseBlock).name === "code_execution"
      ) {
        ptcInvocations++;
        const code = (block.input as { code?: string } | undefined)?.code ?? "";
        await recordExecutionEvent(runId, "code_start", "code_execution", {
          tool_use_id: block.id,
          code,
          code_length: code.length,
        });
        continue;
      }

      if (block.type === "code_execution_tool_result") {
        const stdout = extractCodeExecutionStdout(block);
        const stderr = extractCodeExecutionStderr(block);
        const errored = isCodeExecutionError(block);
        await recordExecutionEvent(runId, "code_end", "code_execution", {
          tool_use_id: block.tool_use_id,
          stdout_preview: stdout.slice(0, 1000),
          stdout_length: stdout.length,
          stderr_preview: stderr.slice(0, 500),
          errored,
        });
        continue;
      }
    }

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

      const caller = callerKind(block);
      const handler = tool_handlers[block.name];
      if (!handler) {
        await recordExecutionEvent(runId, "tool_error", block.name, {
          tool_use_id: block.id,
          error: "unknown_tool",
          caller,
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `error: unknown tool '${block.name}'`,
          is_error: true,
        });
        continue;
      }

      // light guard: a tool not opted into PTC should never arrive with a
      // code_execution caller. log + still answer (api would have rejected it
      // upstream already) so we have visibility if anthropic's behavior shifts.
      if (caller === "code_execution" && !PTC_ELIGIBLE.has(block.name)) {
        await recordExecutionEvent(runId, "tool_warning", block.name, {
          tool_use_id: block.id,
          warning: "ptc_call_on_direct_only_tool",
        });
      }

      try {
        await recordExecutionEvent(runId, "tool_start", block.name, {
          tool_use_id: block.id,
          input: block.input,
          terminator: TERMINATORS.has(block.name),
          caller,
        });
        const toolStartedAt = Date.now();

        // wrap each tool dispatch as a langsmith span. when LANGSMITH_TRACING
        // is unset, traceable is a passthrough (zero overhead). nests inside
        // the runTurn parent span automatically (langsmith uses
        // AsyncLocalStorage internally).
        const tracedHandler = traceable(
          async (input: unknown) => handler(input),
          {
            name: block.name,
            run_type: "tool",
            metadata: {
              tool_use_id: block.id,
              caller,
              terminator: TERMINATORS.has(block.name),
            },
          },
        );
        const output = await tracedHandler(block.input);

        await recordExecutionEvent(runId, "tool_end", block.name, {
          tool_use_id: block.id,
          duration_ms: Date.now() - toolStartedAt,
          caller,
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
          caller,
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `error: ${msg}`,
          is_error: true,
        });
      }
    }

    if (toolResults.length > 0) {
      working.push({ role: "user", content: toolResults });
    }

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
    ptcInvocations,
  };
}

// public entry point. langsmith parent trace per turn — children are the LLM
// calls (auto-traced via wrapAnthropic). callers may attach metadata/tags via
// `args.langsmithExtra`; the wrapper extracts and strips it before calling
// _runTurn. when LANGSMITH_TRACING is unset, the wrapper is a pass-through.
export const runTurn = traceable(_runTurn, {
  name: "runTurn",
  run_type: "chain",
  argsConfigPath: [0, "langsmithExtra"],
});
