// watches — lifecycle tools for the main brain. direct-only.
//
// create_watch sets up a long-lived sub-agent that fires on a trigger (cron
// today; one_shot for "ping me at X" cases). list_watches and close_watch
// let donna reason about active watches and retire them.
//
// the actual firing/execution happens in src/donna/agents/runner.ts.

import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import type { BrainMode } from "../brain.js";
import { getTurnContext } from "../context.js";
import {
  closeWatch,
  createWatch,
  listWatchesForUser,
} from "../watches/service.js";
import { parseTriggerSpec } from "../watches/trigger-spec.js";
import type { TriggerSpec, WatchStatus } from "../agents/types.js";

// ─── create_watch ───────────────────────────────────────────────────────────

export const createWatchTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "create_watch",
  description: `create a long-lived watch that fires on a trigger and runs in its own sub-agent thread.

use a watch when:
- the user wants something tracked over time ("ping me every weekday at 8am with my unread email count")
- the user wants to be notified when something happens ("tell me when this PR merges")
- a goal needs persistent state across firings (a hydration tracker that knows what was logged today)

inputs:
- name: short label ("PR donna-prod#123 watch", "evening gratitude", "hydration")
- description: english instruction the sub-agent reads every firing. include WHAT to do, WHEN to send vs stay silent, and any state to track. be specific.
- trigger: discriminated union, one of:
    { kind: "cron",     schedule: "0 21 * * *", timezone?: "America/Los_Angeles" }
    { kind: "one_shot", fire_at:  "2026-05-13T17:00:00-07:00" }
- initial_context: optional json object with seed state (URLs, baselines, targets) the sub-agent should always know.

returns: { watch_id, thread_id, next_fire_at }.

after calling, send a brief send_burst confirming what was set up. do NOT explain the technical setup — say "got it, will check in at 9pm" or similar in donna's voice.

NEVER create duplicate watches for the same purpose. check list_watches first when the user references something that might already exist.`,
  input_schema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "short label for the watch.",
      },
      description: {
        type: "string",
        description: "english instruction the sub-agent reads every firing.",
      },
      trigger: {
        type: "object",
        description: "trigger spec: {kind:'cron',schedule,timezone?} or {kind:'one_shot',fire_at}",
      },
      initial_context: {
        type: "object",
        description: "optional seed state (URLs, baselines, targets).",
      },
    },
    required: ["name", "description", "trigger"],
  },
  modes: new Set<BrainMode>(["reactive"]),
};

interface CreateWatchInput {
  name?: string;
  description?: string;
  trigger?: unknown;
  initial_context?: Record<string, unknown>;
}

export async function createWatchHandler(input: unknown): Promise<unknown> {
  const { name, description, trigger, initial_context } = (input ?? {}) as CreateWatchInput;
  if (!name || typeof name !== "string") throw new Error("create_watch: name required");
  if (!description || typeof description !== "string") {
    throw new Error("create_watch: description required");
  }
  // throws TriggerSpecError on bad spec.
  const triggerSpec: TriggerSpec = parseTriggerSpec(trigger);
  const ctx = getTurnContext();
  const result = await createWatch({
    userId: ctx.userId,
    name,
    description,
    trigger: triggerSpec,
    initialContext: initial_context,
    createdBy: ctx.source === "cli" ? "user" : "donna_reactive",
  });
  return {
    ok: true,
    watch_id: result.watch_id,
    thread_id: result.thread_id,
    next_fire_at: result.next_fire_at,
  };
}

// ─── list_watches ───────────────────────────────────────────────────────────

export const listWatchesTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "list_watches",
  description: `list active watches for the user.

call this when:
- user references something that might already be watched ("how's the PR doing?", "what reminders do i have?")
- user asks "what are you tracking"
- before creating a new watch — confirm it doesn't already exist

inputs:
- status (optional): "active" | "paused" | "closed". default "active".

returns: { watches: [{id, name, description, trigger_spec, status, created_at}, ...], count }.`,
  input_schema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["active", "paused", "closed"],
        description: "filter by status. default 'active'.",
      },
    },
  },
  modes: new Set<BrainMode>(["reactive"]),
};

interface ListWatchesInput {
  status?: string;
}

export async function listWatchesHandler(input: unknown): Promise<unknown> {
  const { status } = (input ?? {}) as ListWatchesInput;
  const ctx = getTurnContext();
  const rows = await listWatchesForUser(ctx.userId, {
    status: (status as WatchStatus | undefined) ?? "active",
  });
  return {
    watches: rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      trigger_spec: r.trigger_spec,
      status: r.status,
      created_at: r.created_at,
    })),
    count: rows.length,
  };
}

// ─── close_watch ────────────────────────────────────────────────────────────

export const closeWatchTool: Tool & { modes: ReadonlySet<BrainMode> } = {
  name: "close_watch",
  description: `close (retire) a watch. no further firings will happen.

call this when:
- user explicitly says to stop ("stop reminding me about the PR")
- the watch's purpose has resolved and you want to clean up

inputs:
- watch_id: id from list_watches or create_watch.

returns: { ok: true }.`,
  input_schema: {
    type: "object",
    properties: {
      watch_id: { type: "string", description: "the watch id to close." },
    },
    required: ["watch_id"],
  },
  modes: new Set<BrainMode>(["reactive"]),
};

interface CloseWatchInput {
  watch_id?: string;
}

export async function closeWatchHandler(input: unknown): Promise<unknown> {
  const { watch_id } = (input ?? {}) as CloseWatchInput;
  if (!watch_id) throw new Error("close_watch: watch_id required");
  await closeWatch(watch_id);
  return { ok: true };
}
