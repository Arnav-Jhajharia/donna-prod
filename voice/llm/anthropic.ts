// custom LLM adapter so claude is the voice agent's brain.
// the @livekit/agents node sdk ships no anthropic plugin (only python does),
// so we bridge: ChatContext -> anthropic streaming -> ChatChunks.
//
// v0 scope: text in, text out, no tool calls. prompt caching, tool support,
// and prosody-aware system variants come later.

import Anthropic from '@anthropic-ai/sdk';
import {
  APIError,
  DEFAULT_API_CONNECT_OPTIONS,
  llm,
  type APIConnectOptions,
} from '@livekit/agents';

const DEFAULT_MODEL = 'claude-opus-4-7';
const DEFAULT_MAX_TOKENS = 1024;

export interface ClaudeLLMOptions {
  systemPrompt: string;
  model?: string;
  apiKey?: string;
  maxTokens?: number;
  temperature?: number;
}

interface InternalOpts {
  model: string;
  systemPrompt: string;
  maxTokens: number;
  temperature: number;
}

export class ClaudeLLM extends llm.LLM {
  readonly #client: Anthropic;
  readonly #opts: InternalOpts;

  constructor(opts: ClaudeLLMOptions) {
    super();
    this.#client = new Anthropic({
      apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY,
    });
    this.#opts = {
      model: opts.model ?? DEFAULT_MODEL,
      systemPrompt: opts.systemPrompt,
      maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: opts.temperature ?? 1,
    };
  }

  label(): string {
    return `anthropic.ClaudeLLM<${this.#opts.model}>`;
  }

  override get model(): string {
    return this.#opts.model;
  }

  override get provider(): string {
    return 'anthropic';
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
    return new ClaudeLLMStream(this, {
      chatCtx,
      toolCtx,
      connOptions: connOptions ?? DEFAULT_API_CONNECT_OPTIONS,
      client: this.#client,
      opts: this.#opts,
    });
  }
}

class ClaudeLLMStream extends llm.LLMStream {
  readonly #client: Anthropic;
  readonly #opts: InternalOpts;

  constructor(
    parent: ClaudeLLM,
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

    const stream = this.#client.messages.stream(
      {
        model: this.#opts.model,
        max_tokens: this.#opts.maxTokens,
        temperature: this.#opts.temperature,
        system,
        messages,
      },
      { signal: this.abortController.signal },
    );

    let messageId = '';
    let promptTokens = 0;
    let cachedTokens = 0;
    let completionTokens = 0;

    try {
      for await (const event of stream) {
        if (this.abortController.signal.aborted) break;

        switch (event.type) {
          case 'message_start': {
            messageId = event.message.id;
            const usage = event.message.usage;
            promptTokens = usage?.input_tokens ?? 0;
            cachedTokens = usage?.cache_read_input_tokens ?? 0;
            break;
          }
          case 'content_block_delta': {
            if (event.delta.type === 'text_delta') {
              this.queue.put({
                id: messageId,
                delta: { role: 'assistant', content: event.delta.text },
              });
            }
            break;
          }
          case 'message_delta': {
            completionTokens = event.usage?.output_tokens ?? completionTokens;
            break;
          }
        }
      }
    } catch (err) {
      throw mapError(err);
    }

    this.queue.put({
      id: messageId,
      usage: {
        promptTokens,
        completionTokens,
        promptCachedTokens: cachedTokens,
        totalTokens: promptTokens + completionTokens,
      },
    });
  }
}

function buildAnthropicInput(
  ctx: llm.ChatContext,
  fallbackSystem: string,
): {
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
} {
  const systemParts: string[] = [];
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const item of ctx.items) {
    if (item.type !== 'message') continue;
    const text = extractText(item);
    if (!text) continue;
    if (item.role === 'system' || item.role === 'developer') {
      systemParts.push(text);
    } else if (item.role === 'user' || item.role === 'assistant') {
      messages.push({ role: item.role, content: text });
    }
  }
  const system = systemParts.length > 0 ? systemParts.join('\n\n') : fallbackSystem;
  return { system, messages };
}

function extractText(msg: llm.ChatMessage): string {
  const parts: string[] = [];
  for (const c of msg.content) {
    if (typeof c === 'string') {
      parts.push(c);
      continue;
    }
    if (c && typeof c === 'object' && 'type' in c) {
      if (c.type === 'instructions' && typeof c.value === 'string') {
        parts.push(c.value);
      }
    }
  }
  return parts.join('\n').trim();
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
