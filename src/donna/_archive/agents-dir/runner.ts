// runWatchTurn — the loop for a watch firing. parallels brain.ts:_runTurnInner
// but with watch-specific shape:
//   - loads from agent_messages (per-watch private history) + chat_messages (shared transcript)
//   - uses WATCH_EXECUTION_PROMPT_TEMPLATE filled with this watch's name + description
//   - terminator set is { send_burst, do_nothing, watch_close } — no defer (cron re-fires)
//   - tools are the watch-curated subset (no oauth/agendas/calorie/subscriptions)
//   - send_burst output writes to BOTH agent_messages AND chat_messages
//
// the runner returns a structured result the schedule executor uses to:
//   - deliver bursts via the channel
//   - close the watch on watch_close
//   - schedule the next firing on send_burst/do_nothing for cron watches

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
import { MODEL } from "../brain.js";
import {
  PTC_ELIGIBLE,
  WATCH_TERMINATORS,
  selectToolsForWatch,
  tool_handlers,
} from "../tools/index.js";
import { filterSends } from "../voice_filter.js";
import { recordExecutionEvent } from "../observability/execution.js";
import { withTurnContext } from "../context.js";
import { loadRecentMessages } from "../memory/chat.js";
import { appendMessages, loadThread, loadThreadMessages } from "./thread.js";
import { getWatchById } from "../watches/service.js";
import { buildWatchExecutionPrompt } from "./prompt.js";
import type { ProactiveCause } from "../proactive/cause.js";

const MAX_LOOP_ITERATIONS = 12;
const MAX_TOKENS = 2048;
const SHARED_CHAT_LIMIT = 20;
const THREAD_HISTORY_LIMIT = 30;
const CAP_HIT_FALLBACK =
  "watch hit iteration cap without a terminator — silenced this firing.";

// reuse the same beta header as brain.ts: enables code_execution_20250825 +
// allowed_callers on user tools.
const ANTHROPIC_BETA_HEADER = "advanced-tool-use-2025-11-20";

export type WatchTerminator = "send_burst" | "do_nothing" | "watch_close" | "cap_hit";

export interface RunWatchTurnArgs {
  threadId: string;
  watchId: string;
  cause: ProactiveCause;
  runId?: string | null;
  source?: "cli" | "whatsapp" | "imessage" | "proactive_worker";
  langsmithExtra?: { tags?: string[]; metadata?: Record<string, unknown> };
}

export interface RunWatchTurnResult {
  terminator: WatchTerminator;
  sends: string[];
  voiceViolations: string[];
  newMessages: MessageParam[]; // appended to agent_messages by the runner
  iterations: number;
  model: string;
  closeReason?: string; // populated when terminator === "watch_close"
}

const client = wrapAnthropic(
  new Anthropic({
    defaultHeaders: { "anthropic-beta": ANTHROPIC_BETA_HEADER },
  }),
);

// ─── helpers ────────────────────────────────────────────────────────────────

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderTriggerEventXml(cause: ProactiveCause): string {
  const payload = Object.keys(cause.payload).length > 0
    ? ` payload="${escapeXml(JSON.stringify(cause.payload))}"`
    : "";
  return `<trigger_fired kind="${escapeXml(cause.kind)}" set_at="${escapeXml(cause.set_at)}" schedule_id="${escapeXml(cause.schedule_id)}"${payload}>${escapeXml(cause.instruction)}</trigger_fired>`;
}

// flatten shared chat into a single xml block. compact form:
// <recent_user_chat>
//   <m role="user">hey</m>
//   <m role="assistant">what's up</m>
//   ...
// </recent_user_chat>
function renderSharedChatXml(messages: MessageParam[]): string {
  if (messages.length === 0) return "<recent_user_chat />";
  const lines = ["<recent_user_chat>"];
  for (const m of messages) {
    const role = m.role;
    const text = extractText(m.content).slice(0, 400);
    lines.push(`  <m role="${role}">${escapeXml(text)}</m>`);
  }
  lines.push("</recent_user_chat>");
  return lines.join("\n");
}

