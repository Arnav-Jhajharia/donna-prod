import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { searchMem0 } from "../memory/mem0.js";
import {
  searchEpisodes,
  searchFacts,
  searchOpenLoops,
} from "../memory/store.js";

type RecallScope = "auto" | "episodes" | "facts" | "open_loops";

export const recallTool: Tool = {
  name: "recall",
  description: `search donna's memory. use this when the user asks about past discussions, what donna knows about them, current unresolved work, prior decisions, or anything that requires memory beyond recent chat.

when to use:
- "what did we decide about..."
- "what do you remember about..."
- "what are we working on"
- "what is unresolved"
- when the user references an older topic not visible in recent chat

when NOT to use:
- simple replies answerable from the current message or recent visible context
- generic knowledge questions
- current time questions; use get_current_time instead`,
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        minLength: 1,
        description: "natural language memory search query.",
      },
      scope: {
        type: "string",
        enum: ["auto", "episodes", "facts", "open_loops"],
        description: "optional memory lane. default auto searches all lanes.",
      },
    },
    required: ["query"],
  },
};

function parseScope(value: unknown): RecallScope {
  if (
    value === "episodes" ||
    value === "facts" ||
    value === "open_loops" ||
    value === "auto"
  ) {
    return value;
  }
  return "auto";
}

export async function recallHandler(input: unknown): Promise<unknown> {
  const userId = process.env.DONNA_USER_ID;
  if (!userId) throw new Error("DONNA_USER_ID not set");

  const obj = (input ?? {}) as { query?: unknown; scope?: unknown };
  const query = typeof obj.query === "string" ? obj.query.trim() : "";
  if (!query) throw new Error("query is required");
  const scope = parseScope(obj.scope);

  const [episodes, facts, openLoops, mem0] = await Promise.all([
    scope === "auto" || scope === "episodes"
      ? searchEpisodes(userId, query, 6)
      : Promise.resolve([]),
    scope === "auto" || scope === "facts"
      ? searchFacts(userId, query, 10)
      : Promise.resolve([]),
    scope === "auto" || scope === "open_loops"
      ? searchOpenLoops(userId, query, 10)
      : Promise.resolve([]),
    scope === "auto" || scope === "episodes"
      ? searchMem0({ userId, query, limit: 5 }).catch(() => [])
      : Promise.resolve([]),
  ]);

  return {
    query,
    scope,
    facts: facts.map((fact) => ({
      id: fact.id,
      content: fact.content,
      category: fact.category,
      confidence: Number(fact.confidence),
      source_episode_id: fact.source_episode_id,
    })),
    open_loops: openLoops.map((loop) => ({
      id: loop.id,
      content: loop.content,
      priority: loop.priority,
      due_at: loop.due_at,
      source_episode_id: loop.source_episode_id,
    })),
    episodes: episodes.map((episode) => ({
      id: episode.id,
      title: episode.title,
      summary: episode.summary,
      topics: episode.topics,
      start_seq: Number(episode.start_seq),
      end_seq: Number(episode.end_seq),
    })),
    semantic_memory: mem0.map((hit) => ({
      id: hit.id,
      content: hit.content ?? hit.memory,
      score: hit.score,
      metadata: hit.metadata,
    })),
  };
}
