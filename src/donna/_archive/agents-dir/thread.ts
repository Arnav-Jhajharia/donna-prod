// agent thread storage. mirrors memory/chat.ts but for per-thread agent
// histories. load returns chronological MessageParam[]; append takes the
// newMessages the runner emitted this firing.

import type {
  MessageParam,
  ContentBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import { getSql } from "../db.js";
import type { AgentThread, ThreadKind, ThreadStatus, AgentMessageRow } from "./types.js";

const LOAD_LIMIT = 50;

function normalizeContent(raw: MessageParam["content"]): ContentBlockParam[] {
  if (typeof raw === "string") {
    return [{ type: "text", text: raw }];
  }
  return raw as ContentBlockParam[];
}

// coalesce consecutive same-role rows into a single MessageParam. same logic
// as memory/chat.ts — the api requires alternating user/assistant, but
// storage rows aren't required to alternate (a tool_use+tool_result pair is
// "assistant then user", but a watch firing's <trigger_fired> is a "user"
// message that may follow another "user" if storage was non-alternating).
function coalesce(rows: Array<{ role: "user" | "assistant"; content: ContentBlockParam[] }>): MessageParam[] {
  const out: MessageParam[] = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (last && last.role === row.role) {
      const prev = Array.isArray(last.content)
        ? last.content
        : [{ type: "text" as const, text: last.content }];
      last.content = [...prev, ...row.content];
    } else {
      out.push({ role: row.role, content: [...row.content] });
    }
  }
  return out;
}

export async function createThread(args: {
  userId: string;
  kind: ThreadKind;
  name: string;
  metadata?: Record<string, unknown>;
}): Promise<AgentThread> {
  const sql = getSql();
  const rows = await sql<AgentThread[]>`
    insert into agent_threads (user_id, kind, name, metadata)
    values (${args.userId}, ${args.kind}, ${args.name}, ${sql.json((args.metadata ?? {}) as Parameters<typeof sql.json>[0])})
    returning id, user_id, kind, name, metadata, status, created_at, updated_at
  `;
  if (rows.length === 0) throw new Error("createThread: insert returned no rows");
  return rows[0]!;
}

export async function loadThread(threadId: string): Promise<AgentThread | null> {
  const sql = getSql();
  const rows = await sql<AgentThread[]>`
    select id, user_id, kind, name, metadata, status, created_at, updated_at
    from agent_threads
    where id = ${threadId}
    limit 1
  `;
  return rows[0] ?? null;
}

export async function loadThreadMessages(
  threadId: string,
  limit: number = LOAD_LIMIT,
): Promise<MessageParam[]> {
  const sql = getSql();
  // bigserial id is monotonic per insert; ordering by id gives chronological.
  // we fetch the MOST RECENT `limit` rows then reverse to chronological asc.
  const rows = await sql<Array<{ role: "user" | "assistant"; content: ContentBlockParam[] }>>`
    select role, content
    from agent_messages
    where thread_id = ${threadId}
    order by id desc
    limit ${limit}
  `;
  const chronological = [...rows].reverse();
  return coalesce(chronological);
}

export async function appendMessages(
  threadId: string,
  messages: MessageParam[],
): Promise<void> {
  if (messages.length === 0) return;
  const sql = getSql();
  const values = messages.map((m) => ({
    thread_id: threadId,
    role: m.role,
    content: sql.json(normalizeContent(m.content) as unknown as Parameters<typeof sql.json>[0]),
  }));
  await sql`
    insert into agent_messages ${sql(values, "thread_id", "role", "content")}
  `;
}

export async function updateThreadMetadata(
  threadId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const sql = getSql();
  await sql`
    update agent_threads
    set metadata = ${sql.json(metadata as Parameters<typeof sql.json>[0])},
        updated_at = now()
    where id = ${threadId}
  `;
}

export async function setThreadStatus(
  threadId: string,
  status: ThreadStatus,
): Promise<void> {
  const sql = getSql();
  await sql`
    update agent_threads
    set status = ${status},
        updated_at = now()
    where id = ${threadId}
  `;
}

// fetched primarily for debug surfaces (/debug/threads etc).
export async function listMessagesRaw(
  threadId: string,
  limit: number = 200,
): Promise<AgentMessageRow[]> {
  const sql = getSql();
  const rows = await sql<AgentMessageRow[]>`
    select id::text as id, thread_id, role, content, created_at
    from agent_messages
    where thread_id = ${threadId}
    order by id asc
    limit ${limit}
  `;
  return [...rows];
}
