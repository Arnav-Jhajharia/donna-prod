import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { addEpisodeToMem0, isMem0Enabled } from "./mem0.js";
import {
  closeOpenLoopsByText,
  createEpisode,
  ensureMemoryState,
  getRowsAfterSeq,
  listFacts,
  listOpenLoops,
  markEpisodeSeq,
  supersedeFactsByText,
  updateMemoryState,
  upsertFacts,
  upsertOpenLoops,
  type ChatLedgerRow,
  type Fact,
  type OpenLoop,
} from "./store.js";

const MODEL = "claude-sonnet-4-6";
const MAX_LEDGER_ROWS = 30;

const client = new Anthropic();

interface ExtractedMemory {
  title: string;
  summary: string;
  topics: string[];
  facts: Array<{ content: string; category: string; confidence?: number }>;
  open_loops: Array<{ content: string; priority?: string; due_at?: string | null }>;
  superseded_facts: string[];
  closed_open_loops: string[];
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content);

  const parts: string[] = [];
  for (const block of content as ContentBlockParam[]) {
    if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "tool_use") {
      if (block.name === "send_burst") {
        const input = block.input as { messages?: unknown };
        const sends = Array.isArray(input.messages)
          ? input.messages.filter((m): m is string => typeof m === "string")
          : [];
        parts.push(`send_burst: ${sends.join(" | ")}`);
      } else {
        parts.push(`tool_use: ${block.name} ${JSON.stringify(block.input)}`);
      }
    } else if (block.type === "tool_result") {
      parts.push(`tool_result: ${JSON.stringify(block.content)}`);
    }
  }
  return parts.join("\n");
}

function formatLedger(rows: ChatLedgerRow[]): string {
  return rows
    .map((row) => {
      const text = textFromContent(row.content).trim();
      return `[seq ${row.seq}] ${row.role}: ${text}`;
    })
    .join("\n\n");
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced?.[1] ?? text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("memory extractor did not return json");
  }
  return JSON.parse(raw.slice(start, end + 1));
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizeExtraction(value: unknown): ExtractedMemory {
  const obj = (value ?? {}) as Record<string, unknown>;
  const facts = Array.isArray(obj.facts) ? obj.facts : [];
  const loops = Array.isArray(obj.open_loops) ? obj.open_loops : [];
  return {
    title: typeof obj.title === "string" && obj.title.trim() ? obj.title.trim() : "Donna turn",
    summary:
      typeof obj.summary === "string" && obj.summary.trim()
        ? obj.summary.trim()
        : "No summary extracted.",
    topics: asStringArray(obj.topics).slice(0, 8),
    facts: facts
      .map((item) => item as Record<string, unknown>)
      .filter((item) => typeof item.content === "string" && item.content.trim())
      .map((item) => ({
        content: String(item.content).trim(),
        category: typeof item.category === "string" ? item.category : "general",
        confidence:
          typeof item.confidence === "number" ? Math.max(0, Math.min(1, item.confidence)) : 0.8,
      }))
      .slice(0, 8),
    open_loops: loops
      .map((item) => item as Record<string, unknown>)
      .filter((item) => typeof item.content === "string" && item.content.trim())
      .map((item) => ({
        content: String(item.content).trim(),
        priority: typeof item.priority === "string" ? item.priority : "normal",
        due_at: typeof item.due_at === "string" ? item.due_at : null,
      }))
      .slice(0, 8),
    superseded_facts: asStringArray(obj.superseded_facts).slice(0, 8),
    closed_open_loops: asStringArray(obj.closed_open_loops).slice(0, 8),
  };
}

