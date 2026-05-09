// gmail threads tools — donna's surface for the threads/people layer.
//
// readers (PTC-callable, both modes):
//   threads_open_for_me   — what's the user the bottleneck on, sorted by importance × age
//   threads_search        — find threads by participant / subject / keyword
//   threads_get           — full detail for one thread
//   people_top            — top people by salience (who matters)
//
// writers (direct, reactive only):
//   threads_mark_done     — close a thread / dismiss it
//   threads_pin           — always-show, even if importance is low

import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../brain.js";
import { getSql } from "../db.js";
import { getTurnContext } from "../context.js";
import type {
  ThreadView,
  PersonView,
  ThreadState,
  BallInCourt,
} from "../extractors/threads/types.js";

const PTC_CALLER = "code_execution_20250825" as const;

// ──────────────────────────────────────────────────────────────────────────
// helpers
// ──────────────────────────────────────────────────────────────────────────

interface RawThreadRow {
  id: string;
  user_id: string;
  gmail_thread_id: string;
  subject: string | null;
  participants: string[];
  last_inbound_from: string | null;
  message_count: number;
  state: string;
  ball_in_court: string | null;
  awaiting_since: string | null;
  one_line_summary: string | null;
  importance_score: number;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  last_event_at: string;
  user_dismissed: boolean;
  user_pinned: boolean;
  created_at: string;
  updated_at: string;
}

function rowToThreadView(r: RawThreadRow): ThreadView {
  return {
    id: r.id,
    user_id: r.user_id,
    gmail_thread_id: r.gmail_thread_id,
    subject: r.subject,
    participants: r.participants,
    last_inbound_from: r.last_inbound_from,
    message_count: r.message_count,
    state: r.state as ThreadState,
    ball_in_court: r.ball_in_court as BallInCourt,
    awaiting_since: r.awaiting_since,
    one_line_summary: r.one_line_summary,
    importance_score: r.importance_score,
    last_inbound_at: r.last_inbound_at,
    last_outbound_at: r.last_outbound_at,
    last_event_at: r.last_event_at,
    user_dismissed: r.user_dismissed,
    user_pinned: r.user_pinned,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const d = (Date.now() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000);
  return Number.isFinite(d) ? Math.max(0, d) : null;
}

// ──────────────────────────────────────────────────────────────────────────
// threads_open_for_me
// ──────────────────────────────────────────────────────────────────────────

export const threadsOpenForMeTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "threads_open_for_me",
  description: `list email threads where the USER is the bottleneck — they owe a reply or decision.

returns: { threads: [{id, gmail_thread_id, subject, last_inbound_from, one_line_summary, importance_score, awaiting_since, days_waiting, message_count}], count }.

sorted by importance × age (oldest important things bubble up first).

call when user asks:
- "what's open on me"
- "who am i ghosting"
- "what do i need to reply to"
- (proactively) when composing a morning summary or "anything urgent"`,
  input_schema: {
    type: "object",
    properties: {
      limit: { type: "integer", description: "max rows (default 10)." },
      min_importance: { type: "number", description: "0..1 floor (default 0.3)." },
    },
  },
  allowed_callers: [PTC_CALLER],
  input_examples: [{}, { limit: 5, min_importance: 0.5 }],
  modes: new Set<BrainMode>(["reactive", "proactive"]),
};

interface ThreadsOpenForMeInput {
  limit?: number;
  min_importance?: number;
}

export async function threadsOpenForMeHandler(input: unknown): Promise<unknown> {
  const { limit, min_importance } = (input ?? {}) as ThreadsOpenForMeInput;
  const lim = Math.min(50, Math.max(1, limit ?? 10));
  const floor = Math.max(0, Math.min(1, min_importance ?? 0.3));
  const ctx = getTurnContext();

  const sql = getSql();
  const rows = await sql<RawThreadRow[]>`
    select * from gmail_threads
    where user_id = ${ctx.userId}
      and user_dismissed = false
      and state = 'awaiting_user'
      and ball_in_court = 'user'
      and importance_score >= ${floor}
    order by (importance_score * (1 + extract(epoch from now() - coalesce(awaiting_since, last_event_at)) / 86400 / 7)) desc
    limit ${lim}
  `;

  const threads = rows.map((r) => {
    const v = rowToThreadView(r);
    return {
      ...v,
      days_waiting: daysSince(v.awaiting_since),
    };
  });

  return { threads, count: threads.length };
}

// ──────────────────────────────────────────────────────────────────────────
// threads_search
// ──────────────────────────────────────────────────────────────────────────

