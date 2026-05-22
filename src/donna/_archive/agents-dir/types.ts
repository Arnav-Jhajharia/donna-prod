// shared types for the agent thread / watch substrate.
//
// a thread is a long-lived sub-agent conversation: its own message history,
// its own metadata, addressable by id. watches are the first (and currently
// only) "kind" of thread.

import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages";

export type ThreadKind = "watch";
export type ThreadStatus = "open" | "paused" | "done";

export interface AgentThread {
  id: string;
  user_id: string;
  kind: ThreadKind;
  name: string;
  metadata: Record<string, unknown>;
  status: ThreadStatus;
  created_at: string;
  updated_at: string;
}

export interface AgentMessageRow {
  id: string;        // bigserial as string (postgres returns big numbers as strings)
  thread_id: string;
  role: "user" | "assistant";
  content: ContentBlockParam[];
  created_at: string;
}

// trigger_spec discriminated union. v1 supports cron and one_shot.
export type TriggerSpec =
  | { kind: "cron"; schedule: string; timezone?: string }
  | { kind: "one_shot"; fire_at: string };

export type WatchStatus = "active" | "paused" | "closed";

export interface WatchRow {
  id: string;
  user_id: string;
  thread_id: string;
  name: string;
  description: string;
  trigger_spec: TriggerSpec;
  initial_context: Record<string, unknown>;
  status: WatchStatus;
  created_at: string;
  updated_at: string;
}