function extractText(content: MessageParam["content"]): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts.join(" ");
}

function renderInitialContextXml(args: {
  description: string;
  initial_context: Record<string, unknown>;
}): string {
  const parts: string[] = [
    `<initial_context>`,
    `  <description>${escapeXml(args.description)}</description>`,
  ];
  if (Object.keys(args.initial_context).length > 0) {
    parts.push(`  <context>${escapeXml(JSON.stringify(args.initial_context))}</context>`);
  }
  parts.push(`</initial_context>`);
  return parts.join("\n");
}

function previewString(value: unknown, cap: number = 8000): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > cap ? `${text.slice(0, cap)}…[+${text.length - cap}]` : text;
}

function callerKind(block: ToolUseBlock): "direct" | "code_execution" {
  const caller = (block as ToolUseBlock & { caller?: { type?: string } }).caller;
  if (!caller) return "direct";
  if (caller.type === "direct") return "direct";
  return "code_execution";
}

function withTrailingCacheControl(messages: MessageParam[]): MessageParam[] {
  if (messages.length === 0) return messages;
  const lastIdx = messages.length - 1;
  const last = messages[lastIdx]!;
  if (typeof last.content === "string") {
    return [
      ...messages.slice(0, lastIdx),
      {
        ...last,
        content: [{ type: "text", text: last.content, cache_control: { type: "ephemeral" } }],
      },
    ];
  }
  const blocks = last.content;
  if (blocks.length === 0) return messages;
  const lastBlockIdx = blocks.length - 1;
  const lastBlock = blocks[lastBlockIdx]!;
  if (lastBlock.type === "thinking" || lastBlock.type === "redacted_thinking") {
    return messages;
  }
  return [
    ...messages.slice(0, lastIdx),
    {
      ...last,
      content: [
        ...blocks.slice(0, lastBlockIdx),
        { ...lastBlock, cache_control: { type: "ephemeral" } },
      ],
    },
  ];
}

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

function extractWatchCloseReason(content: ContentBlock[]): string | undefined {
  for (const block of content) {
    if (block.type === "tool_use" && block.name === "watch_close") {
      const input = block.input as { reason?: unknown };
      if (typeof input.reason === "string") return input.reason;
      return "unspecified";
    }
  }
  return undefined;
}

// ─── public entry ───────────────────────────────────────────────────────────

async function _runWatchTurn(args: RunWatchTurnArgs): Promise<RunWatchTurnResult> {
  const { threadId, watchId, cause, runId = null, source = "proactive_worker" } = args;

  const [thread, watch] = await Promise.all([
    loadThread(threadId),
    getWatchById(watchId),
  ]);
  if (!thread) throw new Error(`runWatchTurn: thread ${threadId} not found`);
  if (!watch) throw new Error(`runWatchTurn: watch ${watchId} not found`);
  if (watch.user_id !== thread.user_id) {
    throw new Error(`runWatchTurn: watch.user_id (${watch.user_id}) != thread.user_id (${thread.user_id})`);
  }

  return withTurnContext({ userId: thread.user_id, runId, source }, () =>
    _runWatchTurnInner({ thread, watch, cause, runId }),
  );
}