export const threadsSearchTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "threads_search",
  description: `search the threads index by participant email, subject substring, or general keyword. fast — operates on donna's typed thread store, not gmail directly.

returns: { threads: [{id, gmail_thread_id, subject, last_inbound_from, one_line_summary, state, ball_in_court, importance_score}], count }.

call when:
- "anything from raj"           → participant: "raj"
- "find the lease thread"       → keyword: "lease"
- "open threads with stripe"    → participant: "stripe", state: "awaiting_user"

if the user asks for a specific keyword that isn't in donna's index, fall back to the gmail_search tool — that hits gmail directly.`,
  input_schema: {
    type: "object",
    properties: {
      participant: { type: "string", description: "email substring (matches any participant)." },
      keyword: { type: "string", description: "substring matched against subject + one_line_summary." },
      state: {
        type: "string",
        enum: ["awaiting_user", "awaiting_other", "scheduled", "closed", "fyi"],
        description: "optional filter.",
      },
      limit: { type: "integer" },
    },
  },
  allowed_callers: [PTC_CALLER],
  input_examples: [{ participant: "raj" }, { keyword: "lease" }, { state: "awaiting_other", limit: 20 }],
  modes: new Set<BrainMode>(["reactive", "proactive"]),
};

interface ThreadsSearchInput {
  participant?: string;
  keyword?: string;
  state?: ThreadState;
  limit?: number;
}

export async function threadsSearchHandler(input: unknown): Promise<unknown> {
  const { participant, keyword, state, limit } = (input ?? {}) as ThreadsSearchInput;
  const lim = Math.min(50, Math.max(1, limit ?? 20));
  const ctx = getTurnContext();
  const sql = getSql();

  const rows = await sql<RawThreadRow[]>`
    select * from gmail_threads
    where user_id = ${ctx.userId}
      and user_dismissed = false
      ${participant
        ? sql`and exists (select 1 from unnest(participants) p where p ilike ${"%" + participant + "%"})`
        : sql``}
      ${keyword
        ? sql`and (coalesce(subject, '') ilike ${"%" + keyword + "%"} or coalesce(one_line_summary, '') ilike ${"%" + keyword + "%"})`
        : sql``}
      ${state ? sql`and state = ${state}` : sql``}
    order by importance_score desc, last_event_at desc
    limit ${lim}
  `;
  const threads = rows.map(rowToThreadView);
  return { threads, count: threads.length };
}

// ──────────────────────────────────────────────────────────────────────────
// threads_get
// ──────────────────────────────────────────────────────────────────────────

export const threadsGetTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "threads_get",
  description: `get full state for one thread by its donna id (NOT the gmail_thread_id). use this after threads_search / threads_open_for_me when you need every field.

if you need the message bodies themselves, follow up with gmail_read_thread using the gmail_thread_id from this row.`,
  input_schema: {
    type: "object",
    properties: { id: { type: "string", description: "donna's thread id (uuid)." } },
    required: ["id"],
  },
  allowed_callers: [PTC_CALLER],
  input_examples: [{ id: "f7d9..." }],
  modes: new Set<BrainMode>(["reactive", "proactive"]),
};

interface ThreadsGetInput {
  id?: string;
}

export async function threadsGetHandler(input: unknown): Promise<unknown> {
  const { id } = (input ?? {}) as ThreadsGetInput;
  if (!id) throw new Error("threads_get: id required");
  const ctx = getTurnContext();
  const sql = getSql();
  const rows = await sql<RawThreadRow[]>`
    select * from gmail_threads where id = ${id} and user_id = ${ctx.userId} limit 1
  `;
  if (rows.length === 0) return { thread: null };
  return { thread: rowToThreadView(rows[0]!) };
}

// ──────────────────────────────────────────────────────────────────────────
// threads_mark_done — direct, reactive
// ──────────────────────────────────────────────────────────────────────────

export const threadsMarkDoneTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "threads_mark_done",
  description: `mark a thread as closed (no longer needs the user). use when the user says "i replied", "handled it", "ignore that one", etc.

modes:
- mode="closed": user resolved it (default).
- mode="dismiss": uninteresting — never surface again, even if new replies come in.

returns the updated thread row.`,
  input_schema: {
    type: "object",
    properties: {
      id: { type: "string", description: "donna's thread id." },
      mode: { type: "string", enum: ["closed", "dismiss"], description: "default 'closed'." },
    },
    required: ["id"],
  },
  modes: new Set<BrainMode>(["reactive"]),
};

interface ThreadsMarkDoneInput {
  id?: string;
  mode?: "closed" | "dismiss";
}

