// v3: two-tier brain. a fast frontline (haiku 4.5) and a slow brain (opus 4.7)
// fire in parallel on every turn. the fast one streams to TTS first (~500ms
// TTFB) with a short conversational filler. the slow one's tokens stream
// next (they've been generating in the background, buffered until haiku
// finishes). user perceives: brief filler within ~500ms, real answer at ~1500ms.
//
// the practical effect is that the perceived gap before donna says SOMETHING
// drops from ~1500ms (claude opus cold) to ~500ms (haiku cold). the *full
// answer* still takes opus its normal ~2s, but the user is no longer hearing
// dead air — they're hearing donna think out loud.
//
// the slow brain sees the full system prompt + chat context. the fast
// frontline sees the same context but with a constrained system prompt
// that tells it to emit only a brief filler, never an actual answer.

import Anthropic from "@anthropic-ai/sdk";
import {
  APIError,
  DEFAULT_API_CONNECT_OPTIONS,
  llm,
  type APIConnectOptions,
} from "@livekit/agents";

const DEFAULT_FAST_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_SLOW_MODEL = "claude-opus-4-7";
const DEFAULT_SLOW_MAX_TOKENS = 1024;
const DEFAULT_FAST_MAX_TOKENS = 24;

// the fast frontline's standing instructions. tight on purpose: we want
// 2-5 lowercase words that fit "i'm pulling that up." it must NOT answer
// the user's question — only the slow brain commits to facts.
const FAST_SYSTEM_PROMPT = `you are donna's voice cushion. while the slow brain is composing the real answer, your only job is to emit one brief conversational filler that fits the user's last message.

output rules:
- 2 to 5 lowercase words, no punctuation
- never answer the user's question
- never claim facts, dates, numbers, or names
- never say "i'm" or "i'll" — just the filler

good fillers: "hmm hold on", "yeah let me check", "okay one sec", "mm okay", "oh okay so", "let me see"
bad fillers: "the meeting is at 5" (commits to a fact), "i'll check your calendar" (commits to an action), "great question" (sycophantic)`;

export interface LayeredClaudeLLMOptions {
  /** full system prompt for the slow brain (opus). */
  systemPrompt: string;
  apiKey?: string;
  slowModel?: string;
  fastModel?: string;
  slowMaxTokens?: number;
  fastMaxTokens?: number;
  temperature?: number;
}

interface InternalOpts {
  systemPrompt: string;
  slowModel: string;
  fastModel: string;
  slowMaxTokens: number;
  fastMaxTokens: number;
  temperature: number;
}

export class LayeredClaudeLLM extends llm.LLM {
  readonly #client: Anthropic;
  readonly #opts: InternalOpts;

  constructor(opts: LayeredClaudeLLMOptions) {
    super();
    this.#client = new Anthropic({
      apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY,
    });
    this.#opts = {
      systemPrompt: opts.systemPrompt,
      slowModel: opts.slowModel ?? DEFAULT_SLOW_MODEL,
      fastModel: opts.fastModel ?? DEFAULT_FAST_MODEL,
      slowMaxTokens: opts.slowMaxTokens ?? DEFAULT_SLOW_MAX_TOKENS,
      fastMaxTokens: opts.fastMaxTokens ?? DEFAULT_FAST_MAX_TOKENS,
      temperature: opts.temperature ?? 1,
    };
  }

  label(): string {
    return `anthropic.LayeredClaudeLLM<${this.#opts.fastModel}+${this.#opts.slowModel}>`;
  }

  override get model(): string {
    return this.#opts.slowModel;
  }

  override get provider(): string {
    return "anthropic";
  }

  chat({
    chatCtx,
    toolCtx,
    connOptions,
  }: {
    chatCtx: llm.ChatContext;
    toolCtx?: llm.ToolContext;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: llm.ToolChoice;
    extraKwargs?: Record<string, unknown>;
  }): llm.LLMStream {
    return new LayeredClaudeLLMStream(this, {
      chatCtx,
      toolCtx,
      connOptions: connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
      client: this.#client,
      opts: this.#opts,
    });
  }
}

class LayeredClaudeLLMStream extends llm.LLMStream {
  readonly #client: Anthropic;
  readonly #opts: InternalOpts;

  constructor(
    parent: LayeredClaudeLLM,
    args: {
      chatCtx: llm.ChatContext;
      toolCtx?: llm.ToolContext;
      connOptions: APIConnectOptions;
      client: Anthropic;
      opts: InternalOpts;
    },
  ) {
    super(parent, {
      chatCtx: args.chatCtx,
      toolCtx: args.toolCtx,
      connOptions: args.connOptions,
    });
    this.#client = args.client;
    this.#opts = args.opts;
  }