async function _runWatchTurnInner(args: {
  thread: NonNullable<Awaited<ReturnType<typeof loadThread>>>;
  watch: NonNullable<Awaited<ReturnType<typeof getWatchById>>>;
  cause: ProactiveCause;
  runId: string | null;
}): Promise<RunWatchTurnResult> {
  const { thread, watch, cause, runId } = args;

  const tools = selectToolsForWatch() as MessageCreateParams["tools"];
  const system = buildWatchExecutionPrompt({
    watch_name: watch.name,
    description: watch.description,
  });

  // load both histories in parallel: thread's own prior firings AND the user's
  // shared chat transcript.
  const [threadHistory, sharedChat] = await Promise.all([
    loadThreadMessages(thread.id, THREAD_HISTORY_LIMIT),
    loadRecentMessages(watch.user_id, SHARED_CHAT_LIMIT),
  ]);

  // assemble the initial bundle the watch sees this firing:
  //   shared_chat (xml) + initial_context (xml)  → one user message
  //   ...threadHistory                            → prior firings (alternating)
  //   trigger_fired (xml)                         → one user message
  const initialBundleText = [
    renderSharedChatXml(sharedChat),
    renderInitialContextXml({
      description: watch.description,
      initial_context: watch.initial_context,
    }),
  ].join("\n");

  const triggerText = renderTriggerEventXml(cause);

  // working messages array we'll feed to the api each iteration. these are
  // PER-FIRING — not persisted. newMessages is what we persist below.
  const working: MessageParam[] = [
    { role: "user", content: [{ type: "text", text: initialBundleText }] },
    ...threadHistory,
    { role: "user", content: [{ type: "text", text: triggerText }] },
  ];

  let iterations = 0;
  let terminatorHit = false;
  let lastAssistantContent: ContentBlock[] = [];
  let ptcInvocations = 0;

  await recordExecutionEvent(runId, "watch_turn_start", "watch", {
    watch_id: watch.id,
    thread_id: thread.id,
    watch_name: watch.name,
    cause_kind: cause.kind,
    shared_chat_messages: sharedChat.length,
    thread_history_messages: threadHistory.length,
  });

  while (iterations < MAX_LOOP_ITERATIONS) {
    iterations++;
    const modelStartedAt = Date.now();

    await recordExecutionEvent(runId, "model_start", "anthropic.messages.create", {
      iteration: iterations,
      model: MODEL,
      message_count: working.length,
      tool_count: (tools as unknown[]).length,
      surface: "watch",
    });

    const messagesForApi = withTrailingCacheControl(working);

    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: [
        {
          type: "text",
          text: system,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools,
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
      surface: "watch",
    });

    working.push({ role: "assistant", content: resp.content });
    lastAssistantContent = resp.content;

    // observability pass — code_execution blocks
    for (const block of resp.content) {
      if (
        block.type === "server_tool_use" &&
        (block as ServerToolUseBlock).name === "code_execution"
      ) {
        ptcInvocations++;
        continue;
      }
      if (block.type === "code_execution_tool_result") {
        const result = block as CodeExecutionToolResultBlock;
        const errored =
          "type" in result.content && result.content.type === "code_execution_tool_result_error";
        await recordExecutionEvent(runId, "code_end", "code_execution", {
          tool_use_id: result.tool_use_id,
          iteration: iterations,
          errored,
          surface: "watch",
        });
        continue;
      }
    }

    if (resp.stop_reason !== "tool_use") break;

    const toolResults: ToolResultBlockParam[] = [];
    let sawTerminator = false;

    for (const block of resp.content) {
      if (block.type !== "tool_use") continue;
      if (WATCH_TERMINATORS.has(block.name)) sawTerminator = true;

      const caller = callerKind(block);
      const isTerminator = WATCH_TERMINATORS.has(block.name);
      const handler = tool_handlers[block.name];
      if (!handler) {
        await recordExecutionEvent(runId, "tool_error", block.name, {
          tool_use_id: block.id,
          iteration: iterations,
          error: "unknown_tool",
          caller,
          surface: "watch",
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `error: unknown tool '${block.name}'`,
          is_error: true,
        });
        continue;
      }

      if (caller === "code_execution" && !PTC_ELIGIBLE.has(block.name)) {
        await recordExecutionEvent(runId, "tool_warning", block.name, {
          tool_use_id: block.id,
          iteration: iterations,
          warning: "ptc_call_on_direct_only_tool",
          surface: "watch",
        });
      }

      const toolStartedAt = Date.now();
      try {
        await recordExecutionEvent(runId, "tool_start", block.name, {
          tool_use_id: block.id,
          iteration: iterations,
          input_preview: previewString(block.input),
          terminator: isTerminator,
          caller,
          surface: "watch",
        });

        const output = await handler(block.input);

        await recordExecutionEvent(runId, "tool_end", block.name, {
          tool_use_id: block.id,
          iteration: iterations,
          duration_ms: Date.now() - toolStartedAt,
          output_preview: previewString(output),
          terminator: isTerminator,
          caller,
          surface: "watch",
        });

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: typeof output === "string" ? output : JSON.stringify(output),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await recordExecutionEvent(runId, "tool_error", block.name, {
          tool_use_id: block.id,
          iteration: iterations,
          duration_ms: Date.now() - toolStartedAt,
          error: msg,
          caller,
          surface: "watch",
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

  // ── derive the terminator ──
  let terminator: WatchTerminator;
  let sends: string[];
  let closeReason: string | undefined;

  if (terminatorHit) {
    const firedBlock = lastAssistantContent.find(
      (b) => b.type === "tool_use" && WATCH_TERMINATORS.has((b as ToolUseBlock).name),
    ) as ToolUseBlock | undefined;
    const firedName = firedBlock?.name ?? "send_burst";
    if (firedName === "send_burst") {
      sends = extractSends(lastAssistantContent);
      terminator = sends.length > 0 ? "send_burst" : "cap_hit";
      if (sends.length === 0) sends = [CAP_HIT_FALLBACK];
    } else if (firedName === "do_nothing") {
      sends = [];
      terminator = "do_nothing";
    } else if (firedName === "watch_close") {
      sends = [];
      terminator = "watch_close";
      closeReason = extractWatchCloseReason(lastAssistantContent);
    } else {
      sends = [CAP_HIT_FALLBACK];
      terminator = "cap_hit";
    }
  } else {
    console.warn(
      `[watch] hit max iterations (${MAX_LOOP_ITERATIONS}) without terminator (watch=${watch.name})`,
    );
    sends = [CAP_HIT_FALLBACK];
    terminator = "cap_hit";
  }

  // voice filter only when there are user-facing sends.
  const filtered = sends.length > 0 ? filterSends(sends) : { messages: [], violations: [] };
  sends = filtered.messages;
  const voiceViolations = filtered.violations;

  // newMessages = everything appended this firing. The initial bundle + trigger
  // message we synthesized are NOT persisted (they're regenerated each firing
  // from current chat_messages + watch state). What IS persisted: the trigger
  // message (so the watch can remember it later) + the assistant's responses
  // + any tool_result blocks.
  //
  // we slice from index 1 (after the synthetic initialBundle) through the end.
  // index 0 is the initial bundle (shared chat + initial_context); index 1 is
  // the trigger event; then prior thread history; then assistant + tool result
  // pairs. We want trigger event onward.
  //
  // simpler approach: we know the prior thread history is at indices [1 ..
  // 1 + threadHistory.length - 1] when threadHistory > 0; trigger is at index
  // 1 + threadHistory.length; assistant/tool work follows. So newMessages =
  // everything from (1 + threadHistory.length) onward.
  const newStart = 1 + threadHistory.length;
  const newMessages = working.slice(newStart);

  // persist newMessages into agent_messages so next firing sees them.
  try {
    await appendMessages(thread.id, newMessages);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[watch] appendMessages failed for thread ${thread.id}: ${msg}`);
  }

  await recordExecutionEvent(runId, "watch_turn_end", "watch", {
    watch_id: watch.id,
    thread_id: thread.id,
    terminator,
    iterations,
    sends_count: sends.length,
    voice_violations: voiceViolations,
    ptc_invocations: ptcInvocations,
    close_reason: closeReason ?? null,
  });

  return {
    terminator,
    sends,
    voiceViolations,
    newMessages,
    iterations,
    model: MODEL,
    closeReason,
  };
}

export const runWatchTurn = traceable(_runWatchTurn, {
  name: "runWatchTurn",
  run_type: "chain",
  argsConfigPath: [0, "langsmithExtra"],
});
