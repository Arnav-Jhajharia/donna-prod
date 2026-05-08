import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { executeForUser } from "../integrations/service.js";

const PTC_CALLER = "code_execution_20250825" as const;
const PROVIDER = "gmail";

interface GmailListInput {
  since_hours?: number;
  limit?: number;
  query?: string;
}

interface GmailSearchInput {
  query: string;
  limit?: number;
}

interface GmailReadThreadInput {
  thread_id: string;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function clampLimit(n: number | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(n)));
}

function newerThan(hours: number | undefined): string | null {
  if (typeof hours !== "number" || hours <= 0) return null;
  const days = Math.max(1, Math.ceil(hours / 24));
  return `newer_than:${days}d`;
}

function joinQuery(parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => Boolean(p && p.trim())).join(" ");
}

// composio's GMAIL_FETCH_EMAILS returns a `messages` array. shape varies a bit
// between versions; we normalize to a small surface the model can reason over.
interface RawGmailMessage {
  messageId?: string;
  threadId?: string;
  sender?: string;
  to?: string;
  subject?: string;
  messageText?: string;
  preview?: { body?: string };
  labelIds?: string[];
  messageTimestamp?: string;
}

interface NormalizedMessage {
  id: string;
  thread_id: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  date: string;
  unread: boolean;
  labels: string[];
}

function normalize(raw: RawGmailMessage): NormalizedMessage {
  const labels = raw.labelIds ?? [];
  return {
    id: raw.messageId ?? "",
    thread_id: raw.threadId ?? "",
    from: raw.sender ?? "",
    to: raw.to ?? "",
    subject: raw.subject ?? "",
    snippet: (raw.preview?.body ?? raw.messageText ?? "").slice(0, 280),
    date: raw.messageTimestamp ?? "",
    unread: labels.includes("UNREAD"),
    labels,
  };
}

// ---------------------------------------------------------------------------
// gmail_list_recent — recent inbox, optional since_hours window
// ---------------------------------------------------------------------------

export const gmailListRecentTool: Tool = {
  name: "gmail_list_recent",
  description: `list recent inbox messages, newest first.

returns up to N items, each with: id, thread_id, from, to, subject, snippet (≤280 chars), date (iso), unread (bool), labels (string[]).

typically called inside code_execution to filter/aggregate. for batch reasoning
("morning triage", "what's unread", "anything from rohan today") use this then
filter in code rather than loading everything into your context.

defaults: since_hours=24, limit=20. cap is 100.`,
  input_schema: {
    type: "object",
    properties: {
      since_hours: {
        type: "number",
        description: "look back this many hours. omit for last 24h.",
      },
      limit: {
        type: "number",
        description: "max results (1-100). default 20.",
      },
    },
  },
  allowed_callers: [PTC_CALLER],
  input_examples: [
    { since_hours: 14, limit: 30 },
    { since_hours: 168, limit: 100 },
    { limit: 20 },
  ],
};

export async function gmailListRecentHandler(
  input: unknown,
): Promise<NormalizedMessage[]> {
  const { since_hours, limit } = (input ?? {}) as GmailListInput;
  const query = joinQuery(["in:inbox", newerThan(since_hours ?? 24)]);
  const data = await executeForUser<{ messages?: RawGmailMessage[] }>(
    PROVIDER,
    "GMAIL_FETCH_EMAILS",
    { query, max_results: clampLimit(limit) },
    { action: "read.list", meta: { query, since_hours: since_hours ?? 24, limit } },
  );
  return (data.messages ?? []).map(normalize);
}

// ---------------------------------------------------------------------------
// gmail_search — arbitrary gmail query syntax
// ---------------------------------------------------------------------------

export const gmailSearchTool: Tool = {
  name: "gmail_search",
  description: `search gmail with full gmail query syntax.

returns up to N items with the same shape as gmail_list_recent.

query examples (real gmail syntax):
- "from:rohan@example.com newer_than:7d"
- "subject:invoice has:attachment"
- "anthropic newer_than:30d"
- "in:sent newer_than:14d"   ← finds emails YOU sent
- "label:starred is:unread"

typically called inside code_execution. fan out multiple searches with
asyncio.gather when you need cross-cutting views.

defaults: limit=20. cap is 100.`,
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "gmail query string. required.",
      },
      limit: {
        type: "number",
        description: "max results (1-100). default 20.",
      },
    },
    required: ["query"],
  },
  allowed_callers: [PTC_CALLER],
  input_examples: [
    { query: "from:rohan@anthropic.com newer_than:7d" },
    { query: "anthropic deal", limit: 30 },
    { query: "in:sent newer_than:14d", limit: 100 },
    { query: "label:starred is:unread" },
  ],
};

