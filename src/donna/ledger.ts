// per-turn append-only JSONL ledger. one event per line. file lives at
// $DONNA_LEDGER_DIR/<date>.jsonl (default .donna/ledger/<date>.jsonl).
// every event carries the runId so a single turn is `grep <runId> | jq`-able.
//
// disable with DONNA_LEDGER=0.

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  Message,
  MessageCreateParamsNonStreaming,
  ToolResultBlockParam,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages";
import type { TurnConfig } from "./brain.js";
import type { OutboundMessage } from "./messages.js";

const LEDGER_ENABLED = process.env.DONNA_LEDGER !== "0";
const LEDGER_DIR = process.env.DONNA_LEDGER_DIR ?? ".donna/ledger";
const PREVIEW_MAX = 500;

export interface Ledger {
  modelCallStart(iter: number, payload: MessageCreateParamsNonStreaming): void;
  modelCallEnd(iter: number, response: Message): void;
  toolCalls(uses: ToolUseBlock[], results: ToolResultBlockParam[]): void;
  finish(reason: string, terminator: string | null, sends: OutboundMessage[]): void;
  error(err: unknown): void;
}

const noopLedger: Ledger = {
  modelCallStart() {},
  modelCallEnd() {},
  toolCalls() {},
  finish() {},
  error() {},
};

export function startLedger(runId: string, config: TurnConfig): Ledger {
  if (!LEDGER_ENABLED) return noopLedger;

  if (!existsSync(LEDGER_DIR)) {
    mkdirSync(LEDGER_DIR, { recursive: true });
  }
  const date = new Date().toISOString().slice(0, 10);
  const file = join(LEDGER_DIR, `${date}.jsonl`);

  function write(kind: string, data: unknown): void {
    const line = JSON.stringify({
      runId,
      ts: new Date().toISOString(),
      kind,
      data,
    });
    try {
      appendFileSync(file, line + "\n");
    } catch {
      // never let logging break a turn.
    }
  }

  write("start", { config });

  return {
    modelCallStart(iter, payload) {
      write("model_call_start", {
        iter,
        model: payload.model,
        max_tokens: payload.max_tokens,
        messages_count: payload.messages.length,
      });
    },
    modelCallEnd(iter, response) {
      write("model_call_end", {
        iter,
        stop_reason: response.stop_reason,
        usage: response.usage,
        content_block_types: response.content.map((b) => b.type),
      });
    },
    toolCalls(uses, results) {
      write("tool_calls", {
        calls: uses.map((u, i) => ({
          name: u.name,
          input: u.input,
          is_error: results[i]?.is_error ?? false,
          result_preview: previewResult(results[i]),
        })),
      });
    },
    finish(reason, terminator, sends) {
      write("finish", { reason, terminator, sends });
    },
    error(err) {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      write("error", { msg, stack });
    },
  };
}

function previewResult(result: ToolResultBlockParam | undefined): string {
  if (!result) return "";
  const content = result.content;
  const text = typeof content === "string" ? content : JSON.stringify(content);
  return text.length > PREVIEW_MAX ? text.slice(0, PREVIEW_MAX) + "..." : text;
}
