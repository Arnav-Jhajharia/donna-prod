import type {
  MessageParam,
  ContentBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import { eq, desc } from "drizzle-orm";
import { db } from "./db.js";
import { chatMessages } from "./db/schema.js";

// load + save the brain's conversation history. one row per MessageParam,
// keyed by user_id, ordered by seq (bigserial monotonic insert order).
//
// the brain itself is stateless — `runTurn(history, config)` is a pure
// function of the inputs. this is where persistence lives.

const LOAD_LIMIT = 50;
type Role = "user" | "assistant";
type Mode = "reactive" | "proactive";

// MessageParam.content can be a string (sugar) or an array of blocks.
// we always persist as an array — uniform shape in the db, no later code
// needs to handle both forms.
function normalizeContent(raw: MessageParam["content"]): ContentBlockParam[] {
  if (typeof raw === "string") return [{ type: "text", text: raw }];
  return raw as ContentBlockParam[];
}

// consecutive same-role rows get merged into one MessageParam — anthropic's
// api rejects two assistant messages in a row, and our tool_result rows are
// stored as their own row but live in the same user message at runtime.
function coalesce(
  rows: { role: string; content: unknown }[],
): MessageParam[] {
  const out: MessageParam[] = [];
  for (const row of rows) {
    const role = row.role as Role;
    const content = row.content as ContentBlockParam[];
    const last = out[out.length - 1];
    if (last && last.role === role) {
      const prev = Array.isArray(last.content)
        ? last.content
        : [{ type: "text" as const, text: last.content }];
      last.content = [...prev, ...content];
    } else {
      out.push({ role, content: [...content] });
    }
  }
  return out;
}

export async function loadRecentMessages(
  userId: string,
  limit: number = LOAD_LIMIT,
): Promise<MessageParam[]> {
  // fetch DESC so the LIMIT trims the oldest. reverse to chronological for
  // the api, then coalesce same-role runs into single MessageParams.
  const rows = await db
    .select({ role: chatMessages.role, content: chatMessages.content })
    .from(chatMessages)
    .where(eq(chatMessages.userId, userId))
    .orderBy(desc(chatMessages.seq))
    .limit(limit);
  return coalesce([...rows].reverse());
}

export async function saveMessages(
  userId: string,
  messages: MessageParam[],
  mode: Mode = "reactive",
): Promise<void> {
  if (messages.length === 0) return;
  await db.insert(chatMessages).values(
    messages.map((m) => ({
      userId,
      role: m.role,
      content: normalizeContent(m.content),
      mode,
    })),
  );
}