export async function gmailSearchHandler(
  input: unknown,
): Promise<NormalizedMessage[]> {
  const { query, limit } = (input ?? {}) as GmailSearchInput;
  if (!query || typeof query !== "string") {
    throw new Error("gmail_search: query required");
  }
  const data = await executeForUser<{ messages?: RawGmailMessage[] }>(
    PROVIDER,
    "GMAIL_FETCH_EMAILS",
    { query, max_results: clampLimit(limit) },
    { action: "read.search", meta: { query, limit } },
  );
  return (data.messages ?? []).map(normalize);
}

// ---------------------------------------------------------------------------
// gmail_list_sent — emails YOU sent (typed wrapper around search)
// ---------------------------------------------------------------------------

export const gmailListSentTool: Tool = {
  name: "gmail_list_sent",
  description: `list emails you sent, newest first. typed wrapper for "in:sent" searches.

returns the same normalized shape as gmail_list_recent.

use this for commitment-tracking flows: scan what you promised, cross-reference
with received replies in the same thread to detect open commitments.

defaults: since_hours=336 (14d), limit=50. cap is 100.`,
  input_schema: {
    type: "object",
    properties: {
      since_hours: {
        type: "number",
        description: "look back this many hours. default 336 (14d).",
      },
      limit: {
        type: "number",
        description: "max results (1-100). default 50.",
      },
    },
  },
  allowed_callers: [PTC_CALLER],
  input_examples: [
    { since_hours: 168, limit: 50 },
    { since_hours: 336, limit: 100 },
    {},
  ],
};

export async function gmailListSentHandler(
  input: unknown,
): Promise<NormalizedMessage[]> {
  const { since_hours, limit } = (input ?? {}) as GmailListInput;
  const query = joinQuery(["in:sent", newerThan(since_hours ?? 336)]);
  const data = await executeForUser<{ messages?: RawGmailMessage[] }>(
    PROVIDER,
    "GMAIL_FETCH_EMAILS",
    { query, max_results: clampLimit(limit ?? 50) },
    { action: "read.list", meta: { query, since_hours: since_hours ?? 336, limit: limit ?? 50, scope: "sent" } },
  );
  return (data.messages ?? []).map(normalize);
}

// ---------------------------------------------------------------------------
// gmail_read_thread — full body of a thread by id
// ---------------------------------------------------------------------------

interface ThreadMessage {
  id: string;
  from: string;
  to: string;
  date: string;
  subject: string;
  body: string;
  labels: string[];
}

interface ThreadResult {
  thread_id: string;
  messages: ThreadMessage[];
  participants: string[];
  unread: boolean;
  last_message_date: string;
}

interface RawGmailThread {
  threadId?: string;
  messages?: RawGmailMessage[];
}

export const gmailReadThreadTool: Tool = {
  name: "gmail_read_thread",
  description: `fetch the full body of a thread by id. returns every message in the thread.

shape: { thread_id, messages: [{id, from, to, date, subject, body, labels}], participants, unread, last_message_date }.

use when you have a thread_id (from gmail_list_recent / gmail_search) and need
to actually read the conversation. typically called inside asyncio.gather over
many thread ids to fan out reads.`,
  input_schema: {
    type: "object",
    properties: {
      thread_id: {
        type: "string",
        description: "the gmail thread id (from a list/search result).",
      },
    },
    required: ["thread_id"],
  },
  allowed_callers: [PTC_CALLER],
  input_examples: [{ thread_id: "18c0a1b2c3d4e5f6" }],
};

export async function gmailReadThreadHandler(
  input: unknown,
): Promise<ThreadResult> {
  const { thread_id } = (input ?? {}) as GmailReadThreadInput;
  if (!thread_id || typeof thread_id !== "string") {
    throw new Error("gmail_read_thread: thread_id required");
  }

  const raw = await executeForUser<RawGmailThread>(
    PROVIDER,
    "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
    { thread_id },
    { action: "read.thread", itemRef: thread_id },
  );

  const rawMessages = raw.messages ?? [];
  const messages: ThreadMessage[] = rawMessages.map((m) => ({
    id: m.messageId ?? "",
    from: m.sender ?? "",
    to: m.to ?? "",
    date: m.messageTimestamp ?? "",
    subject: m.subject ?? "",
    body: (m.messageText ?? m.preview?.body ?? "").slice(0, 4000),
    labels: m.labelIds ?? [],
  }));

  const participants = Array.from(
    new Set(messages.flatMap((m) => [m.from, m.to]).filter(Boolean)),
  );
  const unread = messages.some((m) => m.labels.includes("UNREAD"));
  const last = messages[messages.length - 1];

  return {
    thread_id: raw.threadId ?? thread_id,
    messages,
    participants,
    unread,
    last_message_date: last?.date ?? "",
  };
}