async function extractMemory(rows: ChatLedgerRow[]): Promise<ExtractedMemory> {
  const ledger = formatLedger(rows);
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 1800,
    temperature: 0,
    system:
      "You extract Donna memory from a chat ledger. Return only valid JSON. Do not invent facts. Facts are durable truths. Open loops are unresolved commitments, questions, decisions, reminders, or tasks. If the user corrects or rejects a prior memory, include text fragments in superseded_facts or closed_open_loops.",
    messages: [
      {
        role: "user",
        content: `Extract memory from this ledger range.\n\nReturn JSON with exactly these keys:\n{\n  "title": string,\n  "summary": string,\n  "topics": string[],\n  "facts": [{"content": string, "category": string, "confidence": number}],\n  "open_loops": [{"content": string, "priority": "low"|"normal"|"high", "due_at": string|null}],\n  "superseded_facts": string[],\n  "closed_open_loops": string[]\n}\n\nLedger:\n${ledger}`,
      },
    ],
  });
  const text = resp.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  return normalizeExtraction(extractJson(text));
}

async function synthesizeState(args: {
  previousProfile: string;
  previousBrief: string;
  latestEpisode: { title: string; summary: string; topics: string[] };
  facts: Fact[];
  openLoops: OpenLoop[];
}): Promise<{ living_profile: string; situation_brief: string }> {
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 1400,
    temperature: 0,
    system:
      "You synthesize Donna's memory state. Return only JSON. living_profile is durable user model. situation_brief is current working state. Be compact, concrete, and do not invent.",
    messages: [
      {
        role: "user",
        content: JSON.stringify(
          {
            previous_living_profile: args.previousProfile,
            previous_situation_brief: args.previousBrief,
            latest_episode: args.latestEpisode,
            active_facts: args.facts.map((fact) => ({
              content: fact.content,
              category: fact.category,
            })),
            active_open_loops: args.openLoops.map((loop) => ({
              content: loop.content,
              priority: loop.priority,
              due_at: loop.due_at,
            })),
            return_shape: {
              living_profile: "300-700 word durable user model",
              situation_brief: "150-300 word current situation brief",
            },
          },
          null,
          2,
        ),
      },
    ],
  });
  const text = resp.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const obj = extractJson(text) as Record<string, unknown>;
  return {
    living_profile:
      typeof obj.living_profile === "string" ? obj.living_profile.trim() : args.previousProfile,
    situation_brief:
      typeof obj.situation_brief === "string" ? obj.situation_brief.trim() : args.previousBrief,
  };
}

export async function runPostTurnMemory(userId: string): Promise<void> {
  const state = await ensureMemoryState(userId);
  const lastSeq = Number(state.last_episode_seq || 0);
  const rows = await getRowsAfterSeq(userId, lastSeq, MAX_LEDGER_ROWS);
  if (rows.length === 0) return;

  const first = rows[0];
  const last = rows[rows.length - 1];
  if (!first || !last) return;

  const extracted = await extractMemory(rows);
  const episode = await createEpisode({
    userId,
    startSeq: Number(first.seq),
    endSeq: Number(last.seq),
    title: extracted.title,
    summary: extracted.summary,
    topics: extracted.topics,
    metadata: { extractor: "anthropic", mem0_enabled: isMem0Enabled() },
  });

  await supersedeFactsByText(userId, extracted.superseded_facts);
  await closeOpenLoopsByText(userId, extracted.closed_open_loops);
  const factsChanged = await upsertFacts({
    userId,
    episodeId: episode.id,
    facts: extracted.facts,
  });
  await upsertOpenLoops({
    userId,
    episodeId: episode.id,
    openLoops: extracted.open_loops,
  });

  try {
    await addEpisodeToMem0({
      userId,
      episodeId: episode.id,
      content: `${episode.title}\n\n${episode.summary}`,
      metadata: {
        start_seq: episode.start_seq,
        end_seq: episode.end_seq,
        topics: episode.topics,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[memory] mem0 write skipped: ${msg}`);
  }

  const facts = await listFacts(userId, 40);
  const openLoops = await listOpenLoops(userId, 20);
  const synthesized = await synthesizeState({
    previousProfile: state.living_profile,
    previousBrief: state.situation_brief,
    latestEpisode: {
      title: episode.title,
      summary: episode.summary,
      topics: episode.topics,
    },
    facts,
    openLoops,
  });

  await updateMemoryState({
    userId,
    situationBrief: synthesized.situation_brief,
    livingProfile: factsChanged > 0 ? synthesized.living_profile : undefined,
  });
  await markEpisodeSeq(userId, Number(last.seq));
}
