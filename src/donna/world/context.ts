// build a WorldContext from what donna actually knows about the user:
// - supermemory hits for identity / projects / watches / open loops
// - recent chat thread (last few exchanges) for grounding moves to fresh signal
//
// this is the bridge from "memory" to "world engine". without it, query_creation
// has nothing to anchor moves on and silence-by-default kicks in immediately.

import type { ContentBlockParam, MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { getMemoryClient } from "../integrations/supermemory.js";
import { loadRecentMessages } from "../memory/chat.js";
import type { WorldContext } from "./types.js";

const PROFILE_QUERY =
  "what is this user working on, watching, planning, and waiting on right now";
const PROFILE_LIMIT = 20;
const RECENT_THREAD_TAIL = 10;
const MAX_BLURB_CHARS = 4000;

export interface BuildWorldContextArgs {
  user_id: string;
  trigger: string;
  // optional override — useful for tests and one-off ticks
  profile_blurb?: string;
}

export async function buildWorldContext(args: BuildWorldContextArgs): Promise<WorldContext> {
  const [profileBlurb, recentThread] = await Promise.all([
    args.profile_blurb !== undefined
      ? Promise.resolve(args.profile_blurb)
      : loadProfileBlurb(args.user_id),
    loadRecentThread(args.user_id),
  ]);

  return {
    user_id: args.user_id,
    profile_blurb: profileBlurb,
    recent_thread: recentThread,
    current_datetime: new Date().toISOString(),
    trigger: args.trigger,
  };
}

async function loadProfileBlurb(userId: string): Promise<string> {
  const client = getMemoryClient();
  if (!client.available) return "";
  const memories = await client.searchWithGraph({
    userId,
    query: PROFILE_QUERY,
    limit: PROFILE_LIMIT,
  });
  if (memories.length === 0) return "";
  const lines = memories
    .map((m) => `- ${m.content.replace(/\s+/g, " ").trim()}`)
    .filter((line) => line.length > 2);
  return joinClipped(lines, MAX_BLURB_CHARS);
}

async function loadRecentThread(userId: string): Promise<string> {
  const recent = await loadRecentMessages(userId);
  return recent
    .slice(-RECENT_THREAD_TAIL)
    .map((m) => `${m.role}: ${flattenContent(m.content)}`)
    .filter((line) => line.length > 0)
    .join("\n");
}

function flattenContent(content: MessageParam["content"]): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return (content as ContentBlockParam[])
    .map((b) => (b.type === "text" ? b.text : ""))
    .join(" ")
    .trim();
}

function joinClipped(lines: string[], maxChars: number): string {
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > maxChars) break;
    out.push(line);
    used += line.length + 1;
  }
  return out.join("\n");
}