export async function threadsMarkDoneHandler(input: unknown): Promise<unknown> {
  const { id, mode } = (input ?? {}) as ThreadsMarkDoneInput;
  if (!id) throw new Error("threads_mark_done: id required");
  const ctx = getTurnContext();
  const sql = getSql();
  const dismiss = mode === "dismiss";
  await sql`
    update gmail_threads set
      state = 'closed',
      ball_in_court = null,
      awaiting_since = null,
      user_dismissed = ${dismiss},
      updated_at = now()
    where id = ${id} and user_id = ${ctx.userId}
  `;
  const rows = await sql<RawThreadRow[]>`
    select * from gmail_threads where id = ${id} and user_id = ${ctx.userId} limit 1
  `;
  return { ok: true, thread: rows[0] ? rowToThreadView(rows[0]) : null };
}

// ──────────────────────────────────────────────────────────────────────────
// threads_pin — direct, reactive
// ──────────────────────────────────────────────────────────────────────────

export const threadsPinTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "threads_pin",
  description: `pin/unpin a thread so it always surfaces in threads_open_for_me regardless of the importance score. use when the user says "always remind me about X" or "stop highlighting Y".`,
  input_schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      pinned: { type: "boolean", description: "true to pin, false to unpin." },
    },
    required: ["id", "pinned"],
  },
  modes: new Set<BrainMode>(["reactive"]),
};

interface ThreadsPinInput {
  id?: string;
  pinned?: boolean;
}

export async function threadsPinHandler(input: unknown): Promise<unknown> {
  const { id, pinned } = (input ?? {}) as ThreadsPinInput;
  if (!id) throw new Error("threads_pin: id required");
  if (typeof pinned !== "boolean") throw new Error("threads_pin: pinned (bool) required");
  const ctx = getTurnContext();
  const sql = getSql();
  await sql`
    update gmail_threads set user_pinned = ${pinned}, updated_at = now()
    where id = ${id} and user_id = ${ctx.userId}
  `;
  return { ok: true };
}

// ──────────────────────────────────────────────────────────────────────────
// people_top
// ──────────────────────────────────────────────────────────────────────────

interface RawPersonRow {
  email: string;
  display_name: string | null;
  domain: string | null;
  inbound_count_30d: number;
  outbound_count_30d: number;
  reply_rate: number | null;
  salience_score: number;
  is_bot_likely: boolean;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
}

function rowToPersonView(r: RawPersonRow): PersonView {
  return {
    email: r.email,
    display_name: r.display_name,
    domain: r.domain,
    inbound_count_30d: r.inbound_count_30d,
    outbound_count_30d: r.outbound_count_30d,
    reply_rate: r.reply_rate,
    salience_score: r.salience_score,
    is_bot_likely: r.is_bot_likely,
    last_inbound_at: r.last_inbound_at,
    last_outbound_at: r.last_outbound_at,
  };
}

export const peopleTopTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "people_top",
  description: `top people in the user's inbox by salience (humans they actually engage with). bots/notifications are filtered by default.

returns: { people: [{email, display_name, inbound_count_30d, outbound_count_30d, reply_rate, salience_score, last_inbound_at}], count }.

call when:
- "who am i not getting back to"     → reply_rate is low + inbound is high
- "who emails me most"               → sort handled here
- (when triaging a push event) to check whether the sender is in the salient set`,
  input_schema: {
    type: "object",
    properties: {
      limit: { type: "integer", description: "default 15." },
      include_bots: { type: "boolean", description: "default false." },
    },
  },
  allowed_callers: [PTC_CALLER],
  input_examples: [{}, { limit: 30, include_bots: false }],
  modes: new Set<BrainMode>(["reactive", "proactive"]),
};

interface PeopleTopInput {
  limit?: number;
  include_bots?: boolean;
}

export async function peopleTopHandler(input: unknown): Promise<unknown> {
  const { limit, include_bots } = (input ?? {}) as PeopleTopInput;
  const lim = Math.min(100, Math.max(1, limit ?? 15));
  const includeBots = Boolean(include_bots);
  const ctx = getTurnContext();
  const sql = getSql();

  const rows = await sql<RawPersonRow[]>`
    select email, display_name, domain,
           inbound_count_30d, outbound_count_30d, reply_rate,
           salience_score, is_bot_likely,
           last_inbound_at, last_outbound_at
    from gmail_people
    where user_id = ${ctx.userId}
      ${includeBots ? sql`` : sql`and is_bot_likely = false`}
    order by salience_score desc
    limit ${lim}
  `;
  return { people: rows.map(rowToPersonView), count: rows.length };
}
