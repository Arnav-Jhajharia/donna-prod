// recall — semantic + graph search over the user's backfilled content
// (gmail history today; other providers later). direct-callable only.
//
// donna calls this when the user is trying to remember a SPECIFIC PIECE OF
// CONTENT — a thing maya said, an email about a topic, the contract from acme.
// it's NOT for "list all X" or temporal questions ("what's today") — those
// belong to gmail_list_recent / gmail_search / day-events.

import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../brain.js";
import { getTurnContext } from "../context.js";
import { getMemoryClient } from "../integrations/supermemory.js";

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;

interface RecallInput {
  query?: string;
  limit?: number;
}

function clampLimit(n: number | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(n)));
}

export const recallTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "recall",
  description: `semantic + graph recall over the user's backfilled history (gmail today, more later).

call this when the user is trying to remember a SPECIFIC PIECE OF CONTENT they can describe in meaning but not in exact words:
- "what did maya say about housing"
- "the email about the contract from acme"
- "did anyone mention rate limits last month"
- "remember when X talked about Y"

do NOT call for:
- "list all X" / "everything from rohan" → use gmail_search with a from: filter
- "what's today" / "what arrived in the last hour" → use gmail_list_recent
- single-word lookups that are really searches → use gmail_search

returns: { results: [{ id, content, score, updated_at, metadata, relations }, ...] }
each result is a memory chunk with provenance metadata (source, msg_id, thread_id, from, subject, date).
relations is a small list of related memories surfaced by the graph layer.

after recall, summarize what's relevant in send_burst — never quote raw chunks verbatim.`,
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "free-form description of what the user is trying to recall.",
      },
      limit: {
        type: "number",
        description: "max results to return (1-20). default 8.",
      },
    },
    required: ["query"],
  },
  // available in both modes — proactive turns may also need to recall historical
  // context to compose a meaningful surface (e.g. "rohan's third ask this week").
  modes: new Set<BrainMode>(["reactive", "proactive"]),
};

export async function recallHandler(input: unknown): Promise<unknown> {
  const { query, limit } = (input ?? {}) as RecallInput;
  if (!query || typeof query !== "string") {
    throw new Error("recall: query required");
  }
  const ctx = getTurnContext();
  const client = getMemoryClient();
  if (!client.available) {
    return {
      results: [],
      warning: "supermemory unavailable (SUPERMEMORY_API_KEY not set)",
    };
  }
  const results = await client.searchWithGraph({
    userId: ctx.userId,
    query,
    limit: clampLimit(limit),
  });
  return { results, count: results.length };
}
