import type {
  MessageParam,
  ContentBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import { getSql } from "../db.js";

const LOAD_LIMIT = 50;

type Role = "user" | "assistant";
type Mode = "reactive" | "proactive";

interface ChatRow {
  role: Role;
  content: ContentBlockParam[];
}

function normalizeContent(
  raw: MessageParam["content"],
): ContentBlockParam[] {
  if (typeof raw === "string") {
    return [{ type: "text", text: raw }];
  }
  return raw as ContentBlockParam[];
}

function coalesce(rows: ChatRow[]): MessageParam[] {
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

export async function loadRecentMessages(
  userId: string,
  limit: number = LOAD_LIMIT,
): Promise<MessageParam[]> {
  const sql = getSql();
  const rows = await sql<ChatRow[]>`
    select role, content
    from chat_messages
    where user_id = ${userId}
    order by seq desc
    limit ${limit}
  `;
  // rows came back DESC; we want chronological ASC for the API
  const chronological: ChatRow[] = [...rows].reverse();
  return coalesce(chronological);
}

export async function saveMessages(
  userId: string,
  messages: MessageParam[],
  mode: Mode,
): Promise<void> {
  if (messages.length === 0) return;
  const sql = getSql();
  const values = messages.map((m) => ({
    user_id: userId,
    role: m.role,
    content: sql.json(normalizeContent(m.content) as unknown as Parameters<typeof sql.json>[0]),
    mode,
  }));
  await sql`
    insert into chat_messages ${sql(values, "user_id", "role", "content", "mode")}
  `;
}
