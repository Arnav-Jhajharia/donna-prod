// Print exactly what the BRAIN would send to anthropic for a given user.
// Mirrors brain.ts construction — tools, system, messages, cache_control —
// without making the API call. Use this to audit what donna actually sees.
//
// Usage:
//   npx tsx scripts/inspect-context.ts                    # uses DONNA_USER_ID from .env
//   npx tsx scripts/inspect-context.ts <user_id>          # specify user
//   USER_INPUT="hi donna" npx tsx scripts/inspect-context.ts   # simulate a new user message

import "dotenv/config";
import { tool_definitions } from "../src/donna/tools/index.ts";
import { REACTIVE_SYSTEM_PROMPT as SYSTEM_PROMPT } from "../src/donna/prompt.ts";
import { loadRecentMessages } from "../src/donna/memory/chat.ts";
import { closeDb } from "../src/donna/db.ts";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";

// Same helper as brain.ts. Duplicated here on purpose — this script must
// reflect what the brain ACTUALLY does, byte for byte. If brain.ts changes,
// update this to match.
function withTrailingCacheControl(messages: MessageParam[]): MessageParam[] {
  if (messages.length === 0) return messages;
  const lastIdx = messages.length - 1;
  const last = messages[lastIdx]!;
  if (typeof last.content === "string") {
    return [
      ...messages.slice(0, lastIdx),
      {
        ...last,
        content: [
          {
            type: "text" as const,
            text: last.content,
            cache_control: { type: "ephemeral" as const },
          },
        ],
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
        { ...lastBlock, cache_control: { type: "ephemeral" as const } },
      ],
    },
  ];
}

// Crude token estimator (~4 chars per token). Good enough for ordering.
function estTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

function describeBlock(b: unknown): string {
  if (typeof b !== "object" || b === null) return String(b);
  const block = b as Record<string, unknown>;
  const t = block.type;
  switch (t) {
    case "text": {
      const text = String(block.text ?? "");
      const preview = text.length > 80 ? text.slice(0, 77) + "…" : text;
      return `text("${preview}")`;
    }
    case "tool_use": {
      const name = String(block.name ?? "?");
      const input = JSON.stringify(block.input ?? {});
      const preview = input.length > 80 ? input.slice(0, 77) + "…" : input;
      return `tool_use(${name}, ${preview})`;
    }
    case "tool_result": {
      const content = block.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((c) => describeBlock(c)).join(", ")
            : JSON.stringify(content);
      const preview = text.length > 80 ? text.slice(0, 77) + "…" : text;
      const err = block.is_error ? " ⚠️" : "";
      return `tool_result(${preview})${err}`;
    }
    default:
      return `${t}(?)`;
  }
}

function hasCacheControl(b: unknown): boolean {
  if (typeof b !== "object" || b === null) return false;
  return Boolean((b as Record<string, unknown>).cache_control);
}

async function main(): Promise<void> {
  const userId =
    process.argv[2] || process.env.DONNA_USER_ID || "";
  if (!userId) {
    console.error("usage: npx tsx scripts/inspect-context.ts [user_id]");
    console.error("   or set DONNA_USER_ID in .env");
    process.exit(1);
  }

  const userInput = process.env.USER_INPUT || "<simulated new user message>";

  // Load history — same call brain.ts makes.
  const history = await loadRecentMessages(userId, 50);

  // Construct working[] like brain.ts does at the start of a turn.
  const working: MessageParam[] = [
    ...history,
    { role: "user", content: userInput },
  ];

  // Apply the cache marker.
  const messagesForApi = withTrailingCacheControl(working);

  // ---- Print -------------------------------------------------------------

  console.log("=".repeat(70));
  console.log(`CONTEXT FOR USER: ${userId}`);
  console.log(`SIMULATED INPUT:  ${JSON.stringify(userInput)}`);
  console.log("=".repeat(70));

  // POSITION 0 — tools
  console.log("\n┌─ POSITION 0 ── tools[] ──────────────────────────────");
  let toolTokens = 0;
  for (const tool of tool_definitions) {
    const text = JSON.stringify(tool);
    const t = estTokens(text);
    toolTokens += t;
    const cache = hasCacheControl(tool) ? " 🟢 cache_control" : "";
    console.log(`│  • ${tool.name}  (~${t} tok)${cache}`);
  }
  console.log(`│                                          subtotal: ~${toolTokens} tok`);

  // POSITION 1 — system
  console.log("\n┌─ POSITION 1 ── system[] ─────────────────────────────");
  const systemTokens = estTokens(SYSTEM_PROMPT);
  console.log(`│  ${SYSTEM_PROMPT.split("\n").length} lines, ~${systemTokens} tok 🟢 cache_control (always)`);
  console.log("│  ─────────────────────────────────────────────────────");
  for (const line of SYSTEM_PROMPT.split("\n")) {
    console.log(`│  ${line}`);
  }

  // POSITION 2 — messages
  console.log("\n┌─ POSITION 2 ── messages[] ───────────────────────────");
  console.log(`│  ${messagesForApi.length} messages (history: ${history.length} + new input: 1)`);

  let messagesTokens = 0;
  messagesForApi.forEach((msg, i) => {
    const blocks = Array.isArray(msg.content)
      ? msg.content
      : [{ type: "text", text: msg.content } as const];
    blocks.forEach((block, j) => {
      const desc = describeBlock(block);
      const cache = hasCacheControl(block) ? "  🟢 cache_control" : "";
      const tokens = estTokens(JSON.stringify(block));
      messagesTokens += tokens;
      const idx =
        blocks.length === 1 ? `[${i}]` : `[${i}.${j}]`;
      console.log(`│  ${idx.padEnd(7)} ${msg.role.padEnd(10)} ${desc}${cache}`);
    });
  });
  console.log(`│                                          subtotal: ~${messagesTokens} tok`);

  // ---- Totals ------------------------------------------------------------

  const total = toolTokens + systemTokens + messagesTokens;
  console.log("\n" + "=".repeat(70));
  console.log(`ROUGH TOKEN TOTAL:  ~${total} tok`);
  console.log(`  tools:            ~${toolTokens}`);
  console.log(`  system:           ~${systemTokens}`);
  console.log(`  messages:         ~${messagesTokens}`);
  console.log("─".repeat(70));
  if (total < 2048) {
    console.log("⚠️  total < 2048 tok — sonnet 4.6 minimum cacheable prefix.");
    console.log("   nothing will actually be cached until the prefix grows past this.");
  } else {
    console.log(
      `✓  total ≥ 2048 tok — cache_control on the trailing message block`,
    );
    console.log(
      `   will cache the full ${total}-token prefix (read on the next turn).`,
    );
  }
  console.log("=".repeat(70));

  await closeDb();
}

main().catch(async (err) => {
  console.error("error:", err);
  await closeDb();
  process.exit(1);
});