  protected async run(): Promise<void> {
    const { system, messages } = buildAnthropicInput(
      this.chatCtx,
      this.#opts.systemPrompt,
    );

    // fire BOTH calls in the same synchronous tick. messages.stream returns
    // a MessageStream object immediately; the actual sse connection is
    // opened in the background and events buffer internally until consumed.
    const fastStream = this.#client.messages.stream(
      {
        model: this.#opts.fastModel,
        max_tokens: this.#opts.fastMaxTokens,
        temperature: this.#opts.temperature,
        system: FAST_SYSTEM_PROMPT,
        messages,
      },
      { signal: this.abortController.signal },
    );

    const slowStream = this.#client.messages.stream(
      {
        model: this.#opts.slowModel,
        max_tokens: this.#opts.slowMaxTokens,
        temperature: this.#opts.temperature,
        system,
        messages,
      },
      { signal: this.abortController.signal },
    );

    let fastMessageId = "";
    let slowMessageId = "";
    let slowPromptTokens = 0;
    let slowCachedTokens = 0;
    let slowCompletionTokens = 0;
    let fastEmittedText = false;

    // pull fast frontline first. each text delta pushes to the queue
    // immediately so TTS can start speaking the filler.
    try {
      for await (const event of fastStream) {
        if (this.abortController.signal.aborted) break;
        if (event.type === "message_start") {
          fastMessageId = event.message.id;
          continue;
        }
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          this.queue.put({
            id: fastMessageId,
            delta: { role: "assistant", content: event.delta.text },
          });
          fastEmittedText = true;
        }
      }
    } catch (err) {
      // fast model failure is non-fatal — slow brain will still answer.
      // log and continue rather than abort the whole turn.
      this.logger.warn({ err }, "[layered] fast frontline failed, continuing with slow brain only");
    }

    // small spacer between the filler and the real answer. claude-tts
    // handles natural micro-pauses on punctuation, so a comma + space
    // bridges "hmm hold on" -> "the meeting is at five" without clicking.
    if (fastEmittedText) {
      this.queue.put({
        id: fastMessageId,
        delta: { role: "assistant", content: ", " },
      });
    }

    // drain the slow brain. its first tokens have been arriving in the
    // background since we kicked off the stream above, so this loop's
    // first iteration yields immediately if claude has already produced
    // content during the fast frontline's run.
    try {
      for await (const event of slowStream) {
        if (this.abortController.signal.aborted) break;
        switch (event.type) {
          case "message_start": {
            slowMessageId = event.message.id;
            const usage = event.message.usage;
            slowPromptTokens = usage?.input_tokens ?? 0;
            slowCachedTokens = usage?.cache_read_input_tokens ?? 0;
            break;
          }
          case "content_block_delta": {
            if (event.delta.type === "text_delta") {
              this.queue.put({
                id: slowMessageId,
                delta: { role: "assistant", content: event.delta.text },
              });
            }
            break;
          }
          case "message_delta": {
            slowCompletionTokens =
              event.usage?.output_tokens ?? slowCompletionTokens;
            break;
          }
        }
      }
    } catch (err) {
      throw mapError(err);
    }

    this.queue.put({
      id: slowMessageId,
      usage: {
        promptTokens: slowPromptTokens,
        completionTokens: slowCompletionTokens,
        promptCachedTokens: slowCachedTokens,
        totalTokens: slowPromptTokens + slowCompletionTokens,
      },
    });
  }
}

function buildAnthropicInput(
  ctx: llm.ChatContext,
  fallbackSystem: string,
): {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
} {
  const systemParts: string[] = [];
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const item of ctx.items) {
    if (item.type !== "message") continue;
    const text = extractText(item);
    if (!text) continue;
    if (item.role === "system" || item.role === "developer") {
      systemParts.push(text);
    } else if (item.role === "user" || item.role === "assistant") {
      messages.push({ role: item.role, content: text });
    }
  }
  const system = systemParts.length > 0 ? systemParts.join("\n\n") : fallbackSystem;
  return { system, messages };
}

function extractText(msg: llm.ChatMessage): string {
  const parts: string[] = [];
  for (const c of msg.content) {
    if (typeof c === "string") {
      parts.push(c);
      continue;
    }
    if (c && typeof c === "object" && "type" in c) {
      if (c.type === "instructions" && typeof c.value === "string") {
        parts.push(c.value);
      }
    }
  }
  return parts.join("\n").trim();
}

function mapError(err: unknown): Error {
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    return new APIError(err.message, {
      retryable: status === 429 || (status >= 500 && status < 600),
    });
  }
  if (err instanceof Error) return err;
  return new Error(String(err));
}
