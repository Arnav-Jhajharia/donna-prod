import { randomUUID } from "node:crypto";

// a trigger is a natural-language instruction donna plants for future-self.
// when its fireAt time arrives, the runtime re-invokes the loop with `action`
// as the input. self-cancelling pairs (the jony pattern) work because each
// trigger's action can include "cancel trigger X" as part of its instructions.
//
// only cron triggers exist today. email-condition triggers come later — when
// they do, this becomes a discriminated union and the store grows a separate
// `kind` index. one variant doesn't earn a `kind` field yet.
export interface Trigger {
  id: string;
  // ISO timestamp. comparisons are string-safe in ISO 8601.
  fireAt: string;
  // the prompt the loop will receive when the trigger fires. as detailed as
  // a user message would be — the future-self has no other context.
  action: string;
  status: "pending" | "fired" | "cancelled";
  createdAt: string;
}

// in-memory store. process-local, lost on restart. that's fine for now —
// persistence (sqlite, supabase) is a later commit. the api here is what
// the persistent version will implement, so callers don't change.
const triggers = new Map<string, Trigger>();

export function addTrigger(input: {
  fireAt: string;
  action: string;
}): Trigger {
  const t: Trigger = {
    id: randomUUID(),
    fireAt: input.fireAt,
    action: input.action,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  triggers.set(t.id, t);
  return t;
}

// returns all triggers, newest-first by createdAt. caller filters by status
// if they only want pending — keeping the store dumb means it doesn't need
// to grow new methods every time a caller wants a different view.
export function listTriggers(): Trigger[] {
  return Array.from(triggers.values()).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
}

// returns true if the trigger was pending and is now cancelled. returns false
// if the id is unknown or the trigger already fired / was already cancelled.
// the boolean lets the caller's tool_result distinguish "done" from "no-op".
export function cancelTrigger(id: string): boolean {
  const t = triggers.get(id);
  if (!t || t.status !== "pending") return false;
  t.status = "cancelled";
  return true;
}

// called by the runtime when a trigger's setTimeout elapses. only transitions
// pending → fired; cancelled triggers were already torn down. returns the
// updated trigger (or undefined if missing) so the caller can include it in
// the synthetic input it builds for runTurn.
export function markFired(id: string): Trigger | undefined {
  const t = triggers.get(id);
  if (!t || t.status !== "pending") return undefined;
  t.status = "fired";
  return t;
}
